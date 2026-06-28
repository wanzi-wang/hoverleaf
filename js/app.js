/* =====================================================================
   Hoverleaf — app.js
   Read economics papers without flipping to the back for every exhibit.

   Pipeline:
     1. Load PDF (pdf.js, fully client-side).
     2. Scan every page's text → build an "exhibit index" (Figure/Table
        captions: which page, where on the page).
     3. Scan text again → find in-text references ("see Table 3") and lay
        transparent clickable hot-spots over them.
     4. Hover a reference → preview card; click → pinnable floating window.
   ===================================================================== */
import * as pdfjsLib from "./vendor/pdf.min.mjs";
// Self-hosted worker → the app runs fully offline and nothing about the paper
// (not even which URL you opened) is sent to any third party.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;

/* ----------------------------------------------------------------------
 * Feedback: paste your Google Form's share link below (the ".../viewform"
 * URL from the form's "Send" → link button). Responses land in your own
 * Google Sheet — no GitHub or email needed from readers. Leave "" to fall
 * back to a GitHub-issue link.
 * -------------------------------------------------------------------- */
const FEEDBACK_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLScAPVg-qjV32YxxWKmfOfoTzXA50EHAL61vM2I8kpHZD5F7BA/viewform";
const FEEDBACK_GITHUB = "https://github.com/wanzi-wang/hoverleaf/issues/new";

const { Util } = pdfjsLib;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ *
 * Global state
 * ------------------------------------------------------------------ */
const State = {
  pdf: null,
  numPages: 0,
  pageCache: new Map(),     // pageNum -> PDFPageProxy
  pageModel: new Map(),     // pageNum -> { wpt, hpt, items[], lines[], content }
  pageEls: new Map(),       // pageNum -> { wrap, canvas, textLayer, linkLayer, rendered }
  exhibits: new Map(),      // key -> exhibit object
  exhibitOrder: [],         // keys in document order
  refs: [],                 // {page, key, boxes[]}
  zoom: 1,
  baseWidthCss: 760,        // css width of a page at zoom 1
  filename: "",
  pageGraphics: new Map(),  // pageNum -> [ink bounding boxes] (images + vector paths)
};

/* ------------------------------------------------------------------ *
 * Tiny helpers
 * ------------------------------------------------------------------ */
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
function setLoading(on, text, pct) {
  const o = $("#loadingOverlay");
  o.hidden = !on;
  if (text) $("#loadText").textContent = text;
  if (pct != null) $("#loadFill").style.width = `${Math.round(pct * 100)}%`;
}
async function getPage(n) {
  if (State.pageCache.has(n)) return State.pageCache.get(n);
  const p = await State.pdf.getPage(n);
  State.pageCache.set(n, p);
  return p;
}
// Pixel-density cap for canvas backing stores. Phones / low-memory devices get
// a gentler cap so a big PDF page doesn't allocate a huge bitmap and crash.
function maxDPR() {
  const dpr = window.devicePixelRatio || 1;
  const small = Math.min(screen.width || 9999, screen.height || 9999) <= 820;
  const lowMem = (navigator.deviceMemory || 8) <= 4;
  return Math.min(dpr, small || lowMem ? 2 : 2.5);
}
function normId(raw) {
  return raw.replace(/\./g, "").toUpperCase(); // "A.1" -> "A1", "3a" -> "3A"
}
function kindOf(word) {
  return /^(t|tab)/i.test(word) ? "table" : "figure";
}
function exhibitKey(kind, id) {
  return `${kind}-${normId(id)}`;
}

/* =====================================================================
   STEP 1 — Build a geometric text model for one page
   ===================================================================== */
async function buildPageModel(pageNum) {
  if (State.pageModel.has(pageNum)) return State.pageModel.get(pageNum);
  const page = await getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();

  const items = [];
  let cTop = Infinity, cBottom = -Infinity, cLeft = Infinity, cRight = -Infinity;

  for (const it of tc.items) {
    if (!it.str) continue;
    const tx = Util.transform(vp.transform, it.transform);
    const h = Math.hypot(tx[2], tx[3]) || 10;
    const w = (it.width || 0) * 1; // scale 1
    const left = tx[4];
    const top = tx[5] - h;
    items.push({ str: it.str, x: left, y: top, w, h });
    cTop = Math.min(cTop, top);
    cBottom = Math.max(cBottom, top + h);
    cLeft = Math.min(cLeft, left);
    cRight = Math.max(cRight, left + w);
  }

  // Detect a two-column layout, then group items into lines PER COLUMN so a
  // left-column line and a right-column line at the same height don't merge
  // into one garbled "line" (which would wreck caption + reference detection
  // on AER/QJE-style published papers).
  const columns = detectColumns(items, vp.width);
  const lines = [];
  columns.forEach((col, ci) => {
    const colItems = items.filter((it) => {
      const cx = it.x + it.w / 2;
      return cx >= col.x0 && cx < col.x1;
    }).sort((a, b) => a.y - b.y || a.x - b.x);
    const colLines = [];
    for (const it of colItems) {
      const last = colLines[colLines.length - 1];
      if (last && Math.abs(it.y - last.y) < last.h * 0.7) {
        last.items.push(it);
        last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
        last.h = Math.max(last.h, it.h);
      } else {
        colLines.push({ y: it.y, h: it.h, items: [it], col: ci });
      }
    }
    lines.push(...colLines);
  });
  for (const ln of lines) ln.items.sort((a, b) => a.x - b.x);

  const model = {
    wpt: vp.width, hpt: vp.height, items, lines, columns,
    content: { top: cTop, bottom: cBottom, left: cLeft, right: cRight },
  };
  State.pageModel.set(pageNum, model);
  return model;
}

// Find a clean vertical gutter near the page centre. Returns one band (single
// column) or two bands (two columns). Conservative: only splits when there is a
// near-empty gutter with well-balanced, populated sides.
function detectColumns(items, W) {
  if (items.length < 40) return [{ x0: 0, x1: W }];
  let best = null;
  for (let s = W * 0.4; s <= W * 0.6; s += W * 0.01) {
    let straddle = 0, left = 0, right = 0;
    for (const it of items) {
      if (it.x < s - 1 && it.x + it.w > s + 1) straddle++;
      else if (it.x + it.w / 2 < s) left++; else right++;
    }
    const bal = Math.min(left, right) / Math.max(1, Math.max(left, right));
    if (left > 12 && right > 12 && straddle < items.length * 0.04 && bal > 0.4) {
      if (!best || straddle < best.straddle) best = { s, straddle };
    }
  }
  return best ? [{ x0: 0, x1: best.s }, { x0: best.s, x1: W }] : [{ x0: 0, x1: W }];
}

/* =====================================================================
   STEP 1b — Ink boxes (images + vector paths)
   Figures are usually drawn as images / vector paths that the text layer can't
   see. We walk the page's draw operations and record the bounding box of every
   image and stroked/filled path (in scale-1 viewport coords). This is what lets
   us frame a figure precisely instead of guessing from surrounding text.
   ===================================================================== */
async function getPageGraphics(pageNum) {
  if (State.pageGraphics.has(pageNum)) return State.pageGraphics.get(pageNum);
  const page = await getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const OPS = pdfjsLib.OPS, T = Util.transform, A = Util.applyTransform;
  let opList;
  try { opList = await page.getOperatorList(); }
  catch { State.pageGraphics.set(pageNum, []); return []; }

  const fn = opList.fnArray, ar = opList.argsArray;
  const boxes = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let path = null;
  const toView = (x, y) => A(A([x, y], ctm), vp.transform); // PDF space -> viewport(scale 1)
  const addPts = (pts) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x0, y0, x1, y1 };
  };

  for (let i = 0; i < fn.length; i++) {
    const f = fn[i];
    if (f === OPS.save) stack.push(ctm);
    else if (f === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (f === OPS.transform) ctm = T(ctm, ar[i]);
    else if (f === OPS.paintFormXObjectBegin) { stack.push(ctm); if (ar[i] && ar[i][0]) ctm = T(ctm, ar[i][0]); }
    else if (f === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (f === OPS.paintImageXObject || f === OPS.paintImageMaskXObject ||
             f === OPS.paintInlineImageXObject || f === OPS.paintJpegXObject) {
      boxes.push(addPts([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => toView(x, y))));
    } else if (f === OPS.constructPath) {
      const coords = ar[i] && ar[i][1];
      if (coords && coords.length >= 2) {
        const pts = [];
        for (let j = 0; j + 1 < coords.length; j += 2) pts.push(toView(coords[j], coords[j + 1]));
        const b = addPts(pts);
        path = path ? addPts([[path.x0, path.y0], [path.x1, path.y1], [b.x0, b.y0], [b.x1, b.y1]]) : b;
      }
    } else if (f === OPS.fill || f === OPS.eoFill || f === OPS.stroke || f === OPS.fillStroke ||
               f === OPS.eoFillStroke || f === OPS.closeFillStroke || f === OPS.closeStroke || f === OPS.endPath) {
      if (path) { boxes.push(path); path = null; }
    }
  }

  // drop noise (hairlines, dots) and page-filling backgrounds
  const area = vp.width * vp.height;
  const filt = boxes.filter((b) => {
    const w = b.x1 - b.x0, h = b.y1 - b.y0, a = w * h;
    return w > 3 && h > 3 && a > area * 0.0006 && a < area * 0.93;
  });
  State.pageGraphics.set(pageNum, filt);
  return filt;
}

/* =====================================================================
   STEP 2 — Caption / exhibit detection
   ===================================================================== */
const CAPTION_RE =
  /^\s*(figures?|figs?\.?|tables?|tabs?\.?)\s*\.?\s*([A-Za-z]{0,3}\.?\d+[A-Za-z]?)\b([\s\S]*)$/i;
const NOTE_RE = /^\s*(notes?|sources?)\s*[:.—]/i;
const CAP_THRESHOLD = 3;

function lineText(line) {
  let s = "", prevRight = null;
  for (const it of line.items) {
    if (prevRight != null && it.x - prevRight > it.h * 0.3) s += " ";
    s += it.str;
    prevRight = it.x + it.w;
  }
  return s;
}

// Score how caption-like the text after a "Figure N" / "Table N" label is.
// A real back-of-paper caption ("Table 2—Effect of X") scores high; an in-text
// sentence that merely starts a wrapped line ("Figure 2. Heterogeneity is…")
// scores low and is rejected. Returns {score, title}.
function scoreCaption(rest) {
  const r = rest.replace(/^\s+/, "");
  const sep = r[0] || "";
  let score = 0;
  if (sep === ":" || sep === "—" || sep === "–") score += 4;       // strong caption markers
  else if (sep === "") score += 2;                                   // bare "Figure 3" line
  else if (sep === "." || sep === ")" || sep === "-") score += 1;
  else if (/^[A-Z(]/.test(r)) score += 1;                            // "Figure 3 Title Case…"
  else return { score: -10, title: "" };                             // lowercase/garbage → not a caption

  const title = r.replace(/^[\s:.—–)\-]+/, "").trim();
  const wc = title.split(/\s+/).filter(Boolean).length;
  if (wc > 0 && wc <= 12) score += 1;
  if (wc > 16) score -= 3;                                           // long → it's a sentence
  // a finite verb only signals prose in a longer run; short Title-Case captions
  // like "Treatment effects are larger in rural areas" stay valid
  if (wc > 6 && /\b(is|are|was|were|be|been|shows?|reports?|presents?|displays?|summari[sz]ed|documented|provides?|reveals?|suggests?|indicates?|implies?|we|our|this|these|which|that)\b/i.test(title))
    score -= 4;
  if (/\b(figures?|figs?\.?|tables?|tabs?\.?|panels?)\s*\.?\s*\d/i.test(title)) score -= 3; // cites another exhibit
  if (/^[A-Z]/.test(title)) score += 1;
  return { score, title: title.slice(0, 140) };
}

function isCaptionLine(txt) {
  const m = txt.match(CAPTION_RE);
  if (!m) return null;
  const { score, title } = scoreCaption(m[3]);
  if (score < CAP_THRESHOLD) return null;
  return { kind: kindOf(m[1]), id: m[2], title, score };
}

function detectExhibits() {
  State.exhibits.clear();
  State.exhibitOrder = [];
  const candidates = new Map(); // key -> best candidate

  for (let p = 1; p <= State.numPages; p++) {
    const model = State.pageModel.get(p);
    if (!model) continue;
    for (const line of model.lines) {
      const hit = isCaptionLine(lineText(line));
      if (!hit) continue;
      const key = exhibitKey(hit.kind, hit.id);
      const capLeft = Math.min(...line.items.map((i) => i.x));
      const capRight = Math.max(...line.items.map((i) => i.x + i.w));
      const cap = { top: line.y, bottom: line.y + line.h, left: capLeft, right: capRight };
      // bias slightly toward later pages (exhibits usually live at the back)
      const score = hit.score + p / Math.max(1, State.numPages);
      const prev = candidates.get(key);
      if (prev && prev.score >= score) continue;
      candidates.set(key, { key, kind: hit.kind, id: normId(hit.id), page: p, cap, title: hit.title, score });
    }
  }

  for (const ex of candidates.values()) State.exhibits.set(ex.key, ex);
  State.exhibitOrder = [...State.exhibits.keys()].sort((a, b) => {
    const A = State.exhibits.get(a), B = State.exhibits.get(b);
    return A.page - B.page || A.cap.top - B.cap.top;
  });

}

// Second pass (async): now that every caption is known, compute crop regions.
// Each exhibit's siblings on the same page act as hard walls. Figures are framed
// from their actual ink (images / vector paths); tables fall back to text geometry.
async function computeRegions() {
  const byPage = new Map();
  for (const ex of State.exhibits.values()) {
    if (!byPage.has(ex.page)) byPage.set(ex.page, []);
    byPage.get(ex.page).push(ex.cap);
  }
  for (const ex of State.exhibits.values()) {
    const model = State.pageModel.get(ex.page);
    const siblings = byPage.get(ex.page).filter((c) => c !== ex.cap);
    let region = null;
    if (ex.kind === "figure") {
      const graphics = await getPageGraphics(ex.page);
      region = regionFromGraphics(ex.cap, model, siblings, graphics);
    }
    ex.region = region || computeRegion(ex.kind, ex.cap, model, siblings);
  }
}

// Frame a figure from its ink. The figure's graphic sits on ONE side of the
// caption (usually above). We bound each side by the nearest neighbouring
// caption/note, then take whichever side actually holds the ink — so two figures
// stacked on one page don't swallow each other's graphic.
function regionFromGraphics(cap, model, siblings, graphics) {
  if (!graphics || !graphics.length) return null;
  const H = model.hpt, W = model.wpt, pad = H * 0.012;
  const band = regionXBand(cap, model);
  const inBandX = (x) => x >= band.x - 2 && x <= band.x + band.w + 2;

  // nearest neighbouring exhibit caption / Notes line on each side
  let above = 0, below = H;
  for (const s of siblings) {
    if (!inBandX((s.left + s.right) / 2)) continue;
    if (s.bottom <= cap.top + 1) above = Math.max(above, s.bottom);
    else if (s.top >= cap.bottom - 1) below = Math.min(below, s.top);
  }
  for (const line of model.lines) {
    if (!NOTE_RE.test(lineText(line))) continue;
    const top = line.y, bot = line.y + line.h;
    if (bot > cap.top - 1 && top < cap.bottom + 1) continue;
    if (bot <= cap.top + 1) above = Math.max(above, bot);
    else if (top >= cap.bottom - 1) below = Math.min(below, top);
  }

  // ink fully above the caption (down to the previous neighbour) vs fully below
  const aboveInk = graphics.filter((b) => inBandX((b.x0 + b.x1) / 2) && b.y1 <= cap.top + 2 && b.y0 >= above - 1);
  const belowInk = graphics.filter((b) => inBandX((b.x0 + b.x1) / 2) && b.y0 >= cap.bottom - 2 && b.y1 <= below + 1);
  const area = (arr) => arr.reduce((s, b) => s + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  const useAbove = area(aboveInk) >= area(belowInk);
  const mine = useAbove ? aboveInk : belowInk;
  if (!mine.length) return null;

  const gx0 = Math.min(...mine.map((b) => b.x0)), gx1 = Math.max(...mine.map((b) => b.x1));
  const gy0 = Math.min(...mine.map((b) => b.y0)), gy1 = Math.max(...mine.map((b) => b.y1));
  // extend toward the graphic only; keep a thin margin on the caption's far side
  let y0 = useAbove ? Math.min(cap.top, gy0) - pad : cap.top - pad;
  let y1 = useAbove ? cap.bottom + pad : Math.max(cap.bottom, gy1) + pad;
  y0 = clamp(y0, above === 0 ? 0 : above + pad, H);
  y1 = clamp(y1, 0, below === H ? H : below - pad);
  const x0 = clamp(Math.min(cap.left, gx0) - pad, 0, W);
  const x1 = clamp(Math.max(cap.right, gx1) + pad, 0, W);
  if (y1 - y0 < H * 0.04 || x1 - x0 < W * 0.1) return null; // implausible → fall back
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Region (in scale-1 page coords) we crop for a preview. Figures put their
// graphic above OR below the caption (and the graphic is an image, invisible to
// the text layer), so we extend generously on both sides and let neighbouring
// captions / "Notes:" lines bound the crop. Works regardless of caption side.
function computeRegion(kind, cap, model, siblings = []) {
  const H = model.hpt, W = model.wpt, c = model.content, pad = H * 0.012;
  const MAXG = 0.80 * H;   // how far we'll reach toward the graphic/body
  const SMALL = 0.06 * H;  // trim on the non-graphic side (keeps a one-line note)

  // horizontal band: full width for exhibits that span columns, otherwise the
  // single column the caption lives in (so a 2-col figure preview isn't garbage)
  const band = regionXBand(cap, model);
  const inBand = (x) => x >= band.x - 1 && x <= band.x + band.w + 1;

  // nearest boundary above/below that we never cross: any OTHER exhibit caption
  // on this page (known from the first pass) plus any Notes/Source line in-band
  let above = -Infinity, below = Infinity;
  for (const s of siblings) {
    if (!inBand((s.left + s.right) / 2)) continue;
    if (s.bottom <= cap.top + 1) above = Math.max(above, s.bottom);
    else if (s.top >= cap.bottom - 1) below = Math.min(below, s.top);
  }
  for (const line of model.lines) {
    const lx = line.items.length ? (line.items[0].x + line.items[line.items.length - 1].x + line.items[line.items.length - 1].w) / 2 : -1;
    if (!inBand(lx)) continue;
    const t = lineText(line);
    if (!NOTE_RE.test(t)) continue;
    const top = line.y, bot = line.y + line.h;
    if (bot > cap.top - 1 && top < cap.bottom + 1) continue; // the caption itself
    if (bot <= cap.top + 1) above = Math.max(above, bot);
    else if (top >= cap.bottom - 1) below = Math.min(below, top);
  }
  const prevBound = above > -Infinity ? above : Math.max(0, c.top - pad);
  const nextBound = below < Infinity ? below : Math.min(H, c.bottom + pad);
  const gapAbove = cap.top - prevBound;     // empty space above the caption
  const gapBelow = nextBound - cap.bottom;  // empty space below the caption

  // The graphic / table body lives on the side with MORE space. Reach fully to
  // that side (up to MAXG); trim the other side to a small margin so the crop
  // can never spill into the neighbouring exhibit.
  let y0, y1;
  if (gapAbove >= gapBelow) {
    y0 = cap.top - Math.min(MAXG, gapAbove);
    y1 = cap.bottom + Math.min(SMALL, gapBelow);
  } else {
    y0 = cap.top - Math.min(SMALL, gapAbove);
    y1 = cap.bottom + Math.min(MAXG, gapBelow);
  }
  // never cross a real neighbouring caption/note
  if (above > -Infinity) y0 = Math.max(y0, above + pad);
  if (below < Infinity) y1 = Math.min(y1, below - pad);
  // clamp to page content
  y0 = clamp(y0, Math.max(0, c.top - pad), H);
  y1 = clamp(y1, 0, Math.min(H, c.bottom + pad));
  if (y1 - y0 < H * 0.08) { y0 = clamp(cap.top - 0.06 * H, 0, H); y1 = clamp(cap.bottom + 0.3 * H, 0, H); }
  return { x: band.x, y: y0, w: band.w, h: y1 - y0 };
}

// Horizontal crop band for an exhibit: full page if its caption spans columns,
// else the column band that contains the caption.
function regionXBand(cap, model) {
  const cols = model.columns || [{ x0: 0, x1: model.wpt }];
  if (cols.length < 2) return { x: 0, w: model.wpt };
  const colW = cols[0].x1 - cols[0].x0;
  if (cap.right - cap.left > colW * 1.25) return { x: 0, w: model.wpt }; // spans columns
  const cx = (cap.left + cap.right) / 2;
  const col = cols.find((c) => cx >= c.x0 && cx < c.x1) || cols[0];
  const pad = model.wpt * 0.012;
  return { x: Math.max(0, col.x0 - pad), w: Math.min(model.wpt - Math.max(0, col.x0 - pad), col.x1 - col.x0 + 2 * pad) };
}

/* =====================================================================
   STEP 3 — In-text reference detection
   ===================================================================== */
const REF_HEAD = /(figures?|figs?\.?|tables?|tabs?\.?)\s*\.?\s*([A-Za-z]{0,3}\.?\d+[A-Za-z]?)/gi;
const REF_TAIL = /^(\s*(?:,|;|and|&|or|to|through|–|—|-)\s*(?:and\s*)?)([A-Za-z]{0,3}\.?\d+[A-Za-z]?)\b/i;

// Resolve a reference key to an exhibit, falling back from a panel id to its
// base (e.g. a "Figure 1a" reference resolves to the "Figure 1" caption).
function resolveExhibit(key) {
  if (State.exhibits.has(key)) return State.exhibits.get(key);
  const base = key.replace(/[A-Za-z]+$/, ""); // figure-1A -> figure-1
  if (base !== key && State.exhibits.has(base)) return State.exhibits.get(base);
  return null;
}

// flatten a page model into a string + per-char box map
function pageTextIndex(model) {
  let text = "";
  const map = []; // per character: {item, ci} or null
  let prevLineY = null;
  for (const line of model.lines) {
    if (prevLineY != null) { text += "\n"; map.push(null); }
    prevLineY = line.y;
    let prevRight = null;
    for (const it of line.items) {
      if (prevRight != null && it.x - prevRight > it.h * 0.3) { text += " "; map.push(null); }
      for (let ci = 0; ci < it.str.length; ci++) { text += it.str[ci]; map.push({ item: it, ci, len: it.str.length }); }
      prevRight = it.x + it.w;
    }
  }
  return { text, map };
}

function boxesForRange(map, s, e) {
  // collect sub-item boxes covering [s,e)
  const byItem = new Map();
  for (let i = s; i < e; i++) {
    const m = map[i];
    if (!m) continue;
    let g = byItem.get(m.item);
    if (!g) { g = { item: m.item, lo: m.ci, hi: m.ci }; byItem.set(m.item, g); }
    g.lo = Math.min(g.lo, m.ci); g.hi = Math.max(g.hi, m.ci);
  }
  const boxes = [];
  for (const { item, lo, hi } of byItem.values()) {
    const frac0 = lo / item.str.length, frac1 = (hi + 1) / item.str.length;
    boxes.push({
      x: item.x + frac0 * item.w,
      y: item.y,
      w: Math.max(2, (frac1 - frac0) * item.w),
      h: item.h,
    });
  }
  return boxes;
}

function expandRange(kind, a, b) {
  // "Tables 1 to 3" -> 1,2,3  (numeric, small span only)
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (Number.isInteger(na) && Number.isInteger(nb) && nb > na && nb - na <= 20 &&
      /^\d+$/.test(a) && /^\d+$/.test(b)) {
    const out = [];
    for (let n = na; n <= nb; n++) out.push(String(n));
    return out;
  }
  return [b];
}

function detectReferences() {
  State.refs = [];
  for (let p = 1; p <= State.numPages; p++) {
    const model = State.pageModel.get(p);
    if (!model) continue;
    const { text, map } = pageTextIndex(model);

    REF_HEAD.lastIndex = 0;
    let m;
    while ((m = REF_HEAD.exec(text))) {
      const kind = kindOf(m[1]);
      const headStart = m.index;
      const idStart = m.index + m[0].length - m[2].length;
      const idEnd = m.index + m[0].length;
      addRef(model, map, p, kind, m[2], idStart, idEnd, headStart);

      // trailing list: "3 and 4", "1–3", "2, 5"
      let cursor = idEnd;
      let prevId = m[2];
      let guard = 0;
      while (guard++ < 12) {
        const tail = text.slice(cursor).match(REF_TAIL);
        if (!tail) break;
        const conn = tail[1];
        const tId = tail[2];
        const tStart = cursor + conn.length;
        const tEnd = tStart + tId.length;
        const isRange = /(?:to|through|–|—|-)\s*(?:and\s*)?$/i.test(conn);
        const ids = isRange ? expandRange(kind, prevId, tId) : [tId];
        for (const idv of ids) addRef(model, map, p, kind, idv, tStart, tEnd, tStart);
        prevId = tId;
        cursor = tEnd;
      }
      REF_HEAD.lastIndex = Math.max(REF_HEAD.lastIndex, cursor);
    }
  }
}

function addRef(model, map, page, kind, id, s, e, anchorStart) {
  const key = exhibitKey(kind, id);
  const boxes = boxesForRange(map, anchorStart, e);
  if (!boxes.length) return;
  State.refs.push({ page, key, kind, id: normId(id), boxes });
}

/* =====================================================================
   RENDERING — pages, lazily, into the continuous viewer
   ===================================================================== */
function renderScale() {
  return (State.baseWidthCss * State.zoom) / referencePageWidth();
}
function referencePageWidth() {
  // use first page width as the layout reference
  const m = State.pageModel.get(1);
  return m ? m.wpt : 612;
}

function buildPagePlaceholders() {
  const viewer = $("#viewer");
  viewer.innerHTML = "";
  State.pageEls.clear();
  const scale = renderScale();
  for (let p = 1; p <= State.numPages; p++) {
    const model = State.pageModel.get(p);
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.dataset.page = p;
    wrap.style.width = `${model.wpt * scale}px`;
    wrap.style.height = `${model.hpt * scale}px`;
    viewer.appendChild(wrap);
    State.pageEls.set(p, { wrap, rendered: false });
  }
  observePages();
}

let pageObserver;
function observePages() {
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const p = +en.target.dataset.page;
        if (en.isIntersecting) renderPage(p);
        else unrenderPage(p); // free canvases far from the viewport (memory)
      }
    },
    { root: $("#viewerScroll"), rootMargin: "900px 0px" }
  );
  for (const { wrap } of State.pageEls.values()) pageObserver.observe(wrap);
}

// Release a rendered page's canvas/layers so a 60-page paper doesn't accumulate
// hundreds of MB of bitmaps. The placeholder keeps its size; it re-renders when
// it scrolls back into range.
function unrenderPage(p) {
  const el = State.pageEls.get(p);
  if (!el || !el.rendered) return;
  if (el.canvas) { el.canvas.width = el.canvas.height = 0; }
  el.wrap.innerHTML = "";
  el.canvas = null;
  el.rendered = false;
}

async function renderPage(p) {
  const el = State.pageEls.get(p);
  if (!el || el.rendered) return;
  el.rendered = true;
  const page = await getPage(p);
  const model = State.pageModel.get(p);
  const scale = renderScale();
  const dpr = maxDPR();
  const vp = page.getViewport({ scale: scale * dpr });

  const canvas = document.createElement("canvas");
  canvas.width = vp.width;
  canvas.height = vp.height;
  canvas.style.width = `${model.wpt * scale}px`;
  canvas.style.height = `${model.hpt * scale}px`;
  el.wrap.appendChild(canvas);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;

  // text layer (selectable)
  const tl = document.createElement("div");
  tl.className = "textLayer";
  el.wrap.appendChild(tl);
  buildTextLayer(tl, model, scale);

  // link layer (clickable references)
  const ll = document.createElement("div");
  ll.className = "linkLayer";
  el.wrap.appendChild(ll);
  buildLinkLayer(ll, p, scale);

  el.canvas = canvas;
}

function buildTextLayer(container, model, scale) {
  const frag = document.createDocumentFragment();
  for (const it of model.items) {
    const span = document.createElement("span");
    span.textContent = it.str;
    span.style.left = `${it.x * scale}px`;
    span.style.top = `${it.y * scale}px`;
    span.style.fontSize = `${it.h * scale}px`;
    // squeeze the glyphs to roughly match the underlying render width
    span.style.transform = `scaleX(${(it.w * scale) / Math.max(1, measureWidth(it.str, it.h * scale))})`;
    frag.appendChild(span);
  }
  container.appendChild(frag);
}
let _mc;
function measureWidth(str, fontPx) {
  if (!_mc) _mc = document.createElement("canvas").getContext("2d");
  _mc.font = `${fontPx}px ${getComputedStyle(document.body).fontFamily}`;
  return _mc.measureText(str).width || 1;
}

function buildLinkLayer(container, p, scale) {
  for (const ref of State.refs) {
    if (ref.page !== p) continue;
    const ex = resolveExhibit(ref.key);
    const label = ex
      ? `Preview ${ex.kind === "table" ? "Table" : "Figure"} ${ex.id}${ex.title ? ", " + ex.title : ""}`
      : `${ref.kind} ${ref.id} — caption not found`;
    for (const b of ref.boxes) {
      const a = document.createElement("div");
      a.className = ex ? "ref-link" : "ref-link unresolved";
      a.style.left = `${b.x * scale}px`;
      a.style.top = `${b.y * scale}px`;
      a.style.width = `${b.w * scale}px`;
      a.style.height = `${b.h * scale}px`;
      a.dataset.key = ref.key;
      a.tabIndex = 0;                       // keyboard reachable
      a.setAttribute("role", "button");
      a.setAttribute("aria-label", label);
      wireRefLink(a, ref.key);
      container.appendChild(a);
    }
  }
}

/* =====================================================================
   PREVIEW CROP renderer — renders just the exhibit's region
   ===================================================================== */
async function renderRegion(targetWrap, ex, cssWidth) {
  const page = await getPage(ex.page);
  const region = ex.region;
  const dpr = maxDPR();
  const scale = cssWidth / region.w;
  const vp = page.getViewport({ scale: scale * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.w * scale * dpr));
  canvas.height = Math.max(1, Math.round(region.h * scale * dpr));
  canvas.style.width = `${region.w * scale}px`;
  canvas.style.height = `${region.h * scale}px`;
  const transform = [1, 0, 0, 1, -region.x * scale * dpr, -region.y * scale * dpr];
  targetWrap.innerHTML = "";
  targetWrap.appendChild(canvas);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform }).promise;
  return canvas;
}

/* =====================================================================
   HOVER CARD
   ===================================================================== */
const hoverCard = $("#hoverCard");
let hoverTimer, hoverKey = null;

function wireRefLink(el, key) {
  const open = (x, y) => {
    hideHoverCard();
    const ex = resolveExhibit(key);
    if (!ex) { jumpToText(key); return; }
    openPip(ex, x, y, el);
  };
  // mouse: hover to preview, click to pin
  el.addEventListener("mouseenter", () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showHoverCard(el, key), 130);
  });
  el.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); hideHoverCard(); });
  el.addEventListener("click", (e) => { e.preventDefault(); const r = el.getBoundingClientRect(); open(r.left + r.width / 2, r.bottom); });
  // keyboard: focus previews, Enter/Space pins
  el.addEventListener("focus", () => showHoverCard(el, key));
  el.addEventListener("blur", () => hideHoverCard());
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const r = el.getBoundingClientRect(); open(r.right, r.bottom); }
  });
}

async function showHoverCard(anchor, key) {
  const ex = resolveExhibit(key);
  if (!ex) return;
  dismissCoach();
  hoverKey = key;
  $(".hc-label", hoverCard).textContent =
    `${ex.kind === "table" ? "Table" : "Figure"} ${ex.id}${ex.title ? " · " + ex.title : ""}`;
  hoverCard.hidden = false;
  hoverCard.style.left = "-9999px";
  const w = Math.min(440, window.innerWidth * 0.6);
  await renderRegion($(".hc-canvas-wrap", hoverCard), ex, w);
  if (hoverKey !== key) return; // moved away while rendering
  positionHoverCard(anchor);
}
function positionHoverCard(anchor) {
  const r = anchor.getBoundingClientRect();
  const cw = hoverCard.offsetWidth, ch = hoverCard.offsetHeight;
  let left = clamp(r.left + r.width / 2 - cw / 2, 10, window.innerWidth - cw - 10);
  let top = r.top - ch - 12;
  if (top < 62) top = r.bottom + 12;            // flip below if no room above
  if (top + ch > window.innerHeight - 10) top = Math.max(62, window.innerHeight - ch - 10);
  hoverCard.style.left = `${left}px`;
  hoverCard.style.top = `${top}px`;
}
function hideHoverCard() { hoverKey = null; hoverCard.hidden = true; }

/* =====================================================================
   PiP — pinnable floating exhibit windows
   ===================================================================== */
let pipZ = 50;
const openPips = new Map(); // key -> element

async function openPip(ex, x, y, opener) {
  if (openPips.has(ex.key)) { focusPip(openPips.get(ex.key)); return; }
  const tpl = $("#pipTemplate").content.firstElementChild.cloneNode(true);
  tpl.dataset.key = ex.key;
  tpl.style.zIndex = ++pipZ;
  tpl.setAttribute("role", "dialog");
  tpl.setAttribute("aria-label", `${ex.kind === "table" ? "Table" : "Figure"} ${ex.id} preview`);
  tpl._opener = opener || null;
  $(".pip-title", tpl).textContent =
    `${ex.kind === "table" ? "Table" : "Figure"} ${ex.id} (p.${ex.page})`;
  document.body.appendChild(tpl);
  openPips.set(ex.key, tpl);

  let width = clamp(window.innerWidth * 0.34, 320, 560);
  const wrap = $(".pip-canvas-wrap", tpl);
  await renderRegion(wrap, ex, width);

  // initial position near the click, kept on-screen
  const ph = wrap.firstChild ? wrap.firstChild.offsetHeight + 38 : 300;
  let px = x != null ? clamp(x + 18, 10, window.innerWidth - width - 14) : 120;
  let py = y != null ? clamp(y - 20, 64, window.innerHeight - Math.min(ph, 500) - 14) : 100;
  tpl.style.left = `${px}px`;
  tpl.style.top = `${py}px`;
  tpl.style.width = `${width}px`;

  // --- controls ---
  $(".pip-close", tpl).onclick = () => closePip(ex.key);
  $(".pip-goto", tpl).onclick = () => scrollToExhibit(ex);
  $(".pip-pin", tpl).onclick = (e) => {
    tpl.classList.toggle("pinned");
    e.currentTarget.classList.toggle("on");
  };
  let curW = width;
  const rerender = async () => { await renderRegion(wrap, ex, curW); };
  $(".pip-zoom-in", tpl).onclick = async () => { curW = clamp(curW * 1.25, 240, 1400); tpl.style.width = `${curW}px`; await rerender(); };
  $(".pip-zoom-out", tpl).onclick = async () => { curW = clamp(curW / 1.25, 240, 1400); tpl.style.width = `${curW}px`; await rerender(); };

  makeDraggable(tpl, $(".pip-head", tpl));
  makeResizable(tpl, $(".pip-resize", tpl), wrap, async (newW) => { curW = newW; await rerender(); });
  tpl.addEventListener("pointerdown", () => focusPip(tpl));
  focusPip(tpl);
}
function focusPip(el) { el.style.zIndex = ++pipZ; el.focus({ preventScroll: true }); }
function closePip(key) {
  const el = openPips.get(key);
  if (!el) return;
  const opener = el._opener;
  el.remove();
  openPips.delete(key);
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true }); // return focus
}
function closeAllPips(onlyUnpinned = true) {
  for (const [k, el] of [...openPips]) if (!onlyUnpinned || !el.classList.contains("pinned")) closePip(k);
}

// Pointer Events → one code path works for mouse, trackpad and touch.
function makeDraggable(el, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".pip-btn")) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    const r = el.getBoundingClientRect();
    const move = (ev) => {
      el.style.left = `${clamp(r.left + ev.clientX - sx, -el.offsetWidth + 80, window.innerWidth - 80)}px`;
      el.style.top = `${clamp(r.top + ev.clientY - sy, 54, window.innerHeight - 40)}px`;
    };
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
function makeResizable(el, grip, wrap, onDone) {
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const startW = el.offsetWidth;
    const move = (ev) => { el.style.width = `${clamp(startW + ev.clientX - sx, 240, 1400)}px`; };
    const up = async () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      await onDone(el.offsetWidth);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}

/* =====================================================================
   Navigation
   ===================================================================== */
function scrollToExhibit(ex) {
  const el = State.pageEls.get(ex.page);
  if (!el) return;
  const scroller = $("#viewerScroll");
  const scale = renderScale();
  const targetTop = el.wrap.offsetTop + ex.region.y * scale - 80;
  scroller.scrollTo({ top: targetTop, behavior: "smooth" });
  el.wrap.classList.remove("flash"); void el.wrap.offsetWidth; el.wrap.classList.add("flash");
}
function jumpToText(key) {
  const ref = State.refs.find((r) => r.key === key);
  if (ref) { const el = State.pageEls.get(ref.page); if (el) $("#viewerScroll").scrollTo({ top: el.wrap.offsetTop - 60, behavior: "smooth" }); }
  else toast(`Couldn't locate ${key.replace("-", " ")} in this paper.`);
}
function goToPage(n) {
  n = clamp(n, 1, State.numPages);
  const el = State.pageEls.get(n);
  if (el) $("#viewerScroll").scrollTo({ top: el.wrap.offsetTop - 20, behavior: "smooth" });
}

/* =====================================================================
   SIDEBAR — exhibit rail
   ===================================================================== */
function buildSidebar(filter = "all") {
  const list = $("#exhibitList");
  list.innerHTML = "";
  const keys = State.exhibitOrder.filter((k) => filter === "all" || State.exhibits.get(k).kind === filter);
  if (!keys.length) {
    list.innerHTML = `<div style="padding:18px;color:var(--ink-faint);font-size:13px;text-align:center">No ${filter === "all" ? "exhibits" : filter + "s"} detected.</div>`;
    return;
  }
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) { renderThumb(en.target); io.unobserve(en.target); }
  });
  for (const key of keys) {
    const ex = State.exhibits.get(key);
    const card = document.createElement("button");
    card.className = "exhibit-card";
    card.innerHTML = `
      <div class="exhibit-thumb" data-key="${key}"></div>
      <div class="exhibit-meta">
        <div class="exhibit-kind ${ex.kind}">${ex.kind === "table" ? "Table" : "Figure"} ${ex.id}</div>
        <div class="exhibit-cap">${ex.title ? escapeHtml(ex.title) : "<i>untitled</i>"}</div>
        <div class="exhibit-pg">page ${ex.page}</div>
      </div>`;
    card.onclick = () => { const r = card.getBoundingClientRect(); openPip(ex, r.right, r.top); scrollToExhibit(ex); };
    list.appendChild(card);
    io.observe($(".exhibit-thumb", card));
  }
}
async function renderThumb(el) {
  const ex = State.exhibits.get(el.dataset.key);
  try { await renderRegion(el, ex, 64); } catch {}
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* =====================================================================
   LOAD a document end-to-end
   ===================================================================== */
async function loadDocument(source, label) {
  try {
    $("#landing").hidden = true;
    setLoading(true, "Opening…", 0.05);
    const task = pdfjsLib.getDocument(source);
    task.onProgress = (p) => { if (p.total) setLoading(true, "Downloading…", 0.05 + 0.25 * (p.loaded / p.total)); };
    State.pdf = await task.promise;
    State.numPages = State.pdf.numPages;
    State.filename = label || "document.pdf";

    setLoading(true, "Reading the text layer…", 0.32);
    for (let p = 1; p <= State.numPages; p++) {
      await buildPageModel(p);
      if (p % 3 === 0 || p === State.numPages)
        setLoading(true, `Scanning page ${p} of ${State.numPages}…`, 0.32 + 0.5 * (p / State.numPages));
    }

    setLoading(true, "Finding figures & tables…", 0.86);
    detectExhibits();
    await computeRegions();
    detectReferences();
    if (location.search.includes("debug")) window.__ep = { State, computeRegion, isCaptionLine, lineText, getPageGraphics, renderRegion };

    setLoading(true, "Laying out…", 0.95);
    enterReader();
    setLoading(false);

    const nF = State.exhibitOrder.filter((k) => State.exhibits.get(k).kind === "figure").length;
    const nT = State.exhibitOrder.length - nF;
    if (!State.exhibitOrder.length)
      toast("No figures or tables detected — this PDF may be scanned images (no text layer).", 5000);
    else
      toast(`Found ${nF} figure${nF !== 1 ? "s" : ""} and ${nT} table${nT !== 1 ? "s" : ""}. Hover any reference to preview.`, 4200);
  } catch (err) {
    console.error(err);
    setLoading(false);
    $("#landing").hidden = false;
    const remote = typeof source === "object" && source.url;
    const corsLike = /unexpected|fetch|cors|networkerror|failed to|load/i.test(err.message || "") || err.name === "UnexpectedResponseException";
    if (remote && corsLike)
      toast("That site blocks loading PDFs from other pages. Download the file and drop it here instead.", 6500);
    else if (err.name === "InvalidPDFException")
      toast("That file doesn't look like a valid PDF.", 5000);
    else
      toast(`Couldn't open this PDF: ${err.message || err}`, 5000);
  }
}

/* first-run coach-mark pointing at the first reference link */
function maybeShowCoach() {
  try { if (localStorage.getItem("ep-coached")) return; } catch {}
  setTimeout(() => {
    const link = $(".ref-link:not(.unresolved)");
    const coach = $("#coach");
    if (!link || !coach) return;
    const r = link.getBoundingClientRect();
    if (r.top < 60 || r.top > window.innerHeight - 80) { $("#viewerScroll").scrollBy({ top: r.top - 240 }); }
    const r2 = link.getBoundingClientRect();
    coach.hidden = false;
    const cw = coach.offsetWidth;
    let left = clamp(r2.left - 20, 10, window.innerWidth - cw - 10);
    coach.style.left = `${left}px`;
    coach.style.top = `${r2.bottom + 14}px`;
    const arrow = $(".coach-arrow", coach);
    arrow.style.left = `${clamp(r2.left + r2.width / 2 - left - 6, 12, cw - 24)}px`;
    arrow.style.top = "-6px";
    $("#viewerScroll").addEventListener("scroll", dismissCoach, { once: true });
  }, 1200);
}
function dismissCoach() {
  $("#coach").hidden = true;
  try { localStorage.setItem("ep-coached", "1"); } catch {}
}

function enterReader() {
  // fit page width to the viewport (so phones don't get a horizontally-scrolling page)
  State.baseWidthCss = clamp(window.innerWidth - (window.innerWidth > 760 ? 320 : 28), 300, 860);
  $("#topbar").hidden = false;
  $("#reader").hidden = false;
  $("#docTitle").textContent = State.filename;
  $("#pageTotal").textContent = `/ ${State.numPages}`;
  $("#pageInput").max = State.numPages;
  const nF = State.exhibitOrder.filter((k) => State.exhibits.get(k).kind === "figure").length;
  const nT = State.exhibitOrder.length - nF;
  $("#exhibitCounts").textContent = `${nF} fig · ${nT} tab`;
  buildPagePlaceholders();
  buildSidebar("all");
  $("#sidebar").hidden = State.exhibitOrder.length === 0 || window.innerWidth <= 760;
  updateZoomLabel();
  trackScroll();
  if (State.exhibitOrder.length) maybeShowCoach();
}

/* =====================================================================
   Zoom + scroll sync
   ===================================================================== */
function setZoom(z) {
  const scroller = $("#viewerScroll");
  const anchorRatio = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
  State.zoom = clamp(z, 0.5, 2.4);
  // re-layout: resize placeholders, drop renders so they re-render at new scale
  const scale = renderScale();
  for (const [p, el] of State.pageEls) {
    const m = State.pageModel.get(p);
    el.wrap.style.width = `${m.wpt * scale}px`;
    el.wrap.style.height = `${m.hpt * scale}px`;
    el.wrap.innerHTML = "";
    el.rendered = false;
  }
  observePages();
  scroller.scrollTop = anchorRatio * scroller.scrollHeight;
  updateZoomLabel();
}
function updateZoomLabel() { $("#zoomLabel").textContent = `${Math.round(State.zoom * 100)}%`; }

let scrollRAF;
function trackScroll() {
  const scroller = $("#viewerScroll");
  scroller.addEventListener("scroll", () => {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
      scrollRAF = null;
      // find the page nearest the top
      let best = 1, bestDist = Infinity;
      for (const [p, el] of State.pageEls) {
        const d = Math.abs(el.wrap.offsetTop - scroller.scrollTop - 40);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      if (document.activeElement !== $("#pageInput")) $("#pageInput").value = best;
    });
  });
}

/* =====================================================================
   UI wiring
   ===================================================================== */
function wireUI() {
  // theme
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    $("#btnTheme").textContent = t === "dark" ? "☀️" : "🌙";
    try { localStorage.setItem("ep-theme", t); } catch {}
  };
  applyTheme(localStorage.getItem("ep-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("#btnTheme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

  // file input + dropzone
  const fileInput = $("#fileInput");
  $("#dropzone").onclick = () => fileInput.click();
  $("#dropzone").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); };
  fileInput.onchange = () => { if (fileInput.files[0]) openFile(fileInput.files[0]); };
  $("#btnOpenNew").onclick = () => fileInput.click();

  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f && f.type === "application/pdf") openFile(f); });
  // also allow dropping anywhere once reading
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && f.type === "application/pdf") openFile(f); });

  // demo + url
  $("#btnDemo").onclick = () => loadDocument("assets/demo.pdf", "Demo — Coffee, Commits & Causal Effects.pdf");
  $("#urlForm").onsubmit = (e) => { e.preventDefault(); const u = $("#urlInput").value.trim(); if (u) loadDocument({ url: u, withCredentials: false }, u.split("/").pop() || "remote.pdf"); };

  // zoom + page
  $("#btnZoomIn").onclick = () => setZoom(State.zoom + 0.15);
  $("#btnZoomOut").onclick = () => setZoom(State.zoom - 0.15);
  $("#pageInput").onchange = (e) => goToPage(+e.target.value);
  $("#viewerScroll") && ($("#viewerScroll").addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(State.zoom + (e.deltaY < 0 ? 0.12 : -0.12)); }
  }, { passive: false }));

  // sidebar toggle + filters
  $("#btnSidebar").onclick = () => { const s = $("#sidebar"); s.hidden = !s.hidden; };
  $(".side-filter").onclick = (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    $$(".chip").forEach((c) => c.classList.toggle("active", c === b));
    buildSidebar(b.dataset.filter);
  };

  // keyboard
  $("#coachDismiss").onclick = dismissCoach;
  $("#btnHome").onclick = goHome;
  $("#btnFeedback").onclick = openFeedback;
  $("#btnFeedback2").onclick = openFeedback;
  $$("[data-fbclose]").forEach((el) => (el.onclick = closeFeedback));

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input")) return;
    if (e.key === "Escape") { if (!$("#fbModal").hidden) closeFeedback(); else if (openPips.size) closeAllPips(true); else { hideHoverCard(); dismissCoach(); } }
    else if (e.key === "d" || e.key === "D") $("#btnTheme").click();
    else if (e.key === "f" || e.key === "F") $("#btnSidebar").click();
    else if (e.key === "o" || e.key === "O") fileInput.click();
    else if (e.key === "+" || e.key === "=") setZoom(State.zoom + 0.15);
    else if (e.key === "-") setZoom(State.zoom - 0.15);
  });

  // keep floating things in-bounds on resize
  addEventListener("resize", () => { if (!hoverCard.hidden) hideHoverCard(); });
}

function openFile(file) {
  resetState();
  const url = URL.createObjectURL(file);
  loadDocument(url, file.name);
}

function resetState() {
  if (State.pdf) { try { State.pdf.destroy(); } catch {} }
  State.pdf = null;
  State.pageCache.clear(); State.pageModel.clear(); State.pageGraphics.clear();
  State.exhibits.clear(); State.exhibitOrder = []; State.refs = [];
  State.pageEls.clear();
  $("#viewer").innerHTML = "";
}

// Feedback modal — embeds your Google Form (or links to GitHub issues).
function openFeedback() {
  const body = $("#fbBody");
  if (!body.dataset.loaded) {
    if (FEEDBACK_FORM_URL) {
      const src = FEEDBACK_FORM_URL.replace(/\/viewform.*$/, "/viewform") + "?embedded=true";
      body.innerHTML = `<iframe class="fb-frame" src="${src}" title="Feedback form" loading="lazy">Loading…</iframe>`;
    } else {
      body.innerHTML = `<div class="fb-soon">A feedback form is being set up here.<br>In the meantime, you can <a href="${FEEDBACK_GITHUB}" target="_blank" rel="noopener">open an issue on GitHub</a> — thank you!</div>`;
    }
    body.dataset.loaded = "1";
  }
  $("#fbModal").hidden = false;
}
function closeFeedback() { $("#fbModal").hidden = true; }

// Return to the landing page (e.g. clicking the brand).
function goHome() {
  closeAllPips(false);
  hideHoverCard();
  dismissCoach();
  resetState();
  $("#topbar").hidden = true;
  $("#reader").hidden = true;
  $("#sidebar").hidden = true;
  $("#landing").hidden = false;
  if (location.search) history.replaceState(null, "", location.pathname); // drop ?pdf= so refresh stays home
  $("#landing").scrollTop = 0;
}

// allow ?pdf=URL deep links
function bootFromQuery() {
  const u = new URLSearchParams(location.search).get("pdf");
  if (u) loadDocument({ url: u, withCredentials: false }, u.split("/").pop() || "remote.pdf");
}

wireUI();
bootFromQuery();
// signal a successful start so the HTML fallback banner stays hidden
window.__hoverleafReady = true;
