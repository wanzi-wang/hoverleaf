/* =====================================================================
   Enjoyable Paper — app.js
   Read economics papers without flipping to the back for every exhibit.

   Pipeline:
     1. Load PDF (pdf.js, fully client-side).
     2. Scan every page's text → build an "exhibit index" (Figure/Table
        captions: which page, where on the page).
     3. Scan text again → find in-text references ("see Table 3") and lay
        transparent clickable hot-spots over them.
     4. Hover a reference → preview card; click → pinnable floating window.
   ===================================================================== */
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

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

  // group items into visual lines (by vertical position)
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) < last.h * 0.7) {
      last.items.push(it);
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
      last.h = Math.max(last.h, it.h);
    } else {
      lines.push({ y: it.y, h: it.h, items: [it] });
    }
  }
  for (const ln of lines) ln.items.sort((a, b) => a.x - b.x);

  const model = {
    wpt: vp.width, hpt: vp.height, items, lines,
    content: { top: cTop, bottom: cBottom, left: cLeft, right: cRight },
  };
  State.pageModel.set(pageNum, model);
  return model;
}

/* =====================================================================
   STEP 2 — Caption / exhibit detection
   ===================================================================== */
const CAPTION_RE =
  /^\s*(figures?|figs?\.?|tables?|tabs?\.?)\s*\.?\s*([A-Za-z]?\.?\d+[A-Za-z]?)\b([\s\S]*)$/i;
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
  if (/\b(is|are|was|were|be|been|shows?|reports?|presents?|displays?|summari[sz]ed|documented|provides?|reveals?|suggests?|indicates?|implies?|we|our|this|these|which|that)\b/i.test(title))
    score -= 4;                                                      // finite verb / pronoun → prose
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
      candidates.set(key, {
        key, kind: hit.kind, id: normId(hit.id), page: p, cap,
        title: hit.title, score, region: computeRegion(hit.kind, cap, model),
      });
    }
  }

  for (const ex of candidates.values()) State.exhibits.set(ex.key, ex);
  State.exhibitOrder = [...State.exhibits.keys()].sort((a, b) => {
    const A = State.exhibits.get(a), B = State.exhibits.get(b);
    return A.page - B.page || A.cap.top - B.cap.top;
  });
}

// Region (in scale-1 page coords) we crop for a preview. Figures put their
// graphic above OR below the caption (and the graphic is an image, invisible to
// the text layer), so we extend generously on both sides and let neighbouring
// captions / "Notes:" lines bound the crop. Works regardless of caption side.
function computeRegion(kind, cap, model) {
  const H = model.hpt, W = model.wpt, c = model.content, pad = H * 0.012;
  const up = kind === "figure" ? 0.55 : 0.06;
  const down = kind === "figure" ? 0.55 : 0.60;
  let y0 = cap.top - up * H;
  let y1 = cap.bottom + down * H;

  // nearest boundary (another caption or a Notes/Source line) above and below
  let boundAbove = -Infinity, boundBelow = Infinity;
  for (const line of model.lines) {
    const t = lineText(line);
    if (!isCaptionLine(t) && !NOTE_RE.test(t)) continue;
    const top = line.y, bot = line.y + line.h;
    if (bot > cap.top - 1 && top < cap.bottom + 1) continue; // the caption itself
    if (bot <= cap.top + 1) boundAbove = Math.max(boundAbove, bot);
    else if (top >= cap.bottom - 1) boundBelow = Math.min(boundBelow, top);
  }
  if (boundAbove > -Infinity) y0 = Math.max(y0, boundAbove + pad);
  if (boundBelow < Infinity) y1 = Math.min(y1, boundBelow - pad);

  // clamp to actual content + margins, then to the page
  y0 = clamp(y0, Math.max(0, c.top - pad), H);
  y1 = clamp(y1, 0, Math.min(H, c.bottom + pad));
  if (y1 - y0 < H * 0.08) { y0 = clamp(cap.top - 0.06 * H, 0, H); y1 = clamp(cap.bottom + 0.3 * H, 0, H); }
  return { x: 0, y: y0, w: W, h: y1 - y0 };
}

/* =====================================================================
   STEP 3 — In-text reference detection
   ===================================================================== */
const REF_HEAD = /(figures?|figs?\.?|tables?|tabs?\.?)\s*\.?\s*([A-Za-z]?\.?\d+[A-Za-z]?)/gi;
const REF_TAIL = /^(\s*(?:,|;|and|&|or|to|through|–|—|-)\s*(?:and\s*)?)([A-Za-z]?\.?\d+[A-Za-z]?)\b/i;

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
        if (en.isIntersecting) renderPage(+en.target.dataset.page);
      }
    },
    { root: $("#viewerScroll"), rootMargin: "600px 0px" }
  );
  for (const { wrap } of State.pageEls.values()) pageObserver.observe(wrap);
}

async function renderPage(p) {
  const el = State.pageEls.get(p);
  if (!el || el.rendered) return;
  el.rendered = true;
  const page = await getPage(p);
  const model = State.pageModel.get(p);
  const scale = renderScale();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
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
    const ex = State.exhibits.get(ref.key);
    for (const b of ref.boxes) {
      const a = document.createElement("div");
      a.className = "ref-link";
      a.style.left = `${b.x * scale}px`;
      a.style.top = `${b.y * scale}px`;
      a.style.width = `${b.w * scale}px`;
      a.style.height = `${b.h * scale}px`;
      a.dataset.key = ref.key;
      if (!ex) { a.style.opacity = ".45"; a.title = `${ref.key} — caption not found`; }
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
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
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
  el.addEventListener("mouseenter", () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showHoverCard(el, key), 130);
  });
  el.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    hideHoverCard();
  });
  el.addEventListener("click", (e) => {
    e.preventDefault();
    hideHoverCard();
    const ex = State.exhibits.get(key);
    if (!ex) { jumpToText(key); return; }
    openPip(ex, e.clientX, e.clientY);
  });
}

async function showHoverCard(anchor, key) {
  const ex = State.exhibits.get(key);
  if (!ex) return;
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

async function openPip(ex, x, y) {
  if (openPips.has(ex.key)) { focusPip(openPips.get(ex.key)); return; }
  const tpl = $("#pipTemplate").content.firstElementChild.cloneNode(true);
  tpl.dataset.key = ex.key;
  tpl.style.zIndex = ++pipZ;
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
  tpl.addEventListener("mousedown", () => focusPip(tpl));
  focusPip(tpl);
}
function focusPip(el) { el.style.zIndex = ++pipZ; el.focus({ preventScroll: true }); }
function closePip(key) { const el = openPips.get(key); if (el) { el.remove(); openPips.delete(key); } }
function closeAllPips(onlyUnpinned = true) {
  for (const [k, el] of [...openPips]) if (!onlyUnpinned || !el.classList.contains("pinned")) closePip(k);
}

function makeDraggable(el, handle) {
  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest(".pip-btn")) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const r = el.getBoundingClientRect();
    const move = (ev) => {
      el.style.left = `${clamp(r.left + ev.clientX - sx, -el.offsetWidth + 80, window.innerWidth - 80)}px`;
      el.style.top = `${clamp(r.top + ev.clientY - sy, 54, window.innerHeight - 40)}px`;
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
function makeResizable(el, grip, wrap, onDone) {
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX;
    const startW = el.offsetWidth;
    const move = (ev) => { el.style.width = `${clamp(startW + ev.clientX - sx, 240, 1400)}px`; };
    const up = async () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      await onDone(el.offsetWidth);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
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
    detectReferences();

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
    toast(`Couldn't open this PDF: ${err.message || err}`, 5000);
  }
}

function enterReader() {
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
  $("#sidebar").hidden = State.exhibitOrder.length === 0;
  updateZoomLabel();
  trackScroll();
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
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input")) return;
    if (e.key === "Escape") { if (openPips.size) closeAllPips(true); else hideHoverCard(); }
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
  State.pageCache.clear(); State.pageModel.clear();
  const url = URL.createObjectURL(file);
  loadDocument(url, file.name);
}

// allow ?pdf=URL deep links
function bootFromQuery() {
  const u = new URLSearchParams(location.search).get("pdf");
  if (u) loadDocument({ url: u, withCredentials: false }, u.split("/").pop() || "remote.pdf");
}

wireUI();
bootFromQuery();
