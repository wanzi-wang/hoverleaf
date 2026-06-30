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
function kindLabel(kind) {
  return kind === "table" ? "Table" : kind === "equation" ? "Equation" : "Figure";
}
function countKinds() {
  const c = { figure: 0, table: 0, equation: 0 };
  for (const ex of State.exhibits.values()) c[ex.kind] = (c[ex.kind] || 0) + 1;
  return c;
}

/* =====================================================================
   STEP 1 — Build a geometric text model for one page
   ===================================================================== */
// Median angle (deg) of the text on a page under a given viewport. ~0 means the
// text reads horizontally; ~±90 means the page content is sideways (landscape
// tables typeset with LaTeX \begin{landscape}, very common in economics).
function medianTextAngle(items, vp) {
  const angs = [];
  for (const it of items) {
    if (!it.str || it.str.trim().length < 2) continue;
    const tx = Util.transform(vp.transform, it.transform);
    angs.push(Math.atan2(tx[1], tx[0]) * 180 / Math.PI);
    if (angs.length >= 240) break;
  }
  if (!angs.length) return 0;
  angs.sort((a, b) => a - b);
  return angs[angs.length >> 1];
}

async function buildPageModel(pageNum) {
  if (State.pageModel.has(pageNum)) return State.pageModel.get(pageNum);
  const page = await getPage(pageNum);
  const tc = await page.getTextContent();

  // Normalise rotation: choose the viewport rotation that makes text horizontal,
  // so every downstream step (lines, captions, regions, rendering) sees an
  // upright page — and sideways tables preview the right way up.
  let rotation = 0;
  let vp = page.getViewport({ scale: 1 });
  if (Math.abs(medianTextAngle(tc.items, vp)) > 30) {
    for (const r of [90, 270, 180]) {
      const vpr = page.getViewport({ scale: 1, rotation: r });
      if (Math.abs(medianTextAngle(tc.items, vpr)) < 15) { rotation = r; vp = vpr; break; }
    }
  }

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
  // a rotated (landscape) page is a single full-width exhibit, never 2-column text
  const columns = rotation ? [{ x0: 0, x1: vp.width }] : detectColumns(items, vp.width);
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
    wpt: vp.width, hpt: vp.height, items, lines, columns, rotation,
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
  const rotation = (State.pageModel.get(pageNum) || {}).rotation || 0;
  const vp = page.getViewport({ scale: 1, rotation });
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
// The decisive signal is what immediately follows the number:
//   "Table 2—Effect…" / "Figure 1a. Animal herds graze…"  → caption (terminator + Title)
//   "TABLE 1" alone on a line (Econometrica/AER style)     → caption (bare label)
//   "Figure 3 shows…" / "Figure 2, which…"                 → prose (lowercase word / comma)
// Returns {score, title}.
function scoreCaption(rest, labelWord) {
  const r = rest.replace(/^\s+/, "");
  const c0 = r[0] || "";
  const allCaps = /^(TABLE|FIGURE|FIG|TAB)\.?$/.test(labelWord); // journal-style caps label
  let score = 0;
  if (c0 === "") score += allCaps ? 5 : 3;                          // bare label on its own line
  else if (c0 === ":" || c0 === "—" || c0 === "–") score += 4;      // strong caption markers
  else if (c0 === "." || c0 === ")")                               // label terminator …
    score += /^[.)]\s*([A-Z(]|$)/.test(r) ? 3 : 1;                 // … if followed by a Title or end
  else if (/^[A-Z(]/.test(c0)) score += allCaps ? 3 : 1;           // "Figure 1 Title" / "TABLE 2Continued"
  else return { score: -10, title: "" };                           // comma / lowercase word → prose
  if (allCaps) score += 1;                                          // all-caps label is a strong signal

  const title = r.replace(/^[\s:.—–)\-]+/, "").trim();
  // citing another exhibit hints at prose, but only override a weak score
  if (score < 5 && /\b(figures?|figs?\.?|tables?|tabs?\.?|panels?)\s*\.?\s*\d/i.test(title)) score -= 3;
  if (/^[A-Z]/.test(title)) score += 1;
  return { score, title: title.slice(0, 140) };
}

function isCaptionLine(txt) {
  const m = txt.match(CAPTION_RE);
  if (!m) return null;
  const { score, title } = scoreCaption(m[3], m[1]);
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
    for (let li = 0; li < model.lines.length; li++) {
      const line = model.lines[li];
      const hit = isCaptionLine(lineText(line));
      if (!hit) continue;
      const key = exhibitKey(hit.kind, hit.id);
      const capLeft = Math.min(...line.items.map((i) => i.x));
      const capRight = Math.max(...line.items.map((i) => i.x + i.w));
      const cap = { top: line.y, bottom: line.y + line.h, left: capLeft, right: capRight };
      // pick a human title: the same-line text if it reads like prose, else the
      // next line (Econometrica-style "TABLE 1" with the title beneath it)
      const titleOk = (t) => !!t && /^[A-Za-z]/.test(t) && t.replace(/[^A-Za-z]/g, "").length / t.length > 0.45;
      let title = titleOk(hit.title) ? hit.title : "";
      if (!title) {
        const next = model.lines[li + 1];
        if (next && next.col === line.col && next.y - line.y < line.h * 2.4) {
          const nt = lineText(next).trim();
          if (titleOk(nt) && !isCaptionLine(nt) && !NOTE_RE.test(nt)) title = nt.slice(0, 140);
        }
      }
      // bias slightly toward later pages (exhibits usually live at the back)
      const score = hit.score + p / Math.max(1, State.numPages);
      const prev = candidates.get(key);
      if (prev && prev.score >= score) continue;
      candidates.set(key, { key, kind: hit.kind, id: normId(hit.id), page: p, cap, title, score });
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
  const byPage = new Map(); // only figure/table captions act as walls
  for (const ex of State.exhibits.values()) {
    if (ex.kind === "equation") continue;
    if (!byPage.has(ex.page)) byPage.set(ex.page, []);
    byPage.get(ex.page).push(ex.cap);
  }
  for (const ex of State.exhibits.values()) {
    if (ex.kind === "equation") continue; // equation regions are computed at detection time
    const model = State.pageModel.get(ex.page);
    const siblings = (byPage.get(ex.page) || []).filter((c) => c !== ex.cap);
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
   STEP 2b — Numbered equations / specifications
   A displayed equation ends with a right-aligned number, e.g.  …β₁xᵢ+εᵢ   (3).
   We find the right-aligned "(N)" marker and crop the equation block to its left.
   ===================================================================== */
const MATH_RE = /[=≥≤≠±×÷·∑∏∫∈∉∀∃∞√∂∇βγδεζηθϑικλμνξπρςστυφχψω]/;

function detectEquations() {
  for (let p = 1; p <= State.numPages; p++) {
    const model = State.pageModel.get(p);
    if (!model) continue;
    const W = model.wpt;
    for (let li = 0; li < model.lines.length; li++) {
      const line = model.lines[li];
      const its = line.items;
      if (!its.length) continue;
      const cx = (its[0].x + its[its.length - 1].x + its[its.length - 1].w) / 2;
      const col = (model.columns || [{ x0: 0, x1: W }]).find((c) => cx >= c.x0 && cx < c.x1) || { x0: 0, x1: W };
      const last = its[its.length - 1];
      if (last.x + last.w < col.x1 - 0.16 * W) continue;            // number not at the right margin

      // the line ends with a right-aligned "(N)" …
      const t = lineText(line);
      const tm = t.match(/\((\d{1,3}[a-z]?|[A-Z]\.?\d{1,3}[a-z]?)\)\s*$/);
      if (!tm) continue;
      // … and it's a real equation (math content), not prose ending in "(3)"
      const isMath = its.length === 1 || MATH_RE.test(t.slice(0, tm.index));
      if (!isMath) continue;
      if (isCaptionLine(t) || NOTE_RE.test(t)) continue;
      if ((t.match(/\(\s*\d{1,3}[a-z]?\s*\)/g) || []).length > 1) continue; // "(1) (2) (3)" header row
      const id = tm[1];
      const key = `equation-${normId(id)}`;
      if (State.exhibits.has(key)) continue;                        // first occurrence wins

      const capLeft = Math.min(...its.map((i) => i.x)), capRight = Math.max(...its.map((i) => i.x + i.w));
      State.exhibits.set(key, {
        key, kind: "equation", id: normId(id), page: p, title: "",
        cap: { top: line.y, bottom: line.y + line.h, left: capLeft, right: capRight },
        region: equationRegion(line, model, col),
      });
    }
  }
  // re-sort the exhibit rail to include equations in document order
  State.exhibitOrder = [...State.exhibits.keys()].sort((a, b) => {
    const A = State.exhibits.get(a), B = State.exhibits.get(b);
    return A.page - B.page || A.cap.top - B.cap.top;
  });
}

// Crop band for an equation: the marker line plus any tightly-spaced rows above
// (multi-line displays), full column width.
function equationRegion(markerLine, model, col) {
  const H = model.hpt, pad = H * 0.006, lh = markerLine.h || 10;
  const colLines = model.lines
    .filter((l) => { const cx = l.items.length ? (l.items[0].x + l.items[l.items.length - 1].x + l.items[l.items.length - 1].w) / 2 : -1; return cx >= col.x0 && cx < col.x1; })
    .sort((a, b) => a.y - b.y);
  const colW = col.x1 - col.x0;
  // display equations are centred/indented; prose starts at the left text margin.
  // A line that begins at the margin (and isn't tiny) bounds the equation block.
  const isProse = (l) => {
    const left = Math.min(...l.items.map((i) => i.x));
    const lw = Math.max(...l.items.map((i) => i.x + i.w)) - left;
    return left < model.content.left + colW * 0.08 && lw > colW * 0.4;
  };
  const idx = colLines.indexOf(markerLine);
  let top = markerLine.y, bot = markerLine.y + markerLine.h;
  for (let i = idx - 1; i >= 0 && idx - i <= 4; i--) { const gap = top - (colLines[i].y + colLines[i].h); if (gap > lh * 1.7 || isProse(colLines[i])) break; top = colLines[i].y; }
  for (let i = idx + 1; i < colLines.length && i - idx <= 2; i++) { const gap = colLines[i].y - bot; if (gap > lh * 1.7 || isProse(colLines[i])) break; bot = colLines[i].y + colLines[i].h; }
  top = clamp(top - pad - lh * 0.3, 0, H); bot = clamp(bot + pad, 0, H);
  return { x: col.x0, y: top, w: col.x1 - col.x0, h: bot - top };
}

/* =====================================================================
   STEP 3 — In-text reference detection
   ===================================================================== */
const REF_HEAD = /(figures?|figs?\.?|tables?|tabs?\.?)\s*\.?\s*([A-Za-z]{0,3}\.?\d+[A-Za-z]?)/gi;
const EQ_HEAD = /(equations?|eqs?\.?|eqn\.?|expressions?|specifications?|specs?\.?)\s*\.?\s*\(?(\d{1,3}[a-z]?|[A-Z]\.?\d{1,3}[a-z]?)\)?/gi;
const EQ_TAIL = /^(\s*(?:,|;|and|&|or)\s*(?:and\s*)?)\(?(\d{1,3}[a-z]?)\)?\b/i;
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

    // equation / specification references: "equation (3)", "Eq. 4", "specifications (1) and (2)"
    EQ_HEAD.lastIndex = 0;
    let e;
    while ((e = EQ_HEAD.exec(text))) {
      const idStart = e.index + e[0].length - e[2].length - (e[0].endsWith(")") ? 1 : 0);
      const idEnd = e.index + e[0].length;
      addRef(model, map, p, "equation", e[2], idStart, idEnd, e.index);
      let cursor = idEnd, guard = 0;
      while (guard++ < 12) {
        const tail = text.slice(cursor).match(EQ_TAIL);
        if (!tail) break;
        const tStart = cursor + tail[1].length + (tail[0].slice(tail[1].length).startsWith("(") ? 1 : 0);
        const tEnd = tStart + tail[2].length;
        addRef(model, map, p, "equation", tail[2], tStart, tEnd, tStart);
        cursor = cursor + tail[0].length;
      }
      EQ_HEAD.lastIndex = Math.max(EQ_HEAD.lastIndex, cursor);
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
  const vp = page.getViewport({ scale: scale * dpr, rotation: model.rotation || 0 });

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
      ? `Preview ${kindLabel(ex.kind)} ${ex.id}${ex.title ? ", " + ex.title : ""}`
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
  const rotation = (State.pageModel.get(ex.page) || {}).rotation || 0;
  const vp = page.getViewport({ scale: scale * dpr, rotation });
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
    `${kindLabel(ex.kind)} ${ex.id}${ex.title ? " · " + ex.title : ""}`;
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
  tpl.setAttribute("aria-label", `${kindLabel(ex.kind)} ${ex.id} preview`);
  tpl._opener = opener || null;
  $(".pip-title", tpl).textContent =
    `${kindLabel(ex.kind)} ${ex.id} (p.${ex.page})`;
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
   TOP NAV — uppercase exhibit-type navigation with live counts
   ===================================================================== */
let currentFilter = "all";
function buildTopnav() {
  const nav = $("#topnav");
  const c = countKinds();
  const items = [{ f: "all", label: "All" }];
  if (c.figure) items.push({ f: "figure", label: "Figures", n: c.figure });
  if (c.table) items.push({ f: "table", label: "Tables", n: c.table });
  if (c.equation) items.push({ f: "equation", label: "Equations", n: c.equation });
  nav.innerHTML = "";
  items.forEach((it, i) => {
    if (i) nav.insertAdjacentHTML("beforeend", `<span class="nav-dot">·</span>`);
    const b = document.createElement("button");
    b.dataset.nav = it.f;
    b.innerHTML = `<span>${it.label}</span>${it.n ? `<span class="nav-count">${it.n}</span>` : ""}`;
    b.onclick = () => setFilter(it.f);
    nav.appendChild(b);
  });
  if (State.exhibitOrder.length) {
    nav.insertAdjacentHTML("beforeend", `<span class="nav-dot">·</span>`);
    const ov = document.createElement("button");
    ov.className = "nav-ov";
    ov.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg><span>Overview</span>`;
    ov.onclick = openOverview;
    nav.appendChild(ov);
  }
  syncNav();
}
function syncNav() {
  $$("#topnav button[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === currentFilter));
}
function setFilter(kind) {
  currentFilter = kind;
  syncNav();
  const titles = { all: "All exhibits", figure: "Figures", table: "Tables", equation: "Equations" };
  $("#sideTitle").textContent = titles[kind] || "Exhibits";
  if ($("#sidebar").hidden) $("#sidebar").hidden = false;
  buildSidebar(kind);
}

/* =====================================================================
   OVERVIEW — a visual dashboard of the whole paper
   ===================================================================== */
function refCounts() {
  const m = new Map();
  for (const r of State.refs) { if (resolveExhibit(r.key)) m.set(r.key, (m.get(r.key) || 0) + 1); }
  return m;
}
function kColor(kind) {
  return getComputedStyle(document.documentElement).getPropertyValue("--c-" + kind).trim() || "#888";
}

function openOverview() {
  const c = countKinds();
  const total = c.figure + c.table + c.equation;
  const refs = refCounts();
  const totalRefs = [...refs.values()].reduce((a, b) => a + b, 0);
  $("#ovDoc").textContent = State.filename;

  const stat = (v, l) => `<div class="ov-stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const stats = `<div class="ov-stats">
    ${stat(State.numPages, "pages")}
    ${stat(total, "exhibits")}
    ${stat(c.figure, "figures")}
    ${stat(c.table, "tables")}
    ${stat(c.equation, "equations")}
    ${stat(totalRefs, "links")}
  </div>`;

  const segs = [
    { k: "figure", label: "Figures", v: c.figure }, { k: "table", label: "Tables", v: c.table },
    { k: "equation", label: "Equations", v: c.equation },
  ].filter((s) => s.v);
  const donut = `<section class="ov-sec"><h4>Composition</h4>
    <div class="ov-donut">${donutSVG(segs, total)}
      <div class="ov-legend">${segs.map((s) => `<div class="ov-leg"><span class="sw" style="background:${kColor(s.k)}"></span><span class="lk">${s.label}</span><span class="lv">${s.v}</span><span class="lp">${Math.round(s.v / total * 100)}%</span></div>`).join("")}</div>
    </div></section>`;

  const map = `<section class="ov-sec wide"><h4>Where everything lives <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink-faint)">— click a marker to jump</span></h4>${mapSVG()}</section>`;

  const top = [...refs.entries()].map(([k, n]) => ({ ex: resolveExhibit(k), n }))
    .filter((x) => x.ex).sort((a, b) => b.n - a.n).slice(0, 8);
  const max = top.length ? top[0].n : 1;
  const bars = `<section class="ov-sec wide"><h4>Most-referenced exhibits</h4>${
    top.length ? `<div class="ov-bars">${top.map((x) => `<div class="ov-bar" data-jump="${x.ex.key}"><span class="ov-bar-lab">${kindLabel(x.ex.kind)} ${x.ex.id}</span><span class="ov-bar-track"><span class="ov-bar-fill" style="width:${x.n / max * 100}%;background:${kColor(x.ex.kind)}"></span></span><span class="ov-bar-n">${x.n}</span></div>`).join("")}</div>`
      : `<div class="ov-empty">No in-text references were detected.</div>`}</section>`;

  $("#ovBody").innerHTML = stats + `<div class="ov-grid">${donut}${map}${bars}</div>`;
  $$("#ovBody [data-jump]").forEach((el) => el.onclick = () => {
    const ex = State.exhibits.get(el.dataset.jump); if (!ex) return;
    closeOverview(); scrollToExhibit(ex); openPip(ex);
  });
  $$("#ovBody .ov-dot").forEach((el) => el.onclick = () => {
    const ex = State.exhibits.get(el.dataset.key); if (!ex) return;
    closeOverview(); scrollToExhibit(ex); openPip(ex);
  });
  $("#overview").hidden = false;
}
function closeOverview() { $("#overview").hidden = true; }

function donutSVG(segs, total) {
  const cx = 66, cy = 66, r = 50, sw = 22, C = 2 * Math.PI * r;
  let off = 0, arcs = "";
  for (const s of segs) {
    const len = (s.v / (total || 1)) * C;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${kColor(s.k)}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += len;
  }
  return `<svg class="donut" viewBox="0 0 132 132" role="img" aria-label="Exhibit composition">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-sunken)" stroke-width="${sw}"/>
    ${arcs}<text class="donut-num" x="66" y="70">${total}</text><text class="donut-lab" x="66" y="86">exhibits</text></svg>`;
}

function mapSVG() {
  const W = 1000, lanes = [["figure", "Fig"], ["table", "Tab"], ["equation", "Eq"]].filter(([k]) => countKinds()[k]);
  const padL = 44, padR = 16, top = 8, laneH = 30, H = top + lanes.length * laneH + 22;
  const N = Math.max(1, State.numPages);
  const xOf = (pg) => padL + (N === 1 ? 0.5 : (pg - 1) / (N - 1)) * (W - padL - padR);
  let svg = `<svg class="ov-map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Exhibit positions by page">`;
  lanes.forEach(([k, lab], i) => {
    const y = top + i * laneH + laneH / 2;
    svg += `<line class="axis" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
    svg += `<text class="lane-lab" x="6" y="${y + 3}">${lab}</text>`;
    for (const key of State.exhibitOrder) {
      const ex = State.exhibits.get(key);
      if (ex.kind !== k) continue;
      svg += `<circle class="ov-dot" data-key="${key}" cx="${xOf(ex.page).toFixed(1)}" cy="${y}" r="4.5" fill="${kColor(k)}"><title>${kindLabel(k)} ${ex.id} — page ${ex.page}</title></circle>`;
    }
  });
  const axisY = H - 12;
  svg += `<text x="${padL}" y="${axisY}" text-anchor="start">p.1</text><text x="${W - padR}" y="${axisY}" text-anchor="end">p.${N}</text>`;
  svg += `</svg>`;
  return svg;
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
        <div class="exhibit-kind ${ex.kind}">${kindLabel(ex.kind)} ${ex.id}</div>
        <div class="exhibit-cap">${ex.title ? escapeHtml(ex.title) : (ex.kind === "equation" ? "numbered equation" : "<i>untitled</i>")}</div>
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
   Resolve a pasted link to a *direct* PDF URL.
   Users usually paste the abstract/landing page, not the PDF itself.
   Returns { url, label, hint }. `hint` (if set) explains a known problem
   before we even try the fetch.
   ===================================================================== */
function resolvePdfUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { url: raw, label: raw }; }
  const host = u.hostname.replace(/^www\./, "");
  const file = (p) => p.split("/").filter(Boolean).pop() || "remote.pdf";

  // arXiv: /abs/ID or /pdf/ID(vN) → the CORS-enabled PDF endpoint (works in-browser)
  if (host.endsWith("arxiv.org")) {
    const m = u.pathname.match(/\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/);
    if (m) { const id = m[1]; return { url: `https://arxiv.org/pdf/${id}`, label: `arXiv ${id}.pdf` }; }
  }

  // NBER: /papers/wNNNNN → direct PDF (NBER sends no CORS header, so warn it'll likely be blocked)
  if (host.endsWith("nber.org")) {
    const m = u.pathname.match(/\/papers\/(w\d+)/i);
    if (m) {
      const id = m[1].toLowerCase();
      return {
        url: `https://www.nber.org/system/files/working_papers/${id}/${id}.pdf`,
        label: `NBER ${id}.pdf`,
        hint: "NBER doesn't allow other sites to fetch its PDFs (no CORS). If this fails, download the PDF and drop it here.",
      };
    }
  }

  // SSRN abstract page is HTML, and the real download is session-gated — can't be fetched directly.
  if (host.endsWith("ssrn.com") && /papers\.cfm/i.test(u.pathname) && u.searchParams.get("abstract_id"))
    return { url: raw, label: "SSRN paper", hint: "That's the SSRN abstract page, not a PDF — and SSRN gates the download behind a session. Click \"Download This Paper\" on SSRN, then drop the file here." };

  // AEA: pdfplus is behind the subscription paywall and sends no CORS header.
  if (host.endsWith("aeaweb.org") && /\/doi\/(pdf|pdfplus)\//i.test(u.pathname))
    return { url: raw, label: file(u.pathname), hint: "AEA articles are paywalled and can't be fetched from another site. Open it on aeaweb.org, download the PDF, and drop it here." };

  return { url: raw, label: file(u.pathname) };
}

// Resolve a link then hand off to loadDocument, surfacing any up-front hint.
function loadFromLink(raw) {
  const { url, label, hint } = resolvePdfUrl(raw);
  if (hint) toast(hint, 7000);
  loadDocument({ url, withCredentials: false }, label);
}

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

    setLoading(true, "Finding figures, tables & equations…", 0.86);
    detectExhibits();
    detectEquations();
    await computeRegions();
    detectReferences();
    if (location.search.includes("debug")) window.__ep = { State, computeRegion, isCaptionLine, lineText, getPageGraphics, renderRegion };

    setLoading(true, "Laying out…", 0.95);
    enterReader();
    setLoading(false);

    let textItems = 0;
    for (const m of State.pageModel.values()) textItems += m.items.length;
    const hasText = textItems > State.numPages * 8; // ~real text layer vs. scanned
    if (!State.exhibitOrder.length)
      toast(hasText
        ? "No figure/table captions matched here — you can still read the PDF, but inline previews aren't available for this one."
        : "This PDF has no text layer (it looks scanned), so figures and references can't be detected.", 6500);
    else {
      const c = countKinds();
      const parts = [];
      if (c.figure) parts.push(`${c.figure} figure${c.figure !== 1 ? "s" : ""}`);
      if (c.table) parts.push(`${c.table} table${c.table !== 1 ? "s" : ""}`);
      if (c.equation) parts.push(`${c.equation} equation${c.equation !== 1 ? "s" : ""}`);
      toast(`Found ${parts.join(", ")}. Hover any reference to preview.`, 4200);
    }
  } catch (err) {
    console.error(err);
    setLoading(false);
    $("#landing").hidden = false;
    const remote = typeof source === "object" && source.url;
    const corsLike = /cors|networkerror|cross-origin|access-control|unexpected/i.test(err.message || "") || err.name === "UnexpectedResponseException";
    if (remote && err.name === "InvalidPDFException")
      toast("That link returned a web page, not a PDF. Paste the direct PDF link (the one ending in .pdf), or download it and drop the file here.", 7000);
    else if (err.name === "InvalidPDFException")
      toast("That file doesn't look like a valid PDF.", 5000);
    else if (remote && corsLike)
      toast("That site blocks loading PDFs from other pages. Download the file and drop it here instead.", 6500);
    else if (remote)
      toast("Couldn't fetch that link (the site may block it or require a login). Download the PDF and drop it here instead.", 6500);
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
  buildTopnav();
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
  const SUN = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    $("#btnTheme").innerHTML = t === "dark" ? SUN : MOON;
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
  $("#urlForm").onsubmit = (e) => { e.preventDefault(); const u = $("#urlInput").value.trim(); if (u) loadFromLink(u); };

  // zoom + page
  $("#btnZoomIn").onclick = () => setZoom(State.zoom + 0.15);
  $("#btnZoomOut").onclick = () => setZoom(State.zoom - 0.15);
  $("#pageInput").onchange = (e) => goToPage(+e.target.value);
  $("#viewerScroll") && ($("#viewerScroll").addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(State.zoom + (e.deltaY < 0 ? 0.12 : -0.12)); }
  }, { passive: false }));

  // sidebar toggle + overview
  $("#btnSidebar").onclick = () => { const s = $("#sidebar"); s.hidden = !s.hidden; };
  $("#btnOverview2").onclick = openOverview;
  $$("[data-ovclose]").forEach((el) => (el.onclick = closeOverview));

  // keyboard
  $("#coachDismiss").onclick = dismissCoach;
  $("#btnHome").onclick = goHome;
  $("#btnFeedback").onclick = openFeedback;
  $("#btnFeedback2").onclick = openFeedback;
  $$("[data-fbclose]").forEach((el) => (el.onclick = closeFeedback));

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input")) return;
    if (e.key === "Escape") { if (!$("#overview").hidden) closeOverview(); else if (!$("#fbModal").hidden) closeFeedback(); else if (openPips.size) closeAllPips(true); else { hideHoverCard(); dismissCoach(); } }
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
  if (u) loadFromLink(u);
}

wireUI();
bootFromQuery();
// signal a successful start so the HTML fallback banner stays hidden
window.__hoverleafReady = true;
