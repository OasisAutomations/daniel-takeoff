// Daniel Takeoff — everything stays on this device (IndexedDB). No uploads, no analytics.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import { propose as voicePropose, resolveQty as voiceResolve } from './voice.js';
import { evaluate as fxEval, SAMPLE_VARS as FX_SAMPLE, PRESETS as FX_PRESETS, HELP_HTML as FX_HELP } from './formula.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
const VER = 'v1.7.1';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => { const n = parseFloat(String(v ?? '').replace(/[$,%\s]/g, '')); return isFinite(n) ? n : d; };
const COARSE = matchMedia('(pointer: coarse)').matches;
const PALETTE = ['#1f8a7e', '#2f6fb3', '#b5642b', '#8a4fb0', '#b23a48', '#5d8a2f', '#c49a1c', '#3d7f99', '#7a5c3e', '#4e5ab8'];
const TYPE_COLOR = { length: '#2f6fb3', area: '#1f8a7e', count: '#b5642b' };
/* v1.6: quantity markups (length/area/count) vs. annotation markups (type 'note': highlight, pen, shapes, text, callout).
   Notes never count toward quantities; both print on the marked-up drawing. Style fields are optional, so older saved
   takeoffs load unchanged and just use the defaults below. */
const QTY_TYPES = new Set(['length', 'area', 'count']);
const isQty = m => QTY_TYPES.has(m.type);
const ANN_KINDS = { highlight: 'Highlight', pen: 'Pen', line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Cloud', text: 'Text', callout: 'Callout' };
const isAnnTool = t => Object.prototype.hasOwnProperty.call(ANN_KINDS, t);
/* v1.7: drafting (plan linework). Plan lines / rectangles / dimensions are notes (never counted); walls are length markups with a
   thickness (centerline LF feeds the takeoff, wall height turns it into SF). All fields are optional, so older takeoffs load unchanged. */
const DRAFT_KINDS = { dline: 'Plan line', drect: 'Plan rectangle', dim: 'Dimension' };
const isDraftTool = t => t === 'wall' || Object.prototype.hasOwnProperty.call(DRAFT_KINDS, t);
const NOTE_NAMES = { ...ANN_KINDS, ...DRAFT_KINDS };
const SHAPE = { color: '#d1495b', width: 3, opacity: 1, dash: 'solid', fill: 'none', fillOpacity: 0.2 };
const ANN_DEF = {
  highlight: { color: '#ffd400', width: 14, opacity: 0.4, dash: 'solid' },
  pen: { color: '#d1495b', width: 3, opacity: 1, dash: 'solid' },
  line: { ...SHAPE }, arrow: { ...SHAPE }, rect: { ...SHAPE }, ellipse: { ...SHAPE }, cloud: { ...SHAPE },
  text: { color: '#d1495b', fs: 18, opacity: 1, bg: '#ffffff', border: false, bold: true },
  callout: { color: '#d1495b', width: 2.5, fs: 16, opacity: 1, bg: '#ffffff', bold: true, dash: 'solid' },
  dline: { color: '#111111', width: 1.5, opacity: 1, dash: 'solid' },
  drect: { color: '#111111', width: 1.5, opacity: 1, dash: 'solid', fill: 'none', fillOpacity: 0.2, hatch: 'none' },
  dim: { color: '#111111', width: 0.75, fs: 9, opacity: 1 },
};
const QTY_DEF = { width: 2.6, dash: 'solid', opacity: 1, fill: 'solid', fillOpacity: 0.2, hatch: 'none', showLabel: true, showValue: true };
const SWATCHES = ['#d1495b', '#ff7a00', '#ffd400', '#2fbf71', '#1f8a7e', '#2f6fb3', '#8a4fb0', '#111111', '#ffffff'];
const HATCHES = { none: 'None', diag: 'Diagonal', back: 'Back diagonal', cross: 'Crosshatch', horiz: 'Horizontal', vert: 'Vertical', grid: 'Grid', dots: 'Dots' };
const DASHES = { solid: 'Solid', dash: 'Dashed', dot: 'Dotted', dashdot: 'Dash-dot' };

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
  tool: 'select', activeProductId: '', drawing: null, countId: null, hover: null, sel: new Set(), _pri: null, multi: false, clip: null,
  undo: [], redo: [], view: 'plans', ckOpen: new Set(),
};
// Selection: S.sel is the set of selected markup ids; S.selId is the "primary" one (kept for older code paths).
Object.defineProperty(S, 'selId', { enumerable: true, get() { return this._pri; }, set(v) { this.sel = new Set(v ? [v] : []); this._pri = v || null; } });
const prodById = id => S.products.find(p => p.id === id) || null;

/* ======================= v1.7: architectural patterns & textures (extend the 8 basic hatches) ======================= */
// Basic hatches stay screen-sized (as in v1.6). Material and texture patterns are drawn in sheet units at real-world size
// (e.g. 8" brick, 16" block, 12" tile) when the page has a scale, so they zoom and print with the drawing.
const ARCH_PATS = {
  stud: { n: 'Stud wall (diagonal)', g: 'mat', ft: 4 / 12, pt: 6 }, cmu: { n: 'CMU / block', g: 'mat', ft: 8 / 12, pt: 10 },
  concrete: { n: 'Concrete', g: 'mat', ft: 1, pt: 18 }, brick: { n: 'Brick', g: 'mat', ft: 8 / 12, pt: 12 },
  insul: { n: 'Insulation (batt)', g: 'mat', ft: 3.5 / 12, pt: 7 }, gyp: { n: 'Gypsum board / drywall', g: 'mat', ft: 0.5 / 12, pt: 3 },
  wood: { n: 'Wood / plywood', g: 'mat', ft: 3 / 12, pt: 8 }, earth: { n: 'Earth', g: 'mat', ft: 1, pt: 16 },
  gravel: { n: 'Gravel', g: 'mat', ft: 4 / 12, pt: 10 }, tile: { n: 'Tile grid (12")', g: 'mat', ft: 1, pt: 14 },
  opeel: { n: 'Orange peel', g: 'tex', ft: 2 / 12, pt: 6 }, knock: { n: 'Knockdown', g: 'tex', ft: 6 / 12, pt: 14 },
  smooth: { n: 'Smooth', g: 'tex', ft: 1, pt: 20 }, popcorn: { n: 'Acoustic / popcorn', g: 'tex', ft: 2 / 12, pt: 6 },
  grain: { n: 'Wood grain', g: 'tex', ft: 1, pt: 20 }, carpet: { n: 'Carpet', g: 'tex', ft: 1.5 / 12, pt: 5 },
  tile4: { n: 'Tile (4" mosaic)', g: 'tex', ft: 4 / 12, pt: 7 },
};
for (const [k, v] of Object.entries(ARCH_PATS)) HATCHES[k] = v.n;
const HATCH_GROUPS = [['Basic', ['none', 'diag', 'back', 'cross', 'horiz', 'vert', 'grid', 'dots']],
  ['Materials', Object.keys(ARCH_PATS).filter(k => ARCH_PATS[k].g === 'mat')], ['Textures', Object.keys(ARCH_PATS).filter(k => ARCH_PATS[k].g === 'tex')]];
const kOf = m => S.project?.scales[m.docId + ':' + m.page]?.ftPerPt || null;
function rndGen(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function archCell(kind, c, s) {   // returns [w, h, svg body] for a pattern cell of base size s (sheet units)
  const lw = +clamp(s * 0.06, 0.12, 1.2).toFixed(3), L = d => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${lw}" stroke-linecap="round"/>`, r = rndGen(kind.length * 7919 + kind.charCodeAt(0));
  const f = v => +v.toFixed(3), dots = (w, h, n, r0, r1, op = 1) => { let o = ''; for (let i = 0; i < n; i++) o += `<circle cx="${f(r() * w)}" cy="${f(r() * h)}" r="${f(r0 + r() * (r1 - r0))}" fill="${c}"${op < 1 ? ` fill-opacity="${op}"` : ''}/>`; return o; };
  switch (kind) {
    case 'stud': return [s, s, L(`M0 ${s}L${s} 0M${-s / 4} ${s / 4}L${s / 4} ${-s / 4}M${s * 0.75} ${s * 1.25}L${s * 1.25} ${s * 0.75}`)];
    case 'cmu': { const w = s * 2, h = s * 2; return [w, h, L(`M0 0H${w}M0 ${s}H${w}M0 0V${s}M${s} ${s}V${h}M0 ${s}L${s} 0M${s} ${h}L${w} ${s}`)]; }
    case 'concrete': { let o = dots(s, s, 14, s * 0.012, s * 0.03); for (let i = 0; i < 3; i++) { const x = r() * s * 0.8 + s * 0.1, y = r() * s * 0.8 + s * 0.1, t = s * 0.07, a = r() * 6.28; o += `<polygon points="${[0, 2.1, 4.2].map(q => f(x + Math.cos(a + q) * t) + ',' + f(y + Math.sin(a + q) * t)).join(' ')}" fill="none" stroke="${c}" stroke-width="${lw * 0.8}"/>`; } return [s, s, o]; }
    case 'brick': { const w = s, h = s * 2.667 / 4; return [w, h, L(`M0 0H${w}M0 ${h / 2}H${w}M0 0V${h / 2}M${w / 2} ${h / 2}V${h}`)]; }
    case 'insul': { const w = s / 2, h = s; return [w, h, L(`M0 ${h / 2}C0 0 ${w / 2} 0 ${w / 2} ${h / 2}S${w} ${h} ${w} ${h / 2}`)]; }
    case 'gyp': return [s, s, dots(s, s, 3, s * 0.05, s * 0.09, 0.9)];
    case 'wood': { const w = s * 2, h = s / 2; return [w, h, L(`M0 ${h / 2}Q${w / 4} ${h * 0.05} ${w / 2} ${h / 2}T${w} ${h / 2}`)]; }
    case 'earth': return [s, s, L(`M${s * 0.05} ${s * 0.45}L${s * 0.45} ${s * 0.05}M${s * 0.15} ${s * 0.5}L${s * 0.5} ${s * 0.15}M${s * 0.25} ${s * 0.55}L${s * 0.55} ${s * 0.25}`) + dots(s, s, 4, s * 0.015, s * 0.03).replace(/cx="([\d.]+)"/g, (m, x) => `cx="${f(s * 0.55 + x * 0.4)}"`)];
    case 'gravel': { let o = ''; for (let i = 0; i < 5; i++) o += `<ellipse cx="${f(r() * s)}" cy="${f(r() * s)}" rx="${f(s * (0.07 + r() * 0.07))}" ry="${f(s * (0.05 + r() * 0.05))}" fill="none" stroke="${c}" stroke-width="${lw}"/>`; return [s, s, o]; }
    case 'tile': case 'tile4': return [s, s, L(`M0 0H${s}M0 0V${s}`)];
    case 'opeel': return [s, s, dots(s, s, 9, s * 0.02, s * 0.06, 0.75)];
    case 'knock': { let o = ''; for (let i = 0; i < 4; i++) { const x = r() * s, y = r() * s, a = s * (0.08 + r() * 0.1); o += `<path d="M${f(x)} ${f(y)}q${f(a)} ${f(-a * 0.6)} ${f(a * 1.6)} ${f(a * 0.1)}q${f(-a * 0.2)} ${f(a * 0.8)} ${f(-a * 1.1)} ${f(a * 0.6)}q${f(-a * 0.6)} ${f(-a * 0.2)} ${f(-a * 0.5)} ${f(-a * 0.7)}z" fill="${c}" fill-opacity=".35"/>`; } return [s, s, o]; }
    case 'smooth': return [s, s, `<path d="M0 ${s * 0.3}L${s * 0.3} 0M${s * 0.5} ${s}L${s} ${s * 0.5}" stroke="${c}" stroke-opacity=".25" stroke-width="${lw}"/>`];
    case 'popcorn': { let o = ''; for (let i = 0; i < 7; i++) o += `<circle cx="${f(r() * s)}" cy="${f(r() * s)}" r="${f(s * (0.05 + r() * 0.07))}" fill="none" stroke="${c}" stroke-width="${lw * 0.8}"/>`; return [s, s, o]; }
    case 'grain': { const w = s, h = s / 4; return [w, h, L(`M0 ${h * 0.3}C${w * 0.3} ${h * 0.1} ${w * 0.6} ${h * 0.5} ${w} ${h * 0.3}M0 ${h * 0.75}C${w * 0.25} ${h * 0.95} ${w * 0.55} ${h * 0.55} ${w} ${h * 0.75}`)]; }
    case 'carpet': { let o = ''; for (let i = 0; i < 8; i++) { const x = r() * s, y = r() * s, a = r() * 6.28, t = s * 0.08; o += `M${f(x)} ${f(y)}l${f(Math.cos(a) * t)} ${f(Math.sin(a) * t)}`; } return [s, s, `<path d="${o}" stroke="${c}" stroke-width="${lw}" stroke-linecap="round" stroke-opacity=".8"/>`]; }
  }
  return [s, s, ''];
}
function archDef(id, kind, color, k, cell) {
  const P = ARCH_PATS[kind], s = cell || clamp(k ? P.ft / k : P.pt, P.g === 'tex' ? P.pt * 0.75 : 1.5, 400), [w, h, body] = archCell(kind, color, s);
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${+w.toFixed(3)}" height="${+h.toFixed(3)}">${body}</pattern>`;
}
function patId(defs, pre, kind, color, z, k) {   // registers the pattern in defs (once) and returns its id
  const id = pre + kind + '-' + String(color).replace(/[^\w]/g, '') + (ARCH_PATS[kind] && k ? '-' + Math.round(1 / k) : '');
  if (!defs.has(id)) defs.set(id, ARCH_PATS[kind] ? archDef(id, kind, color, k) : hatchDef(id, kind, color, z));
  return id;
}
let patIconN = 0;
function patIcon(k, px) { const id = 'pic' + (++patIconN), P = ARCH_PATS[k]; if (!P) return ''; return `<svg viewBox="0 0 24 24" width="${px}" height="${px}"><defs>${archDef(id, k, 'currentColor', null, P.pt * 0.9)}</defs><rect x=".5" y=".5" width="23" height="23" fill="url(#${id})" stroke="currentColor" stroke-opacity=".5"/></svg>`; }
function legendSwatch(a, pre) {
  const defs = new Map(), id = patId(defs, pre + 'lg' + (++patIconN) + '-', a.hatch, a.color, 1.4, null);
  return `<svg class="lgsw" viewBox="0 0 28 16" width="28" height="16" style="vertical-align:middle;margin-right:6px"><defs>${[...defs.values()].join('')}</defs><rect width="28" height="16" fill="${a.color}" fill-opacity=".15"/><rect width="28" height="16" fill="url(#${id})" stroke="${a.color}" stroke-width="1"/></svg>`;
}

/* ======================= v1.7: walls (length markups with real thickness) ======================= */
const WALL_PRESETS = {
  w2x4: { n: '2x4 stud, 1/2" drywall both sides (4-1/2")', core: 3.5, gwb: 0.5, hatch: 'stud' },
  w2x6: { n: '2x6 stud, 1/2" drywall both sides (6-1/2")', core: 5.5, gwb: 0.5, hatch: 'stud' },
  m358: { n: '3-5/8" metal stud, 5/8" GWB both sides (4-7/8")', core: 3.625, gwb: 0.625, hatch: 'insul' },
  custom: { n: 'Custom', core: 4, gwb: 0, hatch: 'stud' },
};
const wallTotalIn = w => (+w.core || 0) + 2 * (+w.gwb || 0);
const wallThkPt = m => { const k = kOf(m); return k ? wallTotalIn(m.wall) / 12 / k : 4; };
function offsetLine(pts, d, closed) {   // mitered offset of a polyline (sheet units); positive d = left of travel direction
  const n = pts.length, out = [], N = (a, b) => { const L = dist(a, b) || 1; return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]; };
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? pts[i - 1] : closed ? pts[n - 2] : null, next = i < n - 1 ? pts[i + 1] : closed ? pts[1] : null, p = pts[i];
    if (!prev) { const q = N(p, next); out.push([p[0] + q[0] * d, p[1] + q[1] * d]); continue; }
    if (!next) { const q = N(prev, p); out.push([p[0] + q[0] * d, p[1] + q[1] * d]); continue; }
    const a = N(prev, p), b = N(p, next), mx = a[0] + b[0], my = a[1] + b[1], ml = Math.hypot(mx, my);
    if (ml < 1e-6) { out.push([p[0] + a[0] * d, p[1] + a[1] * d]); continue; }
    const cos = (mx * a[0] + my * a[1]) / ml, k = d / Math.max(cos, 0.25);
    out.push([p[0] + mx / ml * k, p[1] + my / ml * k]);
  }
  return out;
}
function wallSVG(m, st, z, sel, defs, pre, lab) {
  const k = kOf(m), w = m.wall, P = m.pts; if (P.length < 2) return '';
  const closed = P.length > 3 && dist(P[0], P[P.length - 1]) < 1e-6, T = wallThkPt(m), g = k ? (+w.gwb || 0) / 12 / k : 0, c = st.color;
  const lw = clamp(+st.width || 1, 0.25, 8), edges = [-T / 2, -T / 2 + g, T / 2 - g, T / 2].filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-9);
  const band = (a, b) => { const A = offsetLine(P, a, closed), B = offsetLine(P, b, closed).reverse(); return pp(A.concat(B)); };
  let h = `<polygon points="${band(-T / 2, T / 2)}" fill="#fff" stroke="none"/>`;
  const core = st.hatch && st.hatch !== 'none' && HATCHES[st.hatch] ? patId(defs, pre, st.hatch, c, z, k) : null;
  if (g > 0) { const gy = patId(defs, pre, 'gyp', c, z, k); h += `<polygon points="${band(-T / 2, -T / 2 + g)}" fill="url(#${gy})"/><polygon points="${band(T / 2 - g, T / 2)}" fill="url(#${gy})"/>`; }
  if (core) h += `<polygon points="${band(-T / 2 + g, T / 2 - g)}" fill="url(#${core})"/>`;
  if (st.fill !== 'none' && st.fillOpacity > 0 && !core) h += `<polygon points="${band(-T / 2, T / 2)}" fill="${c}" fill-opacity="${st.fillOpacity}"/>`;
  if (sel) h += `<polygon points="${band(-T / 2, T / 2)}" fill="none" stroke="#ffd23f" stroke-width="${3 / z}" stroke-linejoin="miter"/>`;
  for (const [i, e] of edges.entries()) { const o = offsetLine(P, e, closed), outer = i === 0 || i === edges.length - 1; h += `<polyline points="${pp(o)}" fill="none" stroke="${c}" stroke-width="${outer ? lw : lw * 0.5}" stroke-linejoin="miter"/>`; }
  if (!closed) for (const i of [0, P.length - 1]) { const a = offsetLine(P, -T / 2, false)[i], b = offsetLine(P, T / 2, false)[i]; h += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="${lw}"/>`; }
  if (lab) { const e = P[P.length - 1]; h += pill(e[0] + 8 / z, e[1] - 10 / z, lab, c, 'start', z); }
  return h;
}
function wallPresetHTML(w, pre) {
  return `<div class="fxRow wallp"><label class="sg"><span>Wall type</span><select id="${pre}Preset">${Object.entries(WALL_PRESETS).map(([k, v]) => `<option value="${k}" ${w.preset === k ? 'selected' : ''}>${esc(v.n)}</option>`).join('')}</select></label>
    <label class="sg"><span>Core in</span><input id="${pre}Core" inputmode="decimal" value="${+w.core}" style="width:64px"></label><label class="sg"><span>Board each side in</span><input id="${pre}Gwb" inputmode="decimal" value="${+w.gwb}" style="width:64px"></label>
    <span class="small muted">Total ${fmtN(wallTotalIn(w), 3).replace(/\.?0+$/, '')}"</span></div>`;
}
function bindWallPreset(root, pre, set) {
  const ps = root.querySelector('#' + pre + 'Preset'), co = root.querySelector('#' + pre + 'Core'), gw = root.querySelector('#' + pre + 'Gwb'); if (!ps) return;
  ps.onchange = () => { const v = WALL_PRESETS[ps.value]; set({ preset: ps.value, core: v.core, gwb: v.gwb }, v.hatch); };
  const cust = () => { const c = parseInches(co.value), g = parseInches(gw.value); if (!(c > 0) || !(g >= 0)) return toast('Enter the wall thickness in inches'); set({ preset: 'custom', core: c, gwb: g }); };
  co.onchange = cust; gw.onchange = cust;
}
const wallTool = () => ({ preset: 'w2x4', core: 3.5, gwb: 0.5, ...(UI.wall || {}) });

/* ======================= v1.7: drafting (grid, snaps, typed lengths, dimensions) ======================= */
const gridPt = () => { const k = curScale()?.ftPerPt; return k ? (UI.gridFt || 1) / k : 18; };
function gridSVG(z) {
  if (!UI.grid || !S.W) return '';
  let g = gridPt(); while (g * z < 6) g *= 5;
  return `<defs><pattern id="gridp" patternUnits="userSpaceOnUse" width="${g}" height="${g}"><path d="M${g} 0H0V${g}" fill="none" stroke="#5b9bd5" stroke-opacity=".45" stroke-width="${0.6 / z}"/></pattern></defs><rect x="0" y="0" width="${S.W}" height="${S.H}" fill="url(#gridp)" pointer-events="none"/>`;
}
function snapTargets() {   // endpoints and midpoints of everything on this page (plan linework and takeoff markups)
  const out = [], seg = (a, b) => out.push(a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  for (const m of pageMarkups()) {
    const p = m.pts || []; if (m.type === 'count') continue;
    if (!isQty(m) && ['rect', 'drect', 'ellipse', 'cloud'].includes(m.kind)) { const b = box2(p), C = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]; C.forEach((c, i) => seg(c, C[(i + 1) % 4])); continue; }
    if (!isQty(m) && ['text', 'callout', 'highlight', 'pen'].includes(m.kind)) continue;
    for (let i = 1; i < p.length; i++) seg(p[i - 1], p[i]);
    if (m.type === 'area' && p.length > 2) seg(p[p.length - 1], p[0]);
  }
  for (const q of S.drawing?.pts || []) out.push(q);
  return out;
}
// v1.7.1: snap reach is a finger/cursor radius on screen, but never more than 2'-0" of real length (or 2% of the sheet
// unscaled), so zoomed-out phone views don't grab far-away points; and never less than 8 screen px so it still works.
function snapTol() {
  const px = (COARSE ? 16 : 11) / S.z, k = curScale()?.ftPerPt, cap = k ? 2 / k : 0.02 * Math.max(S.W || 0, S.H || 0, 400);
  return Math.max(8 / S.z, Math.min(px, cap));
}
function snapPoint(q, shift) {
  S.snapHit = null;
  if (UI.osnap !== false) {
    const tol = snapTol(); let best = null, bd = tol;
    for (const t of snapTargets()) { const d = dist(t, q); if (d < bd) { bd = d; best = t; } }
    if (best) { S.snapHit = best; return best.slice(); }
  }
  let p = constrain(q, shift);
  if (UI.gsnap) { const g = gridPt(), d = S.drawing, last = d?.pts[d.pts.length - 1], o = (shift || UI.ortho) && last;
    p = [o && p[0] === last[0] ? p[0] : Math.round(p[0] / g) * g, o && p[1] === last[1] ? p[1] : Math.round(p[1] / g) * g]; }
  return p;
}
function snapMark() { const h = S.snapHit; if (!h) return ''; const s = 7 / S.z; return `<rect x="${h[0] - s}" y="${h[1] - s}" width="${2 * s}" height="${2 * s}" fill="none" stroke="#ff7a00" stroke-width="${2 / S.z}"/>`; }
function prevPill(e, lab, c, z) { const fs = 15 / z, w = lab.length * 0.62 * fs + 14 / z; return `<rect x="${e[0] + 10 / z}" y="${e[1] + 16 / z - fs * 0.75}" width="${w}" height="${fs * 1.5}" rx="${6 / z}" fill="#0f151a" fill-opacity=".92" stroke="${c}" stroke-width="${1.8 / z}"/><text class="lbl" x="${e[0] + 17 / z}" y="${e[1] + 16.5 / z}" font-size="${fs}" dominant-baseline="middle">${esc(lab)}</text>`; }
const angOf = (a, b) => { let d = Math.atan2(a[1] - b[1], b[0] - a[0]) * 180 / Math.PI; return d < 0 ? d + 360 : d; };   // 0 = right, 90 = up
function dimGeo(m) {
  const [a, b] = m.pts; if (!a || !b) return null; const L = dist(a, b) || 1, n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L], o = +m.off || 0;
  return { a, b, n, a2: [a[0] + n[0] * o, a[1] + n[1] * o], b2: [b[0] + n[0] * o, b[1] + n[1] * o], o };
}
const dimText = m => { const k = kOf(m), L = dist(m.pts[0], m.pts[1] || m.pts[0]); return k ? fmtFtIn(L * k) : 'set scale'; };
function dimSVG(m, st, z) {
  const G = dimGeo(m); if (!G) return ''; const c = st.color, w = Math.max(+st.width || 0.75, 0.4 / z), fs = clamp(+st.fs || 9, 2, 200), t = fs * 0.45, sg = Math.sign(G.o) || 1, gap = Math.min(Math.abs(G.o), fs * 0.3);
  const ext = (p, p2) => `<line x1="${p[0] + G.n[0] * gap * sg}" y1="${p[1] + G.n[1] * gap * sg}" x2="${p2[0] + G.n[0] * t * sg}" y2="${p2[1] + G.n[1] * t * sg}" stroke="${c}" stroke-width="${w * 0.8}"/>`;
  const L = dist(G.a2, G.b2) || 1, u = [(G.b2[0] - G.a2[0]) / L, (G.b2[1] - G.a2[1]) / L], tick = p => `<line x1="${p[0] - (u[0] + G.n[0]) * t * 0.7}" y1="${p[1] - (u[1] + G.n[1]) * t * 0.7}" x2="${p[0] + (u[0] + G.n[0]) * t * 0.7}" y2="${p[1] + (u[1] + G.n[1]) * t * 0.7}" stroke="${c}" stroke-width="${w * 2}"/>`;
  let ang = Math.atan2(u[1], u[0]) * 180 / Math.PI; if (ang > 89.99) ang -= 180; else if (ang <= -90.01) ang += 180;   // text reads from the bottom or the right
  const mx = (G.a2[0] + G.b2[0]) / 2, my = (G.a2[1] + G.b2[1]) / 2, tx = mx + G.n[0] * sg * fs * 0.62, ty = my + G.n[1] * sg * fs * 0.62;   // outside the measured object
  return (Math.abs(G.o) > 1e-6 ? ext(G.a, G.a2) + ext(G.b, G.b2) : '') + `<line x1="${G.a2[0]}" y1="${G.a2[1]}" x2="${G.b2[0]}" y2="${G.b2[1]}" stroke="${c}" stroke-width="${w}"/>` + tick(G.a2) + tick(G.b2)
    + `<text x="${tx}" y="${ty}" font-size="${fs}" fill="${c}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, Arial, sans-serif" stroke="#fff" stroke-width="${fs * 0.22}" paint-order="stroke" transform="rotate(${ang} ${tx} ${ty})">${esc(dimText(m))}</text>`;
}
function draftPreview(d) {
  const z = S.z, pts = d.pts.slice(), hv = S.hover; let h = '';
  const ghost = { id: 'pv', docId: S.docId, page: S.pageNum, label: '' };
  if (d.type === 'dim') {
    if (pts.length === 1 && hv) pts.push(hv);
    if (pts.length >= 2) { const m = { ...ghost, type: 'note', kind: 'dim', pts: pts.slice(0, 2), style: annToolStyle('dim'), off: 0 }; if (d.pts.length === 2 && hv) { const G = dimGeo(m); m.off = (hv[0] - G.a[0]) * G.n[0] + (hv[1] - G.a[1]) * G.n[1]; } h += annSVG(m, z, false); }
  } else if (d.type === 'drect') { if (pts.length === 1 && hv) pts.push(hv); if (pts.length === 2) { h += annSVG({ ...ghost, type: 'note', kind: 'drect', pts, style: annToolStyle('drect') }, z, false); const k = curScale()?.ftPerPt; if (k) h += prevPill(pts[1], `${fmtFtIn(Math.abs(pts[1][0] - pts[0][0]) * k)} × ${fmtFtIn(Math.abs(pts[1][1] - pts[0][1]) * k)}`, '#2f6fb3', z); } }
  else {
    if (hv && pts.length) pts.push(hv);
    if (pts.length >= 2) {
      if (d.type === 'wall') { const m = { ...ghost, type: 'length', wall: wallTool(), pts, productId: S.activeProductId || null, style: wallToolStyle() }, dm = new Map(), body = wallSVG(m, styleOf(m), z, false, dm, 'pvw-', ''); h += `<defs>${[...dm.values()].join('')}</defs>` + body; }
      else h += annSVG({ ...ghost, type: 'note', kind: 'dline', pts, style: annToolStyle('dline') }, z, false);
    }
    for (const p of d.pts) h += `<circle cx="${p[0]}" cy="${p[1]}" r="${3.5 / z}" fill="#fff" stroke="#2f6fb3" stroke-width="${1.4 / z}"/>`;
    const k = curScale()?.ftPerPt;
    if (k && pts.length >= 2) { const a = pts[pts.length - 2], b = pts[pts.length - 1]; h += prevPill(b, `${fmtFtIn(dist(a, b) * k)} @ ${Math.round(angOf(a, b) * 10) / 10}°` + (pts.length > 2 ? ` · total ${fmtFtIn(polyLen(pts) * k)}` : ''), '#2f6fb3', z); }
  }
  return h;
}
const wallToolStyle = () => { const p = prodById(S.activeProductId), h = (UI.ann?.wall || {}).hatch; return p?.style?.hatch ? {} : h ? { hatch: h } : {}; };
function draftTap(p, now) {
  const d = S.drawing, t = d.type, last = d.pts[d.pts.length - 1];
  if (last && (t === 'dline' || t === 'wall')) {
    if (now - (S.lastTap || 0) < 380 && dist(last, p) * S.z < 12) { S.lastTap = 0; finishDraft(); return; }
    if (d.pts.length >= 3 && dist(d.pts[0], p) * S.z < 12) { d.pts.push(d.pts[0].slice()); finishDraft(); return; }
  }
  S.lastTap = now;
  if (t === 'dim' && d.pts.length === 2) { const G = dimGeo({ pts: d.pts }); d.off = (p[0] - G.a[0]) * G.n[0] + (p[1] - G.a[1]) * G.n[1]; finishDraft(); return; }
  if (last && dist(last, p) < 1e-6) return;
  d.pts.push(p); updateFinish(); renderPreview(); renderDock();
  if (t === 'drect' && d.pts.length === 2) finishDraft();
}
function finishDraft() {
  const d = S.drawing; if (!d) return; const t = d.type, need = 2;
  if (d.pts.length < need) { toast(t === 'drect' ? 'Tap the opposite corner, or type width × height' : 'Needs at least 2 points'); return; }
  if (t === 'drect') { const b = box2(d.pts); if (b.x1 - b.x0 < 1e-6 || b.y1 - b.y0 < 1e-6) return toast('The rectangle needs a width and a height'); }
  S.drawing = null; S.hover = null; S.snapHit = null;
  if (t === 'wall') {
    pushUndo();
    const m = { id: uid(), type: 'length', docId: S.docId, page: S.pageNum, pts: d.pts.map(p => [rr2(p[0]), rr2(p[1])]), productId: S.activeProductId || null, label: '', height: UI.wallArea ? (UI.wallH > 0 ? UI.wallH : 9) : null, color: S.activeProductId ? null : '#333333', wall: wallTool(), created: Date.now() };
    const st = wallToolStyle(); if (Object.keys(st).length) m.style = st;
    S.project.markups.push(m); S.selId = m.id; touch(); updateFinish(); renderOverlay(); refreshPanel(); markThumb(); return m;
  }
  const m = addNote(t, d.pts); if (t === 'dim') { m.off = rr2(d.off || 0); renderOverlay(); }
  updateFinish(); renderDock(); return m;
}
function parseFtIn(s) {   // 10'6"  10' 6 1/2"  10'-6"  10.5  126"  → feet
  s = String(s ?? '').trim().replace(/[’′]/g, "'").replace(/[”″]/g, '"'); if (!s) return NaN;
  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*'\s*-?\s*(.*)$/); if (m) { const i = m[2] ? parseInches(m[2]) : 0; return isFinite(i) ? +m[1] + i / 12 : NaN; }
  if (/"$|in$/i.test(s)) { const i = parseInches(s); return isFinite(i) ? i / 12 : NaN; }
  m = s.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\s+\d+\/\d+)?|\d+\/\d+)$/); if (m) { const i = parseInches(m[2]); return +m[1] + i / 12; }
  const v = parseFloat(s); return /^-?\d+(\.\d+)?$/.test(s) ? v : NaN;
}
function typedSegment(lenStr, angStr) {
  const d = S.drawing, k = curScale()?.ftPerPt; if (!k) { toast('Set the page scale first'); return false; }
  if (!d?.pts.length) { toast('Tap the start point on the plan first'); return false; }
  const L = parseFtIn(lenStr); if (!(L > 0)) { toast('Type a length like 10\'6"'); return false; }
  const last = d.pts[d.pts.length - 1], prevA = d.pts.length > 1 ? angOf(d.pts[d.pts.length - 2], last) : 0, A = String(angStr).trim() === '' ? prevA : num(angStr, 0), r = A * Math.PI / 180, dp = L / k;
  d.pts.push([last[0] + Math.cos(r) * dp, last[1] - Math.sin(r) * dp]); S.hover = null; updateFinish(); renderPreview(); return true;
}
function typedRect(wStr, hStr) {
  const d = S.drawing, k = curScale()?.ftPerPt; if (!k) { toast('Set the page scale first'); return false; }
  if (!d?.pts.length) { toast('Tap a corner on the plan first'); return false; }
  const W = parseFtIn(wStr), H = parseFtIn(hStr); if (!(W > 0) || !(H > 0)) { toast('Type width and height like 12\' and 10\''); return false; }
  const p = d.pts[0]; d.pts = [p, [p[0] + W / k, p[1] - H / k]]; finishDraft(); return true;
}
function toggleDraftOpt(k) { UI[k] = k === 'osnap' ? UI.osnap === false : !UI[k]; saveUI(); renderOverlay(); renderDock(true); toast(`${{ grid: 'Grid', gsnap: 'Snap to grid', ortho: 'Ortho', osnap: 'Snap to points' }[k]} ${(k === 'osnap' ? UI.osnap !== false : UI[k]) ? 'on' : 'off'}`, 1200); }

/* ======================= v1.7: blank pages (a real one-page PDF built in the browser) ======================= */
// v1.7.1: full grouped sheet list. Sizes are portrait (w < h) in PDF points; keys of v1.7.0 (letter, tabloid, archd) are kept.
const inS = (n, tag, wi, hi, g) => ({ n, tag, w: wi * 72, h: hi * 72, g }), mmS = (n, wmm, hmm) => ({ n: `${n} (${wmm}x${hmm} mm)`, tag: n, w: +(wmm / 25.4 * 72).toFixed(2), h: +(hmm / 25.4 * 72).toFixed(2), g: 'ISO' });
const BLANK_SIZES = {
  letter: inS('Letter 8.5x11', '8.5x11', 8.5, 11, 'ANSI'), legal: inS('Legal 8.5x14', '8.5x14', 8.5, 14, 'ANSI'), tabloid: inS('Tabloid / ANSI B 11x17', '11x17', 11, 17, 'ANSI'),
  ansic: inS('ANSI C 17x22', '17x22', 17, 22, 'ANSI'), ansid: inS('ANSI D 22x34', '22x34', 22, 34, 'ANSI'), ansie: inS('ANSI E 34x44', '34x44', 34, 44, 'ANSI'),
  archa: inS('Arch A 9x12', '9x12', 9, 12, 'Architectural'), archb: inS('Arch B 12x18', '12x18', 12, 18, 'Architectural'), archc: inS('Arch C 18x24', '18x24', 18, 24, 'Architectural'),
  archd: inS('Arch D 24x36', '24x36', 24, 36, 'Architectural'), arche1: inS('Arch E1 30x42', '30x42', 30, 42, 'Architectural'), arche: inS('Arch E 36x48', '36x48', 36, 48, 'Architectural'),
  a4: mmS('A4', 210, 297), a3: mmS('A3', 297, 420), a2: mmS('A2', 420, 594), a1: mmS('A1', 594, 841), a0: mmS('A0', 841, 1189),
  custom: { n: 'Custom W x H inches', tag: 'custom', g: 'Custom' },
};
const fmtIn = v => String(+(+v).toFixed(3));
function sheetDims(o) {   // → { w, h, tag } in PDF points for the chosen size + orientation (custom: W x H inches, max 200")
  let B = BLANK_SIZES[o.size] || BLANK_SIZES.tabloid;
  if (o.size === 'custom') { const cw = clamp(+o.cw || 0, 1, 200), ch = clamp(+o.ch || 0, 1, 200); B = { tag: `${fmtIn(Math.min(cw, ch))}x${fmtIn(Math.max(cw, ch))}`, w: Math.min(cw, ch) * 72, h: Math.max(cw, ch) * 72 }; }
  const land = o.orient !== 'port'; return { w: land ? B.h : B.w, h: land ? B.w : B.h, tag: B.tag, land };
}
const BLANK_SCALES = ['1/8"', '1/4"', '1/2"', '1"', '3"'];
function blankPdf(w, h) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> /Contents 4 0 R >>`, '<< /Length 0 >>\nstream\n\nendstream'];
  let s = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}
const blankOpts = () => ({ size: 'tabloid', orient: 'land', scale: '1/4"', cw: 24, ch: 18, ...(UI.blank || {}) });
async function addBlankPage(o = blankOpts()) {
  if (o.size === 'custom' && !(+o.cw > 0 && +o.ch > 0)) { toast('Type the custom sheet width and height in inches'); return null; }
  const { w, h, tag, land } = sheetDims(o);
  const n = (S.project?.docs || []).filter(d => d.blank).length + 1, name = `Blank page ${n} (${tag})`;
  const sc = SCALES.find(s => s.group === 'Architectural' && s.label === `${o.scale} = 1'-0"`);
  const f = new File([blankPdf(w, h)], name + '.pdf', { type: 'application/pdf' });
  const id = await addPdfFiles([f], { docName: name, projectName: 'Blank plan', blank: { size: o.size, orient: land ? 'land' : 'port', ...(o.size === 'custom' ? { cw: +o.cw, ch: +o.ch } : {}) }, scale: sc ? { ftPerPt: sc.ftPerPt, label: sc.label } : null, toast: `${name} added${sc ? ' · scale ' + sc.label : ''}` });
  if (id) { updateScaleLabel(); renderOverlay(); refreshPanel(); }
  return id;
}
function sizeSelectHTML(id, o) {
  const groups = [...new Set(Object.values(BLANK_SIZES).map(v => v.g))];
  return `<select id="${id}" title="Sheet size">${groups.map(g => `<optgroup label="${g}">${Object.entries(BLANK_SIZES).filter(([, v]) => v.g === g).map(([k, v]) => `<option value="${k}" ${o.size === k ? 'selected' : ''}>${v.n}</option>`).join('')}</optgroup>`).join('')}</select>`;
}
const sizeBits = (pre, o) => `${sizeSelectHTML(pre + 'Size', o)}<span class="cwh${o.size === 'custom' ? '' : ' hidden'}" id="${pre}Cwh"><input id="${pre}Cw" inputmode="decimal" value="${esc(fmtIn(o.cw || 24))}" title="Custom width, inches" style="width:54px"><span class="small">×</span><input id="${pre}Ch" inputmode="decimal" value="${esc(fmtIn(o.ch || 18))}" title="Custom height, inches" style="width:54px"><span class="small">in</span></span>
    <select id="${pre}Or" title="Orientation"><option value="land" ${o.orient !== 'port' ? 'selected' : ''}>Landscape</option><option value="port" ${o.orient === 'port' ? 'selected' : ''}>Portrait</option></select>`;
function readSizeBits(root, pre) {
  const q = s => root.querySelector('#' + pre + s), o = { size: q('Size').value, orient: q('Or').value };
  if (o.size === 'custom') { o.cw = parseInches(q('Cw').value); o.ch = parseInches(q('Ch').value); }
  return o;
}
function bindSizeBits(root, pre, on) {
  const q = s => root.querySelector('#' + pre + s);
  q('Size').addEventListener('change', () => q('Cwh').classList.toggle('hidden', q('Size').value !== 'custom'));
  ['Size', 'Or', 'Cw', 'Ch'].forEach(k => q(k).addEventListener('change', on));
}
function blankFormHTML(pre) {
  const o = blankOpts();
  return `<div class="fxRow blankf">${sizeBits(pre, o)}
    <select id="${pre}Sc" title="Sheet scale (set automatically)">${BLANK_SCALES.map(s => `<option value='${s}' ${o.scale === s ? 'selected' : ''}>${s} = 1'-0"</option>`).join('')}<option value="" ${o.scale === '' ? 'selected' : ''}>No scale</option></select>
    <button class="accent${pre === 'eb' ? ' big' : ' small'}" id="${pre}Go">Blank page…</button></div>`;
}
function bindBlankForm(root, pre) {
  const g = () => { const o = { ...blankOpts(), ...readSizeBits(root, pre), scale: root.querySelector('#' + pre + 'Sc').value }; if (!(o.cw > 0)) o.cw = blankOpts().cw; if (!(o.ch > 0)) o.ch = blankOpts().ch; return o; };
  bindSizeBits(root, pre, () => { UI.blank = g(); saveUI(); }); root.querySelector('#' + pre + 'Sc').onchange = () => { UI.blank = g(); saveUI(); };
  root.querySelector('#' + pre + 'Go').onclick = async () => { const o = g(); UI.blank = o; saveUI(); await addBlankPage(o); };
}
// v1.7.1: change an existing blank page's sheet size. The page PDF is rebuilt; markups keep their place measured from the
// sheet's top-left corner (same scale), so nothing moves on the drawing.
async function resizeBlank(docId, o) {
  const d = S.project?.docs.find(x => x.id === docId); if (!d?.blank) return;
  if (o.size === 'custom' && !(o.cw > 0 && o.ch > 0)) return toast('Type the custom sheet width and height in inches');
  const { w, h, tag, land } = sheetDims(o), buf = blankPdf(w, h).buffer;
  const name = /\([^)]*\)\s*$/.test(d.name) ? d.name.replace(/\([^)]*\)\s*$/, `(${tag})`) : `${d.name} (${tag})`;
  const pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf.slice(0)) }).promise;
  await DB.put('pdfs', { id: d.id, name, data: buf });
  S.docs.get(d.id)?.destroy?.(); S.docs.set(d.id, pdf);
  d.name = name; d.blank = { size: o.size, orient: land ? 'land' : 'port', ...(o.size === 'custom' ? { cw: o.cw, ch: o.ch } : {}) };
  const off = S.project.markups.filter(m => m.docId === d.id && m.pts?.some(p => p[0] > w || p[1] > h)).length;
  touch(); await flush(); refreshDocSelect(); await showPage(d.id, 1); renderThumbs();
  toast(`Sheet is now ${tag}${land ? ' landscape' : ' portrait'}${off ? ` · ${off} markup${off > 1 ? 's' : ''} reach past the new edge` : ''}`, 3500);
}
function sheetFormHTML(d) {
  const o = { cw: 24, ch: 18, ...d.blank };
  return `<div class="dsec"><b class="small">This sheet</b> <span class="muted small">${esc(d.name)}</span><div class="fxRow blankf">${sizeBits('sz', o)}<button class="small" id="szGo">Change sheet size</button></div></div>`;
}
function bindSheetForm(root, d) {
  if (!root.querySelector('#szGo')) return; bindSizeBits(root, 'sz', () => { });
  root.querySelector('#szGo').onclick = () => resizeBlank(d.id, readSizeBits(root, 'sz'));
}
const curDoc = () => S.project?.docs.find(d => d.id === S.docId) || null;
// v1.7.1: pattern key: a grid of hatched plan rectangles with labels, at real size on scaled sheets. One undo step.
function insertPatternKey() {
  if (!S.page) return; const k = curScale()?.ftPerPt, sw = k ? 2 / k : 36, gap = sw * 1.3, fs = clamp(sw * 0.19, 4, 40), cols = 6, x0 = 36, y0 = 36;
  pushUndo(); const add = (kind, pts, extra) => { const m = { id: uid(), type: 'note', kind, docId: S.docId, page: S.pageNum, pts: pts.map(p => [rr2(p[0]), rr2(p[1])]), text: '', label: '', created: Date.now(), ...extra }; S.project.markups.push(m); return m; };
  let y = y0; const ids = [];
  for (const [title, keys] of HATCH_GROUPS.slice(1)) {
    ids.push(add('text', [[x0, y]], { text: title + (k ? ` (2'-0" squares, ${curScale().label})` : ''), style: { ...ANN_DEF.text, color: '#111111', fs: fs * 1.25, bg: 'none', border: false } }).id); y += fs * 2.4;
    keys.forEach((h, i) => {
      const cx = x0 + (i % cols) * (sw + gap), cy = y + Math.floor(i / cols) * (sw + fs * 3.2);
      ids.push(add('drect', [[cx, cy], [cx + sw, cy + sw]], { style: { ...ANN_DEF.drect, width: 1, hatch: h } }).id);
      ids.push(add('text', [[cx, cy + sw + fs * 0.3]], { text: HATCHES[h], style: { ...ANN_DEF.text, color: '#111111', fs, bold: false, bg: 'none', border: false } }).id);
    });
    y += Math.ceil(keys.length / cols) * (sw + fs * 3.2) + fs;
  }
  S.sel = new Set(ids); S._pri = ids[0]; touch(); renderOverlay(); refreshPanel(); markThumb(); toast('Pattern key added · move it with the selection, or ↶ to undo', 3000);
}
function mountEmptyBlank() { const el = $('#emptyBlank'); if (!el) return; el.innerHTML = blankFormHTML('eb'); bindBlankForm(el, 'eb'); }

/* ---- the Draw tab in the bottom dock: blank pages, drafting tools, typed lengths, grid / snaps ---- */
function dockDraw(body) {
  const tg = (k, label, on, tip) => `<label class="chk small" title="${tip}"><input type="checkbox" data-dopt="${k}" ${on ? 'checked' : ''}> ${label}</label>`;
  const blank = `<div class="dsec"><b class="small">New blank page</b> ${blankFormHTML('bp')}</div>`;
  if (!S.project || !S.page) { body.innerHTML = `<div class="dhead"><b>Draw your own plan</b><span class="muted small">Start a blank sheet; the scale is set for you so takeoffs measure right away.</span></div>${blank}`; bindBlankForm(body, 'bp'); return; }
  const t = S.tool, d = S.drawing && isDraftTool(S.drawing.type) || (S.drawing && (S.drawing.type === 'length' || S.drawing.type === 'area')) ? S.drawing : null, k = curScale();
  const tools = [['dline', 'Line / polyline'], ['drect', 'Rectangle'], ['wall', 'Wall'], ['dim', 'Dimension']];
  let typed = '';
  if (t === 'drect') typed = `<form id="dwRect" class="fxRow"><span class="small">Width</span><input id="dwW" placeholder="12'" style="width:80px" autocomplete="off"><span class="small">× Height</span><input id="dwH" placeholder="10'" style="width:80px" autocomplete="off"><button class="small accent">Place</button><span class="muted small">${d?.pts.length ? 'from the corner you tapped (right and up)' : 'tap a corner on the plan first'}</span></form>`;
  else if (['dline', 'wall', 'length', 'area'].includes(t)) typed = `<form id="dwSeg" class="fxRow"><span class="small">Length</span><input id="dwL" placeholder="10'6&quot;" style="width:86px" autocomplete="off"><span class="small">Angle°</span><input id="dwA" inputmode="decimal" placeholder="0" style="width:56px" autocomplete="off">
    ${[['0', '→'], ['90', '↑'], ['180', '←'], ['270', '↓']].map(([a, s]) => `<button type="button" class="small" data-ang="${a}" title="${a}°">${s}</button>`).join('')}<button class="small accent">Add segment</button><button type="button" class="small" id="dwFin" ${d?.pts.length > 1 ? '' : 'disabled'}>✓ Finish</button>
    <span class="muted small">${d?.pts.length ? '0° = right, 90° = up. Blank angle keeps the last direction.' : 'Tap the start point on the plan first.'}</span></form>`;
  const sty = isDraftTool(t) ? (t === 'wall' ? `${wallPresetHTML(wallTool(), 'dw')}${styleHTML({ ...QTY_DEF, hatch: 'stud', width: 1, color: prodById(S.activeProductId)?.color || '#333333', ...(prodById(S.activeProductId)?.style || {}), ...wallToolStyle() }, ['hatch'], 'wall')}<div class="fxRow"><label class="chk small" title="New walls take their area: centerline LF × height"><input type="checkbox" id="dwWA" ${UI.wallArea ? 'checked' : ''}> Wall area = LF × height</label><input id="dwWH" inputmode="decimal" value="${esc(String(UI.wallH || 9))}" style="width:52px" title="Wall height, feet"><span class="small">ft high</span></div>
    <p class="muted small">Walls count centerline LF for the product picked in the toolbar. With wall area on (or a height set in Properties) they count SF instead, unless the product's unit is LF.</p>`
    : styleHTML(annToolStyle(t), STYLE_FIELDS[t], t)) : '';
  body.innerHTML = `<div class="dgrid"><div class="dcol">
    <div class="dhead"><b>Draw</b><span class="muted small">Plan linework: lines, rectangles and dimensions print on the drawing but never count. ${k ? 'Scale ' + esc(k.label) + '.' : '<b>Set a scale</b> to type exact lengths.'}</span></div>
    <div class="fxRow">${tools.map(([v, n]) => `<button type="button" class="small${t === v ? ' accent' : ''}" data-dtool="${v}">${n}</button>`).join('')}</div>
    ${typed}
    <div class="fxRow">${tg('grid', 'Grid', UI.grid, 'Show a grid (G)')}<input id="dwGrid" style="width:58px" value="${esc(fmtFtIn(UI.gridFt || 1).replace(/-0"$/, ''))}" title="Grid spacing (real feet when the page has a scale)">${tg('gsnap', 'Snap to grid', UI.gsnap, 'Points land on the grid')}${tg('osnap', 'Snap to ends / midpoints', UI.osnap !== false, 'Points jump to nearby endpoints and midpoints')}${tg('ortho', 'Ortho', UI.ortho, 'Lock to horizontal / vertical (O, or hold Shift)')}</div>
    <div class="fxRow"><button type="button" class="small" id="dwKey" title="Drop a labelled key of every material hatch and surface texture on this sheet (plan linework, never counted)">Insert pattern key</button></div>
    ${curDoc()?.blank ? sheetFormHTML(curDoc()) : ''}
    ${blank}
  </div><div class="dcol grow">${sty}</div></div>`;
  bindBlankForm(body, 'bp'); if (curDoc()?.blank) bindSheetForm(body, curDoc());
  body.querySelector('#dwKey').onclick = insertPatternKey;
  const wa = body.querySelector('#dwWA'), wh = body.querySelector('#dwWH');
  if (wa) { wa.onchange = () => { UI.wallArea = wa.checked; saveUI(); }; wh.onchange = () => { const v = parseFtIn(wh.value); if (v > 0) { UI.wallH = +v.toFixed(4); saveUI(); } else toast('Wall height like 9 or 8\'6"'); }; }
  body.querySelectorAll('[data-dtool]').forEach(b => b.onclick = () => setTool(b.dataset.dtool));
  body.querySelectorAll('[data-dopt]').forEach(c => c.onchange = () => toggleDraftOpt(c.dataset.dopt));
  const gi = body.querySelector('#dwGrid'); gi.onchange = () => { const v = parseFtIn(gi.value); if (v > 0) { UI.gridFt = v; saveUI(); renderOverlay(); } else toast('Grid spacing like 1\' or 6"'); };
  const seg = body.querySelector('#dwSeg');
  if (seg) {
    const L = seg.querySelector('#dwL'), A = seg.querySelector('#dwA');
    seg.onsubmit = e => { e.preventDefault(); if (typedSegment(L.value, A.value)) { L.value = ''; L.focus(); const f = seg.querySelector('#dwFin'); if (f) f.disabled = !(S.drawing?.pts.length > 1); } };
    seg.querySelectorAll('[data-ang]').forEach(b => b.onclick = () => { A.value = b.dataset.ang; L.focus(); });
    seg.querySelector('#dwFin').onclick = () => finishDrawing();
  }
  const rf = body.querySelector('#dwRect'); if (rf) rf.onsubmit = e => { e.preventDefault(); typedRect(rf.querySelector('#dwW').value, rf.querySelector('#dwH').value); };
  if (t === 'wall') {
    bindWallPreset(body, 'dw', (w, hatch) => { UI.wall = w; if (hatch) { UI.ann = UI.ann || {}; UI.ann.wall = { ...(UI.ann.wall || {}), hatch }; } saveUI(); renderPreview(); renderDock(true); });
    bindStyle(body.querySelector('.dcol.grow .stl'), (key, v, final) => { UI.ann = UI.ann || {}; UI.ann.wall = { ...(UI.ann.wall || {}), [key]: v }; saveUI(); if (final) renderDock(true); });
  } else if (isDraftTool(t)) bindStyle(body.querySelector('.dcol.grow'), (key, v, final) => { UI.ann = UI.ann || {}; UI.ann[t] = { ...(UI.ann[t] || {}), [key]: v }; saveUI(); if (final) renderDock(true); });
}

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
async function addPdfFiles(files, opt = {}) {
  files = [...files].filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)); if (!files.length) return null;
  if (!S.project) await createProject(opt.projectName || files[0].name.replace(/\.pdf$/i, ''));
  let first = null;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer(), name = opt.docName || f.name;
      const d = await pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf.slice(0)) }).promise;
      const id = uid(); await DB.put('pdfs', { id, name, data: buf });
      S.docs.set(id, d); S.project.docs.push({ id, name, pages: d.numPages, ...(opt.blank ? { blank: opt.blank } : {}) }); first ||= id;
      if (opt.scale) S.project.scales[id + ':1'] = { ...opt.scale };
    } catch (e) { console.warn(e); toast(`Couldn't open ${f.name}`); }
  }
  await flush();
  if (first) { refreshDocSelect(); await showPage(first, 1); renderThumbs(); toast(opt.toast || 'PDF added'); }
  return first;
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
// v1.3 crisp rendering:
//  - #stage holds only a low-res full-page "base" canvas. It is CSS-scaled and is just a fallback that shows while panning/zooming.
//  - #detailCanvas sits in screen space (never CSS-scaled once settled): after zoom/pan settles, pdf.js re-renders the visible
//    part of the page at exactly zoom × devicePixelRatio, capped for tablet limits. In between, a CSS transform keeps it aligned.
//  - Markups are SVG in screen space; only a <g> transform changes, so the browser draws vectors at full device resolution.
const viewer = $('#viewer'), stage = $('#stage'), baseC = $('#baseCanvas'), detC = $('#detailCanvas'), svg = $('#overlay'), world = $('#world');
const pageKey = (d = S.docId, p = S.pageNum) => d + ':' + p;
const curScale = () => S.project?.scales[pageKey()] || null;
const pageMarkups = () => (S.project?.markups || []).filter(m => m.docId === S.docId && m.page === S.pageNum);
const MAX_PIX = 16e6 * 0.98, MAX_SIDE = COARSE ? 4096 : 8192;   // stay under iOS/Android canvas limits
const offC = document.createElement('canvas');                  // one reusable offscreen buffer (iOS leaks memory if canvases are churned)
let detState = null;                                           // {z, tx, ty, sx, sy, w, h, k} of the last detail render

function clearViewer() {
  S.page = null; S.docId = null; stage.style.display = 'none'; detC.style.display = 'none'; detState = null;
  $('#empty').style.display = ''; $('#pageNav').style.display = 'none';
  world.innerHTML = ''; updateScaleLabel(); refreshPanel();
}
async function showPage(docId, pageNum, fit = true) {
  const tok = ++S.token;
  const pdf = await getPdf(docId); pageNum = clamp(pageNum, 1, pdf.numPages);
  const page = await pdf.getPage(pageNum); if (tok !== S.token) return;
  cancelDrawing(); S.selId = null;
  S.docId = docId; S.pageNum = pageNum; S.page = page;
  const vp = page.getViewport({ scale: 1 }); S.W = vp.width; S.H = vp.height;
  for (const el of [stage, baseC]) { el.style.width = S.W + 'px'; el.style.height = S.H + 'px'; }
  stage.style.display = ''; $('#empty').style.display = 'none'; $('#pageNav').style.display = '';
  detC.style.display = 'none'; detState = null;
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
  const maxSide = COARSE ? 2048 : 3072;   // fallback only — kept modest so tablets stay fast
  const b = Math.min(maxSide / Math.max(S.W, S.H), 2, Math.sqrt(6e6 / (S.W * S.H)));
  const vp = page.getViewport({ scale: b });
  try { baseTask?.cancel(); } catch { }
  baseC.width = Math.floor(vp.width); baseC.height = Math.floor(vp.height);
  baseTask = page.render({ canvasContext: baseC.getContext('2d'), viewport: vp });
  try { await baseTask.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') return; throw e; }
  if (tok !== S.token) return;
  S.baseRes = b; scheduleDetail(0);
}
let detT = null, detTask = null;
function scheduleDetail(ms = 140) { clearTimeout(detT); detT = setTimeout(renderDetail, ms); }
// device-pixel scale actually used: zoom × DPR, reduced only if the visible region would exceed the canvas caps
function detailScale(w, h) {
  const dpr = window.devicePixelRatio || 1;
  return dpr * Math.min(1, Math.sqrt(MAX_PIX / (w * h * dpr * dpr)), MAX_SIDE / (w * dpr), MAX_SIDE / (h * dpr));
}
async function renderDetail() {
  const page = S.page; if (!page) return;
  if (G && (G.type === 'pinch' || G.type === 'pan')) { scheduleDetail(); return; }   // wait until the gesture settles
  const vw = viewer.clientWidth, vh = viewer.clientHeight;
  // visible part of the page, in screen CSS px, snapped outward to whole px
  const sx = Math.max(0, Math.floor(S.tx)), sy = Math.max(0, Math.floor(S.ty));
  const ex = Math.min(vw, Math.ceil(S.tx + S.W * S.z)), ey = Math.min(vh, Math.ceil(S.ty + S.H * S.z));
  if (ex <= sx || ey <= sy) { detC.style.display = 'none'; detState = null; return; }
  const w = ex - sx, h = ey - sy, k = detailScale(w, h);
  if (detState && detState.z === S.z && detState.tx === S.tx && detState.ty === S.ty && detState.w === w && detState.h === h && detState.k === k) { positionDetail(); return; }
  const pw = Math.round(w * k), ph = Math.round(h * k), z = S.z, tx = S.tx, ty = S.ty, tok = S.token;
  const vp = page.getViewport({ scale: z * k, offsetX: (tx - sx) * k, offsetY: (ty - sy) * k });
  try { detTask?.cancel(); } catch { }
  offC.width = pw; offC.height = ph;
  detTask = page.render({ canvasContext: offC.getContext('2d', { alpha: false }), viewport: vp });
  try { await detTask.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') return; throw e; }
  if (tok !== S.token) return;
  if (detC.width !== pw || detC.height !== ph) { detC.width = pw; detC.height = ph; }
  detC.getContext('2d', { alpha: false }).drawImage(offC, 0, 0);
  offC.width = offC.height = 1;   // release the buffer's memory right away
  detC.style.width = w + 'px'; detC.style.height = h + 'px'; detC.style.display = 'block';
  detState = { z, tx, ty, sx, sy, w, h, k };
  positionDetail();
  if (S.z !== z || S.tx !== tx || S.ty !== ty) scheduleDetail();   // view moved while rendering
}
function positionDetail() {   // keep the last sharp render aligned with the page while the view moves (identity once settled)
  if (!detState) return;
  const d = detState, s = S.z / d.z, ox = S.tx - d.tx * s, oy = S.ty - d.ty * s;
  detC.style.transform = (s === 1 && ox === 0 && oy === 0) ? `translate(${d.sx}px,${d.sy}px)` : `translate(${s * d.sx + ox}px,${s * d.sy + oy}px) scale(${s})`;
}
let ovT = 0;
function applyT() {
  stage.style.transform = `translate(${S.tx}px,${S.ty}px) scale(${S.z})`;
  world.setAttribute('transform', `translate(${S.tx} ${S.ty}) scale(${S.z})`);
  $('#zoomLabel').textContent = Math.round(S.z * 75) + '%';   // 100% = real paper size (1pt = 1/72")
  positionDetail(); scheduleDetail();
  if (S.z !== S.ovZ) { clearTimeout(ovT); ovT = setTimeout(renderOverlay, 90); }   // rebuild label/marker sizes once zoom settles
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
  if (!isQty(m)) return { note: true };
  if (m.type === 'count') return { ea: m.pts.length };
  const k = S.project.scales[m.docId + ':' + m.page]?.ftPerPt; if (!k) return { noscale: true };
  if (m.type === 'length') { const lf = polyLen(m.pts) * k; return { lf, sf: m.height > 0 ? lf * m.height : null }; }
  return { sf: shoelace(m.pts) * k * k, lf: polyLen(m.pts, true) * k };
}
// Quantity formula variables for one markup (see formula.js). Every value is a plain number.
function fxVars(m, g, base, prod) {
  const len = m.type === 'count' ? 0 : (g.lf || 0), area = m.type === 'count' ? 0 : (g.sf || 0);
  const per = m.type === 'count' ? 0 : (g.lf || 0), cnt = m.type === 'count' ? g.ea : 1;
  return { length: len, lf: len, area, sf: area, perimeter: per, count: cnt, ea: cnt, height: m.height > 0 ? m.height : 0, qty: base, mult: prod?.mult > 0 ? prod.mult : 1 };
}
const formulaOf = (m, prod) => String(m.formula || '').trim() || String(prod?.formula || '').trim();   // v1.6: a markup can override its product's formula
function qtyFor(m, prod) {   // quantity in the product's unit
  if (!isQty(m)) return null;
  const g = geo(m); if (g.noscale) return null;
  const base = qtyDefault(m, g, prod), f = prod ? formulaOf(m, prod) : '';
  if (f) { try { return fxEval(f, fxVars(m, g, base, prod)); } catch { return base; } }
  return base;
}
function qtyDefault(m, g, prod) {
  const u = String(prod?.unit || '').toUpperCase(), mult = prod?.mult > 0 ? prod.mult : 1;
  if (m.type === 'count') return g.ea * mult;
  if (m.type === 'length') return (u !== 'LF' && g.sf != null ? g.sf : g.lf) * mult;   // wall height set → SF (unless product is LF)
  return (u === 'LF' ? g.lf : g.sf) * mult;
}
const nativeUnit = m => m.type === 'count' ? 'EA' : m.type === 'length' ? (m.height > 0 ? 'SF' : 'LF') : 'SF';
const noteText = m => String(m.text || '').replace(/\s+/g, ' ').trim();
function valueText(m) {
  if (!isQty(m)) { const t = noteText(m); return t ? (t.length > 28 ? t.slice(0, 27) + '…' : t) : ''; }
  const g = geo(m); if (g.noscale) return 'set scale';
  if (m.type === 'count') return g.ea + ' EA';
  if (m.type === 'length') return fmtFtIn(g.lf) + (g.sf != null ? ` × ${fmtFtIn(m.height)} = ${fmtN(g.sf)} SF` : '');
  return fmtN(g.sf) + ' SF' + (S.project.settings.showPerim ? ` · P ${fmtFtIn(g.lf)}` : '');
}
function styleOf(m) {   // effective look: defaults, then the product's style (like an OST condition), then this markup's own overrides
  if (!isQty(m)) return { ...(ANN_DEF[m.kind] || SHAPE), ...(m.style || {}) };
  const p = prodById(m.productId), s = { ...QTY_DEF, ...(m.wall ? { hatch: 'stud', width: 1 } : {}), ...(p?.style || {}), ...(m.style || {}) };
  s.color = m.style?.color || p?.color || m.color || TYPE_COLOR[m.type];
  return s;
}
const colorOf = m => styleOf(m).color;
const markName = m => { if (!isQty(m)) return NOTE_NAMES[m.kind] || 'Markup'; const p = prodById(m.productId); return (p ? p.name : (m.wall ? 'Wall' : { length: 'Length', area: 'Area', count: 'Count' }[m.type])) + (m.label ? ' – ' + m.label : ''); };

/* ---------- overlay ---------- */
const pp = pts => pts.map(p => p[0] + ',' + p[1]).join(' ');
const DASH = { dash: [4, 2.5], dot: [0.01, 2], dashdot: [5, 2, 0.01, 2] };
const dashAttr = (d, w) => DASH[d] ? ` stroke-dasharray="${DASH[d].map(x => +(x * w).toFixed(3)).join(' ')}"` : '';
function pill(x, y, s, col, anchor, z) {   // value labels: dark pills with big bold white text, always screen-sized
  const fs = 15 / z, w = s.length * 0.62 * fs + 14 / z, hh = fs * 1.5, x0 = anchor === 'start' ? x : x - w / 2;
  return `<rect x="${x0}" y="${y - hh / 2}" width="${w}" height="${hh}" rx="${6 / z}" fill="#0f151a" fill-opacity=".92" stroke="${col}" stroke-width="${1.8 / z}"/><text class="lbl" x="${x0 + 7 / z}" y="${y + 0.5 / z}" font-size="${fs}" text-anchor="start" dominant-baseline="middle">${esc(s)}</text>`;
}
function hatchDef(id, kind, color, z) {   // SVG pattern; spacing stays the same on screen at any zoom (and in print)
  const s = 9 / z, w = 1.1 / z;
  const body = kind === 'dots' ? `<circle cx="${s / 2}" cy="${s / 2}" r="${1.2 / z}" fill="${color}"/>`
    : `<line x1="0" y1="${s / 2}" x2="${s}" y2="${s / 2}" stroke="${color}" stroke-width="${w}"/>` + (kind === 'cross' || kind === 'grid' ? `<line x1="${s / 2}" y1="0" x2="${s / 2}" y2="${s}" stroke="${color}" stroke-width="${w}"/>` : '');
  const rot = { diag: -45, back: 45, cross: 45, vert: 90 }[kind] || 0;
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${s}" height="${s}"${rot ? ` patternTransform="rotate(${rot})"` : ''}>${body}</pattern>`;
}
function pillText(m, st) { return [st.showLabel !== false && m.label ? m.label : '', st.showValue !== false ? valueText(m) : ''].filter(Boolean).join(' · '); }
function qtySVG(m, z, sel, defs, pre, labs) {
  const st = styleOf(m), c = st.color, w = clamp(+st.width || QTY_DEF.width, 0.5, 30), sw = sel ? w + 1.4 : w, P = pp(m.pts), lab = pillText(m, st);
  const da = dashAttr(st.dash, sw), NS = 'vector-effect="non-scaling-stroke"'; let h = '';
  if (m.type === 'length' && m.wall) h = wallSVG(m, st, z, sel, defs, pre, labs ? '' : lab);
  else if (m.type === 'length') {
    if (sel) h += `<polyline points="${P}" fill="none" stroke="#fff" stroke-width="${sw + 3}" ${NS} stroke-linejoin="round" opacity=".8"/>`;
    h += `<polyline points="${P}" fill="none" stroke="${c}" stroke-width="${sw}" ${NS} stroke-linejoin="round" stroke-linecap="round"${da}/>`;
    if (lab && !labs) { const e = m.pts[m.pts.length - 1]; h += pill(e[0] + 8 / z, e[1] - 10 / z, lab, c, 'start', z); }
  } else if (m.type === 'area') {
    if (st.fill !== 'none') h += `<polygon points="${P}" fill="${c}" fill-opacity="${st.fillOpacity}" stroke="none"/>`;
    if (st.hatch && st.hatch !== 'none' && HATCHES[st.hatch]) h += `<polygon points="${P}" fill="url(#${patId(defs, pre, st.hatch, c, z, kOf(m))})" stroke="none"/>`;
    if (sel) h += `<polygon points="${P}" fill="none" stroke="#fff" stroke-width="${sw + 3}" ${NS} stroke-linejoin="round"/>`;
    h += `<polygon points="${P}" fill="none" stroke="${c}" stroke-width="${sw}" ${NS} stroke-linejoin="round"${da}/>`;
    if (lab && !labs) { const [cx, cy] = centroid(m.pts); h += pill(cx, cy, lab, c, 'middle', z); }
  } else {
    const nd = String(m.pts.length).length, r = ((nd >= 3 ? 15 : nd === 2 ? 13 : 12) + (sel ? 2 : 0)) / z, nfs = (nd >= 3 ? 14 : 16) / z;
    m.pts.forEach((p, i) => { h += `<circle cx="${p[0]}" cy="${p[1]}" r="${r}" fill="${c}" stroke="${sel ? '#ffd23f' : '#fff'}" stroke-width="${(sel ? 3 : 2) / z}"/><text class="cnum" x="${p[0]}" y="${p[1] + 0.5 / z}" font-size="${nfs}" stroke-width="${3.4 / z}" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`; });
    if (m.pts.length && lab && !labs) { const p = m.pts[m.pts.length - 1]; h += pill(p[0] + (r + 4 / z), p[1] - (r + 4 / z), lab, c, 'start', z); }
  }
  if (lab && labs && m.pts.length) labs.push({ m, s: lab, c, op: st.opacity });
  return `<g${st.opacity < 1 ? ` opacity="${st.opacity}"` : ''}>${h}</g>`;
}
/* ---- annotation geometry (page units: they scale with the sheet, like Bluebeam markups, and print the same) ---- */
const box2 = pts => { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };
const inBox = (q, b) => q[0] >= b.x0 && q[0] <= b.x1 && q[1] >= b.y0 && q[1] <= b.y1;
const mctx = document.createElement('canvas').getContext('2d');
function textLayout(m, st) {
  const fs = clamp(+st.fs || 16, 2, 800), pad = fs * 0.35, lh = fs * 1.25, raw = String(m.text || ''), lines = (raw || ' ').split('\n');
  mctx.font = `${st.bold ? 700 : 400} 100px system-ui, "Segoe UI", Arial, sans-serif`;
  const tw = Math.max(...lines.map(l => mctx.measureText(l).width)) * fs / 100;
  const a = m.kind === 'callout' ? m.pts[1] : m.pts[0];
  return { x: a[0], y: a[1], w: Math.max(tw, fs * 2) + pad * 2, h: lines.length * lh + pad * 2, fs, pad, lh, lines, empty: !raw.trim() };
}
function bboxOf(m) {
  if (m.type === 'note' && (m.kind === 'text' || m.kind === 'callout')) {
    const t = textLayout(m, styleOf(m)); const b = { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h };
    if (m.kind === 'callout') { const p = m.pts[0]; b.x0 = Math.min(b.x0, p[0]); b.y0 = Math.min(b.y0, p[1]); b.x1 = Math.max(b.x1, p[0]); b.y1 = Math.max(b.y1, p[1]); }
    return b;
  }
  return box2(m.pts);
}
function cloudPath(b) {   // revision cloud: outward bulging arcs around the box, traced clockwise
  const W = b.x1 - b.x0, H = b.y1 - b.y0; if (W < 0.5 || H < 0.5) return `M${b.x0} ${b.y0}`;
  const L = clamp(Math.min(W, H) / 4, 5, 40), C = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]; let d = `M${b.x0} ${b.y0}`;
  for (let i = 0; i < 4; i++) {
    const a = C[i], e = C[(i + 1) % 4], len = dist(a, e), n = Math.max(1, Math.round(len / L)), r = len / n * 0.6;
    for (let j = 1; j <= n; j++) d += ` A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${(a[0] + (e[0] - a[0]) * j / n).toFixed(2)} ${(a[1] + (e[1] - a[1]) * j / n).toFixed(2)}`;
  }
  return d + 'Z';
}
function arrowHead(a, b, w, z, c) {   // filled head at b, pointing from a to b; returns [svg, base point]
  const L = Math.max(w * 4, 10 / z), d = dist(a, b) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d, bx = b[0] - ux * L, by = b[1] - uy * L, hw = L * 0.42;
  return [`<polygon points="${b[0]},${b[1]} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}" fill="${c}" stroke="none"/>`, [bx, by]];
}
function textSVG(m, st, framed) {
  const t = textLayout(m, st), c = st.color; let h = '';
  if ((st.bg && st.bg !== 'none') || framed || st.border) h += `<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="${t.fs * 0.15}" fill="${st.bg && st.bg !== 'none' ? st.bg : 'none'}"${framed || st.border ? ` stroke="${c}" stroke-width="${Math.max(+st.width || 1.5, t.fs * 0.06)}"` : ''}/>`;
  const lines = t.empty ? ['Text'] : t.lines;
  h += `<text class="at" x="${t.x + t.pad}" y="${t.y + t.pad + t.fs * 0.92}" font-size="${t.fs}" fill="${c}"${t.empty ? ' fill-opacity=".45"' : ''} font-weight="${st.bold ? 700 : 400}">${lines.map((l, i) => `<tspan x="${t.x + t.pad}"${i ? ` dy="${t.lh}"` : ''}>${esc(l) || ' '}</tspan>`).join('')}</text>`;
  return h;
}
function annSVG(m, z, sel, defs, pre = 'h-') {
  const st = styleOf(m), c = st.color, k = m.kind, p = m.pts; if (!p?.length) return '';
  const w = Math.max(+st.width || 0, 1.2 / z), cap = k === 'highlight' ? 'butt' : 'round';
  const stroke = `stroke="${c}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="${cap}"${dashAttr(st.dash, w)}`;
  const fill = st.fill && st.fill !== 'none' ? `fill="${c}" fill-opacity="${st.fillOpacity ?? 0.2}"` : 'fill="none"';
  let h = '';
  if (k === 'highlight' || k === 'pen') h = p.length === 1 ? `<circle cx="${p[0][0]}" cy="${p[0][1]}" r="${w / 2}" fill="${c}"/>` : `<polyline points="${pp(p)}" fill="none" ${stroke}/>`;
  else if (k === 'line') h = `<line x1="${p[0][0]}" y1="${p[0][1]}" x2="${p[1][0]}" y2="${p[1][1]}" ${stroke}/>`;
  else if (k === 'arrow') { const [hd, bs] = arrowHead(p[0], p[1], w, z, c); h = `<line x1="${p[0][0]}" y1="${p[0][1]}" x2="${bs[0]}" y2="${bs[1]}" ${stroke}/>` + hd; }
  else if (k === 'rect') { const b = box2(p); h = `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" ${fill} ${stroke}/>`; }
  else if (k === 'ellipse') { const b = box2(p); h = `<ellipse cx="${(b.x0 + b.x1) / 2}" cy="${(b.y0 + b.y1) / 2}" rx="${(b.x1 - b.x0) / 2}" ry="${(b.y1 - b.y0) / 2}" ${fill} ${stroke}/>`; }
  else if (k === 'cloud') h = `<path d="${cloudPath(box2(p))}" ${fill} ${stroke}/>`;
  else if (k === 'dline') h = p.length === 1 ? `<circle cx="${p[0][0]}" cy="${p[0][1]}" r="${w / 2}" fill="${c}"/>` : `<polyline points="${pp(p)}" fill="none" ${stroke.replace('stroke-linejoin="round"', 'stroke-linejoin="miter"')}/>`;
  else if (k === 'drect') { const b = box2(p), own = !defs; defs ||= new Map(); const hid = st.hatch && st.hatch !== 'none' && HATCHES[st.hatch] ? patId(defs, pre + (own ? 'pv-' : ''), st.hatch, c, z, kOf(m)) : null;
    h = (own && hid ? `<defs>${[...defs.values()].join('')}</defs>` : '') + `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" ${fill} stroke="none"/>` + (hid ? `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="url(#${hid})" stroke="none"/>` : '') + `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="none" ${stroke.replace('stroke-linejoin="round"', 'stroke-linejoin="miter"')}/>`; }
  else if (k === 'dim') h = dimSVG(m, st, z);
  else if (k === 'text') h = textSVG(m, st, false);
  else if (k === 'callout') {
    const t = textLayout(m, st), tip = p[0], e = [clamp(tip[0], t.x, t.x + t.w), clamp(tip[1], t.y, t.y + t.h)];
    const [hd, bs] = arrowHead(e, tip, w, z, c);
    if (dist(e, tip) > 1e-6) h += `<line x1="${e[0]}" y1="${e[1]}" x2="${bs[0]}" y2="${bs[1]}" ${stroke}/>` + hd;
    h += textSVG(m, st, true);
  }
  let o = `<g${(st.opacity ?? 1) < 1 ? ` opacity="${st.opacity}"` : ''}>${h}</g>`;
  if (sel) { const b = bboxOf(m), pd = 5 / z; o += `<rect x="${b.x0 - pd}" y="${b.y0 - pd}" width="${b.x1 - b.x0 + 2 * pd}" height="${b.y1 - b.y0 + 2 * pd}" fill="none" stroke="#ffd23f" stroke-width="${1.6 / z}" stroke-dasharray="${5 / z} ${3 / z}"/>`; }
  return o;
}
// v1.7.1 layers: plan (walls, plan lines/rects, dimensions) → takeoff → notes → value labels. Labels are placed where they
// don't sit on plan linework or across a gap in it (door openings), nor on each other.
const PLAN_KINDS = new Set(['dline', 'drect', 'dim']);
function markupsSVG(ms, z, isSel, pre = 'h-') {
  const defs = new Map(), labs = []; let plan = '', take = '', note = '';
  for (const m of ms) {
    if (isQty(m)) { const r = qtySVG(m, z, isSel(m), defs, pre, labs); if (m.wall) plan += r; else take += r; }
    else if (PLAN_KINDS.has(m.kind)) plan += annSVG(m, z, isSel(m), defs, pre); else note += annSVG(m, z, isSel(m), defs, pre);
  }
  return (defs.size ? `<defs>${[...defs.values()].join('')}</defs>` : '') + plan + take + note + placeLabels(labs, ms, z);
}
function planObstacles(ms) {   // segments a label should not cover: plan linework, wall faces, dimension lines/text, and gaps
  const segs = [], ends = [], add = (a, b) => segs.push([a, b]);
  for (const m of ms) {
    const p = m.pts || [];
    if (m.wall) { const k = kOf(m), T = k ? wallTotalIn(m.wall) / 12 / k : 4; for (const d of [-T / 2, T / 2]) { const o = offsetLine(p, d, false); for (let i = 1; i < o.length; i++) add(o[i - 1], o[i]); } if (p.length > 1) ends.push(p[0], p[p.length - 1]); continue; }
    if (isQty(m) || !PLAN_KINDS.has(m.kind)) continue;
    if (m.kind === 'drect') { const b = box2(p), C = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]; C.forEach((c, i) => add(c, C[(i + 1) % 4])); continue; }
    if (m.kind === 'dim') { const G = dimGeo(m); if (!G) continue; add(G.a2, G.b2); const fs = +styleOf(m).fs || 9, sg = Math.sign(G.o) || 1, mx = (G.a2[0] + G.b2[0]) / 2 + G.n[0] * sg * fs * 0.62, my = (G.a2[1] + G.b2[1]) / 2 + G.n[1] * sg * fs * 0.62, hw = dimText(m).length * fs * 0.32; add([mx - hw, my], [mx + hw, my]); add([mx, my - fs * 0.6], [mx, my + fs * 0.6]); continue; }
    for (let i = 1; i < p.length; i++) add(p[i - 1], p[i]);
    if (p.length > 1 && dist(p[0], p[p.length - 1]) > 1e-6) ends.push(p[0], p[p.length - 1]);
  }
  // a gap (door/window opening) = an open end and the nearest other open end within ~6' (or 108 pt unscaled)
  const k = S.project && ms[0] ? kOf(ms[0]) : null, reach = k ? 6 / k : 108;
  ends.forEach((a, i) => { let best = null, bd = reach; ends.forEach((b, j) => { if (i !== j) { const d = dist(a, b); if (d > 1e-6 && d < bd) { bd = d; best = b; } } }); if (best) add(a, best); });
  return segs;
}
function segHitsBox(a, b, x0, y0, x1, y1) {   // Liang-Barsky clip test
  let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
    const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
function placeLabels(labs, ms, z) {
  if (!labs.length) return '';
  const obs = planObstacles(ms), placed = [], fs = 15 / z, hh = fs * 1.5, pad = 3 / z; let out = '';
  for (const L of labs) {
    const m = L.m, w = L.s.length * 0.62 * fs + 14 / z, cands = [];
    if (m.type === 'area') { const [cx, cy] = centroid(m.pts), B = box2(m.pts); cands.push([cx, cy]); for (const dy of [-1.4, 1.4, -2.8, 2.8]) if (cy + dy * hh > B.y0 + hh && cy + dy * hh < B.y1 - hh) cands.push([cx, cy + dy * hh]); }   // stay inside the area
    else if (m.type === 'count') { const p = m.pts[m.pts.length - 1], r = 16 / z; cands.push([p[0] + r + w / 2, p[1] - r], [p[0] - r - w / 2, p[1] - r], [p[0] + r + w / 2, p[1] + r], [p[0] - r - w / 2, p[1] + r]); }
    else {
      const P = m.pts, closed = P.length > 3 && dist(P[0], P[P.length - 1]) < 1e-6, c0 = centroid(P), half = m.wall ? wallThkPt(m) / 2 : 0;
      const segs = []; for (let i = 1; i < P.length; i++) segs.push([P[i - 1], P[i]]); segs.sort((a, b) => dist(b[0], b[1]) - dist(a[0], a[1]));
      for (const [a, b] of segs) {
        const len = dist(a, b) || 1, n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        for (const t of [0.5, 0.25, 0.75]) {
          const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const sides = closed && ((q[0] + n[0] - c0[0]) ** 2 + (q[1] + n[1] - c0[1]) ** 2 < (q[0] - c0[0]) ** 2 + (q[1] - c0[1]) ** 2) ? [-1, 1] : [1, -1];   // outside first
          for (const sd of sides) { const off = half + Math.abs(n[0]) * w / 2 + Math.abs(n[1]) * hh / 2 + 6 / z; cands.push([q[0] + n[0] * off * sd, q[1] + n[1] * off * sd]); }
        }
      }
      const e = P[P.length - 1]; cands.push([e[0] + 8 / z + w / 2, e[1] - 10 / z]);
    }
    const free = ([x, y]) => { const x0 = x - w / 2 - pad, y0 = y - hh / 2 - pad, x1 = x + w / 2 + pad, y1 = y + hh / 2 + pad; return !obs.some(([a, b]) => segHitsBox(a, b, x0, y0, x1, y1)) && !placed.some(B => x0 < B[2] && x1 > B[0] && y0 < B[3] && y1 > B[1]); };
    const at = cands.find(free) || cands[0]; placed.push([at[0] - w / 2, at[1] - hh / 2, at[0] + w / 2, at[1] + hh / 2]);
    out += `<g${L.op < 1 ? ` opacity="${L.op}"` : ''}>${pill(at[0], at[1], L.s, L.c, 'middle', z)}</g>`;
  }
  return out;
}
function handlesOf(m) {   // vertex handles (i) for lines/areas/arrows/callouts; corner resize handles for boxes, freehand and text
  if (isQty(m)) return m.type === 'count' ? [] : m.pts.map((p, i) => ({ x: p[0], y: p[1], i }));
  if (['line', 'arrow', 'callout', 'dline', 'dim'].includes(m.kind)) return m.pts.map((p, i) => ({ x: p[0], y: p[1], i }));
  const b = bboxOf(m);
  if (m.kind === 'text') return [{ x: b.x1, y: b.y1, corner: 2 }];
  if (b.x1 - b.x0 < 1e-6 && b.y1 - b.y0 < 1e-6) return [];
  return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y], corner) => ({ x, y, corner }));
}
function renderOverlay() {
  clearTimeout(ovT);
  if (!S.page || !S.project) { world.innerHTML = ''; return; }
  S.ovZ = S.z; world.setAttribute('transform', `translate(${S.tx} ${S.ty}) scale(${S.z})`);
  const z = S.z, ms = pageMarkups(); let h = gridSVG(z) + markupsSVG(ms, z, m => S.sel.has(m.id) || m.id === S.countId);
  const pm = S.sel.size === 1 && ms.find(m => m.id === S.selId);
  if (pm) { const c = colorOf(pm), hs = 9 / z; for (const q of handlesOf(pm)) h += q.corner != null ? `<rect data-h="c${q.corner}" x="${q.x - hs / 2}" y="${q.y - hs / 2}" width="${hs}" height="${hs}" fill="#2f6fb3" stroke="#fff" stroke-width="${1.6 / z}"/>` : `<rect data-h="v${q.i}" x="${q.x - hs / 2}" y="${q.y - hs / 2}" width="${hs}" height="${hs}" fill="#fff" stroke="${c}" stroke-width="${1.8 / z}"/>`; }
  world.innerHTML = h + '<g id="pv"></g>';
  renderPreview();
}
function renderPreview() {
  const g = world.querySelector('#pv'); if (!g) return;
  if (S.annPrev) { g.innerHTML = annSVG({ type: 'note', kind: S.annPrev.kind, pts: S.annPrev.pts, style: annToolStyle(S.annPrev.kind), text: '' }, S.z, false); return; }
  const d = S.drawing; if (!d) { g.innerHTML = snapMark(); return; }
  if (isDraftTool(d.type)) { g.innerHTML = draftPreview(d) + snapMark(); return; }
  const z = S.z, pts = d.pts.slice(); if (S.hover && pts.length) pts.push(S.hover);
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
    if (lab) h += prevPill(e, lab, c, z);
  }
  g.innerHTML = h + snapMark();
}

/* ---------- tools & drawing ---------- */
const HINTS = {
  length: 'Length: tap/click each point. Double-tap, Enter or ✓ Finish to end. Hold Shift for straight lines.',
  area: 'Area: tap/click the corners. Tap the first point, double-tap, Enter or ✓ Finish to close.',
  count: 'Count: tap each item. ✓ Finish (or Enter) starts a new count group.',
  calibrate: 'Calibrate: tap both ends of a dimension you know.',
  highlight: 'Highlighter: drag over the plan. Hold Shift for a straight stroke.',
  pen: 'Pen: drag to draw freehand.',
  line: 'Line: drag from start to end.',
  arrow: 'Arrow: drag from the tail to the point.',
  rect: 'Rectangle: drag corner to corner.',
  ellipse: 'Ellipse: drag corner to corner.',
  cloud: 'Revision cloud: drag corner to corner around the change.',
  text: 'Text: tap where the text goes, then type. Tap an existing text to edit it.',
  callout: 'Callout: drag from the point you are calling out to where the text goes, then type.',
  select: '',
  dline: 'Plan line: tap each point (snaps to grid, ends and midpoints). Type an exact length and angle in the Draw panel. Double-tap, Enter or ✓ Finish to end; tap the first point to close.',
  drect: 'Plan rectangle: tap one corner, then the opposite corner, or type width × height in the Draw panel.',
  dim: 'Dimension: tap the two points to measure, then tap where the dimension line goes (Enter = right on the points).',
  wall: 'Wall: tap along the wall centerline (type exact lengths in the Draw panel). Double-tap, Enter or ✓ Finish to end; tap the first point to close the room.',
};
function setTool(t) {
  if ((t === 'length' || t === 'area' || t === 'wall') && !curScale() && S.page) { S.scaleNext = t; setDockTab('scale'); toast('Set the scale for this page first'); return; }
  closeTextEditor(); cancelDrawing(); if (t !== S.tool && isAnnTool(t) && S.sel.size) S.selId = null;   // v1.6: picking a tool starts fresh (Bluebeam-style); the tool's look shows in Properties
  S.tool = t; if (t !== 'calibrate') S.calib = null;
  const ap = prodById(S.activeProductId), u = String(ap?.unit || '').toUpperCase();
  if (ap && (QTY_TYPES.has(t) || t === 'wall') && ((t === 'count' && (u === 'LF' || u === 'SF')) || ((t === 'length' || t === 'area' || t === 'wall') && u === 'EA'))) { S.activeProductId = ''; refreshActiveProduct(); toast(`${ap.name} is priced per ${u} — pick a product for this tool`); }
  $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  if (isDraftTool(t) && S.dockTab !== 'draw') { S.dockTab = 'draw'; UI.dockTab = 'draw'; if (UI.dockMin) { UI.dockMin = false; applyDock(); } saveUI(); }
  viewer.classList.toggle('drawing', t !== 'select');
  const h = $('#hint'); h.textContent = HINTS[t] || ''; h.classList.toggle('on', !!HINTS[t]);
  updateFinish(); renderOverlay(); refreshActiveProduct(); renderDock();
}
function cancelDrawing() { S.drawing = null; S.countId = null; S.hover = null; S.snapHit = null; updateFinish(); }
function updateFinish() { $('#btnFinish').disabled = !((S.drawing && S.drawing.pts.length) || S.countId); }
function constrain(p, shift) {
  const d = S.drawing; if (!(shift || UI.ortho) || !d?.pts.length || (d.type === 'dim' && d.pts.length >= 2)) return p; const q = d.pts[d.pts.length - 1];
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
  if (isDraftTool(d.type)) return finishDraft();
  const need = d.type === 'area' ? 3 : 2;
  if (d.pts.length < need) { toast(d.type === 'area' ? 'An area needs at least 3 points' : 'A length needs at least 2 points'); return; }
  pushUndo();
  const m = { id: uid(), type: d.type, docId: S.docId, page: S.pageNum, pts: d.pts, productId: S.activeProductId || null, label: '', height: null, color: S.activeProductId ? null : TYPE_COLOR[d.type], created: Date.now() };
  S.project.markups.push(m); S.selId = m.id; S.drawing = null; S.hover = null;
  touch(); updateFinish(); renderOverlay(); refreshPanel(); markThumb();
}
function tap(sx, sy, e) {
  const q = toPage(sx, sy), t = S.tool;
  if (t === 'select') {
    const hit = hitTest(q), add = e && (e.shiftKey || e.ctrlKey || e.metaKey) || S.multi;
    if (add) { if (hit) toggleSel(hit.id); } else S.selId = hit?.id || null;
    renderOverlay(); refreshPanel(); return;
  }
  if (t === 'count') {
    let m = S.countId && S.project.markups.find(x => x.id === S.countId && x.docId === S.docId && x.page === S.pageNum);
    if (m) { const lp = m.pts[m.pts.length - 1]; if (lp && Date.now() - (S.lastTap || 0) < 280 && dist(lp, q) * S.z < 5) return; }
    S.lastTap = Date.now(); pushUndo();
    if (!m) { m = { id: uid(), type: 'count', docId: S.docId, page: S.pageNum, pts: [], productId: S.activeProductId || null, label: '', height: null, color: S.activeProductId ? null : TYPE_COLOR.count, created: Date.now() }; S.project.markups.push(m); S.countId = m.id; }
    m.pts.push(q); S.selId = m.id; touch(); updateFinish(); renderOverlay(); refreshPanel(); markThumb(); return;
  }
  // length / area / calibrate / v1.7 drafting
  if (!S.drawing) S.drawing = { type: t, pts: [] };
  const d = S.drawing, now = Date.now();
  const p = snapPoint(q, e.shiftKey);
  if (isDraftTool(t)) { draftTap(p, now); return; }
  if (d.pts.length) {
    const last = d.pts[d.pts.length - 1];
    if (now - (S.lastTap || 0) < 380 && dist(last, p) * S.z < 12 && t !== 'calibrate') { S.lastTap = 0; finishDrawing(); return; }
    if (t === 'area' && d.pts.length >= 3 && dist(d.pts[0], p) * S.z < 12) { finishDrawing(); return; }
  }
  S.lastTap = now; d.pts.push(p); d.shift = e.shiftKey; updateFinish(); renderPreview();
  if (t === 'calibrate' && d.pts.length === 2) { const dp = dist(d.pts[0], d.pts[1]); S.drawing = null; renderPreview(); S.calib = { dPts: dp }; setDockTab('scale'); setTimeout(() => $('#cFt')?.focus(), 30); }
}
const selMarks = () => pageMarkups().filter(m => S.sel.has(m.id));
function setSelection(ids) { ids = [...ids]; S.sel = new Set(ids); S._pri = ids.length ? ids[ids.length - 1] : null; }
function toggleSel(id) { if (S.sel.has(id)) { S.sel.delete(id); if (S._pri === id) S._pri = [...S.sel].pop() || null; } else { S.sel.add(id); S._pri = id; } }
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = clamp(t, 0, 1); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
function inPoly(p, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function hitTest(q) {
  const tol = 10 / S.z; let best = null, bd = Infinity;
  for (const m of pageMarkups()) {
    let d = Infinity;
    if (!isQty(m)) d = noteDist(m, q, tol);
    else if (m.type === 'count') for (const p of m.pts) d = Math.min(d, dist(p, q));
    else { for (let i = 1; i < m.pts.length; i++) d = Math.min(d, segDist(q, m.pts[i - 1], m.pts[i])); if (m.wall) d = Math.max(0, d - wallThkPt(m) / 2); if (m.type === 'area') { d = Math.min(d, segDist(q, m.pts[m.pts.length - 1], m.pts[0])); if (inPoly(q, m.pts)) d = Math.min(d, tol * 0.9); } }
    if (d < tol && d < bd) { bd = d; best = m; }
  }
  return best;
}
function noteDist(m, q, tol) {
  const st = styleOf(m), hw = (+st.width || 0) / 2, p = m.pts;
  const poly = (pts, closed) => { let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(q, pts[i - 1], pts[i])); if (closed) d = Math.min(d, segDist(q, pts[pts.length - 1], pts[0])); return pts.length === 1 ? dist(q, pts[0]) : d; };
  if (m.kind === 'highlight' || m.kind === 'pen' || m.kind === 'line' || m.kind === 'arrow' || m.kind === 'dline') return Math.max(0, poly(p) - hw);
  if (m.kind === 'dim') { const o = dimGeo(m); return o ? Math.min(segDist(q, o.a2, o.b2), segDist(q, p[0], o.a2), segDist(q, p[1], o.b2)) : poly(p); }
  if (m.kind === 'text') return inBox(q, bboxOf(m)) ? 0 : Infinity;
  if (m.kind === 'callout') { const t = textLayout(m, st); return inBox(q, { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h }) ? 0 : Math.max(0, segDist(q, p[0], [clamp(p[0][0], t.x, t.x + t.w), clamp(p[0][1], t.y, t.y + t.h)]) - hw); }
  const b = box2(p), filled = st.fill && st.fill !== 'none';
  if (m.kind === 'ellipse') { const rx = (b.x1 - b.x0) / 2 || 1e-6, ry = (b.y1 - b.y0) / 2 || 1e-6, r = Math.hypot((q[0] - b.x0 - rx) / rx, (q[1] - b.y0 - ry) / ry); return r <= 1 && filled ? 0 : Math.max(0, Math.abs(r - 1) * Math.min(rx, ry) - hw); }
  if (filled && inBox(q, b)) return 0;
  return Math.max(0, poly([[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], true) - hw);
}
function hitHandle(q) {
  if (S.sel.size !== 1) return null;
  const m = S.project.markups.find(x => x.id === S.selId); if (!m || m.docId !== S.docId || m.page !== S.pageNum) return null;
  const tol = (COARSE ? 16 : 9) / S.z;
  for (const h of handlesOf(m)) if (dist([h.x, h.y], q) < tol) return { m, ...h };
  return null;
}

/* ---------- pointer input (mouse, touch, pen) ---------- */
const ptrs = new Map(); let G = null, spaceDown = false;
const local = e => { const r = viewer.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
viewer.addEventListener('pointerdown', e => {
  if (!S.page || e.target.closest('#pageNav,#empty,#selBar,#inlineText')) return;
  try { viewer.setPointerCapture(e.pointerId); } catch { }
  const p = local(e); ptrs.set(e.pointerId, p);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; G = { type: 'pinch', d0: dist(a, b) || 1, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], z0: S.z, tx0: S.tx, ty0: S.ty }; return; }
  if (ptrs.size > 2) return;
  if (e.button === 1 || e.button === 2 || spaceDown) { G = { type: 'pan', s: p, tx0: S.tx, ty0: S.ty }; viewer.classList.add('panning'); e.preventDefault(); return; }
  if (S.tool === 'select' && S.selId) { const h = hitHandle(toPage(...p)); if (h) { pushUndo(); G = h.corner != null ? { type: 'scale', m: h.m, corner: h.corner, bb0: bboxOf(h.m), pts0: h.m.pts.map(q => q.slice()), fs0: styleOf(h.m).fs } : { type: 'vertex', m: h.m, i: h.i }; return; } }
  if (isAnnTool(S.tool) && e.button === 0) { G = { type: 'ann', s: p, kind: S.tool, pts: [toPage(...p)] }; return; }
  G = { type: 'pending', s: p, tx0: S.tx, ty0: S.ty, thr: e.pointerType === 'touch' ? 10 : 5 };
  if (S.tool === 'select') {
    const add = e.shiftKey || e.ctrlKey || e.metaKey || S.multi, hit = hitTest(toPage(...p));
    if (hit && S.sel.has(hit.id) && !add) G.type = 'movecand';           // drag a selected item (or the whole selection) to move it
    else if (!hit && (e.shiftKey || e.ctrlKey || e.metaKey)) G.marq = true;   // Shift/Ctrl + drag on empty space = box select
  }
});
viewer.addEventListener('pointermove', e => {
  const p = local(e);
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
  if (G?.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = dist(a, b), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const nz = clamp(G.z0 * d / G.d0, fitZ() * 0.25, 60), px = (G.m0[0] - G.tx0) / G.z0, py = (G.m0[1] - G.ty0) / G.z0;
    S.z = nz; S.tx = m[0] - px * nz; S.ty = m[1] - py * nz; applyT(); return;
  }
  if (G?.type === 'movecand' && dist(p, G.s) > G.thr) {
    pushUndo(); G.type = 'move'; G.items = selMarks().map(m => ({ m, pts0: m.pts.map(q => q.slice()) }));
  }
  if (G?.type === 'move') {
    const dx = (p[0] - G.s[0]) / S.z, dy = (p[1] - G.s[1]) / S.z;
    for (const it of G.items) it.m.pts = it.pts0.map(q => [q[0] + dx, q[1] + dy]);
    G.moved = true; renderOverlay(); return;
  }
  if (G?.type === 'pending' && G.marq && dist(p, G.s) > G.thr) { G.type = 'marquee'; }
  if (G?.type === 'marquee') { G.cur = p; drawMarquee(G.s, p); return; }
  if (G?.type === 'pending' && dist(p, G.s) > G.thr) { G.type = 'pan'; viewer.classList.add('panning'); }
  if (G?.type === 'pan') { S.tx = G.tx0 + p[0] - G.s[0]; S.ty = G.ty0 + p[1] - G.s[1]; applyT(); return; }
  if (G?.type === 'vertex') { G.m.pts[G.i] = toPage(...p); G.moved = true; renderOverlay(); return; }
  if (G?.type === 'scale') {
    const q = toPage(...p), b = G.bb0, C = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], mv = C[G.corner], fx = C[(G.corner + 2) % 4];
    if (G.m.kind === 'text') { const s = Math.max(0.15, (q[1] - b.y0) / Math.max(1e-6, b.y1 - b.y0)); G.m.style = { ...(G.m.style || {}), fs: Math.round(clamp(G.fs0 * s, 4, 600) * 10) / 10 }; }
    else { const sx = Math.abs(mv[0] - fx[0]) > 1e-6 ? (q[0] - fx[0]) / (mv[0] - fx[0]) : 1, sy = Math.abs(mv[1] - fx[1]) > 1e-6 ? (q[1] - fx[1]) / (mv[1] - fx[1]) : 1; G.m.pts = G.pts0.map(([x, y]) => [fx[0] + (x - fx[0]) * sx, fx[1] + (y - fx[1]) * sy]); }
    G.moved = true; renderOverlay(); return;
  }
  if (G?.type === 'ann') {
    const q = toPage(...p);
    if (G.kind === 'pen' || (G.kind === 'highlight' && !e.shiftKey)) { const l = G.pts[G.pts.length - 1]; if (dist(l, q) * S.z > 2) G.pts.push(q); }
    else G.pts = [G.pts[0], q];
    if (dist(p, G.s) > 4) G.moved = true;
    S.annPrev = { kind: G.kind, pts: G.pts }; renderPreview(); return;
  }
  if (!G && S.drawing && e.pointerType !== 'touch') { S.drawing.shift = e.shiftKey; S.hover = snapPoint(toPage(...p), e.shiftKey); renderPreview(); }
  else if (!G && !S.drawing && e.pointerType !== 'touch' && S.page && (isDraftTool(S.tool) || S.tool === 'length' || S.tool === 'area')) { S.hover = null; snapPoint(toPage(...p), false); renderPreview(); }
});
function drawMarquee(a, b) {
  const el = $('#marquee'); el.classList.remove('hidden');
  Object.assign(el.style, { left: Math.min(a[0], b[0]) + 'px', top: Math.min(a[1], b[1]) + 'px', width: Math.abs(a[0] - b[0]) + 'px', height: Math.abs(a[1] - b[1]) + 'px' });
}
function hideMarquee() { $('#marquee').classList.add('hidden'); }
function finishMarquee(a, b, add) {
  const [x1, y1] = toPage(Math.min(a[0], b[0]), Math.min(a[1], b[1])), [x2, y2] = toPage(Math.max(a[0], b[0]), Math.max(a[1], b[1]));
  const ids = pageMarkups().filter(m => { const b = bboxOf(m); return b.x0 <= x2 && b.x1 >= x1 && b.y0 <= y2 && b.y1 >= y1; }).map(m => m.id);
  setSelection(add ? [...new Set([...S.sel, ...ids])] : ids);
  renderOverlay(); refreshPanel();
}
function endPtr(e, cancel) {
  const had = ptrs.delete(e.pointerId); viewer.classList.remove('panning');
  if (!G) return;
  if (G.type === 'pinch') { if (ptrs.size === 0) G = null; return; }
  if (ptrs.size) return;
  const g = G; G = null;
  if (cancel || !had) { if (g.type === 'marquee') hideMarquee(); if (g.type === 'ann') { S.annPrev = null; renderPreview(); } if ((g.type === 'move' || g.type === 'scale' || g.type === 'vertex') && g.moved) { touch(); refreshPanel(); } return; }
  if (g.type === 'ann') { finishAnn(g); return; }
  if (g.type === 'scale') { if (g.moved) { touch(); refreshPanel(); } else S.undo.pop(); return; }
  if (g.type === 'pending' || g.type === 'movecand') tap(...local(e), e);
  if (g.type === 'move') { if (g.moved) { touch(); refreshPanel(); } else S.undo.pop(); }
  if (g.type === 'marquee') { hideMarquee(); finishMarquee(g.s, g.cur || g.s, e.shiftKey || e.ctrlKey || e.metaKey); }
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
  if (S.view === 'plans' && mod && S.page) {
    if (k === 'c') { if (S.sel.size) { e.preventDefault(); copySel(); } return; }
    if (k === 'x') { if (S.sel.size) { e.preventDefault(); copySel(); deleteSelected(); } return; }
    if (k === 'v') { if (S.clip) { e.preventDefault(); pasteClip(); } return; }
    if (k === 'd') { e.preventDefault(); duplicateSel(); return; }
    if (k === 'a') { e.preventDefault(); selectAllPage(); return; }
  }
  if (S.view !== 'plans' || mod) return;
  if (k === ' ') { spaceDown = true; e.preventDefault(); }
  else if (k === 'enter') finishDrawing();
  else if (k === 'escape') { if (S.drawing || S.countId) { cancelDrawing(); renderOverlay(); } else if (S.sel.size && S.tool === 'select') { S.selId = null; renderOverlay(); refreshPanel(); } else setTool('select'); }
  else if (k === 'backspace' || k === 'delete') { if (S.drawing?.pts.length) undo(); else if (S.sel.size) deleteSelected(); e.preventDefault(); }
  else if (k === 'v') setTool('select'); else if (k === 'l') setTool('length'); else if (k === 'a') setTool('area'); else if (k === 'c') setTool('count');
  else if (k === 'h') setTool('highlight'); else if (k === 'p') setTool('pen'); else if (k === 't') setTool('text'); else if (k === 'r') setTool('rect'); else if (k === 'e') setTool('ellipse'); else if (k === 'k') setTool('cloud'); else if (k === 'w') setTool('arrow');
  else if (k === 'g') toggleDraftOpt('grid'); else if (k === 'o') toggleDraftOpt('ortho'); else if (k === 'd') setTool('dline'); else if (k === 'm') setTool('dim');
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
// ONE product picker (top bar). With markups selected it sets THEIR product; otherwise it is the product the next markup is drawn with.
function pickerMode() { return S.tool === 'select' && selMarks().some(isQty) ? 'sel' : 'new'; }
function refreshActiveProduct() {
  const sel = $('#activeProduct'), lab = $('#prodLabel'); if (S.activeProductId && !prodById(S.activeProductId)) S.activeProductId = '';
  const mode = pickerMode(), picked = mode === 'sel' ? selMarks().filter(isQty) : [];
  let val = S.activeProductId, mixed = false;
  if (mode === 'sel') { const ids = new Set(picked.map(m => m.productId || '')); if (ids.size === 1) val = [...ids][0]; else { mixed = true; val = '__mixed'; } }
  sel.innerHTML = (mixed ? '<option value="__mixed" disabled>— Mixed products —</option>' : '') + productOptions(mixed ? '' : val, S.products.length ? '— No product —' : '— No products yet —') + '<option value="__new">＋ Add new product…</option>';
  sel.value = val; const p = mixed ? null : prodById(val);
  sel.style.borderColor = p ? p.color : '';
  lab.textContent = mode === 'sel' ? `Selected (${picked.length}):` : S.tool === 'select' ? 'Next markup:' : 'Draw with:';
  lab.title = mode === 'sel' ? 'Changing this changes the product of the selected markups' : 'The product used for the next thing you draw';
  $('#prodGroup').classList.toggle('selmode', mode === 'sel');
}

/* ======================= RIGHT PANEL ======================= */
function refreshPanel() {
  const list = $('#markupList'), tot = $('#pageTotals'), selBox = $('#selBox');
  if (!S.project || !S.page) { list.innerHTML = '<p class="muted small">No page open.</p>'; tot.innerHTML = ''; selBox.classList.add('hidden'); $('#pageCount').textContent = ''; $('#selBar').classList.add('hidden'); renderDock(); return; }
  const ms = pageMarkups(); $('#pageCount').textContent = ms.length ? `(${ms.length})` : '';
  for (const id of [...S.sel]) if (!ms.some(m => m.id === id)) S.sel.delete(id);
  if (S._pri && !S.sel.has(S._pri)) S._pri = [...S.sel].pop() || null;
  refreshSelBar(); refreshActiveProduct();
  $('#btnPaste').disabled = !S.clip;
  list.innerHTML = ms.map(m => `<div class="mrow ${S.sel.has(m.id) ? 'on' : ''}" data-id="${m.id}"><span class="sw" style="background:${colorOf(m)}"></span><span class="mname">${isQty(m) ? '' : '✎ '}${esc(markName(m))}${m.label && isQty(m) ? ` <span class="muted">· ${esc(m.label)}</span>` : ''}</span><span class="mval">${esc(valueText(m).split(' · ')[0])}</span></div>`).join('') || '<p class="muted small">Pick a tool above and tap on the plan.</p>';
  list.querySelectorAll('.mrow').forEach(r => r.onclick = e => { if (S.tool !== 'select') setTool('select'); if (e.shiftKey || e.ctrlKey || e.metaKey || S.multi) toggleSel(r.dataset.id); else S.selId = r.dataset.id; renderOverlay(); refreshPanel(); });
  // per-product totals for this page (annotations never count)
  tot.innerHTML = pageAgg(ms).map(a => `<div class="trow"><span>${a.hatch ? legendSwatch(a, 'pt-') : `<span class="sw" style="display:inline-block;background:${a.color};margin-right:6px"></span>`}${esc(a.name)}</span><b>${fmtQty(a.q, a.unit)} ${esc(a.unit)}</b></div>`).join('') || '<p class="muted small">No quantities yet.</p>';
  selBox.classList.add('hidden');   // v1.6: the selected markup is edited in the bottom dock, not in the side panel
  renderDock();
}
function pageAgg(ms) {
  const agg = new Map();
  for (const m of ms) {
    if (!isQty(m)) continue;
    const p = prodById(m.productId), key = p ? p.id : 'u-' + nativeUnit(m), q = p ? qtyFor(m, p) : (m.type === 'count' ? m.pts.length : (m.type === 'area' ? geo(m).sf : (geo(m).sf ?? geo(m).lf)));
    const a = agg.get(key) || { name: p ? p.name : 'Unassigned', unit: p ? p.unit : nativeUnit(m), color: p ? p.color : '#888', q: 0, hatch: null };
    if (!a.hatch && (m.type === 'area' || m.wall)) { const h = styleOf(m).hatch; if (h && h !== 'none' && HATCHES[h]) { a.hatch = h; a.k = kOf(m); } }
    if (q != null) a.q += q; agg.set(key, a);
  }
  return [...agg.values()];
}
/* ----- selection actions: copy / paste / duplicate / delete / combine counts ----- */
const cloneM = m => JSON.parse(JSON.stringify(m));
function refreshSelBar() {
  const n = selMarks().length, bar = $('#selBar');
  bar.classList.toggle('hidden', !n || S.tool !== 'select');
  $('#selN').textContent = n + ' selected';
  const nc = selMarks().filter(m => m.type === 'count').length;
  bar.querySelector('[data-sa=combine]').disabled = nc < 2;
  bar.querySelector('[data-sa=paste]').disabled = !S.clip;
  $('#btnMulti').classList.toggle('on', S.multi);
}
function copySel() {
  const ms = selMarks(); if (!ms.length) return toast('Select something first');
  S.clip = { items: ms.map(cloneM), docId: S.docId, page: S.pageNum, n: 0 }; refreshPanel(); toast(`Copied ${ms.length} — paste with Ctrl+V (works on other pages too)`);
}
function addClones(items, off) {
  pushUndo();
  const out = items.map(m => ({ ...cloneM(m), id: uid(), docId: S.docId, page: S.pageNum, pts: m.pts.map(q => [q[0] + off, q[1] + off]), created: Date.now() }));
  S.project.markups.push(...out); setSelection(out.map(m => m.id));
  touch(); renderOverlay(); refreshPanel(); markThumb(); return out.length;
}
function pasteClip() {
  if (!S.clip || !S.page) return toast('Nothing copied yet');
  const same = S.clip.docId === S.docId && S.clip.page === S.pageNum; S.clip.n = same ? S.clip.n + 1 : 0;
  const k = addClones(S.clip.items, same ? 16 / S.z * S.clip.n : 0); toast(`Pasted ${k}`);
}
function duplicateSel() {
  const ms = selMarks(); if (!ms.length) return toast('Select something first');
  const k = addClones(ms, 16 / S.z); toast(`Duplicated ${k} — drag to place`);
}
function deleteSelected() {
  const ids = new Set(selMarks().map(m => m.id)); if (!ids.size) return;
  pushUndo(); S.project.markups = S.project.markups.filter(m => !ids.has(m.id)); if (ids.has(S.countId)) S.countId = null; S.selId = null;
  touch(); renderOverlay(); refreshPanel(); markThumb(); updateFinish(); toast(`Deleted ${ids.size} — Undo to restore`);
}
function combineCounts() {
  const cs = selMarks().filter(m => m.type === 'count'); if (cs.length < 2) return toast('Select two or more counts to combine');
  pushUndo();
  const target = cs.find(m => m.id === S.selId) || cs[0], names = new Set(cs.map(m => m.productId || ''));
  for (const m of cs) if (m !== target) target.pts.push(...m.pts);
  const gone = new Set(cs.filter(m => m !== target).map(m => m.id));
  S.project.markups = S.project.markups.filter(m => !gone.has(m.id));
  if (gone.has(S.countId)) S.countId = null; setSelection([target.id]);
  touch(); renderOverlay(); refreshPanel(); markThumb(); updateFinish();
  toast(`Combined into one count of ${target.pts.length}` + (names.size > 1 ? ` (kept ${prodById(target.productId)?.name || 'no product'})` : ''));
}
function selectAllPage() { if (!S.page) return; if (S.tool !== 'select') setTool('select'); setSelection(pageMarkups().map(m => m.id)); renderOverlay(); refreshPanel(); }
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
    if (!isQty(m)) continue;   // v1.6: highlights, text, clouds… are drawing notes only
    const p = prodById(m.productId);
    if (!p) { const g = geo(m); if (g.noscale) { noScale++; continue; } un.n++; if (m.type === 'count') un.EA += g.ea; else if (m.type === 'area') un.SF += g.sf; else if (g.sf != null) un.SF += g.sf; else un.LF += g.lf; continue; }
    const q = qtyFor(m, p); if (q == null) { noScale++; continue; }
    const r = rows.get(p.id) || { prod: p, qty: 0, n: 0 }; r.qty += q; r.n++; rows.set(p.id, r);
  }
  const lines = [...rows.values()].sort((a, b) => (a.prod.category || '').localeCompare(b.prod.category || '') || a.prod.name.localeCompare(b.prod.name)).map(r => {
    const w = num(r.prod.waste), qw = r.qty * (1 + w / 100), price = num(r.prod.price), lab = num(r.prod.labor);
    return { kind: 'product', id: r.prod.id, name: r.prod.name, category: r.prod.category || '', unit: r.prod.unit, qty: r.qty, waste: w, qtyW: qw, price, mat: qw * price, laborU: lab, labor: qw * lab, total: qw * (price + lab), n: r.n };
  });
  // estimate-line formulas: Q("name") measured qty, QW("name") with waste, N("name") markup count
  const findLine = name => {
    const k = String(name).trim().toLowerCase(), pool = [...lines, ...P.manual.filter(x => !(typeof x.qty === 'string' && x.qty.trim().startsWith('='))).map(x => ({ name: x.desc || '', qty: num(x.qty), qtyW: num(x.qty) * (1 + num(x.waste) / 100), n: 1 }))];
    const ex = pool.filter(l => l.name.toLowerCase() === k), part = pool.filter(l => l.name.toLowerCase().includes(k));
    const hit = ex.length ? ex : part;
    if (hit.length !== 1) throw new Error(hit.length ? `"${name}" matches ${hit.length} lines, be more specific` : `No estimate line named "${name}"`);
    return hit[0];
  };
  const fxFns = { q: n => findLine(n).qty, qw: n => findLine(n).qtyW, n: n => findLine(n).n };
  const manual = P.manual.map(x => { let q, err = '', isF = typeof x.qty === 'string' && x.qty.trim().startsWith('=');
    if (isF) { try { q = fxEval(x.qty, {}, fxFns); } catch (e) { q = 0; err = e.message; } } else q = num(x.qty);
    const pr = num(x.price), lb = num(x.labor), w = num(x.waste), qw = q * (1 + w / 100); return { kind: 'manual', formula: isF, err, id: x.id, name: x.desc || '', category: 'Manual', unit: x.unit || 'EA', qty: q, waste: w, qtyW: qw, price: pr, mat: qw * pr, laborU: lb, labor: qw * lb, total: qw * (pr + lb), productId: x.productId || null }; });
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
    h += `<tr data-mid="${l.id}"><td><input data-f="desc" value="${esc(x.desc)}" placeholder="Description"></td><td><input data-f="unit" value="${esc(x.unit || 'EA')}" style="width:60px"></td><td class="n"><input class="num${l.formula ? ' fxin' : ''}" data-f="qty" inputmode="${l.formula ? 'text' : 'decimal'}" value="${esc(x.qty)}" title="${l.err ? esc('Formula problem: ' + l.err) : l.formula ? 'Formula = ' + esc(String(l.qty)) : 'A number, or a formula starting with ='}">${l.err ? '<div class="fxerr">⚠ ' + esc(l.err) + '</div>' : ''}</td><td class="n"><input class="num pct" data-f="waste" inputmode="decimal" value="${esc(x.waste || 0)}" title="Waste %"></td><td class="n"><b>${fmtQty(l.qtyW, l.unit)}</b></td>${P ? `<td class="n"><input class="num" data-f="price" inputmode="decimal" placeholder="$" value="${num(x.price) ? esc(x.price) : ''}"></td><td class="n">${m$(l.mat)}</td><td class="n"><input class="num" data-f="labor" inputmode="decimal" placeholder="$" value="${num(x.labor) ? esc(x.labor) : ''}"></td><td class="n">${m$(l.labor)}</td><td class="n"><b>${m$(l.total)}</b></td>` : ''}<td><button class="small danger" data-del="${l.id}">✕</button></td></tr>`;
  }
  if (E.un.n) h += `<tr class="sub"><td colspan="${C}">Unassigned markups (${E.un.n}), not included: ${[E.un.LF && fmtN(E.un.LF) + ' LF', E.un.SF && fmtN(E.un.SF) + ' SF', E.un.EA && E.un.EA + ' EA'].filter(Boolean).join(' · ')}. Assign a product to include them.</td></tr>`;
  if (E.noScale) h += `<tr class="sub"><td colspan="${C}">${E.noScale} markups are on pages without a scale and are not included.</td></tr>`;
  if (!E.all.length) h += `<tr><td colspan="${C}" class="muted">No items yet. Measure on the plan with a product selected, or add a manual line.</td></tr>`;
  t.innerHTML = h;
  t.querySelectorAll('tr[data-mid] input').forEach(inp => inp.onchange = () => { const x = S.project.manual.find(m => m.id === inp.closest('tr').dataset.mid); const f = inp.dataset.f, v = inp.value; x[f] = f === 'desc' || f === 'unit' ? v : (f === 'qty' && v.trim().startsWith('=')) ? v.trim() : num(v); touch(); renderEstimate(); });
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
  $('#btnFxHelp').onclick = () => { const b = $('#fxHelpInline'); if (!b.innerHTML) b.innerHTML = FX_HELP; b.classList.toggle('hidden'); };
  $('#estNote').textContent = P ? 'Qty = measured × (1 + waste %). Material = qty × unit price. Labor = qty × labor per unit. Markup % applies to material + labor; tax % applies to material only. Blank price cells = not priced. A manual quantity can be a formula: start it with = (see ƒx Formulas).'
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
    if (!isQty(m)) continue;
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
/* v1.5.3: "Save as PDF" uses document.title as the file name, so print as "<takeoff name> Takeoff" (v1.7: trade-neutral, was "Hardware Takeoff") and put the app title back afterwards */
const takeoffTitle = n => !n ? 'Takeoff' : /takeoff$/i.test(n) ? n : n + ' Takeoff';
const pdfTitle = s => String(s || '').replace(/[\/\\]+/g, '-').replace(/[:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.]+$/g, '').slice(0, 120).trim();
let printTitleTimer = 0, appTitle = null;
function setPrintTitle(suffix = '') {   // the marked-up drawing prints as "<takeoff name> Takeoff - Drawing"
  if (appTitle === null) appTitle = document.title;
  const n = pdfTitle(S.project?.name);   // file name: "<takeoff name> Takeoff", or just "Takeoff"
  document.title = takeoffTitle(n) + suffix;
  clearTimeout(printTitleTimer); printTitleTimer = setTimeout(restorePrintTitle, 60000);   // fallback if afterprint never fires
}
function restorePrintTitle() { clearTimeout(printTitleTimer); if (appTitle !== null) { document.title = appTitle; appTitle = null; } }
addEventListener('beforeprint', () => { if (S.project) setPrintTitle($('#printArea').classList.contains('drawing') ? ' - Drawing' : ''); });   // also covers the browser's own Print menu / Ctrl+P
addEventListener('afterprint', () => setTimeout(restorePrintTitle, 500));
function printSummary() {
  const E = computeEstimate(); if (!E) return; const P = E.show;
  // v1.5: one block per category (same grouping as the on-screen estimate), grand total at the end
  // v1.5.2: per-category subtotal rows are optional ("Category subtotals in print" toggle, off by default)
  const SUBS = !!UI.printSubs;
  const groups = [], byKey = new Map();
  for (const l of E.all) {
    const key = l.kind === 'manual' ? '\u0000manual' : (l.category || '').trim(), label = l.kind === 'manual' ? 'Manual items' : (key || 'Uncategorized');
    let g = byKey.get(key); if (!g) { g = { label, lines: [] }; byKey.set(key, g); groups.push(g); }
    g.lines.push(l);
  }
  const head = `<thead><tr><th>Item</th><th>Unit</th><th class="n">Qty (w/ waste)</th>${P ? '<th class="n">Unit price</th><th class="n">Material</th><th class="n">Labor</th><th class="n">Total</th>' : ''}</tr></thead>`;
  const body = groups.map(g => {
    const byUnit = new Map(); let mat = 0, lab = 0, tot = 0;
    for (const l of g.lines) { const u = (l.unit || 'EA').toUpperCase(); byUnit.set(u, (byUnit.get(u) || 0) + l.qtyW); mat += l.mat; lab += l.labor; tot += l.total; }
    const qtyTxt = [...byUnit].map(([u, q]) => fmtQty(q, u) + ' ' + u).join(' · ');   // units differ inside a category, so qty subtotals are per unit
    const rows = g.lines.map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.unit)}</td><td class="n">${fmtQty(l.qtyW, l.unit)}</td>${P ? `<td class="n">${m$(l.price)}</td><td class="n">${m$(l.mat)}</td><td class="n">${m$(l.labor)}</td><td class="n">${m$(l.total)}</td>` : ''}</tr>`).join('');
    const sub = `<tr class="subt"><td colspan="2">${esc(g.label)} subtotal</td><td class="n">${qtyTxt}</td>${P ? `<td class="n"></td><td class="n">${m$(mat)}</td><td class="n">${m$(lab)}</td><td class="n">${m$(tot)}</td>` : ''}</tr>`;
    return `<section class="pcat"><h3 class="pch">${esc(g.label)}</h3><table>${head}<tbody>${rows}${SUBS ? sub : ''}</tbody></table></section>`;
  }).join('');
  setPrintMode('summary');
  $('#printArea').innerHTML = `<h1>${esc(S.project.name)} — ${P ? 'Estimate' : 'Quantities'}</h1><div>${new Date().toLocaleDateString()}</div><br>
    ${body || '<p>No items yet.</p>'}
    ${P ? `<div class="tot"><div><span>Material</span><span>${fmt$(E.mat)}</span></div><div><span>Labor</span><span>${fmt$(E.labor)}</span></div><div><span>Markup ${E.markupPct}%</span><span>${fmt$(E.markup)}</span></div><div><span>Tax ${E.taxPct}%</span><span>${fmt$(E.tax)}</span></div><div class="g"><span>Grand total</span><span>${fmt$(E.grand)}</span></div></div>` : ''}
    ${S.project.checklist.length ? `<h3>Checklist</h3><table>${S.project.checklist.map(c => `<tr><td>${c.done ? '☑' : '☐'} ${esc(c.text)}${c.notes ? `<br><small>${esc(c.notes)}</small>` : ''}</td></tr>`).join('')}</table>` : ''}`;
  setPrintTitle(); window.print();
}

/* ======================= PRODUCTS ======================= */
function renderProducts() {
  const q = $('#prodSearch').value.trim().toLowerCase();
  const ps = [...S.products].filter(p => !q || (p.name + ' ' + p.category).toLowerCase().includes(q)).sort((a, b) => (a.category || '').trim().localeCompare((b.category || '').trim()) || a.name.localeCompare(b.name));
  const used = {}; if (S.project) for (const m of S.project.markups) if (m.productId) used[m.productId] = (used[m.productId] || 0) + 1;
  $('#prodTable').innerHTML = `<tr><th></th><th>Name</th><th>Category</th><th>Unit</th><th class="n">Unit price</th><th class="n">Labor/unit</th><th class="n">Waste</th><th class="n">Multiplier</th><th>Formula</th><th class="n">In this project</th><th></th></tr>` +
    (ps.map((p, i) => { const c = (p.category || '').trim(), pc = i ? (ps[i - 1].category || '').trim() : null; return (i === 0 || c !== pc ? `<tr class="cat"><td colspan="11">${esc(c || 'Uncategorized')}</td></tr>` : '') + `<tr data-id="${p.id}"><td><span class="sw" style="background:${p.color}"></span></td><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${esc(p.unit)}</td><td class="n">${fmt$(num(p.price))}</td><td class="n">${fmt$(num(p.labor))}</td><td class="n">${fmtN(num(p.waste), 1)}%</td><td class="n">${p.mult && p.mult !== 1 ? p.mult : ''}</td><td class="small">${p.formula ? `<code title="${esc(fxProblem(p.formula) || 'Quantity formula')}">${fxProblem(p.formula) ? '⚠ ' : 'ƒx '}${esc(p.formula)}</code>` : ''}</td><td class="n">${used[p.id] || ''}</td>
      <td class="n"><button class="small" data-act="use">Use</button> <button class="small${S.prodEdit === p.id ? ' on' : ''}" data-act="edit">${S.prodEdit === p.id ? 'Close' : 'Edit'}</button> <button class="small danger" data-act="del">✕</button></td></tr>` + (S.prodEdit === p.id ? `<tr class="pedit" data-edit="${p.id}"><td colspan="11">${productFormHTML(p, { formula: true })}<div class="actions"><span class="muted small">Changes save as you go.</span><button class="small accent" data-pdone>Done</button></div></td></tr>` : ''); }).join('') || `<tr><td colspan="11" class="muted">No products yet. Add one, or import a CSV.</td></tr>`);
  if (S.prodEdit === 'new') $('#prodTable tr').insertAdjacentHTML('afterend', `<tr class="pedit" data-edit="new"><td colspan="11"><b>New product</b>${productFormHTML(S.prodDraft, { formula: true })}<div class="actions"><button class="small" data-pcancel>Cancel</button><button class="small accent" data-padd>Add product</button></div></td></tr>`);
  $$('#prodTable tr.pedit').forEach(tr => {
    const id = tr.dataset.edit;
    if (id === 'new') {
      bindProductForm(tr, null);
      tr.querySelector('[data-pcancel]').onclick = () => { S.prodEdit = null; renderProducts(); };
      tr.querySelector('[data-padd]').onclick = async () => { const p = await createProduct(readPF(tr), tr); if (!p) return; S.prodEdit = null; refreshActiveProduct(); renderProducts(); toast(`Added ${p.name}`); };
    } else { const p = prodById(id); bindProductForm(tr, p); tr.querySelector('[data-pdone]').onclick = () => { S.prodEdit = null; renderProducts(); }; }
  });
  $$('#prodTable tr[data-id]').forEach(tr => tr.onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act, p = prodById(tr.dataset.id); if (!act) return;
    if (act === 'edit') { S.prodEdit = S.prodEdit === p.id ? null : p.id; renderProducts(); $(`#prodTable tr.pedit [data-pf=name]`)?.focus(); }
    if (act === 'use') { S.selId = null; S.activeProductId = p.id; refreshActiveProduct(); switchView('plans'); autoToolFor(p); }
    if (act === 'del') {
      const n = used[p.id] || 0;
      if (!await askConfirm('Delete product?', `Delete <b>${esc(p.name)}</b> from the library?${n ? ` ${n} markups in this project will become unassigned.` : ''} (Other projects that use it will show those markups as unassigned too.)`)) return;
      await DB.del('products', p.id); S.products = S.products.filter(x => x.id !== p.id); refreshActiveProduct(); renderProducts(); toast('Product deleted');
    }
  });
}
const fxProblem = f => { try { fxEval(f, FX_SAMPLE); return ''; } catch (e) { return e.message; } };
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
  const rows = [['name', 'category', 'unit', 'unit_price', 'labor_price', 'waste_pct', 'color', 'multiplier', 'formula'], ...S.products.map(p => [p.name, p.category, p.unit, p.price, p.labor || 0, p.waste || 0, p.color, p.mult || 1, p.formula || ''])];
  download('products.csv', '\ufeff' + toCSV(rows), 'text/csv'); toast('Product library exported');
}
async function importProductsCsv(text) {
  const rows = parseCSV(text); if (rows.length < 2) return toast('No rows found in CSV');
  const hdr = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const col = (...names) => hdr.findIndex(h => names.includes(h));
  const ix = { name: col('name', 'product', 'item'), cat: col('category', 'cat'), unit: col('unit', 'uom'), price: col('unitprice', 'price', 'cost'), labor: col('laborprice', 'labor', 'laborperunit'), waste: col('wastepct', 'waste', 'wastepercent'), color: col('color', 'colour'), mult: col('multiplier', 'mult', 'factor'), formula: col('formula', 'quantityformula', 'qtyformula') };
  if (ix.name < 0) return toast('CSV needs a "name" column');
  let added = 0, updated = 0;
  for (const r of rows.slice(1)) {
    const g = k => ix[k] >= 0 ? (r[ix[k]] ?? '').trim() : ''; const name = g('name'); if (!name) continue;
    const cat = g('cat'); let p = S.products.find(x => x.name.toLowerCase() === name.toLowerCase() && (x.category || '').toLowerCase() === cat.toLowerCase());
    const isNew = !p; p ||= { id: uid(), color: PALETTE[(S.products.length + added) % PALETTE.length] };
    Object.assign(p, { name, category: cat, unit: (g('unit') || p.unit || 'EA').toUpperCase(), price: num(g('price'), p.price || 0), labor: num(g('labor'), p.labor || 0), waste: num(g('waste'), p.waste || 0), mult: num(g('mult'), p.mult || 1) || 1 });
    if (ix.formula >= 0) p.formula = g('formula');
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
$('#btnAddBlank').onclick = () => { setDockTab('draw'); setTimeout(() => $('#bpSize')?.focus(), 30); };
$('#filePdf').onchange = async e => { await addPdfFiles(e.target.files); e.target.value = ''; };
$('#btnRemovePdf').onclick = removeCurrentPdf;
$('#docSelect').onchange = async e => { if (e.target.value) { await showPage(e.target.value, 1); renderThumbs(); } };
$('#activeProduct').onchange = e => {
  const v = e.target.value; if (v === '__mixed') return;
  if (v === '__new') { refreshActiveProduct(); openNewProduct(); return; }
  if (pickerMode() === 'sel') {   // markups are selected: this box sets THEIR product
    const ms = selMarks().filter(isQty); pushUndo(); for (const m of ms) { m.productId = v || null; m.color = v ? null : TYPE_COLOR[m.type]; }
    touch(); renderOverlay(); refreshPanel(); markThumb(); toast(`${ms.length} markup${ms.length > 1 ? 's' : ''} → ${prodById(v)?.name || 'no product'}`); return;
  }
  S.activeProductId = v; S.countId = null; updateFinish(); refreshActiveProduct(); autoToolFor(prodById(S.activeProductId));
};
$('#btnFinish').onclick = finishDrawing; $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnScale').onclick = () => { if (!S.page) return toast('Open a PDF first'); S.calib = null; setDockTab('scale'); };
$('#zoomIn').onclick = () => zoomAt(1.3, viewer.clientWidth / 2, viewer.clientHeight / 2);
$('#zoomOut').onclick = () => zoomAt(1 / 1.3, viewer.clientWidth / 2, viewer.clientHeight / 2);
$('#zoomFit').onclick = fitPage;
$('#prevPage').onclick = () => gotoPage(-1); $('#nextPage').onclick = () => gotoPage(1);
$('#btnAddManual').onclick = () => { if (!S.project) return; S.project.manual.push({ id: uid(), desc: '', unit: 'EA', qty: 1, price: 0, labor: 0 }); touch(); renderEstimate(); const ins = $$('#estTable tr[data-mid] input[data-f=desc]'); ins[ins.length - 1]?.focus(); };
$('#togPrices').onchange = e => setShowPrices(e.target.checked);
$('#btnExportCsv').onclick = exportEstimateCsv; $('#btnExportXlsx').onclick = () => exportXlsx().catch(e => { console.warn(e); toast('Excel export failed — use CSV'); }); $('#btnPrint').onclick = printSummary;
$('#btnAddProduct').onclick = () => { S.prodEdit = 'new'; S.prodDraft = blankProduct(); renderProducts(); $('#prodTable tr.pedit [data-pf=name]')?.focus(); }; $('#prodSearch').oninput = renderProducts;
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
    const t = { id: uid(), name: 'Standard job review', items: ['Verify ceiling height', 'Confirm materials and fixtures', 'Confirm finish / color selection', 'Field-verify wall dimensions', 'Check outlet and switch locations', 'Confirm door swings and clearances', 'Check plan revision / date', 'Confirm delivery and install access'] };
    await DB.put('templates', t); S.templates.push(t); await DB.put('meta', { id: 'seeded', at: Date.now() });
  }
  const last = await DB.get('meta', 'last'); const projects = await DB.all('projects');
  const pick = projects.find(p => p.id === last?.projectId) || projects.sort((a, b) => b.updated - a.updated)[0];
  if (pick) await openProject(pick.id); else { clearViewer(); refreshAll(); }
  setTool('select'); setSave('');
}
start().catch(e => { console.error(e); toast('Startup error: ' + e.message, 6000); });
const UI_KEY = 'dt-ui-v1';
const UI = (() => { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; } })();
if (UI.sideMin === undefined && innerWidth < 800) UI.sideMin = true;
if (UI.panelMin === undefined && innerWidth < 800) UI.panelMin = true;   // v1.6: on phones the bottom dock does the panel's job
window.DT = { S, UI, applyT, setSelection, selMarks, copySel, pasteClip, duplicateSel, deleteSelected, combineCounts, selectAllPage, fxEval, pickerMode, fitPage, toScreen, detInfo: () => detState, hitTest, toPage, computeEstimate, geo, fmtFtIn, qtyFor, flush, setTool, SCALES, undo, redo, styleOf, bboxOf, setDockTab, printDrawing, renderOverlay, refreshPanel };

if (/^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => { reg.update().catch(() => { }); document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => { }); }); }).catch(() => { });
  let reloaded = false; const hadCtrl = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadCtrl || reloaded || S.drawing) return; reloaded = true; flush().then(() => location.reload()); });
}

/* ======================= v1.4: selection bar, multi-select, resizable / minimizable panels ======================= */
$$('#selBar [data-sa]').forEach(b => b.onclick = () => ({ copy: copySel, paste: pasteClip, dup: duplicateSel, combine: combineCounts, del: deleteSelected, clear: () => { S.selId = null; renderOverlay(); refreshPanel(); } })[b.dataset.sa]());
$('#btnMulti').onclick = () => { S.multi = !S.multi; if (S.multi && S.tool !== 'select') setTool('select'); refreshSelBar(); toast(S.multi ? 'Multi-select on: tap items to add or remove them' : 'Multi-select off'); };
$('#btnSelAll').onclick = selectAllPage; $('#btnPaste').onclick = pasteClip;

const saveUI = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(UI)); } catch { } };
$('#togPrintSubs').checked = !!UI.printSubs;
$('#togPrintSubs').onchange = e => { UI.printSubs = e.target.checked; saveUI(); };
function applyUI() {
  const body = $('#plansBody'), side = $('#sidebar'), panel = $('#panel');
  body.classList.toggle('swapped', !!UI.swap);
  side.style.width = UI.sideW ? UI.sideW + 'px' : ''; panel.style.width = UI.panelW ? UI.panelW + 'px' : '';
  side.classList.toggle('min', !!UI.sideMin); panel.classList.toggle('min', !!UI.panelMin);
  $('#splitSide').classList.toggle('min', !!UI.sideMin); $('#splitPanel').classList.toggle('min', !!UI.panelMin);
  setTimeout(() => S.page && scheduleDetail(), 60);
}
$('#togglePanel').onclick = () => { UI.panelMin = !UI.panelMin; saveUI(); applyUI(); };
$('#toggleSide').onclick = () => { UI.sideMin = !UI.sideMin; saveUI(); applyUI(); };
$('#btnSwap').onclick = () => { UI.swap = !UI.swap; saveUI(); applyUI(); };
$$('[data-min]').forEach(b => b.onclick = () => { UI[b.dataset.min === 'side' ? 'sideMin' : 'panelMin'] = true; saveUI(); applyUI(); });
$$('[data-restore]').forEach(b => b.onclick = () => { UI[b.dataset.restore === 'side' ? 'sideMin' : 'panelMin'] = false; saveUI(); applyUI(); });
$$('.split').forEach(sp => {
  sp.addEventListener('pointerdown', e => {
    const which = sp.dataset.split, el = which === 'side' ? $('#sidebar') : $('#panel'), body = $('#plansBody');
    if (el.classList.contains('min')) return;
    e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
    const mv = ev => {
      const br = body.getBoundingClientRect(), vr = $('#viewer').getBoundingClientRect(), onLeft = el.getBoundingClientRect().left < vr.left;
      const w = clamp(Math.round(onLeft ? ev.clientX - br.left : br.right - ev.clientX), 120, Math.min(640, br.width - 260));
      el.style.width = w + 'px'; UI[which === 'side' ? 'sideW' : 'panelW'] = w;
    };
    const up = () => { sp.classList.remove('drag'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up); saveUI(); S.page && scheduleDetail(); };
    sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
  });
  sp.addEventListener('dblclick', () => { const k = sp.dataset.split === 'side' ? 'sideW' : 'panelW'; delete UI[k]; saveUI(); applyUI(); });   // double-click = reset width
});
applyUI();

/* ======================= VOICE ESTIMATOR (v1.1) ======================= */
// Parsing + matching run locally (voice.js). Speech-to-text is the browser's own Web Speech service.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let vRec = null, vRows = [];
function voiceModal() {
  if (!S.project) return toast('Open or create a project first');
  if (!S.products.length) toast('Tip: add products first so items can be matched and priced', 3500);
  const ex = '40 feet of baseboard, two doors, 120 square feet of drywall';
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

/* ======================= v1.6: annotation markups (Bluebeam-style markup toolbar) ======================= */
const rr2 = v => Math.round(v * 100) / 100;
const annToolStyle = k => ({ ...(ANN_DEF[k] || SHAPE), ...((UI.ann || {})[k] || {}) });
function addNote(kind, pts, text = '') {
  pushUndo();
  const m = { id: uid(), type: 'note', kind, docId: S.docId, page: S.pageNum, pts: pts.map(p => [rr2(p[0]), rr2(p[1])]), text, style: annToolStyle(kind), label: '', created: Date.now() };
  S.project.markups.push(m); S.selId = m.id;
  touch(); renderOverlay(); refreshPanel(); markThumb(); return m;
}
function finishAnn(g) {
  S.annPrev = null; const k = g.kind, q0 = g.pts[0];
  if (k === 'text') {
    const hit = hitTest(q0); if (hit && !isQty(hit) && (hit.kind === 'text' || hit.kind === 'callout')) { S.selId = hit.id; renderOverlay(); refreshPanel(); editTextInPlace(hit, false); return; }
    editTextInPlace(addNote('text', [q0]), true); return;
  }
  if (k === 'callout') { const box = g.moved ? g.pts[g.pts.length - 1] : [q0[0] + 40 / S.z, q0[1] - 70 / S.z]; editTextInPlace(addNote('callout', [q0, box]), true); return; }
  if (!g.moved) { renderPreview(); toast(`Drag on the plan to draw a ${ANN_KINDS[k].toLowerCase()}`); return; }
  addNote(k, g.pts);
}
function editTextInPlace(m, isNew) {
  closeTextEditor();
  const st = styleOf(m), t = textLayout(m, st), ta = document.createElement('textarea');
  ta.id = 'inlineText'; ta.value = m.text || ''; ta.placeholder = 'Type your text…'; ta.spellcheck = true;
  Object.assign(ta.style, { left: (S.tx + t.x * S.z) + 'px', top: (S.ty + t.y * S.z) + 'px', fontSize: clamp(st.fs * S.z, 13, 64) + 'px', color: st.color, fontWeight: st.bold ? '700' : '400' });
  viewer.appendChild(ta); S.editing = { m, isNew, ta };
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  ta.oninput = fit; fit(); setTimeout(() => ta.focus(), 0);
  ta.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ta.blur(); } };
  ta.onblur = () => closeTextEditor();
  ta.addEventListener('pointerdown', e => e.stopPropagation());
}
function closeTextEditor() {
  const E = S.editing; if (!E) return; S.editing = null;
  const v = E.ta.value.replace(/\s+$/, ''); E.ta.remove();
  if (!v.trim()) { if (E.isNew) { S.project.markups = S.project.markups.filter(x => x.id !== E.m.id); S.undo.pop(); if (S.sel.has(E.m.id)) S.selId = null; } }
  else if (v !== E.m.text) { if (!E.isNew) pushUndo(); E.m.text = v; }
  touch(); renderOverlay(); refreshPanel(); markThumb();
}
viewer.addEventListener('dblclick', e => {
  if (S.tool !== 'select' || !S.page) return;
  const hit = hitTest(toPage(...local(e)));
  if (hit && !isQty(hit) && (hit.kind === 'text' || hit.kind === 'callout')) { S.selId = hit.id; renderOverlay(); refreshPanel(); editTextInPlace(hit, false); }
});

/* ======================= v1.6: style controls (Bluebeam/OST conventions: color, line width, line style, fill, hatch, opacity) ======================= */
const hex6 = c => /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#000000';
const STYLE_FIELDS = {
  length: ['color', 'width', 'dash', 'opacity', 'show'],
  area: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'hatch', 'opacity', 'show'],
  count: ['color', 'opacity', 'show'],
  highlight: ['color', 'width', 'opacity'],
  pen: ['color', 'width', 'dash', 'opacity'], line: ['color', 'width', 'dash', 'opacity'], arrow: ['color', 'width', 'dash', 'opacity'],
  rect: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'opacity'], ellipse: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'opacity'], cloud: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'opacity'],
  text: ['color', 'fs', 'bold', 'bg', 'border', 'opacity'],
  callout: ['color', 'width', 'fs', 'bold', 'bg', 'opacity'],
  dline: ['color', 'width', 'dash', 'opacity'], drect: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'hatch', 'opacity'], dim: ['color', 'width', 'fs', 'opacity'],
  wall: ['color', 'width', 'hatch', 'opacity', 'show'],
};
const fieldsFor = m => STYLE_FIELDS[isQty(m) ? (m.wall ? 'wall' : m.type) : m.kind] || [];
function hatchIcon(k) {
  const L = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="1.3"/>`;
  const b = { none: '', diag: L(0, 6, 6, 0) + L(0, 12, 12, 0) + L(6, 12, 12, 6), back: L(0, 6, 6, 12) + L(0, 0, 12, 12) + L(6, 0, 12, 6), cross: L(0, 12, 12, 0) + L(0, 0, 12, 12), horiz: L(0, 3, 12, 3) + L(0, 7, 12, 7) + L(0, 11, 12, 11), vert: L(3, 0, 3, 12) + L(7, 0, 7, 12) + L(11, 0, 11, 12), grid: L(0, 4, 12, 4) + L(0, 8, 12, 8) + L(4, 0, 4, 12) + L(8, 0, 8, 12), dots: '<circle cx="3" cy="3" r="1.2" fill="currentColor"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="3" r="1.2" fill="currentColor"/><circle cx="3" cy="9" r="1.2" fill="currentColor"/>' }[k];
  if (b === undefined) return patIcon(k, 18);
  return `<svg viewBox="0 0 12 12" width="18" height="18"><rect x=".5" y=".5" width="11" height="11" fill="none" stroke="currentColor" stroke-opacity=".5"/>${b}</svg>`;
}
function styleHTML(st, F, kind) {
  const rng = (k, label, min, max, step, v, unit = '') => `<label class="sg"><span>${label} <output>${fmtStyle(k, v)}${unit}</output></span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
  let h = '<div class="stl">';
  if (F.includes('color')) h += `<div class="sg wide"><span>Color</span><div class="sws">${SWATCHES.map(c => `<button type="button" class="swb${String(st.color).toLowerCase() === c ? ' on' : ''}" data-k="color" data-v="${c}" style="background:${c}" title="${c}" aria-label="Color ${c}"></button>`).join('')}<input type="color" data-k="color" value="${hex6(st.color)}" title="Custom color"></div></div>`;
  if (F.includes('width')) h += rng('width', 'Line width', 0.5, kind === 'highlight' ? 48 : 16, 0.5, +st.width || 2, ' pt');
  if (F.includes('dash')) h += `<label class="sg"><span>Line style</span><select data-k="dash">${Object.entries(DASHES).map(([k, n]) => `<option value="${k}" ${st.dash === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  if (F.includes('fill')) h += `<label class="sg"><span>Fill</span><select data-k="fill"><option value="none" ${st.fill === 'none' ? 'selected' : ''}>No fill</option><option value="solid" ${st.fill !== 'none' ? 'selected' : ''}>Color fill</option></select></label>`;
  if (F.includes('fillOpacity')) h += rng('fillOpacity', 'Fill opacity', 0.05, 1, 0.05, st.fillOpacity ?? 0.2);
  if (F.includes('hatch')) h += `<div class="sg wide"><span>Pattern (hatch) <output>${esc(HATCHES[st.hatch || 'none'] || 'None')}</output></span>${HATCH_GROUPS.map(([g, ks]) => `<div class="hts"><i class="htg">${g}</i>${ks.map(k => `<button type="button" class="htb${(st.hatch || 'none') === k ? ' on' : ''}" data-k="hatch" data-v="${k}" title="${HATCHES[k]}" aria-label="Hatch ${HATCHES[k]}">${hatchIcon(k)}</button>`).join('')}</div>`).join('')}</div>`;
  if (F.includes('fs')) h += rng('fs', 'Font size', 4, 120, 1, +st.fs || 16, ' pt');
  if (F.includes('bold')) h += `<label class="sg chk"><input type="checkbox" data-k="bold" ${st.bold ? 'checked' : ''}> Bold</label>`;
  if (F.includes('bg')) h += `<label class="sg"><span>Background</span><select data-k="bg">${[['none', 'None'], ['#ffffff', 'White'], ['#fff7b0', 'Yellow'], ['#e8f1ff', 'Light blue']].map(([v, n]) => `<option value="${v}" ${st.bg === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  if (F.includes('border')) h += `<label class="sg chk"><input type="checkbox" data-k="border" ${st.border ? 'checked' : ''}> Border</label>`;
  if (F.includes('opacity')) h += rng('opacity', 'Opacity', 0.1, 1, 0.05, st.opacity ?? 1);
  if (F.includes('show')) h += `<div class="sg wide"><span>Show on drawing</span><label class="chk"><input type="checkbox" data-k="showLabel" ${st.showLabel !== false ? 'checked' : ''}> Label</label> <label class="chk"><input type="checkbox" data-k="showValue" ${st.showValue !== false ? 'checked' : ''}> Measurement</label></div>`;
  return h + '</div>';
}
const fmtStyle = (k, v) => /opacity/i.test(k) ? Math.round(v * 100) + '%' : String(+(+v).toFixed(1));
function bindStyle(root, set) {   // set(key, value, final)
  root.querySelectorAll('[data-k]').forEach(el => {
    const k = el.dataset.k;
    const val = () => el.type === 'checkbox' ? el.checked : el.dataset.v ?? (el.type === 'range' ? parseFloat(el.value) : el.value);
    if (el.tagName === 'BUTTON') { el.onclick = () => set(k, val(), true); return; }
    el.oninput = () => { const o = el.parentElement.querySelector('output') || el.closest('.sg')?.querySelector('output'); if (o) o.textContent = fmtStyle(k, val()) + (k === 'width' || k === 'fs' ? ' pt' : ''); if (el.type === 'range' || el.type === 'color') set(k, val(), false); };
    el.onchange = () => set(k, val(), true);
  });
}
let styleUndo = false;
function styleSetter(ms, scope) {   // scope 'product': change the product's look (all its markups, OST "condition" style); else these markups only
  return (k, v, final) => {
    if (scope === 'product') {
      const prods = [...new Set(ms.map(m => prodById(m.productId)).filter(Boolean))];
      if (!styleUndo) { pushUndo(); styleUndo = true; }
      for (const p of prods) {
        if (k === 'color') p.color = v; else p.style = { ...(p.style || {}), [k]: v };
        for (const m of S.project.markups) if (m.productId === p.id && m.style && k in m.style) { delete m.style[k]; if (!Object.keys(m.style).length) delete m.style; }
      }
      renderOverlay();
      if (final) { styleUndo = false; prods.forEach(saveProduct); touch(); refreshActiveProduct(); refreshPanel(); renderDock(true); }
      return;
    }
    if (!styleUndo) { pushUndo(); styleUndo = true; }
    for (const m of ms) m.style = { ...(m.style || {}), [k]: v };
    renderOverlay();
    if (final) { styleUndo = false; touch(); refreshPanel(); renderDock(true); }
  };
}

/* ======================= v1.6: bottom dock (properties, formula, product, scale, print) ======================= */
S.dockTab = ['props', 'fx', 'prod', 'scale', 'print', 'draw'].includes(UI.dockTab) ? UI.dockTab : 'fx';
S.styleScope = 'markup'; S.fxScope = 'product';
let dockKey = '', dockLive = () => { };
function setDockTab(t) {
  if (t !== 'prod') S.dockNew = t === 'prod' ? S.dockNew : null;
  S.dockTab = t; UI.dockTab = t; if (UI.dockMin) { UI.dockMin = false; applyDock(); } saveUI(); renderDock(true);
}
function applyDock() {
  const d = $('#dock'); if (!d) return;
  d.classList.toggle('min', !!UI.dockMin);
  d.style.height = UI.dockMin ? '' : (UI.dockH || (innerWidth < 800 ? 220 : 250)) + 'px';
  $('#dockMin').textContent = UI.dockMin ? '▴' : '▾'; $('#dockMin').title = UI.dockMin ? 'Open the bottom panel' : 'Minimize the bottom panel';
  setTimeout(() => S.page && scheduleDetail(), 60);
}
function dockTarget() {   // the product the Formula / Product tabs work on: the selected markup's product, else the toolbar's product
  const q = selMarks().filter(isQty), m = q.find(x => x.id === S._pri) || q[0];
  if (m) return { m, p: prodById(m.productId) };
  return { m: null, p: S.tool === 'select' || QTY_TYPES.has(S.tool) ? prodById(S.activeProductId) : prodById(S.activeProductId) };
}
function renderDock(force) {
  const body = $('#dockBody'); if (!body) return;
  $$('#dockTabs button').forEach(b => b.classList.toggle('on', b.dataset.dt === S.dockTab));
  const key = [S.dockTab, [...S.sel].join(','), S.activeProductId, S.tool, S.dockNew ? 'n' : '', S.calib ? 'c' : '', S.project?.id, S.docId, S.pageNum, S.styleScope, S.fxScope, S.dockTab === 'draw' ? (S.drawing?.pts.length ? 1 : 0) + ':' + (curScale()?.ftPerPt || '') : ''].join('|');
  if (!force && key === dockKey && body.contains(document.activeElement)) { dockLive(); return; }
  dockKey = key; dockLive = () => { };
  ({ props: dockProps, fx: dockFx, prod: dockProd, scale: dockScale, print: dockPrint, draw: dockDraw })[S.dockTab](body);
  const ms = selMarks(), ctx = $('#dockCtx');
  ctx.textContent = ms.length > 1 ? `${ms.length} selected` : ms.length ? `Selected: ${markName(ms[0])}${ms[0].label ? ' · ' + ms[0].label : ''}` : isAnnTool(S.tool) || isDraftTool(S.tool) ? `Tool: ${NOTE_NAMES[S.tool] || 'Wall'}` : prodById(S.activeProductId) ? `Next: ${prodById(S.activeProductId).name}` : '';
}
function dockProps(body) {
  if (!S.project || !S.page) { body.innerHTML = '<p class="muted small">Open a PDF to start. Select a markup to edit its label, text and look here.</p>'; return; }
  const ms = selMarks();
  if (!ms.length) {
    if (isAnnTool(S.tool)) {
      const k = S.tool;
      body.innerHTML = `<div class="dhead"><b>${ANN_KINDS[k]} tool</b><span class="muted small">How the next ${ANN_KINDS[k].toLowerCase()} looks (remembered on this device). ${esc(HINTS[k] || '')}</span><button class="small" id="annReset">Reset look</button></div>${styleHTML(annToolStyle(k), STYLE_FIELDS[k], k)}`;
      bindStyle(body, (key, v, final) => { UI.ann = UI.ann || {}; UI.ann[k] = { ...(UI.ann[k] || {}), [key]: v }; saveUI(); if (final) renderDock(true); });
      body.querySelector('#annReset').onclick = () => { if (UI.ann) delete UI.ann[k]; saveUI(); renderDock(true); };
      return;
    }
    const p = prodById(S.activeProductId);
    if (p) {
      body.innerHTML = `<div class="dhead"><span class="sw" style="background:${p.color}"></span><b>${esc(p.name)}</b><span class="muted small">Look of every markup that uses this product (like a Bluebeam tool set / OST condition).</span></div>${styleHTML({ ...QTY_DEF, ...(p.style || {}), color: p.color }, ['color', 'width', 'dash', 'fill', 'fillOpacity', 'hatch', 'opacity', 'show'], 'area')}`;
      bindStyle(body, (k, v, final) => { if (k === 'color') p.color = v; else p.style = { ...(p.style || {}), [k]: v }; renderOverlay(); if (final) { saveProduct(p); refreshActiveProduct(); refreshPanel(); renderDock(true); } });
      return;
    }
    body.innerHTML = '<p class="muted small">Select a markup on the plan to edit its label, text and look here. Pick a markup tool (highlighter, pen, cloud, text…) to set how it draws.</p>'; return;
  }
  const m = ms[0], one = ms.length === 1, allQty = ms.every(isQty), hasProd = allQty && ms.some(x => prodById(x.productId));
  const scope = hasProd ? S.styleScope : 'markup';
  const kinds = new Set(ms.map(x => isQty(x) ? x.type : x.kind));
  const F = kinds.size === 1 ? fieldsFor(m) : ['color', 'opacity'];
  const st = styleOf(m);
  let h = '<div class="dgrid"><div class="dcol">';
  if (one && isQty(m)) {
    const g = geo(m), p = prodById(m.productId), q = p ? qtyFor(m, p) : null;
    h += `<div class="big-val">${esc(valueText(m).split(' · ')[0])}</div>
      ${m.type === 'area' && !g.noscale ? `<div class="muted small">Perimeter ${fmtFtIn(g.lf)} (${fmtN(g.lf)} LF)</div>` : ''}
      ${p && q != null ? `<div class="small">Counts as <b>${fmtQty(q, p.unit)} ${esc(p.unit)}</b> of ${esc(p.name)}</div>` : `<div class="small muted">${p ? '' : 'No product yet: pick one in the Product box at the top.'}</div>`}
      <label class="field"><span>Label</span><input id="sLabel" value="${esc(m.label)}" placeholder="e.g. Kitchen north wall"></label>
      ${m.wall ? wallPresetHTML(m.wall, 'pw') : ''}
      ${m.type === 'length' ? `<label class="field"><span>${m.wall ? 'Wall height ft (area = LF × height)' : 'Wall height ft (turns length into SF)'}</span><input id="sHeight" inputmode="decimal" value="${m.height || ''}" placeholder="e.g. 9"></label>` : ''}
      <div class="actions">${m.type === 'count' ? '<button class="small" id="sAddCount">+ Add to this count</button>' : ''}<button class="small" data-goto="fx">ƒx Formula</button><button class="small danger" id="sDel">Delete</button></div>`;
  } else if (one) {
    h += `<div class="dhead"><b>${NOTE_NAMES[m.kind]}</b><span class="muted small">${DRAFT_KINDS[m.kind] ? 'Plan linework' : 'Drawing note'}: prints on the drawing, never counts in quantities.${m.kind === 'dim' ? ' Reads ' + esc(dimText(m)) + '.' : ''}</span></div>
      ${m.kind === 'text' || m.kind === 'callout' ? `<label class="field"><span>Text</span><textarea id="sText" rows="2">${esc(m.text)}</textarea></label>` : ''}
      <label class="field"><span>Label (shows in the markup list)</span><input id="sLabel" value="${esc(m.label)}" placeholder="optional"></label>
      <div class="actions"><button class="small danger" id="sDel">Delete</button></div>`;
  } else {
    h += `<div class="dhead"><b>${ms.length} selected</b><span class="muted small">Style changes apply to all of them. Drag one to move them all.</span></div><div class="actions"><button class="small danger" id="sDel">Delete ${ms.length}</button></div>`;
  }
  h += `</div><div class="dcol grow">${hasProd ? `<div class="seg" role="group" aria-label="Apply style to"><button type="button" data-scope="markup" class="${scope === 'markup' ? 'on' : ''}">This markup</button><button type="button" data-scope="product" class="${scope === 'product' ? 'on' : ''}">Whole product</button></div>` : ''}${styleHTML(st, F, m.kind || m.type)}</div></div>`;
  body.innerHTML = h;
  bindStyle(body.querySelector('.dcol.grow'), styleSetter(ms, scope));
  body.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { S.styleScope = b.dataset.scope; renderDock(true); });
  body.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => setDockTab(b.dataset.goto));
  const lab = body.querySelector('#sLabel'); if (lab) lab.onchange = () => { pushUndo(); m.label = lab.value.trim(); touch(); renderOverlay(); refreshPanel(); };
  if (m.wall) bindWallPreset(body, 'pw', w => { pushUndo(); m.wall = w; touch(); renderOverlay(); refreshPanel(); renderDock(true); });
  const hEl = body.querySelector('#sHeight'); if (hEl) hEl.onchange = () => { pushUndo(); const v = num(hEl.value, 0); m.height = v > 0 ? v : null; touch(); renderOverlay(); refreshPanel(); renderDock(true); };
  const tx = body.querySelector('#sText'); if (tx) { let u = false; tx.oninput = () => { if (!u) { pushUndo(); u = true; } m.text = tx.value; renderOverlay(); }; tx.onchange = () => { u = false; touch(); refreshPanel(); }; }
  const del = body.querySelector('#sDel'); if (del) del.onclick = () => one ? deleteMarkup(m.id) : deleteSelected();
  const ac = body.querySelector('#sAddCount'); if (ac) ac.onclick = () => { setTool('count'); S.countId = m.id; S.selId = m.id; updateFinish(); renderOverlay(); toast('Tap to add more to this count'); };
}
function fxRows(p) {   // every markup of this product in the project, current page first
  const all = S.project.markups.filter(x => isQty(x) && x.productId === p.id);
  all.sort((a, b) => ((b.docId === S.docId && b.page === S.pageNum) - (a.docId === S.docId && a.page === S.pageNum)) || a.page - b.page);
  return all;
}
function dockFx(body) {
  if (!S.project) { body.innerHTML = '<p class="muted small">Open a project first.</p>'; return; }
  const { m, p } = dockTarget();
  if (!p) { body.innerHTML = `<div class="dhead"><b>ƒx Formula</b><span class="muted small">Pick a product in the Product box at the top, or select a markup that has one, to see and edit its quantity formula here with live results.</span><button class="small" id="fxNew">＋ New product</button></div>`; body.querySelector('#fxNew').onclick = openNewProduct; return; }
  const scope = m ? S.fxScope : 'product', f = scope === 'markup' ? (m.formula || '') : (p.formula || '');
  body.innerHTML = `<div class="dgrid"><div class="dcol">
    <div class="dhead"><span class="sw" style="background:${p.color}"></span><b>${esc(p.name)}</b> <span class="muted">(${esc(p.unit)})</span>
      ${m ? `<div class="seg"><button type="button" data-fs="product" class="${scope === 'product' ? 'on' : ''}" title="Edit the product's formula: every markup of this product uses it">Product formula</button><button type="button" data-fs="markup" class="${scope === 'markup' ? 'on' : ''}" title="A formula just for the selected markup (overrides the product's)">This markup only</button></div>` : ''}</div>
    <div class="fxRow"><span class="fxEq">ƒx =</span><input id="fxIn" class="mono" value="${esc(f)}" placeholder="${scope === 'markup' ? 'blank = use the product formula' : 'blank = measured × multiplier'}" spellcheck="false" autocapitalize="off" autocomplete="off"><button class="small" id="fxClear" title="Clear the formula">Clear</button></div>
    <div class="fxRow"><select id="fxPreset"><option value="">Insert an example…</option>${FX_PRESETS.map(([n, fx]) => `<option value="${esc(fx)}">${esc(n)} → ${esc(fx)}</option>`).join('')}</select><button class="small" id="fxHelpT">Help</button></div>
    <div id="fxMsg" class="small"></div>
    <div id="fxVars" class="fxVars"></div>
    <div id="fxHelpBox" class="fxhelp hidden">${FX_HELP}</div>
  </div><div class="dcol grow"><div id="fxRes"></div></div></div>`;
  const inp = body.querySelector('#fxIn'), msg = body.querySelector('#fxMsg');
  const live = () => {
    const rows = fxRows(p), sample = m || rows[0];
    if (sample) { const g = geo(sample), base = g.noscale ? 0 : qtyDefault(sample, g, p), V = g.noscale ? null : fxVars(sample, g, base, p);
      body.querySelector('#fxVars').innerHTML = V ? `<span class="muted small">${m ? 'Selected markup' : 'First markup'}:</span> ` + [['Length', V.length, 'LF'], ['Area', V.area, 'SF'], ['Perimeter', V.perimeter, 'LF'], ['Count', V.count, 'EA'], ['Height', V.height, 'ft'], ['Qty', V.qty, ''], ['Mult', V.mult, '']].map(([n, v, u]) => `<button type="button" class="chip" data-ins="${n}" title="Insert ${n}">${n} <b>${fmtN(v, 2)}</b>${u ? ' ' + u : ''}</button>`).join('') : '<span class="muted small">Set the scale to see measured values.</span>';
      body.querySelectorAll('[data-ins]').forEach(b => b.onclick = () => { const s = inp.selectionStart ?? inp.value.length; inp.value = inp.value.slice(0, s) + b.dataset.ins + inp.value.slice(inp.selectionEnd ?? s); inp.focus(); inp.dispatchEvent(new Event('input')); });
    } else body.querySelector('#fxVars').innerHTML = '<span class="muted small">No markups use this product yet. Draw one to see live results.</span>';
    let tot = 0, n = 0, h = '';
    rows.forEach((x, i) => { const q = qtyFor(x, p); if (q != null) tot += q; n++; if (i < 60) h += `<tr class="${S.sel.has(x.id) ? 'on' : ''}" data-mid="${x.id}"><td>${x.docId === S.docId && x.page === S.pageNum ? 'This page' : 'Pg ' + x.page}</td><td>${esc(x.label || markName(x))}${x.formula ? ' <span class="badge" title="Has its own formula">ƒx</span>' : ''}</td><td>${esc(valueText(x).split(' · ')[0])}</td><td class="n"><b>${fmtQty(q, p.unit)}</b></td></tr>`; });
    const w = num(p.waste);
    body.querySelector('#fxRes').innerHTML = `<table class="fxT"><thead><tr><th>Where</th><th>Markup</th><th>Measured</th><th class="n">Qty (${esc(p.unit)})</th></tr></thead><tbody>${h || '<tr><td colspan="4" class="muted">No markups yet</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">Total · ${n} markup${n === 1 ? '' : 's'}${w ? ` · with ${fmtN(w, 1)}% waste ${fmtQty(tot * (1 + w / 100), p.unit)}` : ''}</td><td class="n"><b id="fxTotal">${fmtQty(tot, p.unit)}</b></td></tr></tfoot></table>`;
    body.querySelectorAll('#fxRes tr[data-mid]').forEach(tr => tr.onclick = () => { const x = S.project.markups.find(y => y.id === tr.dataset.mid); if (!x) return; if (x.docId !== S.docId || x.page !== S.pageNum) showPage(x.docId, x.page).then(() => { S.selId = x.id; renderOverlay(); refreshPanel(); }); else { if (S.tool !== 'select') setTool('select'); S.selId = x.id; renderOverlay(); refreshPanel(); } });
  };
  dockLive = live;
  let saveT = 0, undone = false;
  const check = () => {
    const v = inp.value.trim(), er = v ? fxProblem(v) : '';
    msg.className = 'small ' + (er ? 'fxerr' : v ? 'fxok' : 'muted');
    msg.textContent = er ? '⚠ ' + er + ' (not saved yet)' : v ? '✓ Saved · results update live' : (scope === 'markup' ? 'Using the product formula' + (p.formula ? `: ${p.formula}` : ' (none: measured × multiplier)') : 'No formula: quantity = measured × multiplier');
    if (er) return;
    if (scope === 'markup') { if ((m.formula || '') !== v) { if (!undone) { pushUndo(); undone = true; } if (v) m.formula = v; else delete m.formula; touch(); } }
    else if ((p.formula || '') !== v) { p.formula = v; clearTimeout(saveT); saveT = setTimeout(() => saveProduct(p), 300); }
    live(); clearTimeout(check.t); check.t = setTimeout(() => { refreshPanel(); if (S.view === 'estimate') renderEstimate(); }, 250);
  };
  inp.oninput = check; check();
  body.querySelector('#fxClear').onclick = () => { inp.value = ''; check(); inp.focus(); };
  body.querySelector('#fxPreset').onchange = e => { if (e.target.value) { inp.value = e.target.value; check(); } e.target.value = ''; };
  body.querySelector('#fxHelpT').onclick = () => body.querySelector('#fxHelpBox').classList.toggle('hidden');
  body.querySelectorAll('[data-fs]').forEach(b => b.onclick = () => { S.fxScope = b.dataset.fs; renderDock(true); });
}
/* product form shared by the dock and the Products page (inline, no popup) */
const UNITS = ['LF', 'SF', 'EA', 'SY', 'SHT', 'BOX', 'HR', 'SET'];
function blankProduct(o = {}) { return { id: uid(), name: '', category: '', unit: 'EA', price: 0, labor: 0, waste: 0, color: PALETTE[S.products.length % PALETTE.length], mult: 1, formula: '', ...o }; }
function productFormHTML(p, opts = {}) {
  const cats = [...new Set(S.products.map(x => x.category).filter(Boolean))];
  const f = (k, label, v, extra = '') => `<label class="pf pf-${k}"><span>${label}</span><input data-pf="${k}" value="${esc(v)}" ${extra}></label>`;
  return `<div class="pform">${f('name', 'Name', p.name, 'placeholder="e.g. Drywall 4x8" autocomplete="off"')}${f('category', 'Category', p.category, 'list="dtCats" autocomplete="off"')}${f('unit', 'Unit', p.unit, 'list="dtUnits" autocomplete="off"')}${f('price', 'Unit price $', p.price, 'inputmode="decimal"')}${f('labor', 'Labor/unit $', p.labor || 0, 'inputmode="decimal"')}${f('waste', 'Waste %', p.waste || 0, 'inputmode="decimal"')}${f('mult', 'Multiplier', p.mult || 1, 'inputmode="decimal" title="Converts what you measure into this unit. 1 = no change. 0.03125 turns SF into 4×8 sheets."')}<label class="pf pf-color"><span>Color</span><input type="color" data-pf="color" value="${hex6(p.color)}"></label>${opts.formula ? f('formula', 'Quantity formula ƒx (optional)', p.formula || '', 'spellcheck="false" autocapitalize="off" autocomplete="off" class="mono" placeholder="e.g. ceil(Area / 32)"') + '<span class="small pf-msg" data-fxmsg></span>' : ''}</div>
    <datalist id="dtCats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist><datalist id="dtUnits">${UNITS.map(u => `<option value="${u}">`).join('')}</datalist>`;
}
function readPF(root) {
  const v = k => root.querySelector(`[data-pf=${k}]`), o = {};
  if (v('name')) o.name = v('name').value.trim(); if (v('category')) o.category = v('category').value.trim(); if (v('unit')) o.unit = (v('unit').value.trim() || 'EA').toUpperCase();
  for (const k of ['price', 'labor', 'waste']) if (v(k)) o[k] = num(v(k).value);
  if (v('mult')) o.mult = num(v('mult').value, 1) || 1; if (v('color')) o.color = v('color').value; if (v('formula')) o.formula = v('formula').value.trim();
  return o;
}
function fxCheckEl(root) {
  const i = root.querySelector('[data-pf=formula]'), msg = root.querySelector('[data-fxmsg]'); if (!i) return true;
  const f = i.value.trim(), er = f ? fxProblem(f) : ''; if (msg) { msg.className = 'small pf-msg ' + (er ? 'fxerr' : f ? 'fxok' : 'muted'); msg.textContent = er ? '⚠ ' + er : f ? '✓ formula OK' : 'Blank: measured × multiplier'; }
  return !er;
}
function bindProductForm(root, p) {   // p = existing product → saves as you go; null → new-product form
  const fi = root.querySelector('[data-pf=formula]'); if (fi) { fi.addEventListener('input', () => fxCheckEl(root)); fxCheckEl(root); }
  if (!p) return;
  root.querySelectorAll('[data-pf]').forEach(el => el.addEventListener('change', async () => {
    if (!fxCheckEl(root)) return toast('Fix the formula first (or clear it)');
    const o = readPF(root); if (!o.name) return toast('Name is required');
    Object.assign(p, o); await saveProduct(p); refreshActiveProduct(); renderOverlay(); refreshPanel(); setSave('Saved');
  }));
}
async function createProduct(o, root) {
  if (root && !fxCheckEl(root)) { toast('Fix the formula first (or clear it)'); return null; }
  if (!o.name) { toast('Give the product a name'); root?.querySelector('[data-pf=name]')?.focus(); return null; }
  const dup = S.products.find(x => x.name.toLowerCase() === o.name.toLowerCase() && (x.category || '').toLowerCase() === (o.category || '').toLowerCase());
  if (dup) { toast(`"${dup.name}" already exists, using it`); return dup; }
  const p = blankProduct(o); await saveProduct(p); S.products.push(p); return p;
}
function openNewProduct() {   // "+ Add new product…" from the toolbar dropdown: inline form in the bottom dock, the drawing stays put
  const q = pickerMode() === 'sel' ? selMarks().filter(isQty) : [];
  const t = q[0]?.type || S.tool, unit = { length: 'LF', area: 'SF', count: 'EA' }[t] || 'EA';
  S.dockNew = { draft: blankProduct({ unit }), assign: q.map(m => m.id) };
  if (S.view !== 'plans') switchView('plans');
  setDockTab('prod'); setTimeout(() => $('#dockBody [data-pf=name]')?.focus(), 30);
}
function dockProd(body) {
  if (S.dockNew) {
    const N = S.dockNew;
    body.innerHTML = `<div class="dhead"><b>＋ New product</b><span class="muted small">${N.assign.length ? `Will be applied to the ${N.assign.length} selected markup${N.assign.length > 1 ? 's' : ''}.` : 'Becomes the product you draw with next.'}</span></div>${productFormHTML(N.draft)}<div class="actions"><button class="small" id="npCancel">Cancel</button><button class="small accent" id="npAdd">Add product</button></div>`;
    bindProductForm(body, null);
    body.querySelectorAll('[data-pf]').forEach(el => el.addEventListener('input', () => Object.assign(N.draft, readPF(body))));
    body.querySelector('[data-pf=name]').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); body.querySelector('#npAdd').click(); } });
    body.querySelector('#npCancel').onclick = () => { S.dockNew = null; renderDock(true); };
    body.querySelector('#npAdd').onclick = async () => {
      const p = await createProduct(readPF(body), body); if (!p) return;
      const ids = new Set(N.assign); S.dockNew = null;
      const ms = S.project ? S.project.markups.filter(m => ids.has(m.id)) : [];
      if (ms.length) { pushUndo(); for (const m of ms) { m.productId = p.id; m.color = null; } touch(); toast(`Added ${p.name} → ${ms.length} markup${ms.length > 1 ? 's' : ''}`); }
      else { S.activeProductId = p.id; toast(`Added ${p.name}: draw with it now`); }
      refreshActiveProduct(); renderOverlay(); refreshPanel(); renderDock(true);
      if (!ms.length) autoToolFor(p);
    };
    return;
  }
  const { p } = dockTarget();
  if (!p) { body.innerHTML = `<div class="dhead"><b>Product</b><span class="muted small">No product picked. Choose one in the Product box at the top, or add one here.</span><button class="small accent" id="npOpen">＋ New product</button></div>`; body.querySelector('#npOpen').onclick = openNewProduct; return; }
  body.innerHTML = `<div class="dhead"><span class="sw" style="background:${p.color}"></span><b>${esc(p.name)}</b><span class="muted small">Edits save as you go and apply everywhere this product is used.</span><button class="small" id="npOpen">＋ New product</button></div>${productFormHTML(p)}`;
  bindProductForm(body, p); body.querySelector('#npOpen').onclick = openNewProduct;
}
function dockScale(body) {
  if (!S.page) { body.innerHTML = '<p class="muted small">Open a PDF first.</p>'; return; }
  const cur = curScale();
  if (S.calib) {
    body.innerHTML = `<div class="dhead"><b>Calibrate</b><span class="muted small">Measured ${fmtN(S.calib.dPts / 72, 3)}" on the sheet. What is the real length?</span></div>
      <form id="cf" class="fxRow"><input id="cFt" inputmode="decimal" placeholder="feet" style="width:90px"><span>ft</span><input id="cIn" placeholder="inches (6 1/2)" style="width:130px"><span>in</span>
      <label class="chk small"><input type="checkbox" id="cAll" ${S.calAllPages ? 'checked' : ''}> every page in this PDF</label><button type="button" class="small" id="cCancel">Cancel</button><button class="small accent" id="cOk">Set scale</button></form>`;
    body.querySelector('#cCancel').onclick = () => { S.calib = null; setTool('select'); renderDock(true); };
    body.querySelector('#cf').onsubmit = e => {
      e.preventDefault(); const ft = num(body.querySelector('#cFt').value, 0), inch = parseInches(body.querySelector('#cIn').value);
      const real = ft + (isFinite(inch) ? inch : 0) / 12; if (!(real > 0) || !isFinite(inch)) return toast('Enter the real length');
      const k = real / S.calib.dPts, near = nearPreset(k), label = near ? `${near} (calibrated)` : `1" = ${fmtFtIn(k * 72)} (calibrated)`;
      S.calib = null; setScale(k, label, body.querySelector('#cAll').checked); const nt = S.scaleNext; S.scaleNext = null; setTool(nt || 'select'); renderDock(true);
    };
    return;
  }
  const groups = [...new Set(SCALES.map(s => s.group))];
  const opts = groups.map(g => `<optgroup label="${g}">${SCALES.filter(s => s.group === g).map(s => `<option value="${SCALES.indexOf(s)}" ${cur && Math.abs(cur.ftPerPt - s.ftPerPt) < 1e-12 ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('');
  body.innerHTML = `<div class="dhead"><b>Scale for page ${S.pageNum}</b><span class="muted small">Current: <b>${esc(cur?.label || 'not set')}</b>. Presets assume the PDF is at full sheet size.${S.scaleNext ? ` Then you can draw your ${S.scaleNext}.` : ''}</span></div>
    <div class="fxRow"><select id="scSel">${cur ? '' : '<option value="">Choose a scale…</option>'}${opts}</select><label class="chk small"><input type="checkbox" id="scAll"> every page in this PDF</label><button class="small accent" id="scOk">Use preset</button><button class="small" id="scMeasure">Calibrate from a known dimension…</button></div>`;
  body.querySelector('#scOk').onclick = () => { const v = body.querySelector('#scSel').value; if (v === '') return toast('Pick a scale'); const s = SCALES[+v]; setScale(s.ftPerPt, s.label, body.querySelector('#scAll').checked); const nt = S.scaleNext; S.scaleNext = null; if (nt) setTool(nt); renderDock(true); };
  body.querySelector('#scMeasure').onclick = () => { S.calAllPages = body.querySelector('#scAll').checked; const nt = S.scaleNext; setTool('calibrate'); S.scaleNext = nt; };
}
function dockPrint(body) {
  const n = S.project ? new Set(S.project.markups.map(m => m.docId + ':' + m.page)).size : 0;
  body.innerHTML = `<div class="dhead"><b>Print the marked-up drawing</b><span class="muted small">Prints (or saves as PDF) the sheet with every markup, highlight and note drawn on it. File name: <b>${esc(drawingTitle())}</b></span></div>
    <div class="fxRow"><label class="chk"><input type="radio" name="prW" value="page" ${UI.prAll ? '' : 'checked'}> This page</label><label class="chk"><input type="radio" name="prW" value="all" ${UI.prAll ? 'checked' : ''}> All marked pages (${n})</label>
    <label class="chk"><input type="checkbox" id="prLeg" ${UI.prLegend === false ? '' : 'checked'}> Quantity legend</label><button class="accent" id="prGo">🖨 Print drawing</button></div>`;
  body.querySelectorAll('[name=prW]').forEach(r => r.onchange = () => { UI.prAll = r.value === 'all' && r.checked; saveUI(); });
  body.querySelector('#prLeg').onchange = e => { UI.prLegend = e.target.checked; saveUI(); };
  body.querySelector('#prGo').onclick = () => printDrawing(!!UI.prAll);
}

/* ======================= v1.6: print the marked-up drawing ======================= */
function drawingTitle() { return takeoffTitle(pdfTitle(S.project?.name)) + ' - Drawing'; }
let printUrls = [];
function setPrintMode(mode, landscape) {
  const pa = $('#printArea'); pa.classList.toggle('drawing', mode === 'drawing');
  if (mode !== 'drawing') { printUrls.forEach(u => URL.revokeObjectURL(u)); printUrls = []; }
  let st = $('#printPageStyle'); if (!st) { st = document.createElement('style'); st.id = 'printPageStyle'; document.head.appendChild(st); }
  st.textContent = mode === 'drawing' ? `@page { size: ${landscape ? 'landscape' : 'portrait'}; margin: 0.3in; }` : '';
}
async function printDrawing(all = false) {
  if (!S.project) return toast('Open a project first');
  closeTextEditor(); await flush();
  let pages;
  if (all) {
    const seen = new Map(), order = S.project.docs.map(d => d.id);
    for (const m of S.project.markups) if (order.includes(m.docId)) seen.set(m.docId + ':' + m.page, [m.docId, m.page]);
    pages = [...seen.values()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]) || a[1] - b[1]);
    if (!pages.length) return toast('No markups to print yet');
  } else { if (!S.page) return toast('Open a PDF first'); pages = [[S.docId, S.pageNum]]; }
  toast(`Preparing ${pages.length > 1 ? pages.length + ' drawings' : 'the drawing'}…`, 15000);
  setPrintMode('summary');
  const secs = []; let land = null;
  for (const [d, pn] of pages) {
    try {
      const pdf = await getPdf(d), pg = await pdf.getPage(pn), v1 = pg.getViewport({ scale: 1 }), W = v1.width, H = v1.height;
      if (land === null) land = W > H;
      const k = Math.min(2.5, Math.sqrt(MAX_PIX * 0.5 / (W * H)), MAX_SIDE / Math.max(W, H)), vp = pg.getViewport({ scale: k });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)); c.width = c.height = 1;
      const url = URL.createObjectURL(blob); printUrls.push(url);
      const ms = S.project.markups.filter(m => m.docId === d && m.page === pn);
      const zP = 1.6 * 720 / Math.max(W, H);   // label pills ≈ 9 pt on a letter / tabloid sheet
      const doc = S.project.docs.find(x => x.id === d), sc = S.project.scales[pageKey(d, pn)];
      const leg = UI.prLegend === false ? [] : pageAgg(ms);
      secs.push(`<section class="pdraw"><div class="pdHead"><b>${esc(S.project.name || 'Takeoff')}</b> · ${esc(doc?.name || '')} · page ${pn}${sc ? ' · scale ' + esc(sc.label) : ''} · ${new Date().toLocaleDateString()}</div>
        <div class="pdBox"><img src="${url}" alt=""><svg class="mk" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${markupsSVG(ms, zP, () => false, `p${secs.length}-`)}</svg></div>
        ${leg.length ? `<div class="pdLeg">${leg.map(a => `<span>${a.hatch ? legendSwatch(a, `p${secs.length}-`) : `<i style="background:${a.color}"></i>`}${esc(a.name)}: <b>${fmtQty(a.q, a.unit)} ${esc(a.unit)}</b></span>`).join('')}</div>` : ''}</section>`);
    } catch (e) { console.warn(e); toast('Could not render page ' + pn); }
  }
  if (!secs.length) return;
  setPrintMode('drawing', !!land);
  $('#printArea').innerHTML = secs.join('');
  await Promise.all([...$('#printArea').querySelectorAll('img')].map(i => i.decode().catch(() => { })));
  toast('Opening print…', 1200);
  setPrintTitle(' - Drawing'); window.print();
}
$('#btnPrintDrawing').onclick = () => printDrawing(false);
$('#btnPrintDrawings').onclick = () => printDrawing(true);
$('#btnNewProd').onclick = openNewProduct;

/* dock wiring */
$$('#dockTabs button').forEach(b => b.onclick = () => { if (b.dataset.dt !== 'prod') S.dockNew = null; setDockTab(b.dataset.dt); });
$('#dockMin').onclick = () => { UI.dockMin = !UI.dockMin; saveUI(); applyDock(); };
$('#dockSplit').addEventListener('pointerdown', e => {
  if (UI.dockMin) return; e.preventDefault(); const sp = e.currentTarget; sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
  const col = $('#viewerCol');
  const mv = ev => { const r = col.getBoundingClientRect(); UI.dockH = Math.round(clamp(r.bottom - ev.clientY, 90, Math.max(120, r.height - 140))); $('#dock').style.height = UI.dockH + 'px'; };
  const up = () => { sp.classList.remove('drag'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); saveUI(); S.page && scheduleDetail(); };
  sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
});
$('#dockSplit').addEventListener('dblclick', () => { delete UI.dockH; saveUI(); applyDock(); });
applyDock(); renderDock(true); mountEmptyBlank();
