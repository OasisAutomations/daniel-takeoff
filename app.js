// Daniel Takeoff — everything stays on this device (IndexedDB). No uploads, no analytics.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import { propose as voicePropose, resolveQty as voiceResolve } from './voice.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
const VER = 'v1.2';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => { const n = parseFloat(String(v ?? '').replace(/[$,%\s]/g, '')); return isFinite(n) ? n : d; };
const COARSE = matchMedia('(pointer: coarse)').matches;
const PALETTE = ['#1f8a7e', '#2f6fb3', '#b5642b', '#8a4fb0', '#b23a48', '#5d8a2f', '#c49a1c', '#3d7f99', '#7a5c3e', '#4e5ab8'];
const TYPE_COLOR = { length: '#2f6fb3', area: '#1f8a7e', count: '#b5642b' };

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('daniel-takeoff', 1);
      r.onupgradeneeded = () => { const d = r.result; for (const s of ['projects', 'pdfs', 'products', 'templates', 'meta']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), q = fn(t.objectStore(store)); let out;
      if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(s, id) { return this.tx(s, 'readonly', st => st.get(id)); },
  all(s) { return this.tx(s, 'readonly', st => st.getAll()); },
  put(s, v) { return this.tx(s, 'readwrite', st => st.put(v)); },
  del(s, id) { return this.tx(s, 'readwrite', st => st.delete(id)); },
};

/* ---------- formatting ---------- */
function fmtFtIn(ft) {
  if (ft == null || !isFinite(ft)) return '—';
  const neg = ft < 0; ft = Math.abs(ft);
  const e8 = Math.round(ft * 96); let f = Math.floor(e8 / 96), rem = e8 - f * 96, inch = Math.floor(rem / 8), e = rem - inch * 8, frac = '';
  if (e) { let n = e, d = 8; while (n % 2 === 0) { n /= 2; d /= 2; } frac = ' ' + n + '/' + d; }
  return (neg ? '-' : '') + f + "'-" + inch + frac + '"';
}
const fmtN = (n, d = 2) => (n == null || !isFinite(n)) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt$ = n => (n < 0 ? '-$' : '$') + fmtN(Math.abs(n), 2);
// v1.2: length/area units keep 2 decimals; count-type units (EA, PAIR, SET, SHT…) show plain whole numbers (fractions only if real, e.g. 6.3)
const MEASURE_UNITS = new Set(['LF', 'SF', 'SY', 'SQ', 'CY', 'FT', 'LIN', 'M', 'M2']);
const isMeasureUnit = u => MEASURE_UNITS.has(String(u || '').toUpperCase());
const fmtQty = (q, unit) => (q == null || !isFinite(q)) ? '—' : isMeasureUnit(unit) ? fmtN(q, 2) : (Math.abs(q - Math.round(q)) < 1e-9 ? fmtN(Math.round(q), 0) : q.toLocaleString('en-US', { maximumFractionDigits: 2 }));
function parseInches(s) {   // "6", "6.5", "6 1/2", "1/2"
  s = String(s ?? '').trim().replace(/["”]|in(ch(es)?)?$/i, '').trim(); if (!s) return 0;
  let m = s.match(/^(\d+(?:\.\d+)?)?\s*(?:(\d+)\s*\/\s*(\d+))?$/); if (!m) return NaN;
  let v = m[1] ? parseFloat(m[1]) : 0; if (m[2]) v += parseInt(m[2]) / parseInt(m[3]); return v;
}

/* ---------- scales (ft per PDF point; 72 pt = 1 paper inch) ---------- */
const ARCH = [['1/32"', 1 / 32], ['1/16"', 1 / 16], ['3/32"', 3 / 32], ['1/8"', 1 / 8], ['3/16"', 3 / 16], ['1/4"', 1 / 4], ['3/8"', 3 / 8], ['1/2"', 1 / 2], ['3/4"', 3 / 4], ['1"', 1], ['1 1/2"', 1.5], ['3"', 3]];
const ENG = [10, 20, 30, 40, 50, 60, 100, 200];
const METRIC = [1, 5, 10, 20, 25, 50, 75, 100, 200, 250, 500, 1000];
const SCALES = [
  ...ARCH.map(([l, x]) => ({ group: 'Architectural', label: `${l} = 1'-0"`, ftPerPt: 1 / (x * 72) })),
  ...ENG.map(f => ({ group: 'Engineering', label: `1" = ${f}'`, ftPerPt: f / 72 })),
  ...METRIC.map(n => ({ group: 'Metric', label: `1:${n}`, ftPerPt: n / 864 })),
];
function nearPreset(ftPerPt) { const p = SCALES.find(s => Math.abs(s.ftPerPt - ftPerPt) / s.ftPerPt < 0.01); return p ? p.label : null; }

/* ---------- state ---------- */
const S = {
  project: null, products: [], templates: [], docs: new Map(),
  docId: null, pageNum: 1, page: null, W: 0, H: 0, z: 1, tx: 0, ty: 0, baseRes: 1, token: 0,
  tool: 'select', activeProductId: '', drawing: null, countId: null, selId: null, hover: null,
  undo: [], redo: [], view: 'plans', ckOpen: new Set(),
};
const prodById = id => S.products.find(p => p.id === id) || null;

/* ---------- UI helpers ---------- */
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms); }
function setSave(s) { $('#saveState').textContent = s; }
function openModal(html, mount, cls = '') {
  const back = $('#modalBack'), m = $('#modal'); m.className = cls; m.innerHTML = html; back.classList.remove('hidden');
  const close = () => { back.classList.add('hidden'); m.innerHTML = ''; };
  m.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  if (mount) mount(m, close);
  const f = m.querySelector('[autofocus]'); if (f) { f.focus(); f.select?.(); }
  return close;
}
function askText(title, label, value = '') {
  return new Promise(res => {
    openModal(`<h3>${esc(title)}</h3><form id="af"><div class="field"><label>${esc(label)}</label><input id="aval" value="${esc(value)}" autofocus></div>
      <div class="btns"><button type="button" data-close>Cancel</button><button class="accent">OK</button></div></form>`, (m, close) => {
      m.querySelector('[data-close]').onclick = () => { close(); res(null); };
      m.querySelector('#af').onsubmit = e => { e.preventDefault(); const v = m.querySelector('#aval').value.trim(); close(); res(v || null); };
    });
  });
}
function askConfirm(title, msg, okLabel = 'Delete') {
  return new Promise(res => {
    openModal(`<h3>${esc(title)}</h3><p>${msg}</p><div class="btns"><button id="cn">Cancel</button><button id="cy" class="accent">${esc(okLabel)}</button></div>`, (m, close) => {
      m.querySelector('#cn').onclick = () => { close(); res(false); };
      m.querySelector('#cy').onclick = () => { close(); res(true); };
    });
  });
}
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const safeName = s => String(s || 'project').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'project';

/* ---------- saving ---------- */
let saveT;
function touch() { if (!S.project) return; S.project.updated = Date.now(); setSave('Saving…'); clearTimeout(saveT); saveT = setTimeout(flush, 300); }
async function flush() { clearTimeout(saveT); if (!S.project) return; try { await DB.put('projects', S.project); setSave('Saved'); } catch (e) { setSave('Save failed'); console.warn(e); } }
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
window.addEventListener('pagehide', () => flush());
async function saveProduct(p) { await DB.put('products', p); }

/* ---------- projects ---------- */
function newProjectObj(name) {
  return { id: uid(), name, created: Date.now(), updated: Date.now(), docs: [], markups: [], scales: {}, checklist: [], manual: [], settings: { markupPct: 0, taxPct: 0, showPerim: true }, lastDoc: null, lastPage: 1 };
}
async function createProject(name) {
  const p = newProjectObj(name); await DB.put('projects', p); await openProject(p.id); return p;
}
async function openProject(id) {
  await flush();
  const p = await DB.get('projects', id); if (!p) return;
  p.settings ||= { markupPct: 0, taxPct: 0, showPerim: true }; p.manual ||= []; p.checklist ||= []; p.scales ||= {}; p.markups ||= [];
  for (const d of S.docs.values()) d.destroy?.();
  S.docs.clear(); S.project = p; S.undo = []; S.redo = []; S.selId = null; S.drawing = null; S.countId = null; S.page = null;
  await DB.put('meta', { id: 'last', projectId: id });
  $('#projName').textContent = p.name;
  const doc = p.docs.find(d => d.id === p.lastDoc) || p.docs[0];
  if (doc) await showPage(doc.id, p.lastPage || 1); else clearViewer();
  refreshDocSelect(); renderThumbs(); refreshAll();
}
async function deleteProject(id) {
  const p = await DB.get('projects', id); if (!p) return;
  for (const d of p.docs) await DB.del('pdfs', d.id);
  await DB.del('projects', id);
  if (S.project?.id === id) { S.project = null; clearViewer(); const rest = (await DB.all('projects')).sort((a, b) => b.updated - a.updated); if (rest[0]) await openProject(rest[0].id); else { $('#projName').textContent = 'No project'; refreshDocSelect(); renderThumbs(); refreshAll(); } }
}
async function projectsModal() {
  await flush();
  const list = (await DB.all('projects')).sort((a, b) => b.updated - a.updated);
  const rows = list.map(p => `<div class="prow ${p.id === S.project?.id ? 'on' : ''}" data-id="${p.id}">
      <span class="pn" data-act="open" title="Open">${esc(p.name)}<br><span class="muted small">${p.docs.length} PDF · ${p.markups.length} markups · ${new Date(p.updated).toLocaleDateString()}</span></span>
      <button class="small" data-act="rename">Rename</button><button class="small" data-act="backup">Backup</button><button class="small danger" data-act="delete">Delete</button></div>`).join('') || '<p class="muted">No projects yet.</p>';
  openModal(`<h3>Projects</h3><div class="plist">${rows}</div>
    <div class="btns"><button id="pmRestore">Restore backup…</button><button data-close>Close</button><button id="pmNew" class="accent">+ New project</button></div>
    <p class="muted small">Projects, plans and prices are stored only in this browser on this device. Use Backup to save a project (with its PDFs) as one file.</p>`, (m, close) => {
    m.querySelector('#pmNew').onclick = async () => { const n = await askText('New project', 'Project name', 'New project'); if (n) { await createProject(n); toast('Project created'); } };
    m.querySelector('#pmRestore').onclick = () => { close(); $('#fileBackup').click(); };
    m.querySelectorAll('.prow').forEach(r => r.onclick = async e => {
      const act = e.target.closest('[data-act]')?.dataset.act, id = r.dataset.id; if (!act) return;
      const p = list.find(x => x.id === id);
      if (act === 'open') { close(); await openProject(id); }
      if (act === 'rename') { const n = await askText('Rename project', 'Project name', p.name); if (n) { if (S.project?.id === id) { S.project.name = n; await flush(); $('#projName').textContent = n; refreshAll(); } else { p.name = n; await DB.put('projects', p); } } projectsModal(); }
      if (act === 'backup') { close(); await backupProject(id); }
      if (act === 'delete') { if (await askConfirm('Delete project?', `Delete <b>${esc(p.name)}</b> and its PDFs from this device? This can't be undone. (Make a backup first if you might need it.)`)) { await deleteProject(id); toast('Project deleted'); } projectsModal(); }
    });
  });
}

/* ---------- PDFs ---------- */
const PDF_OPTS = { cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/', isEvalSupported: false };
async function getPdf(docId) {
  if (S.docs.has(docId)) return S.docs.get(docId);
  const rec = await DB.get('pdfs', docId); if (!rec) throw new Error('PDF missing from this device');
  const d = await pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(rec.data.slice(0)) }).promise;
  S.docs.set(docId, d); return d;
}
async function addPdfFiles(files) {
  files = [...files].filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)); if (!files.length) return;
  if (!S.project) await createProject(files[0].name.replace(/\.pdf$/i, ''));
  let first = null;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const d = await pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf.slice(0)) }).promise;
      const id = uid(); await DB.put('pdfs', { id, name: f.name, data: buf });
      S.docs.set(id, d); S.project.docs.push({ id, name: f.name, pages: d.numPages }); first ||= id;
    } catch (e) { console.warn(e); toast(`Couldn't open ${f.name}`); }
  }
  await flush();
  if (first) { refreshDocSelect(); await showPage(first, 1); renderThumbs(); toast('PDF added'); }
}
async function removeCurrentPdf() {
  const P = S.project, d = P?.docs.find(x => x.id === S.docId); if (!d) return;
  const n = P.markups.filter(m => m.docId === d.id).length;
  if (!await askConfirm('Remove PDF?', `Remove <b>${esc(d.name)}</b> from this project${n ? ` along with its ${n} markups` : ''}?`, 'Remove')) return;
  P.markups = P.markups.filter(m => m.docId !== d.id); P.docs = P.docs.filter(x => x.id !== d.id);
  for (const k of Object.keys(P.scales)) if (k.startsWith(d.id + ':')) delete P.scales[k];
  S.docs.get(d.id)?.destroy?.(); S.docs.delete(d.id); await DB.del('pdfs', d.id); S.undo = []; S.redo = [];
  await flush(); refreshDocSelect();
  if (P.docs[0]) await showPage(P.docs[0].id, 1); else clearViewer();
  renderThumbs(); refreshAll();
}

/* ======================= VIEWER ======================= */
const viewer = $('#viewer'), stage = $('#stage'), baseC = $('#baseCanvas'), detC = $('#detailCanvas'), svg = $('#overlay');
const pageKey = (d = S.docId, p = S.pageNum) => d + ':' + p;
const curScale = () => S.project?.scales[pageKey()] || null;
const pageMarkups = () => (S.project?.markups || []).filter(m => m.docId === S.docId && m.page === S.pageNum);

function clearViewer() {
  S.page = null; S.docId = null; stage.style.display = 'none'; $('#empty').style.display = ''; $('#pageNav').style.display = 'none';
  svg.innerHTML = ''; updateScaleLabel(); refreshPanel();
}
async function showPage(docId, pageNum, fit = true) {
  const tok = ++S.token;
  const pdf = await getPdf(docId); pageNum = clamp(pageNum, 1, pdf.numPages);
  const page = await pdf.getPage(pageNum); if (tok !== S.token) return;
  cancelDrawing(); S.selId = null;
  S.docId = docId; S.pageNum = pageNum; S.page = page;
  const vp = page.getViewport({ scale: 1 }); S.W = vp.width; S.H = vp.height;
  for (const el of [stage, baseC]) { el.style.width = S.W + 'px'; el.style.height = S.H + 'px'; }
  svg.setAttribute('viewBox', `0 0 ${S.W} ${S.H}`); svg.setAttribute('width', S.W); svg.setAttribute('height', S.H);
  stage.style.display = ''; $('#empty').style.display = 'none'; $('#pageNav').style.display = '';
  detC.style.display = 'none';
  if (S.project) { S.project.lastDoc = docId; S.project.lastPage = pageNum; touch(); }
  $('#docSelect').value = docId;
  $('#pageLabel').textContent = `Page ${pageNum} / ${pdf.numPages}`;
  if (fit) fitPage(); else applyT();
  renderOverlay(); refreshPanel(); updateScaleLabel(); markThumb();
  await renderBase(tok);
}
let baseTask = null;
async function renderBase(tok) {
  const page = S.page; if (!page) return;
  const maxSide = COARSE ? 3072 : 4096;
  let b = Math.min(maxSide / Math.max(S.W, S.H), 3, Math.sqrt(14e6 / (S.W * S.H)));
  const vp = page.getViewport({ scale: b });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  try { baseTask?.cancel(); } catch { }
  baseTask = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
  try { await baseTask.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') return; throw e; }
  if (tok !== S.token) return;
  S.baseRes = b; baseC.width = c.width; baseC.height = c.height; baseC.getContext('2d').drawImage(c, 0, 0);
  scheduleDetail();
}
let detT = null, detTask = null;
function scheduleDetail() { clearTimeout(detT); detT = setTimeout(renderDetail, 180); }
async function renderDetail() {
  const page = S.page; if (!page) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5), sc = S.z * dpr;
  if (sc <= S.baseRes * 1.05) { detC.style.display = 'none'; return; }
  const vw = viewer.clientWidth, vh = viewer.clientHeight;
  const x0 = Math.max(0, -S.tx / S.z), y0 = Math.max(0, -S.ty / S.z), x1 = Math.min(S.W, (vw - S.tx) / S.z), y1 = Math.min(S.H, (vh - S.ty) / S.z);
  if (x1 <= x0 || y1 <= y0) return;
  const pw = Math.ceil((x1 - x0) * sc), ph = Math.ceil((y1 - y0) * sc); if (pw * ph > 20e6) return;
  const vp = page.getViewport({ scale: sc, offsetX: -x0 * sc, offsetY: -y0 * sc });
  const c = document.createElement('canvas'); c.width = pw; c.height = ph;
  try { detTask?.cancel(); } catch { }
  const tok = S.token; detTask = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
  try { await detTask.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') return; throw e; }
  if (tok !== S.token) return;
  detC.width = pw; detC.height = ph; detC.getContext('2d').drawImage(c, 0, 0);
  Object.assign(detC.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px', display: 'block' });
}
let ovRaf = 0;
function applyT() {
  stage.style.transform = `translate(${S.tx}px,${S.ty}px) scale(${S.z})`;
  $('#zoomLabel').textContent = Math.round(S.z * 75) + '%';   // 100% = real paper size (1pt = 1/72")
  scheduleDetail();
  if (!ovRaf) ovRaf = requestAnimationFrame(() => { ovRaf = 0; renderOverlay(); });
}
const fitZ = () => Math.min((viewer.clientWidth - 30) / S.W, (viewer.clientHeight - 30) / S.H);
function fitPage() { if (!S.W) return; S.z = fitZ(); S.tx = (viewer.clientWidth - S.W * S.z) / 2; S.ty = (viewer.clientHeight - S.H * S.z) / 2; applyT(); }
function zoomAt(f, sx, sy) {
  if (!S.page) return;
  const nz = clamp(S.z * f, fitZ() * 0.25, 60); const px = (sx - S.tx) / S.z, py = (sy - S.ty) / S.z;
  S.z = nz; S.tx = sx - px * nz; S.ty = sy - py * nz; applyT();
}
const toPage = (sx, sy) => [(sx - S.tx) / S.z, (sy - S.ty) / S.z];
const toScreen = (x, y) => { const r = viewer.getBoundingClientRect(); return [r.left + S.tx + x * S.z, r.top + S.ty + y * S.z]; };
new ResizeObserver(() => { if (S.page) scheduleDetail(); }).observe(viewer);

/* ---------- geometry & quantities ---------- */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polyLen = (pts, closed) => { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); if (closed && pts.length > 2) s += dist(pts[pts.length - 1], pts[0]); return s; };
const shoelace = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
function centroid(pts) {
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length], c = p[0] * q[1] - q[0] * p[1]; A += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c; }
  if (Math.abs(A) < 1e-9) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  return [cx / (3 * A), cy / (3 * A)];
}
function geo(m) {
  if (m.type === 'count') return { ea: m.pts.length };
  const k = S.project.scales[m.docId + ':' + m.page]?.ftPerPt; if (!k) return { noscale: true };
  if (m.type === 'length') { const lf = polyLen(m.pts) * k; return { lf, sf: m.height > 0 ? lf * m.height : null }; }
  return { sf: shoelace(m.pts) * k * k, lf: polyLen(m.pts, true) * k };
}
function qtyFor(m, prod) {   // quantity in the product's unit
  const g = geo(m); if (g.noscale) return null;
  const u = String(prod?.unit || '').toUpperCase(), mult = prod?.mult > 0 ? prod.mult : 1;
  if (m.type === 'count') return g.ea * mult;
  if (m.type === 'length') return (u !== 'LF' && g.sf != null ? g.sf : g.lf) * mult;   // wall height set → SF (unless product is LF)
  return (u === 'LF' ? g.lf : g.sf) * mult;
}
const nativeUnit = m => m.type === 'count' ? 'EA' : m.type === 'length' ? (m.height > 0 ? 'SF' : 'LF') : 'SF';
function valueText(m) {
  const g = geo(m); if (g.noscale) return 'set scale';
  if (m.type === 'count') return g.ea + ' EA';
  if (m.type === 'length') return fmtFtIn(g.lf) + (g.sf != null ? ` × ${fmtFtIn(m.height)} = ${fmtN(g.sf)} SF` : '');
  return fmtN(g.sf) + ' SF' + (S.project.settings.showPerim ? ` · P ${fmtFtIn(g.lf)}` : '');
}
const colorOf = m => prodById(m.productId)?.color || m.color || TYPE_COLOR[m.type];
const markName = m => { const p = prodById(m.productId); return (p ? p.name : ({ length: 'Length', area: 'Area', count: 'Count' }[m.type])) + (m.label ? ' – ' + m.label : ''); };

/* ---------- overlay ---------- */
function renderOverlay() {
  if (!S.page || !S.project) { svg.innerHTML = ''; return; }
  const z = S.z, fs = 12.5 / z, halo = 3.2 / z; let h = '';
  const txt = (x, y, s, col, anchor = 'middle') => `<text x="${x}" y="${y}" font-size="${fs}" fill="${col}" stroke-width="${halo}" text-anchor="${anchor}" dominant-baseline="middle">${esc(s)}</text>`;
  for (const m of pageMarkups()) {
    const c = colorOf(m), sel = m.id === S.selId || m.id === S.countId, sw = sel ? 4 : 2.6, P = m.pts.map(p => p.join(',')).join(' ');
    if (m.type === 'length') {
      if (sel) h += `<polyline points="${P}" fill="none" stroke="#fff" stroke-width="${sw + 3}" vector-effect="non-scaling-stroke" stroke-linejoin="round" opacity=".8"/>`;
      h += `<polyline points="${P}" fill="none" stroke="${c}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
      const e = m.pts[m.pts.length - 1]; h += txt(e[0] + 8 / z, e[1] - 10 / z, valueText(m), c, 'start');
    } else if (m.type === 'area') {
      h += `<polygon points="${P}" fill="${c}" fill-opacity=".2" stroke="${sel ? '#fff' : c}" stroke-width="${sel ? sw + 3 : sw}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
      if (sel) h += `<polygon points="${P}" fill="none" stroke="${c}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>`;
      const [cx, cy] = centroid(m.pts); h += txt(cx, cy, valueText(m), c);
    } else {
      const r = (sel ? 8.5 : 7) / z;
      m.pts.forEach((p, i) => { h += `<circle cx="${p[0]}" cy="${p[1]}" r="${r}" fill="${c}" stroke="#fff" stroke-width="${1.6 / z}"/><text x="${p[0]}" y="${p[1] + 0.5 / z}" font-size="${8.5 / z}" fill="#fff" stroke="none" text-anchor="middle" dominant-baseline="middle">${i + 1}</text>`; });
      if (m.pts.length) { const p = m.pts[m.pts.length - 1]; h += txt(p[0] + 12 / z, p[1] - 12 / z, `${m.pts.length} EA`, c, 'start'); }
    }
    if (m.id === S.selId && m.type !== 'count') { const hs = 9 / z; for (const p of m.pts) h += `<rect x="${p[0] - hs / 2}" y="${p[1] - hs / 2}" width="${hs}" height="${hs}" fill="#fff" stroke="${c}" stroke-width="${1.8 / z}"/>`; }
  }
  svg.innerHTML = h + '<g id="pv"></g>';
  renderPreview();
}
function renderPreview() {
  const g = svg.querySelector('#pv'); if (!g) return; const d = S.drawing; if (!d) { g.innerHTML = ''; return; }
  const z = S.z, pts = d.pts.slice(); if (S.hover && pts.length) pts.push(constrain(S.hover, d.shift));
  const c = d.type === 'calibrate' ? '#d1495b' : (prodById(S.activeProductId)?.color || TYPE_COLOR[d.type]);
  let h = '';
  if (pts.length) {
    const P = pts.map(p => p.join(',')).join(' ');
    if (d.type === 'area' && pts.length > 2) h += `<polygon points="${P}" fill="${c}" fill-opacity=".15" stroke="none"/>`;
    h += `<polyline points="${P}${d.type === 'area' && pts.length > 2 ? ' ' + pts[0].join(',') : ''}" fill="none" stroke="${c}" stroke-width="2.4" stroke-dasharray="7 4" vector-effect="non-scaling-stroke"/>`;
    for (const p of d.pts) h += `<circle cx="${p[0]}" cy="${p[1]}" r="${4 / z}" fill="#fff" stroke="${c}" stroke-width="${1.6 / z}"/>`;
    const k = curScale()?.ftPerPt, e = pts[pts.length - 1];
    let lab = '';
    if (d.type === 'length' && k) lab = fmtFtIn(polyLen(pts) * k);
    if (d.type === 'area' && k && pts.length > 2) lab = fmtN(shoelace(pts) * k * k) + ' SF';
    if (d.type === 'calibrate' && pts.length > 1 && k) lab = fmtFtIn(polyLen(pts) * k) + ' (current scale)';
    if (lab) h += `<text x="${e[0] + 10 / z}" y="${e[1] + 16 / z}" font-size="${12.5 / z}" fill="${c}" stroke-width="${3.2 / z}">${esc(lab)}</text>`;
  }
  g.innerHTML = h;
}

/* ---------- tools & drawing ---------- */
const HINTS = {
  length: 'Length: tap/click each point. Double-tap, Enter or ✓ Finish to end. Hold Shift for straight lines.',
  area: 'Area: tap/click the corners. Tap the first point, double-tap, Enter or ✓ Finish to close.',
  count: 'Count: tap each item. ✓ Finish (or Enter) starts a new count group.',
  calibrate: 'Calibrate: tap both ends of a dimension you know.',
  select: '',
};
function setTool(t) {
  if (t !== 'calibrate' && t !== 'select' && t !== 'count' && !curScale() && S.page) { scaleModal(t); return; }
  cancelDrawing(); S.tool = t;
  const ap = prodById(S.activeProductId), u = String(ap?.unit || '').toUpperCase();
  if (ap && ((t === 'count' && (u === 'LF' || u === 'SF')) || ((t === 'length' || t === 'area') && u === 'EA'))) { S.activeProductId = ''; refreshActiveProduct(); toast(`${ap.name} is priced per ${u} — pick a product for this tool`); }
  $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  viewer.classList.toggle('drawing', t !== 'select');
  const h = $('#hint'); h.textContent = HINTS[t] || ''; h.classList.toggle('on', !!HINTS[t]);
  updateFinish(); renderOverlay();
}
function cancelDrawing() { S.drawing = null; S.countId = null; S.hover = null; updateFinish(); }
function updateFinish() { $('#btnFinish').disabled = !((S.drawing && S.drawing.pts.length) || S.countId); }
function constrain(p, shift) {
  const d = S.drawing; if (!shift || !d?.pts.length) return p; const q = d.pts[d.pts.length - 1];
  return Math.abs(p[0] - q[0]) > Math.abs(p[1] - q[1]) ? [p[0], q[1]] : [q[0], p[1]];
}
const snap = () => JSON.stringify({ markups: S.project.markups, scales: S.project.scales });
function pushUndo() { if (!S.project) return; S.undo.push(snap()); if (S.undo.length > 150) S.undo.shift(); S.redo = []; }
function restoreSnap(s) { const o = JSON.parse(s); S.project.markups = o.markups; S.project.scales = o.scales; S.selId = null; S.countId = null; touch(); renderOverlay(); refreshPanel(); updateScaleLabel(); markThumb(); }
function undo() {
  if (S.drawing?.pts.length) { S.drawing.pts.pop(); updateFinish(); renderPreview(); return; }
  if (!S.undo.length) return toast('Nothing to undo'); S.redo.push(snap()); restoreSnap(S.undo.pop());
}
function redo() { if (!S.redo.length) return toast('Nothing to redo'); S.undo.push(snap()); restoreSnap(S.redo.pop()); }
function finishDrawing() {
  if (S.countId) { S.countId = null; updateFinish(); renderOverlay(); return; }
  const d = S.drawing; if (!d) return;
  const need = d.type === 'area' ? 3 : 2;
  if (d.pts.length < need) { toast(d.type === 'area' ? 'An area needs at least 3 points' : 'A length needs at least 2 points'); return; }
  pushUndo();
  const m = { id: uid(), type: d.type, docId: S.docId, page: S.pageNum, pts: d.pts, productId: S.activeProductId || null, label: '', height: null, color: S.activeProductId ? null : TYPE_COLOR[d.type], created: Date.now() };
  S.project.markups.push(m); S.selId = m.id; S.drawing = null; S.hover = null;
  touch(); updateFinish(); renderOverlay(); refreshPanel(); markThumb();
}
function tap(sx, sy, e) {
  const q = toPage(sx, sy), t = S.tool;
  if (t === 'select') { const hit = hitTest(q); S.selId = hit?.id || null; renderOverlay(); refreshPanel(); return; }
  if (t === 'count') {
    let m = S.countId && S.project.markups.find(x => x.id === S.countId && x.docId === S.docId && x.page === S.pageNum);
    if (m) { const lp = m.pts[m.pts.length - 1]; if (lp && Date.now() - (S.lastTap || 0) < 280 && dist(lp, q) * S.z < 5) return; }
    S.lastTap = Date.now(); pushUndo();
    if (!m) { m = { id: uid(), type: 'count', docId: S.docId, page: S.pageNum, pts: [], productId: S.activeProductId || null, label: '', height: null, color: S.activeProductId ? null : TYPE_COLOR.count, created: Date.now() }; S.project.markups.push(m); S.countId = m.id; }
    m.pts.push(q); S.selId = m.id; touch(); updateFinish(); renderOverlay(); refreshPanel(); markThumb(); return;
  }
  // length / area / calibrate
  if (!S.drawing) S.drawing = { type: t, pts: [] };
  const d = S.drawing, now = Date.now();
  const p = constrain(q, e.shiftKey);
  if (d.pts.length) {
    const last = d.pts[d.pts.length - 1];
    if (now - (S.lastTap || 0) < 380 && dist(last, p) * S.z < 12 && t !== 'calibrate') { S.lastTap = 0; finishDrawing(); return; }
    if (t === 'area' && d.pts.length >= 3 && dist(d.pts[0], p) * S.z < 12) { finishDrawing(); return; }
  }
  S.lastTap = now; d.pts.push(p); d.shift = e.shiftKey; updateFinish(); renderPreview();
  if (t === 'calibrate' && d.pts.length === 2) { const dp = dist(d.pts[0], d.pts[1]); const pts = d.pts; S.drawing = null; renderPreview(); calibrateModal(dp, pts); }
}
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = clamp(t, 0, 1); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
function inPoly(p, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function hitTest(q) {
  const tol = 10 / S.z; let best = null, bd = Infinity;
  for (const m of pageMarkups()) {
    let d = Infinity;
    if (m.type === 'count') for (const p of m.pts) d = Math.min(d, dist(p, q));
    else { for (let i = 1; i < m.pts.length; i++) d = Math.min(d, segDist(q, m.pts[i - 1], m.pts[i])); if (m.type === 'area') { d = Math.min(d, segDist(q, m.pts[m.pts.length - 1], m.pts[0])); if (inPoly(q, m.pts)) d = Math.min(d, tol * 0.9); } }
    if (d < tol && d < bd) { bd = d; best = m; }
  }
  return best;
}
function hitHandle(q) {
  const m = S.project.markups.find(x => x.id === S.selId); if (!m || m.docId !== S.docId || m.page !== S.pageNum) return null;
  const tol = (COARSE ? 16 : 9) / S.z;
  for (let i = 0; i < m.pts.length; i++) if (dist(m.pts[i], q) < tol) return { m, i };
  return null;
}

/* ---------- pointer input (mouse, touch, pen) ---------- */
const ptrs = new Map(); let G = null, spaceDown = false;
const local = e => { const r = viewer.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
viewer.addEventListener('pointerdown', e => {
  if (!S.page || e.target.closest('#pageNav,#empty')) return;
  try { viewer.setPointerCapture(e.pointerId); } catch { }
  const p = local(e); ptrs.set(e.pointerId, p);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; G = { type: 'pinch', d0: dist(a, b) || 1, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], z0: S.z, tx0: S.tx, ty0: S.ty }; return; }
  if (ptrs.size > 2) return;
  if (e.button === 1 || e.button === 2 || spaceDown) { G = { type: 'pan', s: p, tx0: S.tx, ty0: S.ty }; viewer.classList.add('panning'); e.preventDefault(); return; }
  if (S.tool === 'select' && S.selId) { const h = hitHandle(toPage(...p)); if (h) { pushUndo(); G = { type: 'vertex', ...h }; return; } }
  G = { type: 'pending', s: p, tx0: S.tx, ty0: S.ty, thr: e.pointerType === 'touch' ? 10 : 5 };
});
viewer.addEventListener('pointermove', e => {
  const p = local(e);
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
  if (G?.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = dist(a, b), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const nz = clamp(G.z0 * d / G.d0, fitZ() * 0.25, 60), px = (G.m0[0] - G.tx0) / G.z0, py = (G.m0[1] - G.ty0) / G.z0;
    S.z = nz; S.tx = m[0] - px * nz; S.ty = m[1] - py * nz; applyT(); return;
  }
  if (G?.type === 'pending' && dist(p, G.s) > G.thr) { G.type = 'pan'; viewer.classList.add('panning'); }
  if (G?.type === 'pan') { S.tx = G.tx0 + p[0] - G.s[0]; S.ty = G.ty0 + p[1] - G.s[1]; applyT(); return; }
  if (G?.type === 'vertex') { G.m.pts[G.i] = toPage(...p); G.moved = true; renderOverlay(); return; }
  if (!G && S.drawing && e.pointerType !== 'touch') { S.hover = toPage(...p); S.drawing.shift = e.shiftKey; renderPreview(); }
});
function endPtr(e, cancel) {
  const had = ptrs.delete(e.pointerId); viewer.classList.remove('panning');
  if (!G) return;
  if (G.type === 'pinch') { if (ptrs.size === 0) G = null; return; }
  if (ptrs.size) return;
  const g = G; G = null;
  if (cancel || !had) return;
  if (g.type === 'pending') tap(...local(e), e);
  if (g.type === 'vertex') { if (g.moved) { touch(); refreshPanel(); } else S.undo.pop(); }
}
viewer.addEventListener('pointerup', e => endPtr(e, false));
viewer.addEventListener('pointercancel', e => endPtr(e, true));
viewer.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && S.drawing && !G) { S.hover = null; renderPreview(); } });
viewer.addEventListener('contextmenu', e => e.preventDefault());
viewer.addEventListener('wheel', e => {
  if (!S.page) return; e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const p = local(e); zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), p[0], p[1]);
}, { passive: false });
['gesturestart', 'gesturechange'].forEach(n => viewer.addEventListener(n, e => e.preventDefault()));
document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select') || !$('#modalBack').classList.contains('hidden')) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (S.view !== 'plans' || mod) return;
  if (k === ' ') { spaceDown = true; e.preventDefault(); }
  else if (k === 'enter') finishDrawing();
  else if (k === 'escape') { if (S.drawing || S.countId) { cancelDrawing(); renderOverlay(); } else setTool('select'); }
  else if (k === 'backspace' || k === 'delete') { if (S.drawing?.pts.length) undo(); else if (S.selId) deleteMarkup(S.selId); e.preventDefault(); }
  else if (k === 'v') setTool('select'); else if (k === 'l') setTool('length'); else if (k === 'a') setTool('area'); else if (k === 'c') setTool('count');
  else if (k === 'f') fitPage(); else if (k === '+' || k === '=') zoomAt(1.25, viewer.clientWidth / 2, viewer.clientHeight / 2); else if (k === '-') zoomAt(0.8, viewer.clientWidth / 2, viewer.clientHeight / 2);
  else if (k === 'pagedown') gotoPage(1); else if (k === 'pageup') gotoPage(-1);
});
document.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });
function gotoPage(d) { const doc = S.project?.docs.find(x => x.id === S.docId); if (!doc) return; const n = clamp(S.pageNum + d, 1, doc.pages); if (n !== S.pageNum) showPage(S.docId, n); }

/* ======================= SCALE ======================= */
function updateScaleLabel() {
  const s = S.page ? curScale() : null, b = $('#btnScale');
  $('#scaleLabel').textContent = s ? s.label : (S.page ? 'Set scale' : 'No scale'); b.classList.toggle('warn', !!S.page && !s);
}
function setScale(ftPerPt, label, allPages) {
  pushUndo(); const P = S.project, doc = P.docs.find(d => d.id === S.docId);
  const keys = allPages ? Array.from({ length: doc.pages }, (_, i) => pageKey(S.docId, i + 1)) : [pageKey()];
  for (const k of keys) P.scales[k] = { ftPerPt, label };
  touch(); updateScaleLabel(); renderOverlay(); refreshPanel(); toast(`Scale set: ${label}${allPages ? ' (all pages)' : ''}`);
}
function scaleModal(nextTool) {
  if (!S.page) return toast('Open a PDF first');
  const cur = curScale(); const groups = [...new Set(SCALES.map(s => s.group))];
  const opts = groups.map(g => `<optgroup label="${g}">${SCALES.filter(s => s.group === g).map(s => `<option value="${SCALES.indexOf(s)}" ${cur && Math.abs(cur.ftPerPt - s.ftPerPt) < 1e-12 ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('');
  openModal(`<h3>Scale for page ${S.pageNum}</h3>
    <p class="muted small">Current: <b>${esc(cur?.label || 'not set')}</b>. Presets assume the PDF is at full sheet size (as issued).</p>
    <div class="field"><label>Preset scale</label><select id="scSel">${cur ? '' : '<option value="">Choose a scale…</option>'}${opts}</select></div>
    <label class="field row small"><input type="checkbox" id="scAll"> Apply to every page in this PDF</label>
    <div class="btns"><button id="scMeasure">Calibrate from a known dimension…</button><button data-close>Cancel</button><button id="scOk" class="accent">Use preset</button></div>`, (m, close) => {
    m.querySelector('#scOk').onclick = () => { const v = m.querySelector('#scSel').value; if (v === '') return toast('Pick a scale'); const s = SCALES[+v], all = m.querySelector('#scAll').checked; close(); setScale(s.ftPerPt, s.label, all); if (nextTool) setTool(nextTool); };
    m.querySelector('#scMeasure').onclick = () => { S.calAll = m.querySelector('#scAll').checked; S.calNext = nextTool; close(); setTool('calibrate'); };
  });
}
function calibrateModal(dPts, pts) {
  const paperIn = dPts / 72;
  openModal(`<h3>Calibrate</h3><p class="muted small">Measured ${fmtN(paperIn, 3)}" on the sheet. What is the real length?</p>
    <form id="cf"><div class="ftin"><input id="cFt" inputmode="decimal" placeholder="feet" autofocus><span>ft</span><input id="cIn" placeholder='inches (e.g. 6 1/2)'><span>in</span></div>
    <label class="field row small"><input type="checkbox" id="cAll" ${S.calAll ? 'checked' : ''}> Apply to every page in this PDF</label>
    <div class="btns"><button type="button" data-close>Cancel</button><button class="accent">Set scale</button></div></form>`, (m, close) => {
    m.querySelector('[data-close]').onclick = () => { close(); setTool('select'); };
    m.querySelector('#cf').onsubmit = e => {
      e.preventDefault(); const ft = num(m.querySelector('#cFt').value, 0), inch = parseInches(m.querySelector('#cIn').value);
      const real = ft + (isFinite(inch) ? inch : 0) / 12; if (!(real > 0) || !isFinite(inch)) return toast('Enter the real length');
      const k = real / dPts, near = nearPreset(k);
      const label = near ? `${near} (calibrated)` : `1" = ${fmtFtIn(k * 72)} (calibrated)`;
      const all = m.querySelector('#cAll').checked; close(); setScale(k, label, all);
      const nt = S.calNext; S.calNext = null; setTool(nt || 'select');
    };
  });
}

/* ======================= SIDEBAR ======================= */
function refreshDocSelect() {
  const sel = $('#docSelect'), docs = S.project?.docs || [];
  sel.innerHTML = docs.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('') || '<option value="">No PDFs</option>';
  if (S.docId) sel.value = S.docId;
  $('#btnRemovePdf').disabled = !S.docId;
}
let thumbObs = null;
function renderThumbs() {
  const box = $('#thumbs'); box.innerHTML = ''; thumbObs?.disconnect();
  const doc = S.project?.docs.find(d => d.id === S.docId); if (!doc) return;
  const docId = doc.id;
  thumbObs = new IntersectionObserver(ents => ents.forEach(async en => {
    if (!en.isIntersecting) return; const b = en.target; thumbObs.unobserve(b);
    try {
      const pdf = await getPdf(docId), pg = await pdf.getPage(+b.dataset.page), v1 = pg.getViewport({ scale: 1 });
      const sc = 260 / Math.max(v1.width, v1.height), vp = pg.getViewport({ scale: sc }), c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height); await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      c.style.width = Math.round(vp.width / 2) + 'px'; b.prepend(c);
    } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); }
  }), { root: box, rootMargin: '200px' });
  for (let i = 1; i <= doc.pages; i++) {
    const b = document.createElement('button'); b.className = 'thumb'; b.dataset.page = i;
    b.innerHTML = `<div class="tl"></div>`; b.onclick = () => showPage(docId, i);
    box.appendChild(b); thumbObs.observe(b);
  }
  markThumb();
}
function markThumb() {
  const counts = {}; for (const m of S.project?.markups || []) if (m.docId === S.docId) counts[m.page] = (counts[m.page] || 0) + 1;
  $$('#thumbs .thumb').forEach(b => {
    const p = +b.dataset.page, on = p === S.pageNum; b.classList.toggle('on', on);
    b.querySelector('.tl').innerHTML = `Page ${p}${counts[p] ? ` · <b>${counts[p]}</b>` : ''}${S.project?.scales[pageKey(S.docId, p)] ? '' : ' · <span title="No scale">no scale</span>'}`;
    if (on && !b.dataset.seen) { b.scrollIntoView({ block: 'nearest' }); }
  });
}

/* ======================= PRODUCT PICKER ======================= */
function productOptions(selected, emptyLabel = '— No product —') {
  const cats = {}; for (const p of [...S.products].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))) (cats[p.category || 'Uncategorized'] ||= []).push(p);
  return `<option value="">${emptyLabel}</option>` + Object.entries(cats).map(([c, ps]) => `<optgroup label="${esc(c)}">${ps.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} (${esc(p.unit)})</option>`).join('')}</optgroup>`).join('');
}
function refreshActiveProduct() {
  const sel = $('#activeProduct'); if (S.activeProductId && !prodById(S.activeProductId)) S.activeProductId = '';
  sel.innerHTML = productOptions(S.activeProductId, S.products.length ? '— No product —' : '— Add products in Products tab —');
  sel.value = S.activeProductId; const p = prodById(S.activeProductId);
  sel.style.borderColor = p ? p.color : '';
}

/* ======================= RIGHT PANEL ======================= */
function refreshPanel() {
  const list = $('#markupList'), tot = $('#pageTotals'), selBox = $('#selBox');
  if (!S.project || !S.page) { list.innerHTML = '<p class="muted small">No page open.</p>'; tot.innerHTML = ''; selBox.classList.add('hidden'); $('#pageCount').textContent = ''; return; }
  const ms = pageMarkups(); $('#pageCount').textContent = ms.length ? ms.length + ' markups' : '';
  list.innerHTML = ms.map(m => `<div class="mrow ${m.id === S.selId ? 'on' : ''}" data-id="${m.id}"><span class="sw" style="background:${colorOf(m)}"></span><span class="mname">${esc(markName(m))}</span><span class="mval">${esc(valueText(m).split(' · ')[0])}</span></div>`).join('') || '<p class="muted small">Pick a tool above and tap on the plan.</p>';
  list.querySelectorAll('.mrow').forEach(r => r.onclick = () => { S.selId = r.dataset.id; if (S.tool !== 'select') setTool('select'); renderOverlay(); refreshPanel(); });
  // per-product totals for this page
  const agg = new Map();
  for (const m of ms) {
    const p = prodById(m.productId), key = p ? p.id : 'u-' + nativeUnit(m), q = p ? qtyFor(m, p) : (m.type === 'count' ? m.pts.length : (m.type === 'area' ? geo(m).sf : (geo(m).sf ?? geo(m).lf)));
    const a = agg.get(key) || { name: p ? p.name : 'Unassigned', unit: p ? p.unit : nativeUnit(m), color: p ? p.color : '#888', q: 0 };
    if (q != null) a.q += q; agg.set(key, a);
  }
  tot.innerHTML = [...agg.values()].map(a => `<div class="trow"><span><span class="sw" style="display:inline-block;background:${a.color};margin-right:6px"></span>${esc(a.name)}</span><b>${fmtQty(a.q, a.unit)} ${esc(a.unit)}</b></div>`).join('') || '<p class="muted small">No quantities yet.</p>';
  // selected markup
  const m = S.project.markups.find(x => x.id === S.selId && x.docId === S.docId && x.page === S.pageNum);
  if (!m) { selBox.classList.add('hidden'); return; }
  selBox.classList.remove('hidden'); const g = geo(m), p = prodById(m.productId);
  const q = p ? qtyFor(m, p) : null;
  selBox.innerHTML = `<div class="boxHead">Selected ${m.type}<button class="small" id="sClose">✕</button></div>
    <div class="big-val">${esc(valueText(m).split(' · ')[0])}</div>
    ${m.type === 'area' && !g.noscale ? `<div class="muted small">Perimeter ${fmtFtIn(g.lf)} (${fmtN(g.lf)} LF)</div>` : ''}
    ${m.type === 'length' && !g.noscale ? `<div class="muted small">${fmtN(g.lf)} LF</div>` : ''}
    ${p && q != null ? `<div class="small">Counts as <b>${fmtQty(q, p.unit)} ${esc(p.unit)}</b> of ${esc(p.name)}</div>` : ''}
    <div class="field"><label>Product</label><select id="sProd">${productOptions(m.productId)}</select></div>
    <div class="field"><label>Note / label</label><input id="sLabel" value="${esc(m.label)}" placeholder="e.g. Kitchen north wall"></div>
    ${m.type === 'length' ? `<div class="field"><label>Wall height in ft (optional, turns length into SF)</label><input id="sHeight" inputmode="decimal" value="${m.height || ''}" placeholder="e.g. 9"></div>` : ''}
    <div class="actions" style="margin-top:8px">${m.type === 'count' ? '<button class="small" id="sAddCount">+ Add to this count</button>' : '<span class="muted small">Drag the white squares to edit points.</span>'}<button class="small danger" id="sDel" style="margin-left:auto">Delete</button></div>`;
  selBox.querySelector('#sClose').onclick = () => { S.selId = null; renderOverlay(); refreshPanel(); };
  selBox.querySelector('#sProd').onchange = e => { pushUndo(); m.productId = e.target.value || null; if (!m.productId) m.color = TYPE_COLOR[m.type]; touch(); renderOverlay(); refreshPanel(); };
  selBox.querySelector('#sLabel').onchange = e => { pushUndo(); m.label = e.target.value.trim(); touch(); renderOverlay(); refreshPanel(); };
  const hEl = selBox.querySelector('#sHeight'); if (hEl) hEl.onchange = e => { pushUndo(); const v = num(e.target.value, 0); m.height = v > 0 ? v : null; touch(); renderOverlay(); refreshPanel(); };
  selBox.querySelector('#sDel').onclick = () => deleteMarkup(m.id);
  const ac = selBox.querySelector('#sAddCount'); if (ac) ac.onclick = () => { setTool('count'); S.countId = m.id; S.selId = m.id; updateFinish(); renderOverlay(); toast('Tap to add more to this count'); };
}
function deleteMarkup(id) {
  pushUndo(); S.project.markups = S.project.markups.filter(m => m.id !== id);
  if (S.selId === id) S.selId = null; if (S.countId === id) S.countId = null;
  touch(); renderOverlay(); refreshPanel(); markThumb(); updateFinish(); toast('Markup deleted — Undo to restore');
}

/* ======================= ESTIMATE ======================= */
function computeEstimate() {
  const P = S.project; if (!P) return null;
  const rows = new Map(), un = { LF: 0, SF: 0, EA: 0, n: 0 }; let noScale = 0;
  for (const m of P.markups) {
    const p = prodById(m.productId);
    if (!p) { const g = geo(m); if (g.noscale) { noScale++; continue; } un.n++; if (m.type === 'count') un.EA += g.ea; else if (m.type === 'area') un.SF += g.sf; else if (g.sf != null) un.SF += g.sf; else un.LF += g.lf; continue; }
    const q = qtyFor(m, p); if (q == null) { noScale++; continue; }
    const r = rows.get(p.id) || { prod: p, qty: 0, n: 0 }; r.qty += q; r.n++; rows.set(p.id, r);
  }
  const lines = [...rows.values()].sort((a, b) => (a.prod.category || '').localeCompare(b.prod.category || '') || a.prod.name.localeCompare(b.prod.name)).map(r => {
    const w = num(r.prod.waste), qw = r.qty * (1 + w / 100), price = num(r.prod.price), lab = num(r.prod.labor);
    return { kind: 'product', id: r.prod.id, name: r.prod.name, category: r.prod.category || '', unit: r.prod.unit, qty: r.qty, waste: w, qtyW: qw, price, mat: qw * price, laborU: lab, labor: qw * lab, total: qw * (price + lab), n: r.n };
  });
  const manual = P.manual.map(x => { const q = num(x.qty), pr = num(x.price), lb = num(x.labor), w = num(x.waste), qw = q * (1 + w / 100); return { kind: 'manual', id: x.id, name: x.desc || '', category: 'Manual', unit: x.unit || 'EA', qty: q, waste: w, qtyW: qw, price: pr, mat: qw * pr, laborU: lb, labor: qw * lb, total: qw * (pr + lb), productId: x.productId || null }; });
  const all = [...lines, ...manual];
  const mat = all.reduce((s, l) => s + l.mat, 0), labor = all.reduce((s, l) => s + l.labor, 0);
  const taxPct = num(P.settings.taxPct), markupPct = num(P.settings.markupPct);
  const tax = mat * taxPct / 100, markup = (mat + labor) * markupPct / 100, grand = mat + labor + tax + markup;
  const anyPriced = all.some(l => l.price > 0 || l.laborU > 0), sp = P.settings.showPrices;
  const show = typeof sp === 'boolean' ? sp : anyPriced;   // auto: off until something has a price; Daniel's flip overrides
  return { lines, manual, all, un, noScale, mat, labor, tax, taxPct, markup, markupPct, grand, anyPriced, show, showAuto: typeof sp !== 'boolean' };
}
const m$ = v => v ? fmt$(v) : '';   // unpriced cells stay blank instead of $0.00
function renderEstimate() {
  const E = computeEstimate(), t = $('#estTable'), tog = $('#togPrices');
  $('#estProj').textContent = S.project ? '· ' + S.project.name : '';
  if (!E) { t.innerHTML = '<tr><td class="muted">Open or create a project first.</td></tr>'; $('#estTotals').innerHTML = ''; tog.disabled = true; return; }
  const P = E.show, C = P ? 11 : 6;
  tog.disabled = false; tog.checked = P;
  $('#togPricesHint').textContent = E.showAuto ? '(auto)' : '';
  let h = `<tr><th>Item</th><th>Unit</th><th class="n">Measured</th><th class="n">Waste</th><th class="n">Qty</th>${P ? '<th class="n">Unit price</th><th class="n">Material</th><th class="n">Labor/unit</th><th class="n">Labor</th><th class="n">Line total</th>' : ''}<th></th></tr>`;
  let cat = null;
  for (const l of E.lines) {
    if (l.category !== cat) { cat = l.category; h += `<tr class="cat"><td colspan="${C}">${esc(cat || 'Uncategorized')}</td></tr>`; }
    h += `<tr><td><span class="sw" style="display:inline-block;background:${prodById(l.id)?.color};margin-right:6px"></span>${esc(l.name)} <span class="muted small">(${l.n})</span></td><td>${esc(l.unit)}</td><td class="n">${fmtQty(l.qty, l.unit)}</td><td class="n">${fmtN(l.waste, l.waste % 1 ? 1 : 0)}%</td><td class="n"><b>${fmtQty(l.qtyW, l.unit)}</b></td>${P ? `<td class="n">${m$(l.price)}</td><td class="n">${m$(l.mat)}</td><td class="n">${m$(l.laborU)}</td><td class="n">${m$(l.labor)}</td><td class="n"><b>${m$(l.total)}</b></td>` : ''}<td></td></tr>`;
  }
  if (E.manual.length) h += `<tr class="cat"><td colspan="${C}">Manual items</td></tr>`;
  for (const l of E.manual) {
    const x = S.project.manual.find(m => m.id === l.id);
    h += `<tr data-mid="${l.id}"><td><input data-f="desc" value="${esc(x.desc)}" placeholder="Description"></td><td><input data-f="unit" value="${esc(x.unit || 'EA')}" style="width:60px"></td><td class="n"><input class="num" data-f="qty" inputmode="decimal" value="${esc(x.qty)}"></td><td class="n"><input class="num pct" data-f="waste" inputmode="decimal" value="${esc(x.waste || 0)}" title="Waste %"></td><td class="n"><b>${fmtQty(l.qtyW, l.unit)}</b></td>${P ? `<td class="n"><input class="num" data-f="price" inputmode="decimal" placeholder="$" value="${num(x.price) ? esc(x.price) : ''}"></td><td class="n">${m$(l.mat)}</td><td class="n"><input class="num" data-f="labor" inputmode="decimal" placeholder="$" value="${num(x.labor) ? esc(x.labor) : ''}"></td><td class="n">${m$(l.labor)}</td><td class="n"><b>${m$(l.total)}</b></td>` : ''}<td><button class="small danger" data-del="${l.id}">✕</button></td></tr>`;
  }
  if (E.un.n) h += `<tr class="sub"><td colspan="${C}">Unassigned markups (${E.un.n}), not included: ${[E.un.LF && fmtN(E.un.LF) + ' LF', E.un.SF && fmtN(E.un.SF) + ' SF', E.un.EA && E.un.EA + ' EA'].filter(Boolean).join(' · ')}. Assign a product to include them.</td></tr>`;
  if (E.noScale) h += `<tr class="sub"><td colspan="${C}">${E.noScale} markups are on pages without a scale and are not included.</td></tr>`;
  if (!E.all.length) h += `<tr><td colspan="${C}" class="muted">No items yet. Measure on the plan with a product selected, or add a manual line.</td></tr>`;
  t.innerHTML = h;
  t.querySelectorAll('tr[data-mid] input').forEach(inp => inp.onchange = () => { const x = S.project.manual.find(m => m.id === inp.closest('tr').dataset.mid); x[inp.dataset.f] = inp.dataset.f === 'desc' || inp.dataset.f === 'unit' ? inp.value : num(inp.value); touch(); renderEstimate(); });
  t.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.project.manual = S.project.manual.filter(m => m.id !== b.dataset.del); touch(); renderEstimate(); });
  const tot = $('#estTotals');
  tot.classList.toggle('hidden', !P);
  tot.innerHTML = !P ? '' : `<div class="trow"><span>Material</span><span>${fmt$(E.mat)}</span></div>
    <div class="trow"><span>Labor</span><span>${fmt$(E.labor)}</span></div>
    <div class="trow"><span>Markup / overhead <input id="eMk" inputmode="decimal" value="${E.markupPct}">%</span><span>${fmt$(E.markup)}</span></div>
    <div class="trow"><span>Tax on material <input id="eTx" inputmode="decimal" value="${E.taxPct}">%</span><span>${fmt$(E.tax)}</span></div>
    <div class="trow grand"><span>Grand total</span><span id="eGrand">${fmt$(E.grand)}</span></div>`;
  if (P) {
    $('#eMk').onchange = e => { S.project.settings.markupPct = num(e.target.value); touch(); renderEstimate(); };
    $('#eTx').onchange = e => { S.project.settings.taxPct = num(e.target.value); touch(); renderEstimate(); };
  }
  $('#estNote').textContent = P ? 'Qty = measured × (1 + waste %). Material = qty × unit price. Labor = qty × labor per unit. Markup % applies to material + labor; tax % applies to material only. Blank price cells = not priced.'
    : 'Prices are hidden (quantities only), on screen and in print and exports. Turn on "Show prices" to price this estimate.';
}
function setShowPrices(v) {
  const E = computeEstimate(); if (!E) return;
  S.project.settings.showPrices = v === E.anyPriced ? null : v;   // matching the automatic choice goes back to auto
  S.project.updated = Date.now(); flush(); renderEstimate();   // save right away
}
const r2 = n => Math.round(n * 100) / 100, r4 = n => Math.round(n * 10000) / 10000;
const b2 = n => n ? r2(n) : '';   // blank instead of 0 for unpriced cells
function estimateAOA(E) {
  if (!E.show) {
    const rows = [['Item', 'Category', 'Unit', 'Measured qty', 'Waste %', 'Qty with waste']];
    for (const l of E.all) rows.push([l.name, l.category, l.unit, r4(l.qty), l.waste, r4(l.qtyW)]);
    return rows;
  }
  const rows = [['Item', 'Category', 'Unit', 'Measured qty', 'Waste %', 'Qty with waste', 'Unit price', 'Material', 'Labor per unit', 'Labor', 'Line total']];
  for (const l of E.all) rows.push([l.name, l.category, l.unit, r4(l.qty), l.waste, r4(l.qtyW), b2(l.price), b2(l.mat), b2(l.laborU), b2(l.labor), b2(l.total)]);
  rows.push([], ['', '', '', '', '', '', '', 'Material', r2(E.mat)], ['', '', '', '', '', '', '', 'Labor', r2(E.labor)],
    ['', '', '', '', '', '', '', `Markup ${E.markupPct}%`, r2(E.markup)], ['', '', '', '', '', '', '', `Tax on material ${E.taxPct}%`, r2(E.tax)], ['', '', '', '', '', '', '', 'Grand total', r2(E.grand)]);
  return rows;
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCSV = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');
function exportEstimateCsv() {
  const E = computeEstimate(); if (!E) return;
  download(`${safeName(S.project.name)}_estimate.csv`, '\ufeff' + toCSV([[S.project.name + ' — estimate', new Date().toLocaleDateString()], [], ...estimateAOA(E)]), 'text/csv');
  toast('Estimate CSV exported');
}
function loadXlsx() { return window.XLSX ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement('script'); s.src = './vendor/xlsx.mini.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
function markupRows() {
  const rows = [['PDF', 'Page', 'Type', 'Product', 'Note', 'Measured', 'Unit', 'Value']];
  for (const m of S.project.markups) {
    const p = prodById(m.productId), g = geo(m), doc = S.project.docs.find(d => d.id === m.docId);
    const q = p ? qtyFor(m, p) : (m.type === 'count' ? g.ea : m.type === 'area' ? g.sf : (g.sf ?? g.lf));
    rows.push([doc?.name || '', m.page, m.type, p?.name || '(unassigned)', m.label || '', q == null ? '' : r4(q), p ? p.unit : nativeUnit(m), valueText(m)]);
  }
  return rows;
}
async function exportXlsx() {
  const E = computeEstimate(); if (!E) return;
  await loadXlsx(); const X = window.XLSX, wb = X.utils.book_new();
  const ws = X.utils.aoa_to_sheet([[S.project.name + ' — estimate'], [new Date().toLocaleDateString()], [], ...estimateAOA(E)]);
  ws['!cols'] = [{ wch: 34 }, { wch: 16 }, { wch: 7 }, { wch: 13 }, { wch: 8 }, { wch: 14 }, { wch: 11 }, { wch: 18 }, { wch: 13 }, { wch: 12 }, { wch: 12 }];
  X.utils.book_append_sheet(wb, ws, 'Estimate');
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(markupRows()), 'Markups');
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Done', 'Item', 'Notes'], ...S.project.checklist.map(c => [c.done ? 'Yes' : '', c.text, c.notes || ''])]), 'Checklist');
  X.writeFile(wb, `${safeName(S.project.name)}_estimate.xlsx`); toast('Excel file exported');
}
function printSummary() {
  const E = computeEstimate(); if (!E) return; const P = E.show;
  $('#printArea').innerHTML = `<h1>${esc(S.project.name)} — ${P ? 'Estimate' : 'Quantities'}</h1><div>${new Date().toLocaleDateString()}</div><br>
    <table><tr><th>Item</th><th>Unit</th><th class="n">Qty (w/ waste)</th>${P ? '<th class="n">Unit price</th><th class="n">Material</th><th class="n">Labor</th><th class="n">Total</th>' : ''}</tr>
    ${E.all.map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.unit)}</td><td class="n">${fmtQty(l.qtyW, l.unit)}</td>${P ? `<td class="n">${m$(l.price)}</td><td class="n">${m$(l.mat)}</td><td class="n">${m$(l.labor)}</td><td class="n">${m$(l.total)}</td>` : ''}</tr>`).join('')}</table>
    ${P ? `<div class="tot"><div><span>Material</span><span>${fmt$(E.mat)}</span></div><div><span>Labor</span><span>${fmt$(E.labor)}</span></div><div><span>Markup ${E.markupPct}%</span><span>${fmt$(E.markup)}</span></div><div><span>Tax ${E.taxPct}%</span><span>${fmt$(E.tax)}</span></div><div class="g"><span>Grand total</span><span>${fmt$(E.grand)}</span></div></div>` : ''}
    ${S.project.checklist.length ? `<h3>Checklist</h3><table>${S.project.checklist.map(c => `<tr><td>${c.done ? '☑' : '☐'} ${esc(c.text)}${c.notes ? `<br><small>${esc(c.notes)}</small>` : ''}</td></tr>`).join('')}</table>` : ''}`;
  window.print();
}

/* ======================= PRODUCTS ======================= */
function renderProducts() {
  const q = $('#prodSearch').value.trim().toLowerCase();
  const ps = [...S.products].filter(p => !q || (p.name + ' ' + p.category).toLowerCase().includes(q)).sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  const used = {}; if (S.project) for (const m of S.project.markups) if (m.productId) used[m.productId] = (used[m.productId] || 0) + 1;
  $('#prodTable').innerHTML = `<tr><th></th><th>Name</th><th>Category</th><th>Unit</th><th class="n">Unit price</th><th class="n">Labor/unit</th><th class="n">Waste</th><th class="n">Multiplier</th><th class="n">In this project</th><th></th></tr>` +
    (ps.map(p => `<tr data-id="${p.id}"><td><span class="sw" style="background:${p.color}"></span></td><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${esc(p.unit)}</td><td class="n">${fmt$(num(p.price))}</td><td class="n">${fmt$(num(p.labor))}</td><td class="n">${fmtN(num(p.waste), 1)}%</td><td class="n">${p.mult && p.mult !== 1 ? p.mult : ''}</td><td class="n">${used[p.id] || ''}</td>
      <td class="n"><button class="small" data-act="use">Use</button> <button class="small" data-act="edit">Edit</button> <button class="small danger" data-act="del">✕</button></td></tr>`).join('') || `<tr><td colspan="10" class="muted">No products yet. Add one, or import a CSV.</td></tr>`);
  $$('#prodTable tr[data-id]').forEach(tr => tr.onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act, p = prodById(tr.dataset.id); if (!act) return;
    if (act === 'edit') productModal(p);
    if (act === 'use') { S.activeProductId = p.id; refreshActiveProduct(); switchView('plans'); autoToolFor(p); }
    if (act === 'del') {
      const n = used[p.id] || 0;
      if (!await askConfirm('Delete product?', `Delete <b>${esc(p.name)}</b> from the library?${n ? ` ${n} markups in this project will become unassigned.` : ''} (Other projects that use it will show those markups as unassigned too.)`)) return;
      await DB.del('products', p.id); S.products = S.products.filter(x => x.id !== p.id); refreshActiveProduct(); renderProducts(); toast('Product deleted');
    }
  });
}
function productModal(p) {
  const isNew = !p; p = p ? { ...p } : { id: uid(), name: '', category: '', unit: 'LF', price: 0, labor: 0, waste: 0, color: PALETTE[S.products.length % PALETTE.length], mult: 1 };
  const cats = [...new Set(S.products.map(x => x.category).filter(Boolean))];
  openModal(`<h3>${isNew ? 'New product' : 'Edit product'}</h3><form id="pf">
    <div class="field"><label>Name</label><input id="pName" value="${esc(p.name)}" required autofocus></div>
    <div class="grid2">
      <div class="field"><label>Category</label><input id="pCat" list="catList" value="${esc(p.category)}"><datalist id="catList">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="field"><label>Unit (LF, SF, EA or your own)</label><input id="pUnit" list="unitList" value="${esc(p.unit)}"><datalist id="unitList">${['LF', 'SF', 'EA', 'SY', 'SHT', 'BOX', 'HR', 'SET'].map(u => `<option value="${u}">`).join('')}</datalist></div>
      <div class="field"><label>Unit price ($)</label><input id="pPrice" inputmode="decimal" value="${p.price}"></div>
      <div class="field"><label>Labor per unit ($, optional)</label><input id="pLabor" inputmode="decimal" value="${p.labor || 0}"></div>
      <div class="field"><label>Waste %</label><input id="pWaste" inputmode="decimal" value="${p.waste || 0}"></div>
      <div class="field"><label>Color</label><input id="pColor" type="color" value="${p.color}"></div>
    </div>
    <div class="field"><label>Multiplier (optional): converts what you measure into this unit. 1 = no change. Example: 0.03125 turns SF into 4×8 sheets.</label><input id="pMult" inputmode="decimal" value="${p.mult || 1}"></div>
    <p class="muted small">Length markups count as LF (or wall SF when a wall height is set and the unit isn't LF). Area markups count as SF (or their perimeter if the unit is LF). Count markups count as EA.</p>
    <div class="btns"><button type="button" data-close>Cancel</button><button class="accent">Save</button></div></form>`, (m, close) => {
    m.querySelector('#pf').onsubmit = async e => {
      e.preventDefault(); const v = id => m.querySelector(id).value;
      Object.assign(p, { name: v('#pName').trim(), category: v('#pCat').trim(), unit: (v('#pUnit').trim() || 'EA').toUpperCase(), price: num(v('#pPrice')), labor: num(v('#pLabor')), waste: num(v('#pWaste')), color: v('#pColor'), mult: num(v('#pMult'), 1) || 1 });
      if (!p.name) return toast('Name is required');
      await saveProduct(p); const i = S.products.findIndex(x => x.id === p.id); if (i >= 0) S.products[i] = p; else S.products.push(p);
      close(); refreshActiveProduct(); renderProducts(); renderOverlay(); refreshPanel(); toast('Product saved');
    };
  });
}
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function exportProductsCsv() {
  const rows = [['name', 'category', 'unit', 'unit_price', 'labor_price', 'waste_pct', 'color', 'multiplier'], ...S.products.map(p => [p.name, p.category, p.unit, p.price, p.labor || 0, p.waste || 0, p.color, p.mult || 1])];
  download('products.csv', '\ufeff' + toCSV(rows), 'text/csv'); toast('Product library exported');
}
async function importProductsCsv(text) {
  const rows = parseCSV(text); if (rows.length < 2) return toast('No rows found in CSV');
  const hdr = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const col = (...names) => hdr.findIndex(h => names.includes(h));
  const ix = { name: col('name', 'product', 'item'), cat: col('category', 'cat'), unit: col('unit', 'uom'), price: col('unitprice', 'price', 'cost'), labor: col('laborprice', 'labor', 'laborperunit'), waste: col('wastepct', 'waste', 'wastepercent'), color: col('color', 'colour'), mult: col('multiplier', 'mult', 'factor') };
  if (ix.name < 0) return toast('CSV needs a "name" column');
  let added = 0, updated = 0;
  for (const r of rows.slice(1)) {
    const g = k => ix[k] >= 0 ? (r[ix[k]] ?? '').trim() : ''; const name = g('name'); if (!name) continue;
    const cat = g('cat'); let p = S.products.find(x => x.name.toLowerCase() === name.toLowerCase() && (x.category || '').toLowerCase() === cat.toLowerCase());
    const isNew = !p; p ||= { id: uid(), color: PALETTE[(S.products.length + added) % PALETTE.length] };
    Object.assign(p, { name, category: cat, unit: (g('unit') || p.unit || 'EA').toUpperCase(), price: num(g('price'), p.price || 0), labor: num(g('labor'), p.labor || 0), waste: num(g('waste'), p.waste || 0), mult: num(g('mult'), p.mult || 1) || 1 });
    if (/^#[0-9a-f]{6}$/i.test(g('color'))) p.color = g('color');
    await saveProduct(p); if (isNew) { S.products.push(p); added++; } else updated++;
  }
  refreshActiveProduct(); renderProducts(); toast(`Imported: ${added} new, ${updated} updated`);
}
function autoToolFor(p) { if (!p || !S.page || S.drawing?.pts.length) return; const t = { LF: 'length', SF: 'area', EA: 'count' }[String(p.unit).toUpperCase()]; if (t) setTool(t); }

/* ======================= CHECKLIST ======================= */
function renderChecklist() {
  $('#ckProj').textContent = S.project ? '· ' + S.project.name : '';
  const tplSel = $('#tplSelect'); tplSel.innerHTML = S.templates.length ? S.templates.map(t => `<option value="${t.id}">${esc(t.name)} (${t.items.length})</option>`).join('') : '<option value="">No templates</option>';
  const L = $('#ckList');
  if (!S.project) { L.innerHTML = '<li class="muted">Open or create a project first.</li>'; $('#ckProgress').textContent = ''; return; }
  const items = S.project.checklist, done = items.filter(c => c.done).length;
  $('#ckProgress').textContent = items.length ? `${done} of ${items.length} done` : 'No items yet. Add one above or apply a template.';
  L.innerHTML = items.map((c, i) => `<li class="ck ${c.done ? 'done' : ''}" data-id="${c.id}"><div class="ckTop">
      <input type="checkbox" ${c.done ? 'checked' : ''} data-act="done" aria-label="Done">
      <input class="ckT" value="${esc(c.text)}" data-act="text">
      <button class="small icon" data-act="notes" title="Notes">${c.notes ? '📝' : '✎'} Notes</button>
      <button class="small icon" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
      <button class="small icon" data-act="down" ${i === items.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
      <button class="small icon danger" data-act="del" title="Delete">✕</button></div>
      ${S.ckOpen.has(c.id) ? `<textarea data-act="note" placeholder="Notes…">${esc(c.notes || '')}</textarea>` : (c.notes ? `<div class="noteprev">${esc(c.notes)}</div>` : '')}</li>`).join('');
  L.querySelectorAll('.ck').forEach(li => {
    const c = items.find(x => x.id === li.dataset.id), i = items.indexOf(c);
    li.querySelector('[data-act=done]').onchange = e => { c.done = e.target.checked; touch(); renderChecklist(); };
    li.querySelector('[data-act=text]').onchange = e => { c.text = e.target.value.trim() || c.text; touch(); };
    li.querySelector('[data-act=notes]').onclick = () => { S.ckOpen.has(c.id) ? S.ckOpen.delete(c.id) : S.ckOpen.add(c.id); renderChecklist(); li.isConnected; $(`.ck[data-id="${c.id}"] textarea`)?.focus(); };
    li.querySelector('[data-act=up]').onclick = () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; touch(); renderChecklist(); };
    li.querySelector('[data-act=down]').onclick = () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; touch(); renderChecklist(); };
    li.querySelector('[data-act=del]').onclick = () => { items.splice(i, 1); touch(); renderChecklist(); };
    const ta = li.querySelector('[data-act=note]'); if (ta) ta.oninput = () => { c.notes = ta.value; touch(); };
  });
}
function addCheckItems(texts) { const have = new Set(S.project.checklist.map(c => c.text.toLowerCase())); let n = 0; for (const t of texts) { if (!t.trim() || have.has(t.trim().toLowerCase())) continue; S.project.checklist.push({ id: uid(), text: t.trim(), done: false, notes: '' }); n++; } touch(); renderChecklist(); return n; }
function templatesModal() {
  const rows = S.templates.map(t => `<div class="prow" data-id="${t.id}"><span class="pn">${esc(t.name)} <span class="muted small">${t.items.length} items</span></span><button class="small" data-act="edit">Edit</button><button class="small danger" data-act="del">Delete</button></div>`).join('') || '<p class="muted">No templates yet.</p>';
  openModal(`<h3>Checklist templates</h3><div class="plist">${rows}</div><div class="btns"><button id="tNew">+ New template</button><button data-close class="accent">Done</button></div>`, (m, close) => {
    m.querySelector('#tNew').onclick = () => { close(); editTemplate(null); };
    m.querySelectorAll('.prow').forEach(r => r.onclick = async e => {
      const act = e.target.closest('[data-act]')?.dataset.act, t = S.templates.find(x => x.id === r.dataset.id); if (!act) return;
      if (act === 'edit') { close(); editTemplate(t); }
      if (act === 'del' && await askConfirm('Delete template?', `Delete template <b>${esc(t.name)}</b>?`)) { await DB.del('templates', t.id); S.templates = S.templates.filter(x => x !== t); renderChecklist(); templatesModal(); }
    });
  });
}
function editTemplate(t) {
  const isNew = !t; t = t ? { ...t } : { id: uid(), name: '', items: [] };
  openModal(`<h3>${isNew ? 'New template' : 'Edit template'}</h3><form id="tf"><div class="field"><label>Name</label><input id="tName" value="${esc(t.name)}" required autofocus></div>
    <div class="field"><label>Items (one per line)</label><textarea id="tItems" rows="10">${esc(t.items.join('\n'))}</textarea></div>
    <div class="btns"><button type="button" data-close>Cancel</button><button class="accent">Save</button></div></form>`, (m, close) => {
    m.querySelector('#tf').onsubmit = async e => {
      e.preventDefault(); t.name = m.querySelector('#tName').value.trim(); t.items = m.querySelector('#tItems').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!t.name) return; await DB.put('templates', t); const i = S.templates.findIndex(x => x.id === t.id); if (i >= 0) S.templates[i] = t; else S.templates.push(t);
      close(); renderChecklist(); toast('Template saved');
    };
  });
}

/* ======================= BACKUP / RESTORE ======================= */
const bufToDataURL = buf => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([buf], { type: 'application/pdf' })); });
async function backupProject(id) {
  await flush(); const p = await DB.get('projects', id); if (!p) return;
  toast('Preparing backup…');
  const pdfs = []; for (const d of p.docs) { const rec = await DB.get('pdfs', d.id); if (rec) pdfs.push({ id: d.id, name: d.name, dataURL: await bufToDataURL(rec.data) }); }
  const ids = new Set(p.markups.map(m => m.productId).filter(Boolean));
  const out = { app: 'daniel-takeoff', kind: 'project-backup', format: 1, appVersion: VER, exported: new Date().toISOString(), project: p, products: S.products.filter(x => ids.has(x.id)), pdfs };
  download(`${safeName(p.name)}_${new Date().toISOString().slice(0, 10)}.dtakeoff`, new Blob([JSON.stringify(out)], { type: 'application/json' }));
  toast('Backup saved to your downloads');
}
async function restoreBackup(file) {
  let o; try { o = JSON.parse(await file.text()); } catch { return toast('That file is not a Daniel Takeoff backup'); }
  if (o?.app !== 'daniel-takeoff' || !o.project) return toast('That file is not a Daniel Takeoff backup');
  const p = o.project, docMap = {};
  const exists = await DB.get('projects', p.id);
  p.id = exists ? uid() : p.id; if (exists) p.name += ' (restored)';
  for (const d of p.docs) docMap[d.id] = (await DB.get('pdfs', d.id)) ? uid() : d.id;
  for (const pdf of o.pdfs || []) { const buf = await (await fetch(pdf.dataURL)).arrayBuffer(); await DB.put('pdfs', { id: docMap[pdf.id] || pdf.id, name: pdf.name, data: buf }); }
  p.docs = p.docs.map(d => ({ ...d, id: docMap[d.id] }));
  p.markups = p.markups.map(m => ({ ...m, docId: docMap[m.docId] || m.docId }));
  const sc = {}; for (const [k, v] of Object.entries(p.scales || {})) { const [d, pg] = k.split(':'); sc[(docMap[d] || d) + ':' + pg] = v; } p.scales = sc;
  if (p.lastDoc) p.lastDoc = docMap[p.lastDoc] || p.lastDoc;
  let addedP = 0; for (const pr of o.products || []) if (!prodById(pr.id)) { await saveProduct(pr); S.products.push(pr); addedP++; }
  p.updated = Date.now(); await DB.put('projects', p);
  refreshActiveProduct(); await openProject(p.id); toast(`Project restored${addedP ? ` (+${addedP} products)` : ''}`);
}

/* ======================= VIEWS & WIRING ======================= */
function switchView(v) {
  S.view = v; $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v)); $$('.view').forEach(s => s.classList.toggle('on', s.id === 'view-' + v));
  if (v === 'estimate') renderEstimate(); if (v === 'products') renderProducts(); if (v === 'checklist') renderChecklist();
  if (v === 'plans' && S.page) { scheduleDetail(); }
}
function refreshAll() { $('#projName').textContent = S.project?.name || 'No project'; refreshActiveProduct(); refreshPanel(); updateScaleLabel(); renderOverlay(); if (S.view !== 'plans') switchView(S.view); }
$$('#tabs button').forEach(b => b.onclick = () => switchView(b.dataset.view));
$$('.tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$('#btnProjects').onclick = projectsModal;
$('#btnAddPdf').onclick = $('#btnEmptyAdd').onclick = () => $('#filePdf').click();
$('#filePdf').onchange = async e => { await addPdfFiles(e.target.files); e.target.value = ''; };
$('#btnRemovePdf').onclick = removeCurrentPdf;
$('#docSelect').onchange = async e => { if (e.target.value) { await showPage(e.target.value, 1); renderThumbs(); } };
$('#activeProduct').onchange = e => { S.activeProductId = e.target.value; S.countId = null; updateFinish(); refreshActiveProduct(); autoToolFor(prodById(S.activeProductId)); };
$('#btnFinish').onclick = finishDrawing; $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnScale').onclick = () => scaleModal(null);
$('#zoomIn').onclick = () => zoomAt(1.3, viewer.clientWidth / 2, viewer.clientHeight / 2);
$('#zoomOut').onclick = () => zoomAt(1 / 1.3, viewer.clientWidth / 2, viewer.clientHeight / 2);
$('#zoomFit').onclick = fitPage;
$('#togglePanel').onclick = () => { $('#panel').classList.toggle('closed'); setTimeout(() => S.page && scheduleDetail(), 50); };
$('#prevPage').onclick = () => gotoPage(-1); $('#nextPage').onclick = () => gotoPage(1);
$('#btnAddManual').onclick = () => { if (!S.project) return; S.project.manual.push({ id: uid(), desc: '', unit: 'EA', qty: 1, price: 0, labor: 0 }); touch(); renderEstimate(); const ins = $$('#estTable tr[data-mid] input[data-f=desc]'); ins[ins.length - 1]?.focus(); };
$('#togPrices').onchange = e => setShowPrices(e.target.checked);
$('#btnExportCsv').onclick = exportEstimateCsv; $('#btnExportXlsx').onclick = () => exportXlsx().catch(e => { console.warn(e); toast('Excel export failed — use CSV'); }); $('#btnPrint').onclick = printSummary;
$('#btnAddProduct').onclick = () => productModal(null); $('#prodSearch').oninput = renderProducts;
$('#btnImportCsv').onclick = () => $('#fileCsv').click(); $('#btnExportProducts').onclick = exportProductsCsv;
$('#fileCsv').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await importProductsCsv(await f.text()); };
$('#fileBackup').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await restoreBackup(f); };
$('#ckAdd').onsubmit = e => { e.preventDefault(); if (!S.project) return toast('Open a project first'); const v = $('#ckText').value.trim(); if (!v) return; S.project.checklist.push({ id: uid(), text: v, done: false, notes: '' }); $('#ckText').value = ''; touch(); renderChecklist(); };
$('#btnApplyTpl').onclick = () => { if (!S.project) return; const t = S.templates.find(x => x.id === $('#tplSelect').value); if (!t) return toast('No template selected'); const n = addCheckItems(t.items); toast(`Added ${n} items from "${t.name}"`); };
$('#btnSaveTpl').onclick = async () => { if (!S.project?.checklist.length) return toast('Add some items first'); const n = await askText('Save as template', 'Template name', S.project.name + ' checklist'); if (!n) return; const t = { id: uid(), name: n, items: S.project.checklist.map(c => c.text) }; await DB.put('templates', t); S.templates.push(t); renderChecklist(); toast('Template saved'); };
$('#btnManageTpl').onclick = templatesModal;
$('#modalBack').addEventListener('pointerdown', e => { if (e.target.id === 'modalBack') { const c = $('#modal [data-close]'); c?.click(); } });
// drag & drop PDFs or backups onto the window
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => { e.preventDefault(); const fs = [...e.dataTransfer.files]; const bk = fs.find(f => /\.(dtakeoff|json)$/i.test(f.name)); if (bk) await restoreBackup(bk); else await addPdfFiles(fs); });

/* ======================= START ======================= */
async function start() {
  $('#ver').textContent = VER; document.title = 'Daniel Takeoff ' + VER;
  await DB.open(); navigator.storage?.persist?.().catch(() => { });
  S.products = await DB.all('products'); S.templates = await DB.all('templates');
  if (!(await DB.get('meta', 'seeded'))) {
    const t = { id: uid(), name: 'Standard job review', items: ['Verify ceiling height', 'Confirm hardware', 'Confirm finish / color selection', 'Field-verify wall dimensions', 'Check outlet and switch locations', 'Confirm door swings and clearances', 'Check plan revision / date', 'Confirm delivery and install access'] };
    await DB.put('templates', t); S.templates.push(t); await DB.put('meta', { id: 'seeded', at: Date.now() });
  }
  const last = await DB.get('meta', 'last'); const projects = await DB.all('projects');
  const pick = projects.find(p => p.id === last?.projectId) || projects.sort((a, b) => b.updated - a.updated)[0];
  if (pick) await openProject(pick.id); else { clearViewer(); refreshAll(); }
  setTool('select'); setSave('');
}
start().catch(e => { console.error(e); toast('Startup error: ' + e.message, 6000); });
window.DT = { S, applyT, fitPage, toScreen, toPage, computeEstimate, geo, fmtFtIn, qtyFor, flush, setTool, SCALES };

if (/^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => { reg.update().catch(() => { }); document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => { }); }); }).catch(() => { });
  let reloaded = false; const hadCtrl = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadCtrl || reloaded || S.drawing) return; reloaded = true; flush().then(() => location.reload()); });
}

/* ======================= VOICE ESTIMATOR (v1.1) ======================= */
// Parsing + matching run locally (voice.js). Speech-to-text is the browser's own Web Speech service.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let vRec = null, vRows = [];
function voiceModal() {
  if (!S.project) return toast('Open or create a project first');
  if (!S.products.length) toast('Tip: add products first so items can be matched and priced', 3500);
  const ex = '40 feet of base, two 30-inch uppers, 120 square feet of shelving';
  openModal(`<h3>Voice estimate</h3>
    <p class="muted small">Say or type items naturally, e.g. <i>"${ex}"</i>. Separate items with commas, "and", or a pause.</p>
    <div class="vMicRow"><button id="vMic" class="accent big" ${SpeechRec ? '' : 'disabled'}>🎤 Start talking</button><span id="vStatus" class="small muted">${SpeechRec ? 'Tap the mic, speak, then tap again to stop.' : "Speech isn't available in this browser. Type below instead."}</span></div>
    <textarea id="vText" placeholder="Or type here, e.g. ${ex}"></textarea>
    <div class="actions" style="margin-top:6px"><button id="vParse">Read items</button><button id="vClear">Clear</button></div>
    <div id="vRows"></div>
    <div class="btns"><button data-close>Cancel</button><button id="vAdd" class="accent" disabled>Add to estimate</button></div>
    <p class="muted small">Reading and matching happen on this device. ${SpeechRec ? 'Voice-to-text is done by the browser: on-device when it supports it, otherwise the browser maker\'s speech service. Typing never leaves the device.' : ''}</p>`, (m, close) => {
    vRows = [];
    const txt = m.querySelector('#vText');
    m.querySelector('#vParse').onclick = () => voiceParse(txt.value);
    m.querySelector('#vClear').onclick = () => { txt.value = ''; vRows = []; renderVoiceRows(); };
    txt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); voiceParse(txt.value); } });
    m.querySelector('#vMic').onclick = () => vRec ? stopVoice() : startVoice(txt);
    m.querySelector('#vAdd').onclick = () => { const n = voiceCommit(); if (n) { stopVoice(); close(); renderEstimate(); toast(`Added ${n} line${n > 1 ? 's' : ''} to the estimate`); } };
    m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', stopVoice));
    txt.focus();
  }, 'wide');
}
async function startVoice(txt) {
  const st = $('#vStatus'), btn = $('#vMic'); if (!SpeechRec || !btn) return;
  const rec = new SpeechRec(), lang = navigator.language || 'en-US';
  rec.lang = lang; rec.continuous = true; rec.interimResults = true;
  let mode = 'browser speech service';
  try {
    if ('processLocally' in rec && SpeechRec.available) {
      let a = await SpeechRec.available({ langs: [lang], processLocally: true });
      if (a === 'downloadable' || a === 'downloading') { st.textContent = 'Getting on-device speech ready…'; if (await SpeechRec.install({ langs: [lang], processLocally: true }).catch(() => false)) a = 'available'; }
      if (a === 'available') { rec.processLocally = true; mode = 'on-device'; }
    }
  } catch { }
  const base = txt.value.trim() ? txt.value.trim() + ', ' : '';
  let finals = '';
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finals += (finals ? ', ' : '') + r[0].transcript.trim(); else interim += r[0].transcript; }
    txt.value = base + finals + (interim ? (finals ? ', ' : '') + interim : '');
  };
  rec.onerror = e => {
    const msg = { 'not-allowed': 'Microphone blocked. Allow the mic for this site in browser settings.', 'service-not-allowed': 'Speech service blocked in this browser. Type instead.', 'no-speech': 'Didn\'t hear anything. Try again.', network: 'Speech service unreachable (offline?). Type instead.', 'language-not-supported': 'Speech language not supported here. Type instead.', 'audio-capture': 'No microphone found.' }[e.error] || ('Speech error: ' + e.error);
    if ($('#vStatus')) $('#vStatus').textContent = msg;
  };
  rec.onend = () => { vRec = null; const b = $('#vMic'); if (b) { b.classList.remove('live'); b.textContent = '🎤 Start talking'; } if (finals && $('#vText')) voiceParse($('#vText').value); };
  try { rec.start(); } catch (e) { st.textContent = 'Could not start the mic: ' + e.message; return; }
  vRec = rec; btn.classList.add('live'); btn.textContent = '■ Stop'; st.textContent = `Listening (${mode})… tap Stop when done.`;
}
function stopVoice() { try { vRec?.stop(); } catch { } }
function voiceParse(text) {
  vRows = voicePropose(text || '', S.products).map(r => ({ ...r, include: !!r.productId && r.qty != null }));
  renderVoiceRows();
  if (!vRows.length) toast("Couldn't find any items in that");
}
function voiceDesc(r, p) { const ds = r.dims.filter(x => !p || !p.name.includes(x.replace(/(in|ft)$/, ''))), d = ds.length ? ' (' + ds.join(', ') + ')' : ''; return p ? p.name + d : (r.words.join(' ') || r.heard) + d; }
function renderVoiceRows() {
  const box = $('#vRows'), add = $('#vAdd'); if (!box) return;
  if (!vRows.length) { box.innerHTML = ''; add.disabled = true; add.textContent = 'Add to estimate'; return; }
  box.innerHTML = `<div class="tableWrap"><table class="grid"><tr><th>Add</th><th>Heard</th><th>Product</th><th class="n">Qty</th><th>Unit</th><th>Status</th></tr>
    ${vRows.map((r, i) => {
      const p = prodById(r.productId);
      const status = !r.productId ? `<span class="vBad">⚠ ${r.warn || 'No matching product'}</span>` : r.qty == null ? '<span class="vBad">⚠ No quantity heard</span>' : r.warn ? `<span class="vWarn">⚠ ${esc(r.warn)}</span>` : `<span class="vOk">✓ ${p && computeEstimate()?.show && num(p.price) ? fmt$(num(p.price)) + '/' + esc(p.unit) : 'Matched'}</span>`;
      return `<tr data-i="${i}" class="${r.include ? '' : 'off'}"><td><input type="checkbox" data-f="include" ${r.include ? 'checked' : ''}></td><td class="small">${esc(r.heard)}</td>
        <td><select data-f="product">${productOptions(r.productId, '— No match: pick a product —')}</select></td>
        <td class="n"><input class="num" data-f="qty" inputmode="decimal" value="${r.qty == null ? '' : r.qty}"></td>
        <td><input data-f="unit" value="${esc(r.unit || '')}" style="width:62px"></td><td class="small">${status}</td></tr>`;
    }).join('')}</table></div>`;
  box.querySelectorAll('tr[data-i]').forEach(tr => {
    const r = vRows[+tr.dataset.i];
    tr.querySelector('[data-f=include]').onchange = e => { r.include = e.target.checked; renderVoiceRows(); };
    tr.querySelector('[data-f=product]').onchange = e => {
      r.productId = e.target.value; const p = prodById(r.productId);
      const res = voiceResolve({ ...r, qty: r.parsedQty, unit: r.parsedUnit }, p); r.qty = res.qty; r.unit = res.unit; r.warn = p ? res.warn : 'No matching product';
      r.include = !!p && r.qty != null; renderVoiceRows();
    };
    tr.querySelector('[data-f=qty]').onchange = e => { const v = e.target.value.trim(); r.qty = v === '' ? null : num(v, null); if (r.qty != null && r.productId) r.include = true; renderVoiceRows(); };
    tr.querySelector('[data-f=unit]').onchange = e => { r.unit = e.target.value.trim().toUpperCase(); const p = prodById(r.productId); r.warn = p && r.unit !== String(p.unit).toUpperCase() ? `Unit differs from product (${p.unit})` : ''; renderVoiceRows(); };
  });
  const n = vRows.filter(r => r.include && r.qty != null).length;
  add.disabled = !n; add.textContent = n ? `Add ${n} line${n > 1 ? 's' : ''} to estimate` : 'Add to estimate';
}
function voiceCommit() {
  let n = 0;
  for (const r of vRows) {
    if (!r.include || r.qty == null) continue; const p = prodById(r.productId);
    S.project.manual.push({ id: uid(), desc: voiceDesc(r, p), productId: p?.id || null, qty: r.qty, unit: r.unit || p?.unit || 'EA', price: p ? num(p.price) : 0, labor: p ? num(p.labor) : 0, waste: p ? num(p.waste) : 0, source: 'voice', heard: r.heard });
    n++;
  }
  if (n) touch();
  return n;
}
$('#btnVoice').onclick = voiceModal;
