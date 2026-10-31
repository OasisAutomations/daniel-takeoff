// Daniel Takeoff — everything stays on this device (IndexedDB). No uploads, no analytics.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import { propose as voicePropose, resolveQty as voiceResolve } from './voice.js';
import { evaluate as fxEval, SAMPLE_VARS as FX_SAMPLE, PRESETS as FX_PRESETS, HELP_HTML as FX_HELP } from './formula.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
const VER = 'v1.8.0';
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
function archDef(id, kind, color, k, cell, sc = 1) {
  const P = ARCH_PATS[kind], s = (cell || clamp(k ? P.ft / k : P.pt, P.g === 'tex' ? P.pt * 0.75 : 1.5, 400)) * (+sc > 0 ? +sc : 1), [w, h, body] = archCell(kind, color, s);
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${+w.toFixed(3)}" height="${+h.toFixed(3)}">${body}</pattern>`;
}
function patId(defs, pre, kind, color, z, k, sc = 1) {   // registers the pattern in defs (once) and returns its id
  const id = pre + kind + '-' + String(color).replace(/[^\w]/g, '') + (ARCH_PATS[kind] && k ? '-' + Math.round(1 / k) : '') + (+sc > 0 && +sc !== 1 ? '-s' + String(+sc).replace('.', '_') : '');
  if (!defs.has(id)) defs.set(id, ARCH_PATS[kind] ? archDef(id, kind, color, k, undefined, sc) : hatchDef(id, kind, color, z, sc));
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
  const lw = clamp(+st.width || 1, 0.25, 12), edges = [-T / 2, -T / 2 + g, T / 2 - g, T / 2].filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-9);
  const band = (a, b) => { const A = offsetLine(P, a, closed), B = offsetLine(P, b, closed).reverse(); return pp(A.concat(B)); };
  let h = `<polygon points="${band(-T / 2, T / 2)}" fill="#fff" stroke="none"/>`;
  const core = st.hatch && st.hatch !== 'none' && HATCHES[st.hatch] ? patId(defs, pre, st.hatch, c, z, k, st.hscale) : null;
  if (g > 0) { const gy = patId(defs, pre, 'gyp', c, z, k, st.hscale); h += `<polygon points="${band(-T / 2, -T / 2 + g)}" fill="url(#${gy})"/><polygon points="${band(T / 2 - g, T / 2)}" fill="url(#${gy})"/>`; }
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
      if (d.type === 'wall') { const A = asmById(UI.wallAsm), m = { ...ghost, type: 'length', wall: A ? { ...A.wall } : wallTool(), pts, productId: A ? null : S.activeProductId || null, asm: A?.id, color: A ? asmColor(A) : null, style: wallToolStyle() }, dm = new Map(), body = wallSVG(m, styleOf(m), z, false, dm, 'pvw-', ''); h += `<defs>${[...dm.values()].join('')}</defs>` + body; }
      else h += annSVG({ ...ghost, type: 'note', kind: 'dline', pts, style: annToolStyle('dline') }, z, false);
    }
    for (const p of d.pts) h += `<circle cx="${p[0]}" cy="${p[1]}" r="${3.5 / z}" fill="#fff" stroke="#2f6fb3" stroke-width="${1.4 / z}"/>`;
    const k = curScale()?.ftPerPt;
    if (k && pts.length >= 2) { const a = pts[pts.length - 2], b = pts[pts.length - 1]; h += prevPill(b, `${fmtFtIn(dist(a, b) * k)} @ ${Math.round(angOf(a, b) * 10) / 10}°` + (pts.length > 2 ? ` · total ${fmtFtIn(polyLen(pts) * k)}` : ''), '#2f6fb3', z); }
  }
  return h;
}
const wallToolStyle = () => { if (asmById(UI.wallAsm)) return {}; const p = prodById(S.activeProductId), w = UI.ann?.wall || {}, o = {}; if (w.hatch && !p?.style?.hatch) o.hatch = w.hatch; if (+w.width > 0) o.width = +w.width; if (+w.hscale > 0) o.hscale = +w.hscale; return o; };
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
    const A = asmById(UI.wallAsm);
    const m = { id: uid(), type: 'length', docId: S.docId, page: S.pageNum, pts: d.pts.map(p => [rr2(p[0]), rr2(p[1])]), productId: A ? null : S.activeProductId || null, label: '', height: A ? (UI.wallH > 0 ? UI.wallH : (+A.h || 9)) : UI.wallArea ? (UI.wallH > 0 ? UI.wallH : 9) : null, color: A ? asmColor(A) : S.activeProductId ? null : '#333333', wall: A ? { ...A.wall } : wallTool(), created: Date.now() };
    if (A) m.asm = A.id;
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
  const tools = [['dline', 'Line / polyline'], ['drect', 'Rectangle'], ['wall', 'Wall'], ['opening', 'Door / window'], ['dim', 'Dimension'], ['ceiling', 'Ceiling'], ['soffit', 'Soffit']];
  let typed = '';
  if (t === 'drect') typed = `<form id="dwRect" class="fxRow"><span class="small">Width</span><input id="dwW" placeholder="12'" style="width:80px" autocomplete="off"><span class="small">× Height</span><input id="dwH" placeholder="10'" style="width:80px" autocomplete="off"><button class="small accent">Place</button><span class="muted small">${d?.pts.length ? 'from the corner you tapped (right and up)' : 'tap a corner on the plan first'}</span></form>`;
  else if (['dline', 'wall', 'length', 'area', 'ceiling', 'soffit'].includes(t)) typed = `<form id="dwSeg" class="fxRow"><span class="small">Length</span><input id="dwL" placeholder="10'6&quot;" style="width:86px" autocomplete="off"><span class="small">Angle°</span><input id="dwA" inputmode="decimal" placeholder="0" style="width:56px" autocomplete="off">
    ${[['0', '→'], ['90', '↑'], ['180', '←'], ['270', '↓']].map(([a, s]) => `<button type="button" class="small" data-ang="${a}" title="${a}°">${s}</button>`).join('')}<button class="small accent">Add segment</button><button type="button" class="small" id="dwFin" ${d?.pts.length > 1 ? '' : 'disabled'}>✓ Finish</button>
    <span class="muted small">${d?.pts.length ? '0° = right, 90° = up. Blank angle keeps the last direction.' : 'Tap the start point on the plan first.'}</span></form>`;
  const sty = asmDrawHTML(t) + (isDraftTool(t) ? (t === 'wall' ? `${wallPresetHTML(wallTool(), 'dw')}${styleHTML({ ...QTY_DEF, hatch: 'stud', width: 1, color: prodById(S.activeProductId)?.color || '#333333', ...(prodById(S.activeProductId)?.style || {}), ...wallToolStyle() }, ['width', 'hatch', 'hscale'], 'wall')}<div class="fxRow"><label class="chk small" title="New walls take their area: centerline LF × height"><input type="checkbox" id="dwWA" ${UI.wallArea ? 'checked' : ''}> Wall area = LF × height</label><input id="dwWH" inputmode="decimal" value="${esc(String(UI.wallH || 9))}" style="width:52px" title="Wall height, feet"><span class="small">ft high</span></div>
    <p class="muted small">Walls count centerline LF for the product picked in the toolbar. With wall area on (or a height set in Properties) they count SF instead, unless the product's unit is LF.</p>`
    : styleHTML(annToolStyle(t), STYLE_FIELDS[t], t)) : '');
  body.innerHTML = `<div class="dgrid"><div class="dcol">
    <div class="dhead"><b>Draw</b><span class="muted small">Plan linework: lines, rectangles and dimensions print on the drawing but never count. ${k ? 'Scale ' + esc(k.label) + '.' : '<b>Set a scale</b> to type exact lengths.'}</span></div>
    <div class="fxRow">${tools.map(([v, n]) => `<button type="button" class="small${t === v ? ' accent' : ''}" data-dtool="${v}">${n}</button>`).join('')}</div>
    ${typed}
    ${snapRowsHTML()}
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
  bindAsmDraw(body);
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
    { const se = body.querySelectorAll('.dcol.grow .stl'); if (se.length) bindStyle(se[se.length - 1], (key, v, final) => { UI.ann = UI.ann || {}; UI.ann.wall = { ...(UI.ann.wall || {}), [key]: v }; saveUI(); renderPreview(); if (final) renderDock(true); }); }
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
  if (m.type === 'length') { const lf = polyLen(m.pts) * k; return { lf, sf: m.height > 0 ? Math.max(0, lf * m.height - (m.wall ? openArea(m) : 0)) : null }; }
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
  const p = prodById(m.productId), A = asmOf(m), s = { ...QTY_DEF, ...(m.wall ? { hatch: 'stud', width: 1 } : {}), ...(p?.style || {}), ...(A?.style || {}), ...(m.style || {}) };
  s.color = m.style?.color || p?.color || A?.style?.color || m.color || TYPE_COLOR[m.type];
  return s;
}
const colorOf = m => styleOf(m).color;
const markName = m => { if (!isQty(m)) return NOTE_NAMES[m.kind] || 'Markup'; const p = prodById(m.productId); return (p ? p.name : asmOf(m) ? asmOf(m).name : (m.wall ? 'Wall' : { length: 'Length', area: 'Area', count: 'Count' }[m.type])) + (m.label ? ' – ' + m.label : ''); };

/* ---------- overlay ---------- */
const pp = pts => pts.map(p => p[0] + ',' + p[1]).join(' ');
const DASH = { dash: [4, 2.5], dot: [0.01, 2], dashdot: [5, 2, 0.01, 2] };
const dashAttr = (d, w) => DASH[d] ? ` stroke-dasharray="${DASH[d].map(x => +(x * w).toFixed(3)).join(' ')}"` : '';
function pill(x, y, s, col, anchor, z) {   // value labels: dark pills with big bold white text, always screen-sized
  const fs = 15 / z, w = s.length * 0.62 * fs + 14 / z, hh = fs * 1.5, x0 = anchor === 'start' ? x : x - w / 2;
  return `<rect x="${x0}" y="${y - hh / 2}" width="${w}" height="${hh}" rx="${6 / z}" fill="#0f151a" fill-opacity=".92" stroke="${col}" stroke-width="${1.8 / z}"/><text class="lbl" x="${x0 + 7 / z}" y="${y + 0.5 / z}" font-size="${fs}" text-anchor="start" dominant-baseline="middle">${esc(s)}</text>`;
}
function hatchDef(id, kind, color, z, sc = 1) {   // SVG pattern; spacing stays the same on screen at any zoom (and in print)
  const s = 9 / z * (+sc > 0 ? +sc : 1), w = 1.1 / z;
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
    if (st.hatch && st.hatch !== 'none' && HATCHES[st.hatch]) h += `<polygon points="${P}" fill="url(#${patId(defs, pre, st.hatch, c, z, kOf(m), st.hscale)})" stroke="none"/>`;
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
  const fs = clamp(+st.fs || 16, 2, 800), pad = fs * (st.pad != null && st.pad !== '' && +st.pad >= 0 ? +st.pad : 0.35), lh = fs * 1.25, raw = String(m.text || ''), lines = (raw || ' ').split('\n');
  mctx.font = `${st.bold ? 700 : 400} 100px system-ui, "Segoe UI", Arial, sans-serif`;
  const tw = Math.max(...lines.map(l => mctx.measureText(l).width)) * fs / 100;
  const a = m.kind === 'callout' ? m.pts[1] : m.pts[0];
  return { x: a[0], y: a[1], w: Math.max(tw, fs * 2) + pad * 2, h: lines.length * lh + pad * 2, fs, pad, lh, lines, empty: !raw.trim() };
}
function bboxOf(m) {
  if (m.kind === 'opening') return openingBox(m);
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
function arrowHead(a, b, w, z, c, hm = 1) {   // filled head at b, pointing from a to b; returns [svg, base point]
  const L = Math.max(w * 4, 10 / z) * (+hm > 0 ? +hm : 1), d = dist(a, b) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d, bx = b[0] - ux * L, by = b[1] - uy * L, hw = L * 0.42;
  return [`<polygon points="${b[0]},${b[1]} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}" fill="${c}" stroke="none"/>`, [bx, by]];
}
function textSVG(m, st, framed) {
  const t = textLayout(m, st), c = st.color; let h = '';
  if ((st.bg && st.bg !== 'none') || framed || st.border) h += `<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="${t.fs * 0.15}" fill="${st.bg && st.bg !== 'none' ? st.bg : 'none'}"${framed || st.border ? ` stroke="${c}" stroke-width="${Math.max(+st.width || 1.5, t.fs * 0.06)}"` : ''}/>`;
  const lines = t.empty ? ['Text'] : t.lines;
  h += `<text class="at" x="${t.x + t.pad}" y="${t.y + t.pad + t.fs * 0.92}" font-size="${t.fs}" fill="${st.tcolor || c}"${t.empty ? ' fill-opacity=".45"' : ''} font-weight="${st.bold ? 700 : 400}">${lines.map((l, i) => `<tspan x="${t.x + t.pad}"${i ? ` dy="${t.lh}"` : ''}>${esc(l) || ' '}</tspan>`).join('')}</text>`;
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
  else if (k === 'arrow') { const [hd, bs] = arrowHead(p[0], p[1], w, z, c, +st.head || 1); h = `<line x1="${p[0][0]}" y1="${p[0][1]}" x2="${bs[0]}" y2="${bs[1]}" ${stroke}/>` + hd; }
  else if (k === 'rect') { const b = box2(p); h = `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" ${fill} ${stroke}/>`; }
  else if (k === 'ellipse') { const b = box2(p); h = `<ellipse cx="${(b.x0 + b.x1) / 2}" cy="${(b.y0 + b.y1) / 2}" rx="${(b.x1 - b.x0) / 2}" ry="${(b.y1 - b.y0) / 2}" ${fill} ${stroke}/>`; }
  else if (k === 'cloud') h = `<path d="${cloudPath(box2(p))}" ${fill} ${stroke}/>`;
  else if (k === 'opening') h = openingSVG(m, st, z);
  else if (k === 'dline') h = p.length === 1 ? `<circle cx="${p[0][0]}" cy="${p[0][1]}" r="${w / 2}" fill="${c}"/>` : `<polyline points="${pp(p)}" fill="none" ${stroke.replace('stroke-linejoin="round"', 'stroke-linejoin="miter"')}/>`;
  else if (k === 'drect') { const b = box2(p), own = !defs; defs ||= new Map(); const hid = st.hatch && st.hatch !== 'none' && HATCHES[st.hatch] ? patId(defs, pre + (own ? 'pv-' : ''), st.hatch, c, z, kOf(m), st.hscale) : null;
    h = (own && hid ? `<defs>${[...defs.values()].join('')}</defs>` : '') + `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" ${fill} stroke="none"/>` + (hid ? `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="url(#${hid})" stroke="none"/>` : '') + `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="none" ${stroke.replace('stroke-linejoin="round"', 'stroke-linejoin="miter"')}/>`; }
  else if (k === 'dim') h = dimSVG(m, st, z);
  else if (k === 'text') h = textSVG(m, st, false);
  else if (k === 'callout') {
    const t = textLayout(m, st), tip = p[0], e = [clamp(tip[0], t.x, t.x + t.w), clamp(tip[1], t.y, t.y + t.h)];
    const [hd, bs] = arrowHead(e, tip, w, z, c, +st.head || 1);
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
  const defs = new Map(), labs = []; let plan = '', take = '', note = '', ops = '';
  for (const m of ms) {
    if (isQty(m)) { const r = qtySVG(m, z, isSel(m), defs, pre, labs); if (m.wall) plan += r; else take += r; }
    else if (m.kind === 'opening') ops += annSVG(m, z, isSel(m), defs, pre);
    else if (PLAN_KINDS.has(m.kind)) plan += annSVG(m, z, isSel(m), defs, pre); else note += annSVG(m, z, isSel(m), defs, pre);
  }
  return (defs.size ? `<defs>${[...defs.values()].join('')}</defs>` : '') + plan + ops + take + note + placeLabels(labs, ms, z);
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
  if (m.kind === 'opening') return [];
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
  const d = S.drawing; if (!d) { g.innerHTML = (S.tool === 'opening' ? openingGhost() : '') + snapMark(); return; }
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
    const sg = pts.length > 1 && k ? `${fmtFtIn(dist(pts[pts.length - 2], e) * k)} @ ${Math.round(angOf(pts[pts.length - 2], e) * 10) / 10}°` : '';
    if (d.type === 'length' && k) lab = pts.length > 2 ? `${sg} · total ${fmtFtIn(polyLen(pts) * k)}` : fmtFtIn(polyLen(pts) * k) + (sg ? ' @ ' + sg.split(' @ ')[1] : '');
    if (d.type === 'area' && k) lab = pts.length > 2 ? `${sg} · ${fmtN(shoelace(pts) * k * k)} SF` : sg;
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
  if ((t === 'length' || t === 'area' || t === 'wall' || isAsmTool(t)) && !curScale() && S.page) { S.scaleNext = t; setDockTab('scale'); toast('Set the scale for this page first'); return; }
  closeTextEditor(); cancelDrawing(); if (t !== S.tool && isAnnTool(t) && S.sel.size) S.selId = null;   // v1.6: picking a tool starts fresh (Bluebeam-style); the tool's look shows in Properties
  S.tool = t; if (t !== 'calibrate') S.calib = null;
  const ap = prodById(S.activeProductId), u = String(ap?.unit || '').toUpperCase();
  if (ap && (QTY_TYPES.has(t) || t === 'wall') && ((t === 'count' && (u === 'LF' || u === 'SF')) || ((t === 'length' || t === 'area' || t === 'wall') && u === 'EA'))) { S.activeProductId = ''; refreshActiveProduct(); toast(`${ap.name} is priced per ${u} — pick a product for this tool`); }
  $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  if ((isDraftTool(t) || isAsmTool(t)) && S.dockTab !== 'draw') { S.dockTab = 'draw'; UI.dockTab = 'draw'; if (UI.dockMin) { UI.dockMin = false; applyDock(); } saveUI(); }
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
  const A = d.asmTool && asmById(UI[d.asmTool === 'ceiling' ? 'ceilAsm' : 'soffitAsm']);
  const m = { id: uid(), type: d.type, docId: S.docId, page: S.pageNum, pts: d.pts, productId: A ? null : S.activeProductId || null, label: '', height: null, color: A ? asmColor(A) : S.activeProductId ? null : TYPE_COLOR[d.type], created: Date.now() };
  if (A) m.asm = A.id;
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
  if (t === 'opening') { placeOpening(q); return; }
  if (!S.drawing) S.drawing = { type: ASM_DRAW[t] || t, pts: [], asmTool: ASM_DRAW[t] ? t : null };
  const d = S.drawing, now = Date.now();
  const p = snapPoint(q, e.shiftKey);
  if (isDraftTool(t)) { draftTap(p, now); return; }
  if (d.pts.length) {
    const last = d.pts[d.pts.length - 1];
    if (now - (S.lastTap || 0) < 380 && dist(last, p) * S.z < 12 && t !== 'calibrate') { S.lastTap = 0; finishDrawing(); return; }
    if (d.type === 'area' && d.pts.length >= 3 && dist(d.pts[0], p) * S.z < 12) { finishDrawing(); return; }
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
  if (m.kind === 'opening') return openingDist(m, q);
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
    pushUndo(); G.type = 'move'; const sm = selMarks(), sid = new Set(sm.map(m => m.id)); G.items = [...sm, ...S.project.markups.filter(o => o.kind === 'opening' && sid.has(o.wallId) && !sid.has(o.id))].map(m => ({ m, pts0: m.pts.map(q => q.slice()) }));
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
  else if (!G && !S.drawing && e.pointerType !== 'touch' && S.page && (isDraftTool(S.tool) || S.tool === 'length' || S.tool === 'area' || S.tool === 'ceiling' || S.tool === 'soffit')) { S.hover = null; snapPoint(toPage(...p), false); renderPreview(); }
  else if (!G && S.tool === 'opening' && S.page && e.pointerType !== 'touch') { S.opHover = toPage(...p); renderPreview(); }
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
  else if (k === 'g') toggleDraftOpt('grid'); else if (k === 's') toggleDraftOpt('snap'); else if (k === 'o') toggleDraftOpt('ortho'); else if (k === 'd') setTool('dline'); else if (k === 'm') setTool('dim');
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
    const p = prodById(m.productId), A = !p && asmOf(m); if (A) { const g = geo(m), a = agg.get('a-' + A.id) || { name: A.name, unit: m.type === 'area' ? 'SF' : 'LF', color: asmColor(A), q: 0, hatch: null }; if (!a.hatch) { const h = styleOf(m).hatch; if (h && h !== 'none' && HATCHES[h]) { a.hatch = h; a.k = kOf(m); } } if (!g.noscale) a.q += m.type === 'area' ? g.sf : g.lf; agg.set('a-' + A.id, a); continue; }
    const key = p ? p.id : 'u-' + nativeUnit(m), q = p ? qtyFor(m, p) : (m.type === 'count' ? m.pts.length : (m.type === 'area' ? geo(m).sf : (geo(m).sf ?? geo(m).lf)));
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
  pushUndo(); S.project.markups = S.project.markups.filter(m => !ids.has(m.id) && !ids.has(m.wallId)); if (ids.has(S.countId)) S.countId = null; S.selId = null;
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
  pushUndo(); S.project.markups = S.project.markups.filter(m => m.id !== id && m.wallId !== id);
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
    if (!p && asmOf(m)) continue;   // v1.8: priced by its assembly below
    if (!p) { const g = geo(m); if (g.noscale) { noScale++; continue; } un.n++; if (m.type === 'count') un.EA += g.ea; else if (m.type === 'area') un.SF += g.sf; else if (g.sf != null) un.SF += g.sf; else un.LF += g.lf; continue; }
    const q = qtyFor(m, p); if (q == null) { noScale++; continue; }
    const r = rows.get(p.id) || { prod: p, qty: 0, n: 0 }; r.qty += q; r.n++; rows.set(p.id, r);
  }
  const lines = [...rows.values()].sort((a, b) => (a.prod.category || '').localeCompare(b.prod.category || '') || a.prod.name.localeCompare(b.prod.name)).map(r => {
    const w = num(r.prod.waste), qw = r.qty * (1 + w / 100), price = num(r.prod.price), lab = num(r.prod.labor);
    return { kind: 'product', id: r.prod.id, name: r.prod.name, category: r.prod.category || '', unit: r.prod.unit, qty: r.qty, waste: w, qtyW: qw, price, mat: qw * price, laborU: lab, labor: qw * lab, total: qw * (price + lab), n: r.n };
  });
  const AE = asmEstimateLines(P); lines.push(...AE.lines); noScale += AE.noScale;   // v1.8: one group per wall type / assembly
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
    h += `<tr><td><span class="sw" style="display:inline-block;background:${l.color || prodById(l.id)?.color};margin-right:6px"></span>${esc(l.name)} <span class="muted small">(${l.n})</span></td><td>${esc(l.unit)}</td><td class="n">${fmtQty(l.qty, l.unit)}</td><td class="n">${fmtN(l.waste, l.waste % 1 ? 1 : 0)}%</td><td class="n"><b>${fmtQty(l.qtyW, l.unit)}</b></td>${P ? (M => `<td class="n">${M(l.price)}</td><td class="n">${M(l.mat)}</td><td class="n">${M(l.laborU)}</td><td class="n">${M(l.labor)}</td><td class="n"><b>${M(l.total)}</b></td>`)(l.kind === 'asm' ? fmt$ : m$) : ''}<td></td></tr>`;
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
  const out = { app: 'daniel-takeoff', kind: 'project-backup', format: 1, appVersion: VER, exported: new Date().toISOString(), project: p, products: S.products.filter(x => ids.has(x.id)), assemblies: S.asms.filter(a => p.markups.some(m => m.asm === a.id)), pdfs };
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
  for (const a of o.assemblies || []) if (!asmById(a.id)) { S.asms.push(a); saveAsms(); }
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
  S.products = await DB.all('products'); S.templates = await DB.all('templates'); S.asms = await loadAsms();
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
window.DT = { asmBreakdown: (...a) => asmBreakdown(...a), asmVars: (...a) => asmVars(...a), computeEstimate: (...a) => computeEstimate(...a), placeOpening: (...a) => placeOpening(...a), asms: () => S.asms, snapPoint: (...a) => snapPoint(...a), toggleDraftOpt: (...a) => toggleDraftOpt(...a), applyTheme: (...a) => applyTheme(...a), setDockTab: (...a) => setDockTab(...a), S, UI, applyT, setSelection, selMarks, copySel, pasteClip, duplicateSel, deleteSelected, combineCounts, selectAllPage, fxEval, pickerMode, fitPage, toScreen, detInfo: () => detState, hitTest, toPage, computeEstimate, geo, fmtFtIn, qtyFor, flush, setTool, SCALES, undo, redo, styleOf, bboxOf, setDockTab, printDrawing, renderOverlay, refreshPanel };

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
const annToolStyle = k => annToolStyleV18(k);
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

/* ======================= v1.8: snapping, guides, grid, theme, assemblies (wall types), openings ======================= */
UI.snaps = { end: true, mid: true, int: true, perp: true, near: true, align: true, par: true, perpg: true, ...(UI.snaps || {}) };
if (UI.osnap === false) { UI.snaps.end = false; UI.snaps.mid = false; }
delete UI.osnap;
if (UI.snap === undefined) UI.snap = true;
if (UI.ceilAsm === undefined) UI.ceilAsm = 'asm-ceil';
if (UI.soffitAsm === undefined) UI.soffitAsm = 'asm-soffit';
UI.open = { t: 'door', w: 3, h: 7, ...(UI.open || {}) };
const SNAP_NAMES = { end: 'Endpoint', mid: 'Midpoint', int: 'Intersection', perp: 'Perpendicular', near: 'On line', align: 'Aligned', par: 'Parallel', perpg: 'Perpendicular', grid: 'Grid' };
const SNAP_PRI = { end: 0, int: 0.25, mid: 0.4, perp: 0.6, near: 0.8 };
const snapOn = t => UI.snap !== false && (t === 'grid' ? !!UI.gsnap : UI.snaps[t] !== false);
function footOn(p, a, b, strict) {   // closest point to p on segment ab (strict: null when the foot is past either end)
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return strict ? null : a.slice();
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L; if (strict && (t < -1e-9 || t > 1 + 1e-9)) return null; t = clamp(t, 0, 1);
  return [a[0] + t * dx, a[1] + t * dy];
}
function lineX(p, u, q, v) {   // intersection of the lines p + s·u and q + t·v
  const den = u[0] * v[1] - u[1] * v[0]; if (Math.abs(den) < 1e-9 * (Math.hypot(...u) * Math.hypot(...v) || 1)) return null;
  const s = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den; return [p[0] + s * u[0], p[1] + s * u[1]];
}
function segX(s, r) {
  const u = [s.b[0] - s.a[0], s.b[1] - s.a[1]], v = [r.b[0] - r.a[0], r.b[1] - r.a[1]], x = lineX(s.a, u, r.a, v); if (!x) return null;
  const e = 1e-6; return segDist(x, s.a, s.b) < e && segDist(x, r.a, r.b) < e ? x : null;
}
const gridPt = () => { const k = curScale()?.ftPerPt; return k ? (UI.gridFt || 1) / k : 18; };
function gridSVG(z, W = S.W, H = S.H, k = curScale()?.ftPerPt, pre = '', force = false) {
  if (!(UI.grid || force) || !W) return '';
  const minFt = UI.gridFt || 1, majFt = Math.max(UI.gridMajorFt || 5, minFt);
  let mi = k ? minFt / k : 18, ma = k ? majFt / k : 18 * 5;
  while (ma * z < 8) { ma *= 5; mi *= 5; }
  const showMi = mi * z >= 5 && ma / mi > 1.01, sw = 0.6 / z, c = '#5b9bd5';
  const pat = (id, g, op, w) => `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${g}" height="${g}"><path d="M${g} 0H0V${g}" fill="none" stroke="${c}" stroke-opacity="${op}" stroke-width="${w}"/></pattern>`;
  return `<g class="gridlayer" pointer-events="none"><defs>${showMi ? pat(pre + 'gridmi', mi, 0.28, sw) : ''}${pat(pre + 'gridma', ma, 0.6, sw * 1.6)}</defs>${showMi ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#${pre}gridmi)"/>` : ''}<rect x="0" y="0" width="${W}" height="${H}" fill="url(#${pre}gridma)"/></g>`;
}
// v1.7.1: snap reach is a finger/cursor radius on screen, but never more than 2'-0" of real length (or 2% of the sheet
// unscaled), so zoomed-out phone views don't grab far-away points; and never less than 8 screen px so it still works.
function snapTol() {
  const px = (COARSE ? 16 : 11) / S.z, k = curScale()?.ftPerPt, cap = k ? 2 / k : 0.02 * Math.max(S.W || 0, S.H || 0, 400);
  return Math.max(8 / S.z, Math.min(px, cap));
}
function snapGeom() {   // snap points (ends / mids) and segments of everything on this page, plus the shape being drawn
  const P = [], G = [];
  const add = (a, b) => { if (dist(a, b) > 1e-6) { G.push({ a, b }); P.push({ p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], t: 'mid' }); } }, pt = p => P.push({ p, t: 'end' });
  for (const m of pageMarkups()) {
    const p = m.pts || []; if (m.type === 'count' || m.kind === 'opening') continue;
    if (!isQty(m) && ['rect', 'drect', 'ellipse', 'cloud'].includes(m.kind)) { const b = box2(p), C = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]; C.forEach((c, i) => { pt(c); add(c, C[(i + 1) % 4]); }); continue; }
    if (!isQty(m) && ['text', 'callout', 'highlight', 'pen'].includes(m.kind)) continue;
    if (m.kind === 'dim') { p.slice(0, 2).forEach(pt); continue; }
    p.forEach(pt); for (let i = 1; i < p.length; i++) add(p[i - 1], p[i]); if (m.type === 'area' && p.length > 2) add(p[p.length - 1], p[0]);
    if (m.wall && p.length > 1) { const T = wallThkPt(m), cl = p.length > 3 && dist(p[0], p[p.length - 1]) < 1e-6; for (const s of [-T / 2, T / 2]) { const o = offsetLine(p, s, cl); o.forEach(pt); for (let i = 1; i < o.length; i++) add(o[i - 1], o[i]); } }
  }
  const d = S.drawing; if (d?.pts.length) { d.pts.forEach(q => P.push({ p: q, t: 'end', own: true })); for (let i = 1; i < d.pts.length; i++) G.push({ a: d.pts[i - 1], b: d.pts[i], own: true }); }
  return { P, G };
}
function snapPoint(q, shift) {
  S.snapHit = null;
  const p0 = constrain(q, shift); if (UI.snap === false) return p0;
  const tol = snapTol(), { P, G } = snapGeom(), d = S.drawing, last = d?.pts.length ? d.pts[d.pts.length - 1] : null, k = curScale()?.ftPerPt;
  const ortho = !!(last && (shift || UI.ortho) && !(d.type === 'dim' && d.pts.length >= 2));
  // 1. object snaps (they win over ortho, like CAD)
  let best = null, bs = Infinity;
  const cand = (p, t, ref) => { if (!snapOn(t)) return; const dd = dist(p, q); if (dd > tol) return; const s = dd + SNAP_PRI[t] * tol; if (s < bs) { bs = s; best = { p: p.slice(), type: t, ref }; } };
  for (const o of P) if (o.p !== last) cand(o.p, o.t);
  const near = G.filter(g => segDist(q, g.a, g.b) < tol * 1.5);
  if (snapOn('int')) for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) { const x = segX(near[i], near[j]); if (x) cand(x, 'int'); }
  if (last && snapOn('perp')) for (const g of near) if (!g.own) { const f = footOn(last, g.a, g.b, true); if (f && dist(f, last) > 1e-6) cand(f, 'perp', g); }
  if (best) { S.snapHit = { ...best, guides: [] }; return best.p; }
  // 2. tracking guides: line up with ends (horizontal / vertical), parallel / perpendicular to nearby walls and lines
  const lockX = ortho && p0[0] === last[0], lockY = ortho && p0[1] === last[1];
  let gv = null, gh = null, gp = null;
  if (snapOn('align')) for (const o of P) {
    if (o.t !== 'end' || (ortho && o.p === last) || dist(o.p, p0) < tol) continue;
    const dx = Math.abs(o.p[0] - p0[0]), dy = Math.abs(o.p[1] - p0[1]);
    if (!lockX && dx < tol && (!gv || dx < gv.d)) gv = { d: dx, x: o.p[0], src: o.p };
    if (!lockY && dy < tol && (!gh || dy < gh.d)) gh = { d: dy, y: o.p[1], src: o.p };
  }
  if (last && !ortho && (snapOn('par') || snapOn('perpg'))) {
    const reach = Math.max(8 * tol, k ? 15 / k : 0), v = [p0[0] - last[0], p0[1] - last[1]];
    if (Math.hypot(...v) > tol) for (const g of G) {
      if (!g.own && segDist(p0, g.a, g.b) > reach && segDist(last, g.a, g.b) > reach) continue;
      const L = dist(g.a, g.b), u = [(g.b[0] - g.a[0]) / L, (g.b[1] - g.a[1]) / L];
      if (Math.abs(u[0]) < 1e-3 || Math.abs(u[1]) < 1e-3) continue;   // square to the sheet: ortho and alignment cover it
      for (const [t, dir] of [['par', u], ['perpg', [-u[1], u[0]]]]) {
        if (!snapOn(t)) continue;
        const s = v[0] * dir[0] + v[1] * dir[1], f = [last[0] + dir[0] * s, last[1] + dir[1] * s], dd = dist(f, p0);
        if (dd < tol && (!gp || dd < gp.d)) gp = { d: dd, t, dir, f, ref: g };
      }
    }
  }
  if (gv && gh && Math.hypot(gv.d, gh.d) < 1.5 * tol) { const x = [gv.x, gh.y]; S.snapHit = { p: x, type: 'align', guides: [{ a: gv.src, b: x }, { a: gh.src, b: x }] }; return x; }
  const cons = gp ? { o: last, u: gp.dir } : lockX ? { o: last, u: [0, 1] } : lockY ? { o: last, u: [1, 0] } : gv ? { o: [gv.x, p0[1]], u: [0, 1] } : gh ? { o: [p0[0], gh.y], u: [1, 0] } : null;
  const guideTo = x => gp ? [{ a: last, b: x }] : gv && !lockX ? [{ a: gv.src, b: x }] : gh && !lockY ? [{ a: gh.src, b: x }] : [];
  // 3. on a line (nearest point, or where the guide / ortho line crosses it)
  if (snapOn('near')) {
    let nb = null, nd = tol;
    for (const g of near) {
      if (g.own) continue;
      let x = null;
      if (cons) { x = lineX(cons.o, cons.u, g.a, [g.b[0] - g.a[0], g.b[1] - g.a[1]]); if (x && segDist(x, g.a, g.b) > 1e-6) x = null; }
      else x = footOn(p0, g.a, g.b);
      if (x) { const dd = dist(x, p0); if (dd < nd) { nd = dd; nb = { x, g }; } }
    }
    if (nb) { S.snapHit = { p: nb.x, type: 'near', guides: guideTo(nb.x), ref: nb.g }; return nb.x; }
  }
  if (gp) { S.snapHit = { p: gp.f, type: gp.t, guides: [{ a: last, b: gp.f }], ref: gp.ref }; return gp.f.slice(); }
  if (gv || gh) {
    const useV = gv && (!gh || gv.d <= gh.d), x = useV ? [gv.x, p0[1]] : [p0[0], gh.y];
    if (snapOn('grid')) { const g = gridPt(); if (useV && !lockY) x[1] = Math.round(x[1] / g) * g; if (!useV && !lockX) x[0] = Math.round(x[0] / g) * g; }
    S.snapHit = { p: x, type: 'align', guides: [{ a: useV ? gv.src : gh.src, b: x }] }; return x;
  }
  if (snapOn('grid')) { const g = gridPt(), x = [lockX ? p0[0] : Math.round(p0[0] / g) * g, lockY ? p0[1] : Math.round(p0[1] / g) * g]; S.snapHit = { p: x, type: 'grid', guides: [] }; return x; }
  return p0;
}
function snapMark() {
  const h = S.snapHit; if (!h?.p) return '';
  const z = S.z, s = 6 / z, [x, y] = h.p, c = '#ff7a00', w = 2 / z, M = '#e0389a', st = `fill="none" stroke="${c}" stroke-width="${w}"`;
  let o = `<g class="snapmark" data-snap="${h.type}" pointer-events="none">`;
  if (h.ref) o += `<line x1="${h.ref.a[0]}" y1="${h.ref.a[1]}" x2="${h.ref.b[0]}" y2="${h.ref.b[1]}" stroke="${M}" stroke-opacity=".45" stroke-width="${5 / z}" stroke-linecap="round"/>`;
  for (const g of h.guides || []) {
    const L = dist(g.a, g.b) || 1, u = [(g.b[0] - g.a[0]) / L, (g.b[1] - g.a[1]) / L], e = 60 / z;
    o += `<line class="guide" x1="${g.a[0] - u[0] * e}" y1="${g.a[1] - u[1] * e}" x2="${g.b[0] + u[0] * e}" y2="${g.b[1] + u[1] * e}" stroke="${M}" stroke-width="${1.4 / z}" stroke-dasharray="${6 / z} ${4 / z}"/><circle cx="${g.a[0]}" cy="${g.a[1]}" r="${3 / z}" fill="${M}"/>`;
  }
  const shp = {
    end: `<rect x="${x - s}" y="${y - s}" width="${2 * s}" height="${2 * s}" ${st}/>`,
    mid: `<path d="M${x} ${y - s * 1.2}L${x + s * 1.1} ${y + s * 0.8}L${x - s * 1.1} ${y + s * 0.8}Z" ${st}/>`,
    int: `<path d="M${x - s} ${y - s}L${x + s} ${y + s}M${x + s} ${y - s}L${x - s} ${y + s}" ${st}/>`,
    perp: `<path d="M${x - s} ${y + s}H${x + s}M${x - s * 0.4} ${y + s}V${y - s}" ${st}/>`,
    near: `<path d="M${x - s} ${y - s}H${x + s}L${x - s} ${y + s}H${x + s}Z" ${st}/>`,
    align: `<circle cx="${x}" cy="${y}" r="${s * 0.7}" ${st}/><path d="M${x - s * 1.4} ${y}H${x + s * 1.4}M${x} ${y - s * 1.4}V${y + s * 1.4}" fill="none" stroke="${c}" stroke-width="${w * 0.6}"/>`,
    par: `<path d="M${x - s} ${y + s * 0.4}L${x - s * 0.2} ${y - s}M${x + s * 0.2} ${y + s}L${x + s} ${y - s * 0.4}" ${st}/>`,
    grid: `<path d="M${x - s} ${y}H${x + s}M${x} ${y - s}V${y + s}" ${st}/>`,
  };
  o += shp[h.type] || shp[h.type === 'perpg' ? 'perp' : 'end'];
  const lab = SNAP_NAMES[h.type] || h.type, fs = 11 / z, tx = x + 12 / z, ty = y - 14 / z, tw = lab.length * fs * 0.6 + 8 / z;
  o += `<rect x="${tx}" y="${ty - fs}" width="${tw}" height="${fs * 1.45}" rx="${3 / z}" fill="#fff" fill-opacity=".92" stroke="${c}" stroke-width="${1 / z}"/><text class="snaplbl" x="${tx + 4 / z}" y="${ty}" font-size="${fs}" fill="#b34700" font-family="system-ui, Arial, sans-serif" font-weight="600">${lab}</text>`;
  return o + '</g>';
}
function toggleDraftOpt(k) {
  let on;
  if (k.startsWith('s:')) { const t = k.slice(2); if (t === 'grid') on = UI.gsnap = !UI.gsnap; else on = UI.snaps[t] = UI.snaps[t] === false; }
  else if (k === 'snap') on = UI.snap = UI.snap === false;
  else on = UI[k] = !UI[k];
  saveUI(); applyTheme(); renderOverlay(); renderDock(true); syncSnapBar();
  const nm = k.startsWith('s:') ? (k === 's:grid' ? 'Snap to grid' : 'Snap: ' + SNAP_NAMES[k.slice(2)]) : ({ grid: 'Grid', gsnap: 'Snap to grid', ortho: 'Ortho', snap: 'Snap', darkSheet: 'Dark sheet view' }[k] || k);
  toast(`${nm} ${on ? 'on' : 'off'}`, 1200);
}
function syncSnapBar() {
  const t = (id, on) => $(id)?.classList.toggle('on', !!on);
  t('#btnSnap', UI.snap !== false); t('#btnOrtho', UI.ortho); t('#btnGrid', UI.grid); t('#btnDarkSheet', UI.darkSheet);
}
/* ---- theme: dark / light / system; the drawing sheet stays white unless "dark sheet" is on; prints are always light ---- */
const THEME_NAMES = { dark: '☾ Dark', light: '☀ Light', system: '◐ Auto' };
function applyTheme() {
  const t = UI.theme || 'dark', eff = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = eff;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', eff === 'light' ? '#ffffff' : '#1c2126');
  $('#viewer')?.classList.toggle('darksheet', !!UI.darkSheet);
  const b = $('#btnTheme'); if (b) { b.textContent = THEME_NAMES[t] || THEME_NAMES.dark; b.title = `Theme: ${t} (tap to change: dark → light → follow the system)`; }
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (UI.theme === 'system') applyTheme(); });
$('#btnTheme') && ($('#btnTheme').onclick = () => { const o = ['dark', 'light', 'system']; UI.theme = o[(o.indexOf(UI.theme || 'dark') + 1) % 3]; saveUI(); applyTheme(); toast('Theme: ' + UI.theme, 1200); });
$('#btnSnap') && ($('#btnSnap').onclick = () => toggleDraftOpt('snap'));
$('#btnOrtho') && ($('#btnOrtho').onclick = () => toggleDraftOpt('ortho'));
$('#btnGrid') && ($('#btnGrid').onclick = () => toggleDraftOpt('grid'));
$('#btnDarkSheet') && ($('#btnDarkSheet').onclick = () => toggleDraftOpt('darkSheet'));
applyTheme(); syncSnapBar();

/* ---- assemblies (wall types): a template of components, each with a quantity formula on the wall's LF, height, sides and openings ---- */
const ASM_KINDS = { wall: 'Wall type', ceiling: 'Ceiling', soffit: 'Soffit' };
const ASM_NOTE = 'Example rates — not local prices; edit to match yours';
const ASM_VARS_HELP = {
  wall: 'LF (wall length), H (height ft), SIDES (boarded faces), AREA = LF×H, OPEN (opening SF), OPENW (opening widths, ft), NOPEN, NDOOR, NWIN, NET = AREA − OPEN, BOARD = NET × SIDES, CORNERS (turns in the wall), OUTC, BEADLF, OC (stud spacing, in)',
  ceiling: 'AREA (SF), PERIM / LF (perimeter), BOARD = NET = AREA, BEADLF, OC (framing spacing, in)',
  soffit: 'LF (soffit length), W (width ft), D (drop ft), SIDES (drops boarded), AREA = LF×W, BOARD = LF×(W + SIDES×D), BEADLF = LF×SIDES, OC',
};
const C = (id, name, unit, f, price = 0, labor = 0, waste = 0, round = true, on = true) => ({ id, name, unit, f, price, labor, waste, round, on });
function ASM_DEFAULTS() {
  const finish = (sht, shtName, shtPrice, scrRate, lh, lf) => [
    C('gwb', shtName, 'SHT', sht, shtPrice, 0, 10, true),
    C('scr', 'Drywall screws', 'LB', `BOARD / 1000 * ${scrRate}`, 7.5, 0, 5, true),
    C('mud', 'Joint compound (4.5 gal)', 'BKT', 'BOARD / 250', 19, 0, 0, true),
    C('tape', 'Joint tape (500\')', 'ROLL', 'BOARD / 1300', 5, 0, 0, true),
    C('bead', 'Corner bead', 'LF', 'BEADLF', 0.45, 0, 10, false),
  ];
  const base = { builtin: true, note: ASM_NOTE };
  return [
    { ...base, id: 'asm-2x4', kind: 'wall', name: '2x4 interior, 1/2" drywall both sides', sides: 2, oc: 16, h: 9, wall: { preset: 'w2x4', core: 3.5, gwb: 0.5 }, style: { hatch: 'stud' }, comps: [
      ...finish('BOARD / 32', '1/2" drywall 4x8', 14, 4),
      C('stud', '2x4 stud 8\'/9\'', 'EA', 'ceil(LF * 12 / OC) + 1 + 2 * CORNERS', 4.5, 0, 5, true),
      C('kj', 'King / jack studs', 'EA', '4 * NOPEN', 4.5, 0, 0, true),
      C('hdr', 'Header 2x (doubled)', 'LF', '2 * (OPENW + 0.5 * NOPEN)', 1.1, 0, 10, false),
      C('plate', 'Plates 2x4 (top + bottom)', 'LF', 'LF * 2', 0.7, 0, 10, false),
      C('ins', 'Sound batt (optional)', 'SF', 'NET', 0.65, 0, 5, false, false),
      C('lfr', 'Framing labor', 'LF', 'LF', 0, 4, 0, false),
      C('lhg', 'Hang labor', 'SF', 'BOARD', 0, 0.4, 0, false),
      C('lfn', 'Tape & finish labor (L4)', 'SF', 'BOARD', 0, 0.55, 0, false),
    ] },
    { ...base, id: 'asm-m358', kind: 'wall', name: '3-5/8" metal stud 25ga, 5/8" Type X both sides', sides: 2, oc: 16, h: 9, wall: { preset: 'm358', core: 3.625, gwb: 0.625 }, style: { hatch: 'insul' }, comps: [
      C('gwb', '5/8" Type X 4x12', 'SHT', 'BOARD / 48', 23, 0, 10, true),
      C('scr', 'Drywall screws (fine)', 'LB', 'BOARD / 1000 * 4', 8, 0, 5, true),
      C('mud', 'Joint compound (4.5 gal)', 'BKT', 'BOARD / 250', 19, 0, 0, true),
      C('tape', 'Joint tape (500\')', 'ROLL', 'BOARD / 1300', 5, 0, 0, true),
      C('bead', 'Corner bead', 'LF', 'BEADLF', 0.45, 0, 10, false),
      C('stud', '3-5/8" 25ga stud', 'EA', 'ceil(LF * 12 / OC) + 1 + 2 * CORNERS', 6.5, 0, 5, true),
      C('kj', 'King / jack studs', 'EA', '4 * NOPEN', 6.5, 0, 0, true),
      C('hdr', 'Header track', 'LF', 'OPENW + NOPEN', 1.2, 0, 10, false),
      C('trk', '3-5/8" track (top + bottom)', 'LF', 'LF * 2', 1.1, 0, 10, false),
      C('ins', 'Sound batt (optional)', 'SF', 'NET', 0.65, 0, 5, false, false),
      C('lfr', 'Framing labor', 'LF', 'LF', 0, 5, 0, false),
      C('lhg', 'Hang labor', 'SF', 'BOARD', 0, 0.45, 0, false),
      C('lfn', 'Tape & finish labor (L4)', 'SF', 'BOARD', 0, 0.55, 0, false),
    ] },
    { ...base, id: 'asm-w2x6ext', kind: 'wall', name: '2x6 exterior, 1/2" drywall inside', sides: 1, oc: 16, h: 9, wall: { preset: 'w2x6', core: 5.5, gwb: 0.5 }, style: { hatch: 'stud' }, comps: [
      ...finish('BOARD / 32', '1/2" drywall 4x8', 14, 4),
      C('stud', '2x6 stud', 'EA', 'ceil(LF * 12 / OC) + 1 + 2 * CORNERS', 7, 0, 5, true),
      C('kj', 'King / jack studs', 'EA', '4 * NOPEN', 7, 0, 0, true),
      C('hdr', 'Header 2x (doubled)', 'LF', '2 * (OPENW + 0.5 * NOPEN)', 2, 0, 10, false),
      C('plate', 'Plates 2x6 (bottom + double top)', 'LF', 'LF * 3', 1, 0, 10, false),
      C('ins', 'R-19/21 batt insulation', 'SF', 'NET', 0.95, 0, 5, false),
      C('lfr', 'Framing labor', 'LF', 'LF', 0, 6, 0, false),
      C('lhg', 'Hang labor', 'SF', 'BOARD', 0, 0.4, 0, false),
      C('lfn', 'Tape & finish labor (L4)', 'SF', 'BOARD', 0, 0.55, 0, false),
    ] },
    { ...base, id: 'asm-shaft', kind: 'wall', name: 'Shaft wall (optional): 1" liner + 2 layers 5/8" Type X, CH-stud — verify against the listed assembly', sides: 1, oc: 24, h: 9, wall: { preset: 'custom', core: 3.5, gwb: 1.25 }, style: { hatch: 'insul' }, comps: [
      C('liner', '1" shaftliner 2x8', 'SHT', 'NET / 16', 31, 0, 10, true),
      C('gwb', '5/8" Type X 4x12 (2 layers)', 'SHT', 'BOARD * 2 / 48', 23, 0, 10, true),
      C('stud', '2-1/2" CH-stud', 'EA', 'ceil(LF * 12 / OC) + 1', 9, 0, 5, true),
      C('jt', 'J-track (top + bottom)', 'LF', 'LF * 2', 2, 0, 10, false),
      C('scr', 'Drywall screws', 'LB', 'BOARD * 2 / 1000 * 4', 7.5, 0, 5, true),
      C('mud', 'Joint compound (4.5 gal)', 'BKT', 'BOARD / 250', 19, 0, 0, true),
      C('tape', 'Joint tape (500\')', 'ROLL', 'BOARD / 1300', 5, 0, 0, true),
      C('lfr', 'Framing labor', 'LF', 'LF', 0, 9.5, 0, false),
      C('lhg', 'Hang labor (2 layers + liner)', 'SF', 'BOARD * 2', 0, 0.48, 0, false),
      C('lfn', 'Tape & finish labor', 'SF', 'BOARD', 0, 0.55, 0, false),
    ] },
    { ...base, id: 'asm-ceil', kind: 'ceiling', name: 'Drywall ceiling, 1/2" sag-resistant on furring', sides: 1, oc: 16, style: {}, comps: [
      C('gwb', '1/2" ceiling board 4x12', 'SHT', 'BOARD / 48', 17, 0, 10, true),
      C('scr', 'Drywall screws', 'LB', 'BOARD / 1000 * 5', 7.5, 0, 5, true),
      C('mud', 'Joint compound (4.5 gal)', 'BKT', 'BOARD / 220', 19, 0, 0, true),
      C('tape', 'Joint tape (500\')', 'ROLL', 'BOARD / 1300', 5, 0, 0, true),
      C('fur', 'Furring channel / strapping', 'LF', 'AREA * 12 / OC', 0.6, 0, 10, false),
      C('trim', 'Perimeter trim / L-bead', 'LF', 'PERIM', 0.5, 0, 10, false),
      C('bead', 'Corner bead', 'LF', 'BEADLF', 0.45, 0, 10, false),
      C('lfr', 'Framing labor', 'SF', 'AREA', 0, 1.1, 0, false),
      C('lhg', 'Hang labor (overhead)', 'SF', 'BOARD', 0, 0.55, 0, false),
      C('lfn', 'Tape & finish labor', 'SF', 'BOARD', 0, 0.6, 0, false),
    ] },
    { ...base, id: 'asm-soffit', kind: 'soffit', name: 'Soffit / bulkhead, 1/2" drywall', sides: 1, oc: 16, w: 2, d: 1.5, style: { hatch: 'stud' }, comps: [
      C('gwb', '1/2" drywall 4x8', 'SHT', 'BOARD / 32', 14, 0, 15, true),
      C('scr', 'Drywall screws', 'LB', 'BOARD / 1000 * 5', 7.5, 0, 5, true),
      C('mud', 'Joint compound (4.5 gal)', 'BKT', 'BOARD / 200', 19, 0, 0, true),
      C('tape', 'Joint tape (500\')', 'ROLL', 'BOARD / 1000', 5, 0, 0, true),
      C('bead', 'Corner bead', 'LF', 'BEADLF', 0.45, 0, 10, false),
      C('trk', 'Track', 'LF', 'LF * (2 + SIDES)', 0.9, 0, 10, false),
      C('stud', 'Studs / hangers', 'EA', 'ceil((LF * 12 / OC + 1) * (1 + SIDES))', 4, 0, 5, true),
      C('lfr', 'Framing labor', 'LF', 'LF', 0, 8, 0, false),
      C('lhg', 'Hang labor', 'SF', 'BOARD', 0, 0.55, 0, false),
      C('lfn', 'Tape & finish labor', 'SF', 'BOARD', 0, 0.65, 0, false),
    ] },
  ];
}
S.asms = ASM_DEFAULTS();
async function loadAsms() {
  try { const r = await DB.get('meta', 'assemblies'); if (r?.list?.length) { const have = new Set(r.list.map(a => a.id)); return [...r.list, ...ASM_DEFAULTS().filter(a => !have.has(a.id))]; } } catch (e) { console.warn(e); }
  return ASM_DEFAULTS();
}
let asmTimer = 0;
function saveAsms() { clearTimeout(asmTimer); asmTimer = setTimeout(() => DB.put('meta', { id: 'assemblies', list: S.asms }).catch(e => console.warn(e)), 250); }
const asmById = id => (id && S.asms.find(a => a.id === id)) || null;
const asmOf = m => (m && m.asm && isQty(m) && asmById(m.asm)) || null;
const openingsOf = m => (S.project?.markups || []).filter(o => o.type === 'note' && o.kind === 'opening' && o.wallId === m.id);
function openArea(m) { let s = 0; for (const o of openingsOf(m)) s += (+o.ow || 0) * (+o.oh || 0); return s; }
function turnCount(P) {   // corners along a wall run (direction changes over ~10°), including the closing corner of a room
  const closed = P.length > 3 && dist(P[0], P[P.length - 1]) < 1e-6, Q = closed ? P.slice(0, -1) : P, n = Q.length; let c = 0;
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const a = Q[(i - 1 + n) % n], b = Q[i], e = Q[(i + 1) % n], u = [b[0] - a[0], b[1] - a[1]], v = [e[0] - b[0], e[1] - b[1]], L = Math.hypot(...u) * Math.hypot(...v);
    if (L && Math.abs(u[0] * v[1] - u[1] * v[0]) / L > 0.17) c++;
  }
  return c;
}
function asmVars(m, a = asmOf(m)) {
  if (!a) return null; const g = geo(m); if (g.noscale) return null;
  const P = m.asmP || {}, oc = +a.oc > 0 ? +a.oc : 16, bead = P.bead != null && P.bead !== '' ? +P.bead : null;
  if (m.type === 'area') { const A = g.sf || 0; return { AREA: A, PERIM: g.lf || 0, LF: g.lf || 0, H: 0, W: 0, D: 0, SIDES: 1, OPEN: 0, OPENW: 0, NOPEN: 0, NDOOR: 0, NWIN: 0, NET: A, BOARD: A, CORNERS: 0, OUTC: 0, BEADLF: bead ?? 0, OC: oc }; }
  const LF = g.lf || 0;
  if (a.kind === 'soffit') {
    const W = num(P.w ?? a.w, 2), D = num(P.d ?? a.d, 1.5), SD = num(P.sides ?? a.sides, 1), A = LF * W;
    return { LF, W, D, SIDES: SD, H: D, AREA: A, PERIM: LF, OPEN: 0, OPENW: 0, NOPEN: 0, NDOOR: 0, NWIN: 0, NET: A, BOARD: LF * (W + SD * D), CORNERS: turnCount(m.pts), OUTC: 0, BEADLF: bead ?? LF * SD, OC: oc };
  }
  const H = m.height > 0 ? +m.height : (+a.h || 9), SD = num(a.sides, 2), AREA = LF * H, ops = openingsOf(m);
  let OPEN = 0, OPENW = 0, ND = 0, NW = 0; for (const o of ops) { OPEN += (+o.ow || 0) * (+o.oh || 0); OPENW += +o.ow || 0; if (o.ot === 'window') NW++; else ND++; }
  OPEN = Math.min(OPEN, AREA); const NET = AREA - OPEN, CORNERS = turnCount(m.pts), OUTC = SD >= 2 ? CORNERS : 0;
  return { LF, H, W: 0, D: 0, SIDES: SD, AREA, PERIM: LF, OPEN, OPENW, NOPEN: ops.length, NDOOR: ND, NWIN: NW, NET, BOARD: NET * SD, CORNERS, OUTC, BEADLF: bead ?? OUTC * H, OC: oc };
}
function asmCompQty(c, V) { try { const q = fxEval(String(c.f || '0'), V); return isFinite(q) ? Math.max(0, q) : NaN; } catch { return NaN; } }
function asmLine(c, q) { const w = num(c.waste), raw = q * (1 + w / 100), qtyW = c.round ? Math.ceil(raw - 1e-9) : raw, price = num(c.price), laborU = num(c.labor); return { q, waste: w, qtyW, price, laborU, mat: qtyW * price, labor: qtyW * laborU, total: qtyW * (price + laborU) }; }
function asmBreakdown(m, a = asmOf(m)) {
  const V = asmVars(m, a); if (!V) return null;
  const rows = a.comps.filter(c => c.on !== false).map(c => { const q = asmCompQty(c, V); return { c, err: !isFinite(q), ...asmLine(c, isFinite(q) ? q : 0) }; });
  const t = rows.reduce((s, r) => ({ mat: s.mat + r.mat, labor: s.labor + r.labor, total: s.total + r.total }), { mat: 0, labor: 0, total: 0 });
  return { V, rows, a, ...t };
}
function asmEstimateLines(P) {   // estimate lines grouped by assembly: quantities summed over every markup of that type, then waste and round-up
  const groups = new Map(); let noScale = 0;
  for (const m of P.markups) {
    const a = asmOf(m); if (!a) continue; const V = asmVars(m, a); if (!V) { noScale++; continue; }
    const g = groups.get(a.id) || { a, n: 0, q: {} }; g.n++;
    for (const c of a.comps) if (c.on !== false) { const q = asmCompQty(c, V); if (isFinite(q)) g.q[c.id] = (g.q[c.id] || 0) + q; }
    groups.set(a.id, g);
  }
  const lines = [];
  for (const g of groups.values()) for (const c of g.a.comps) {
    if (c.on === false) continue; const q = g.q[c.id] || 0; if (!(q > 0)) continue;
    const L = asmLine(c, q);
    lines.push({ kind: 'asm', id: g.a.id + ':' + c.id, asmId: g.a.id, name: c.name, category: `${ASM_KINDS[g.a.kind] || 'Assembly'}: ${g.a.name}`, unit: c.unit || 'EA', qty: q, waste: L.waste, qtyW: L.qtyW, price: L.price, mat: L.mat, laborU: L.laborU, labor: L.labor, total: L.total, n: g.n, color: asmColor(g.a) });
  }
  return { lines, noScale };
}
const asmColor = a => a.style?.color || { wall: '#333333', ceiling: '#7a5cff', soffit: '#c77d00' }[a.kind] || '#555';
const ASM_DRAW = { ceiling: 'area', soffit: 'length' };
const ASM_TOOL_NAMES = { ceiling: 'Ceiling', soffit: 'Soffit', opening: 'Opening' };
const isAsmTool = t => t === 'ceiling' || t === 'soffit' || t === 'opening';
Object.assign(NOTE_NAMES, { opening: 'Opening' });
Object.assign(HINTS, {
  opening: 'Opening: tap on a wall to place a door or window (size in the Draw panel). Its area comes off the wall board.',
  ceiling: 'Ceiling: tap the corners of the ceiling like an area. It gets the ceiling assembly picked in the Draw panel.',
  soffit: 'Soffit: tap along the soffit run like a length. Width, drop and sides are set in the Assembly tab.',
});
/* ---- openings (doors / windows on a wall) ---- */
function nearestWall(q) {
  const tol = snapTol(); let best = null, bd = Infinity;
  for (const m of pageMarkups()) {
    if (!m.wall || m.type !== 'length' || m.pts.length < 2) continue; const r = wallThkPt(m) / 2 + 1.5 * tol;
    for (let i = 1; i < m.pts.length; i++) { const d = segDist(q, m.pts[i - 1], m.pts[i]); if (d < r && d < bd) { bd = d; best = { m, p: footOn(q, m.pts[i - 1], m.pts[i]) }; } }
  }
  return best;
}
function openingGeo(o) {
  const w = o.wallId && S.project?.markups.find(x => x.id === o.wallId && x.wall), k = kOf(o), wp = k ? (+o.ow || 3) / k : 36, c0 = o.pts[0];
  if (!w || w.pts.length < 2) return { orphan: true, c: c0, u: [1, 0], n: [0, 1], wp, T: k ? 0.4 / k : 6 };
  let best = null, bd = Infinity;
  for (let i = 1; i < w.pts.length; i++) { const d = segDist(c0, w.pts[i - 1], w.pts[i]); if (d < bd) { bd = d; best = [w.pts[i - 1], w.pts[i]]; } }
  const [a, b] = best, L = dist(a, b) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  let t = (c0[0] - a[0]) * u[0] + (c0[1] - a[1]) * u[1]; t = L > wp ? clamp(t, wp / 2, L - wp / 2) : L / 2;
  return { c: [a[0] + u[0] * t, a[1] + u[1] * t], u, n: [-u[1], u[0]], wp, T: wallThkPt(w), wall: w };
}
function openingPoly(G, o) { const h2 = G.wp / 2, t2 = G.T / 2, P = (s, t) => [G.c[0] + G.u[0] * s + G.n[0] * t, G.c[1] + G.u[1] * s + G.n[1] * t], sg = o.flip ? -1 : 1, sw = o.ot === 'window' ? 0 : G.wp; return [P(-h2, -t2 - (sg < 0 ? sw : 0)), P(h2, -t2 - (sg < 0 ? sw : 0)), P(h2, t2 + (sg > 0 ? sw : 0)), P(-h2, t2 + (sg > 0 ? sw : 0))]; }
function openingSVG(m, st, z) {
  const G = openingGeo(m), c = st.color || '#222222', lw = Math.max(+st.width || 1, 0.8 / z), h2 = G.wp / 2, T = G.T, sg = m.flip ? -1 : 1;
  const P = (s, t) => [G.c[0] + G.u[0] * s + G.n[0] * t, G.c[1] + G.u[1] * s + G.n[1] * t], ln = (a, b, w = lw, ex = '') => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="${w}"${ex}/>`;
  const k = kOf(m), lab = `${m.ot === 'window' ? 'W' : 'D'} ${fmtFtIn(+m.ow || 0)} × ${fmtFtIn(+m.oh || 0)}`;
  if (G.orphan) { const b = [P(-h2, -T / 2), P(h2, -T / 2), P(h2, T / 2), P(-h2, T / 2)]; return `<polygon points="${pp(b)}" fill="none" stroke="${c}" stroke-width="${lw}" stroke-dasharray="${4 / z} ${3 / z}"/><text x="${G.c[0]}" y="${G.c[1] - T}" font-size="${Math.max(G.wp * 0.18, 4)}" fill="${c}" text-anchor="middle" font-family="system-ui, Arial, sans-serif">${esc(lab)} (no wall)</text>`; }
  let h = `<polygon points="${pp([P(-h2, -T / 2 - lw), P(h2, -T / 2 - lw), P(h2, T / 2 + lw), P(-h2, T / 2 + lw)])}" fill="#fff" stroke="none"/>`;
  h += ln(P(-h2, -T / 2), P(-h2, T / 2)) + ln(P(h2, -T / 2), P(h2, T / 2));
  if (m.ot === 'window') h += ln(P(-h2, -T / 2), P(h2, -T / 2), lw * 0.7) + ln(P(-h2, T / 2), P(h2, T / 2), lw * 0.7) + ln(P(-h2, 0), P(h2, 0), lw * 0.5);
  else {
    const hinge = P(-h2, sg * T / 2), leaf = P(-h2, sg * (T / 2 + G.wp)), strike = P(h2, sg * T / 2);
    const a1 = Math.atan2(leaf[1] - hinge[1], leaf[0] - hinge[0]), a2 = Math.atan2(strike[1] - hinge[1], strike[0] - hinge[0]); let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    h += ln(hinge, leaf, lw * 0.9) + `<path d="M${leaf[0]} ${leaf[1]}A${G.wp} ${G.wp} 0 0 ${da > 0 ? 1 : 0} ${strike[0]} ${strike[1]}" fill="none" stroke="${c}" stroke-width="${lw * 0.6}" stroke-dasharray="${3 / z} ${2 / z}"/>`;
  }
  let ang = Math.atan2(G.u[1], G.u[0]) * 180 / Math.PI; if (ang > 90.01) ang -= 180; else if (ang < -89.99) ang += 180;
  const fs = Math.max(Math.min(G.wp * 0.2, k ? 0.9 / k : 12), 3), lp = P(0, -sg * (T / 2 + fs * 0.9));
  h += `<text x="${lp[0]}" y="${lp[1]}" font-size="${fs}" fill="${c}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, Arial, sans-serif" stroke="#fff" stroke-width="${fs * 0.2}" paint-order="stroke" transform="rotate(${ang} ${lp[0]} ${lp[1]})">${esc(lab)}</text>`;
  return h;
}
const openingBox = m => { const G = openingGeo(m); return box2(openingPoly(G, m)); };
const openingDist = (m, q) => { const G = openingGeo(m); return inPoly(q, openingPoly(G, m)) ? -0.5 : Infinity; };
function placeOpening(q, wallM) {
  const hit = wallM ? { m: wallM, p: q } : nearestWall(q);
  if (!hit) { toast('Tap on a wall to place the opening'); return null; }
  const o = UI.open, n = addNote('opening', [hit.p]);
  n.wallId = hit.m.id; n.ot = o.t === 'window' ? 'window' : 'door'; n.ow = +o.w > 0 ? +o.w : 3; n.oh = +o.h > 0 ? +o.h : (n.ot === 'door' ? 7 : 4); n.style = { color: '#222222', width: 1 };
  touch(); renderOverlay(); refreshPanel(); renderDock(true);
  toast(`${n.ot === 'window' ? 'Window' : 'Door'} ${fmtFtIn(n.ow)} × ${fmtFtIn(n.oh)} on ${markName(hit.m)}`, 1600); return n;
}
function openingGhost() {
  const q = S.opHover; if (!q) return ''; const hit = nearestWall(q), z = S.z;
  if (!hit) return `<text x="${q[0] + 12 / z}" y="${q[1] - 12 / z}" font-size="${12 / z}" fill="#e0389a" font-family="system-ui, Arial, sans-serif">tap a wall</text>`;
  const o = UI.open, g = { type: 'note', kind: 'opening', docId: S.docId, page: S.pageNum, pts: [hit.p], wallId: hit.m.id, ot: o.t, ow: o.w, oh: o.h };
  return `<g opacity=".65">${openingSVG(g, { color: '#e0389a', width: 1.2 }, z)}</g>`;
}
/* ---- bigger, editable text / callout defaults ---- */
function annToolStyleV18(k) {
  const o = { ...(ANN_DEF[k] || SHAPE) };
  if (k === 'text' || k === 'callout') { o.fs = Math.round(clamp(Math.max(S.W || 0, S.H || 0) / 60, 24, 72)); o.pad = 0.4; if (k === 'callout') { o.width = 3; o.head = 1.4; } }
  if (k === 'opening') Object.assign(o, { color: '#222222', width: 1 });
  return { ...o, ...((UI.ann || {})[k] || {}) };
}
/* ---- the Assembly tab in the bottom dock ---- */
const asmOpts = (kinds, cur) => S.asms.filter(a => kinds.includes(a.kind)).map(a => `<option value="${a.id}" ${a.id === cur ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
function asmHeadline(B) {
  const V = B.V, a = B.a;
  if (a.kind === 'ceiling' || V.W === 0 && a.kind !== 'wall' && a.kind !== 'soffit') return `Area ${fmtN(V.AREA)} SF · perimeter ${fmtN(V.PERIM)} LF · board <b>${fmtN(V.BOARD)} SF</b> before waste`;
  if (a.kind === 'soffit') return `LF ${fmtN(V.LF)} · W ${fmtFtIn(V.W)} · D ${fmtFtIn(V.D)} · ${V.SIDES} side${V.SIDES === 1 ? '' : 's'} · board <b>${fmtN(V.BOARD)} SF</b> before waste`;
  return `LF ${fmtN(V.LF)} · H ${fmtFtIn(V.H)} · ${V.SIDES} side${V.SIDES === 1 ? '' : 's'} · openings ${fmtN(V.OPEN)} SF (${V.NOPEN}) · board <b>${fmtN(V.BOARD)} SF</b> before waste`;
}
function breakdownHTML(m, a) {
  const B = asmBreakdown(m, a); if (!B) return '<p class="muted small">Set the page scale to price this assembly.</p>';
  const rows = B.rows.map(r => `<tr data-comp="${esc(r.c.id)}"${r.err ? ' class="err"' : ''}><td>${esc(r.c.name)}</td><td class="fxf"><code>${esc(r.c.f)}</code></td><td class="n">${r.err ? '⚠' : fmtN(r.q, 2)}</td><td>${esc(r.c.unit)}</td><td class="n">${fmtN(r.waste, r.waste % 1 ? 1 : 0)}%</td><td class="n"><b>${fmtN(r.qtyW, r.c.round ? 0 : 2)}</b></td><td class="n">${fmt$(r.price)}</td><td class="n">${fmt$(r.mat)}</td><td class="n">${fmt$(r.laborU)}</td><td class="n">${fmt$(r.labor)}</td><td class="n"><b>${fmt$(r.total)}</b></td></tr>`).join('');
  return `<div class="asmHead small" data-board="${+B.V.BOARD.toFixed(4)}">${asmHeadline(B)}</div>
    <div class="tscroll"><table class="fxT asmT"><thead><tr><th>Item</th><th>Formula</th><th class="n">Qty</th><th>Unit</th><th class="n">Waste</th><th class="n">Qty w/ waste</th><th class="n">Unit $</th><th class="n">Material</th><th class="n">Labor/unit</th><th class="n">Labor</th><th class="n">Total</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td colspan="7">Totals for this ${a.kind === 'wall' ? 'wall' : a.kind}</td><td class="n" data-tot="mat">${fmt$(B.mat)}</td><td></td><td class="n" data-tot="labor">${fmt$(B.labor)}</td><td class="n" data-tot="total"><b>${fmt$(B.total)}</b></td></tr></tfoot></table></div>
    <p class="muted small">${esc(a.note || ASM_NOTE)}. Edit components and prices with nothing selected (Assembly tab → library).</p>`;
}
function dockAsm(body) {
  if (!S.project) { body.innerHTML = '<p class="muted small">Open a project first.</p>'; return; }
  const q = selMarks().filter(x => isQty(x) && x.type !== 'count'), m = q.find(x => x.id === S.selId) || q[0];
  if (m && S.asmView !== 'lib') return asmMarkPanel(body, m);
  asmLibPanel(body, m);
}
function asmMarkPanel(body, m) {
  const A = asmOf(m), kinds = m.type === 'area' ? ['ceiling'] : m.wall ? ['wall'] : ['soffit'], P = m.asmP || {};
  let h = `<div class="dgrid"><div class="dcol">
    <div class="dhead"><b>Assembly</b><span class="muted small">${esc(markName(m))}</span><button class="small" id="amLib">Wall type library</button></div>
    <label class="field"><span>${m.type === 'area' ? 'Ceiling assembly' : m.wall ? 'Wall type' : 'Soffit assembly'}</span><select id="amSel"><option value="">— None —</option>${asmOpts(kinds, m.asm)}</select></label>`;
  if (!A && !m.wall && m.type === 'length') h += `<p class="muted small">Soffits are lengths. Walls have their own wall types; draw them with the Wall tool.</p>`;
  if (A) {
    if (m.productId) h += `<p class="small warn">This markup also has a product (${esc(prodById(m.productId)?.name || '')}). Both count in the estimate: clear one to avoid counting twice.</p>`;
    if (A.kind === 'wall') h += `<div class="fxRow"><label class="sg"><span>Height ft</span><input id="amH" value="${esc(fmtFtIn(m.height > 0 ? m.height : (+A.h || 9)))}" style="width:72px"></label><label class="sg"><span>Corner bead LF</span><input id="amBead" value="${P.bead ?? ''}" placeholder="auto" style="width:64px"></label></div>
      <div class="oplist"><b class="small">Openings</b>${openingsOf(m).map(o => `<div class="fxRow oprow" data-oid="${o.id}"><select data-of="ot"><option value="door" ${o.ot !== 'window' ? 'selected' : ''}>Door</option><option value="window" ${o.ot === 'window' ? 'selected' : ''}>Window</option></select><input data-of="ow" value="${esc(fmtFtIn(+o.ow))}" style="width:64px" title="Width"><span class="small">×</span><input data-of="oh" value="${esc(fmtFtIn(+o.oh))}" style="width:64px" title="Height"><span class="small muted">${fmtN(o.ow * o.oh)} SF</span><button class="small" data-oflip title="Flip the door swing">⇅</button><button class="small danger" data-odel title="Delete">✕</button></div>`).join('') || '<div class="muted small">None yet.</div>'}
      <div class="fxRow"><button class="small" id="amAddOp">+ Add opening</button><span class="muted small">Adds ${UI.open.t} ${fmtFtIn(UI.open.w)} × ${fmtFtIn(UI.open.h)} at the middle; drag it along the wall, or use the Opening tool.</span></div></div>`;
    if (A.kind === 'soffit') h += `<div class="fxRow"><label class="sg"><span>Width ft</span><input id="amW" value="${esc(fmtFtIn(num(P.w ?? A.w, 2)))}" style="width:64px"></label><label class="sg"><span>Drop ft</span><input id="amD" value="${esc(fmtFtIn(num(P.d ?? A.d, 1.5)))}" style="width:64px"></label><label class="sg"><span>Sides</span><input id="amS" inputmode="decimal" value="${num(P.sides ?? A.sides, 1)}" style="width:44px"></label><label class="sg"><span>Bead LF</span><input id="amBead" value="${P.bead ?? ''}" placeholder="auto" style="width:64px"></label></div>`;
    if (A.kind === 'ceiling') h += `<div class="fxRow"><label class="sg"><span>Corner bead LF</span><input id="amBead" value="${P.bead ?? ''}" placeholder="0" style="width:64px"></label></div>`;
  }
  h += `</div><div class="dcol grow">${A ? breakdownHTML(m, A) : `<p class="muted small">Pick ${m.wall ? 'a wall type' : 'an assembly'} to see the material and labor breakdown for this ${m.wall ? 'wall' : 'markup'}.</p>`}</div></div>`;
  body.innerHTML = h;
  const re = () => { touch(); renderOverlay(); refreshPanel(); renderDock(true); };
  body.querySelector('#amLib').onclick = () => { S.asmView = 'lib'; S.asmEdit = A?.id || S.asmEdit; renderDock(true); };
  body.querySelector('#amSel').onchange = e => { pushUndo(); const a = asmById(e.target.value); if (a) { m.asm = a.id; if (m.wall && a.wall) m.wall = { ...a.wall }; if (m.wall && !(m.height > 0)) m.height = +a.h || 9; } else delete m.asm; re(); };
  const fe = (id, f) => { const el = body.querySelector(id); if (el) el.onchange = () => f(el.value); };
  fe('#amH', v => { const x = parseFtIn(v); if (!(x > 0)) return toast('Height like 9 or 8\'6"'); pushUndo(); m.height = +x.toFixed(4); re(); });
  fe('#amBead', v => { pushUndo(); m.asmP = { ...(m.asmP || {}) }; if (String(v).trim() === '') delete m.asmP.bead; else m.asmP.bead = num(v); re(); });
  fe('#amW', v => { const x = parseFtIn(v); if (!(x > 0)) return toast('Width like 2\''); pushUndo(); m.asmP = { ...(m.asmP || {}), w: x }; re(); });
  fe('#amD', v => { const x = parseFtIn(v); if (!(x >= 0)) return toast('Drop like 1\'6"'); pushUndo(); m.asmP = { ...(m.asmP || {}), d: x }; re(); });
  fe('#amS', v => { pushUndo(); m.asmP = { ...(m.asmP || {}), sides: Math.max(0, num(v, 1)) }; re(); });
  body.querySelectorAll('.oprow').forEach(r => {
    const o = S.project.markups.find(x => x.id === r.dataset.oid); if (!o) return;
    r.querySelectorAll('[data-of]').forEach(el => el.onchange = () => { const f = el.dataset.of; let v = el.value; if (f !== 'ot') { v = parseFtIn(v); if (!(v > 0)) return toast('Size like 3\' or 2\'8"'); } pushUndo(); o[f] = v; re(); });
    r.querySelector('[data-odel]').onclick = () => { pushUndo(); S.project.markups = S.project.markups.filter(x => x.id !== o.id); re(); };
    r.querySelector('[data-oflip]').onclick = () => { pushUndo(); o.flip = !o.flip; re(); };
  });
  const ao = body.querySelector('#amAddOp'); if (ao) ao.onclick = () => { const L = polyLen(m.pts); let acc = 0, at = m.pts[0]; for (let i = 1; i < m.pts.length; i++) { const d = dist(m.pts[i - 1], m.pts[i]); if (acc + d >= L / 2) { const t = (L / 2 - acc) / (d || 1); at = [m.pts[i - 1][0] + (m.pts[i][0] - m.pts[i - 1][0]) * t, m.pts[i - 1][1] + (m.pts[i][1] - m.pts[i - 1][1]) * t]; break; } acc += d; } const sel = m.id; placeOpening(at, m); S.selId = sel; renderOverlay(); refreshPanel(); renderDock(true); };
}
function asmLibPanel(body, selM) {
  const A = asmById(S.asmEdit) || S.asms[0]; if (!A) { body.innerHTML = '<p class="muted small">No assemblies.</p>'; return; } S.asmEdit = A.id;
  const groups = Object.keys(ASM_KINDS).map(k => `<optgroup label="${ASM_KINDS[k]}">${asmOpts([k], A.id)}</optgroup>`).join('');
  const useK = { wall: ['wallAsm', 'wall', 'wall'], ceiling: ['ceilAsm', 'ceiling', 'ceiling'], soffit: ['soffitAsm', 'soffit', 'soffit'] }[A.kind];
  const inp = (k, label, v, w = 60, tip = '') => `<label class="sg"><span>${label}</span><input data-af="${k}" value="${esc(String(v ?? ''))}" style="width:${w}px" title="${tip}"></label>`;
  const sample = { LF: 1, H: 1, W: 1, D: 1, SIDES: 1, AREA: 1, PERIM: 1, OPEN: 1, OPENW: 1, NOPEN: 1, NDOOR: 1, NWIN: 1, NET: 1, BOARD: 1, CORNERS: 1, OUTC: 1, BEADLF: 1, OC: 16 };
  const rows = A.comps.map((c, i) => `<tr data-ci="${i}"><td><input type="checkbox" data-cf="on" ${c.on !== false ? 'checked' : ''}></td><td><input data-cf="name" value="${esc(c.name)}" style="width:180px"></td><td><input data-cf="unit" value="${esc(c.unit)}" style="width:52px"></td><td><input data-cf="f" class="fxin${isFinite(asmCompQty(c, sample)) ? '' : ' bad'}" value="${esc(c.f)}" style="width:210px"></td><td><input data-cf="price" inputmode="decimal" value="${c.price}" style="width:64px"></td><td><input data-cf="labor" inputmode="decimal" value="${c.labor}" style="width:56px"></td><td><input data-cf="waste" inputmode="decimal" value="${c.waste}" style="width:44px"></td><td><input type="checkbox" data-cf="round" ${c.round ? 'checked' : ''}></td><td><button class="small danger" data-cdel title="Remove">✕</button></td></tr>`).join('');
  body.innerHTML = `<div class="dhead"><b>Assemblies</b><select id="alSel">${groups}</select>${selM ? '<button class="small" id="alBack">← Selected markup</button>' : ''}<button class="small" id="alDup">Duplicate</button>${A.builtin ? '<button class="small" id="alReset" title="Put this template back to the example values">Reset to example</button>' : '<button class="small danger" id="alDel">Delete</button>'}<button class="small accent" id="alUse">Use for next ${useK[2]}</button></div>
    <p class="small warnnote">${esc(ASM_NOTE)}. The quantities are rules of thumb to start from, not a code-checked design.</p>
    <div class="fxRow asmMeta">${inp('name', 'Name', A.name, 300)}<span class="badge">${ASM_KINDS[A.kind]}</span>${A.kind !== 'ceiling' ? inp('sides', A.kind === 'soffit' ? 'Drops boarded' : 'Sides boarded', A.sides, 44) : ''}${inp('oc', 'OC in', A.oc, 44, 'Stud / framing spacing in inches')}${A.kind === 'wall' ? inp('h', 'Default height ft', A.h, 52) + inp('core', 'Core in', A.wall?.core, 52) + inp('gwb', 'Board each side in', A.wall?.gwb, 52) : ''}${A.kind === 'soffit' ? inp('w', 'Width ft', A.w, 48) + inp('d', 'Drop ft', A.d, 48) : ''}
      ${inp('lw', 'Line weight pt', A.style?.width ?? '', 48, 'Blank = default')}${inp('hs', 'Hatch scale ×', A.style?.hscale ?? '', 48, 'Blank = 1')}<label class="sg"><span>Hatch</span><select data-af="hatch">${Object.entries(HATCHES).concat(Object.entries(ARCH_PATS).map(([k, p]) => [k, p.n || k])).map(([k, n]) => `<option value="${k}" ${(A.style?.hatch || 'none') === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>
    <div class="tscroll"><table class="fxT asmEd"><thead><tr><th>On</th><th>Item</th><th>Unit</th><th>Qty formula ƒx</th><th>Price $</th><th>Labor $</th><th>Waste %</th><th title="Round the quantity with waste up to whole units">Whole</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="fxRow"><button class="small" id="alAddC">+ Component</button><span class="muted small">Variables: ${esc(ASM_VARS_HELP[A.kind])}. Functions: ceil, round, floor, min, max.</span></div>`;
  const save = (rerender) => { saveAsms(); renderOverlay(); refreshPanel(); if (S.view === 'estimate') renderEstimate(); if (rerender) renderDock(true); };
  body.querySelector('#alSel').onchange = e => { S.asmEdit = e.target.value; renderDock(true); };
  const bk = body.querySelector('#alBack'); if (bk) bk.onclick = () => { S.asmView = 'mark'; renderDock(true); };
  body.querySelector('#alDup').onclick = () => { const c = JSON.parse(JSON.stringify(A)); c.id = 'asm-' + uid(); c.builtin = false; c.name = A.name + ' (copy)'; S.asms.push(c); S.asmEdit = c.id; save(true); toast('Duplicated: edit the copy'); };
  const rs = body.querySelector('#alReset'); if (rs) rs.onclick = () => { const d = ASM_DEFAULTS().find(x => x.id === A.id); if (d) { S.asms[S.asms.indexOf(A)] = d; save(true); toast('Reset to the example values'); } };
  const dl = body.querySelector('#alDel'); if (dl) dl.onclick = () => { const n = (S.project?.markups || []).filter(m => m.asm === A.id).length; if (n && !body.querySelector('#alDel').dataset.armed) { body.querySelector('#alDel').dataset.armed = 1; body.querySelector('#alDel').textContent = `Delete (used by ${n})?`; return; } S.asms = S.asms.filter(x => x !== A); S.asmEdit = null; save(true); };
  body.querySelector('#alUse').onclick = () => { UI[useK[0]] = A.id; saveUI(); S.asmView = 'mark'; S.selId = null; setTool(useK[1]); toast(`Next ${useK[2]}: ${A.name}`); };
  body.querySelectorAll('[data-af]').forEach(el => el.onchange = () => {
    const k = el.dataset.af, v = el.value; A.style = A.style || {};
    if (k === 'name') A.name = v.trim() || A.name;
    else if (k === 'hatch') A.style.hatch = v;
    else if (k === 'lw' || k === 'hs') { const f = k === 'lw' ? 'width' : 'hscale'; if (v.trim() === '') delete A.style[f]; else A.style[f] = clamp(num(v, 1), k === 'lw' ? 0.25 : 0.1, k === 'lw' ? 12 : 10); }
    else if (k === 'core' || k === 'gwb') { const x = parseInches(v); if (!(x >= 0)) return toast('Inches like 3.5 or 5/8'); A.wall = { ...(A.wall || {}), preset: 'custom', [k]: x }; for (const m of S.project?.markups || []) if (m.asm === A.id && m.wall) m.wall = { ...A.wall }; touch(); }
    else if (k === 'h' || k === 'w' || k === 'd') { const x = parseFtIn(v); if (!(x >= 0)) return toast('Feet like 9 or 8\'6"'); A[k] = x; }
    else A[k] = num(v, A[k]);
    save(k === 'name');
  });
  body.querySelectorAll('tr[data-ci]').forEach(r => {
    const c = A.comps[+r.dataset.ci];
    r.querySelectorAll('[data-cf]').forEach(el => el.onchange = () => { const f = el.dataset.cf; c[f] = el.type === 'checkbox' ? el.checked : ['price', 'labor', 'waste'].includes(f) ? num(el.value) : el.value; if (f === 'f') el.classList.toggle('bad', !isFinite(asmCompQty(c, sample))); save(false); });
    r.querySelector('[data-cdel]').onclick = () => { A.comps.splice(+r.dataset.ci, 1); save(true); };
  });
  body.querySelector('#alAddC').onclick = () => { A.comps.push(C('c' + uid().slice(0, 6), 'New item', 'EA', 'LF', 0, 0, 0, true)); save(true); };
}
/* ---- Draw tab: snap / grid rows and the assembly pickers for the wall, opening, ceiling and soffit tools ---- */
function snapRowsHTML() {
  const tg = (k, label, on, tip) => `<label class="chk small" title="${tip}"><input type="checkbox" data-dopt="${k}" ${on ? 'checked' : ''}> ${label}</label>`;
  const ft = v => esc(fmtFtIn(v).replace(/-0"$/, ''));
  const types = [['end', 'Endpoint'], ['mid', 'Midpoint'], ['int', 'Intersection'], ['perp', 'Perpendicular'], ['near', 'On line'], ['align', 'Alignment guides'], ['par', 'Parallel'], ['perpg', 'Perpendicular guide']];
  return `<div class="fxRow snaprow">${tg('snap', '<b>Snap</b> (S)', UI.snap !== false, 'Master snap switch: object snaps and guides (S)')}${tg('ortho', 'Ortho (O)', UI.ortho, 'Lock to horizontal / vertical (O, or hold Shift)')}${tg('s:grid', 'Snap to grid', UI.gsnap, 'Points land on the grid')}</div>
    <div class="fxRow snaptypes${UI.snap === false ? ' off' : ''}">${types.map(([k, n]) => tg('s:' + k, n, UI.snaps[k] !== false, SNAP_NAMES[k] + ' snap')).join('')}</div>
    <div class="fxRow">${tg('grid', 'Grid (G)', UI.grid, 'Show the grid')}<span class="small">minor</span><input id="dwGrid" style="width:58px" value="${ft(UI.gridFt || 1)}" title="Minor grid spacing, feet-inches (real feet when the page has a scale)"><span class="small">major</span><input id="dwGridM" style="width:58px" value="${ft(UI.gridMajorFt || 5)}" title="Major grid spacing, feet-inches"><label class="chk small" title="Print the grid on the drawing"><input type="checkbox" id="dwPrGrid" ${UI.prGrid ? 'checked' : ''}> Print grid</label></div>`;
}
function asmDrawHTML(t) {
  if (t === 'wall') return `<div class="fxRow asmpick"><label class="sg"><span>Wall type</span><select id="dwAsm"><option value="">— None (product only) —</option>${asmOpts(['wall'], UI.wallAsm)}</select></label><button type="button" class="small" data-asmlib="wall">Edit wall types</button></div>${asmById(UI.wallAsm) ? `<p class="muted small">New walls use <b>${esc(asmById(UI.wallAsm).name)}</b>: thickness, hatch and the material / labor breakdown come from the wall type.</p>` : ''}`;
  if (t === 'ceiling' || t === 'soffit') { const key = t === 'ceiling' ? 'ceilAsm' : 'soffitAsm'; return `<div class="fxRow asmpick"><label class="sg"><span>${t === 'ceiling' ? 'Ceiling assembly' : 'Soffit assembly'}</span><select id="dwAsmK" data-k="${key}">${asmOpts([t], UI[key])}</select></label><button type="button" class="small" data-asmlib="${t}">Edit</button></div><p class="muted small">${esc(HINTS[t])}</p>`; }
  if (t === 'opening') { const o = UI.open; return `<div class="fxRow asmpick"><label class="sg"><span>Opening</span><select id="dwOT"><option value="door" ${o.t !== 'window' ? 'selected' : ''}>Door</option><option value="window" ${o.t === 'window' ? 'selected' : ''}>Window</option></select></label><label class="sg"><span>Width</span><input id="dwOW" value="${esc(fmtFtIn(o.w))}" style="width:64px"></label><label class="sg"><span>Height</span><input id="dwOH" value="${esc(fmtFtIn(o.h))}" style="width:64px"></label></div><p class="muted small">${esc(HINTS.opening)} Wall types add king/jack studs and a header for each one.</p>`; }
  return '';
}
function bindAsmDraw(body) {
  const ws = body.querySelector('#dwAsm'); if (ws) ws.onchange = () => { UI.wallAsm = ws.value; saveUI(); renderPreview(); renderDock(true); };
  const ks = body.querySelector('#dwAsmK'); if (ks) ks.onchange = () => { UI[ks.dataset.k] = ks.value; saveUI(); };
  body.querySelectorAll('[data-asmlib]').forEach(b => b.onclick = () => { const k = b.dataset.asmlib; S.asmEdit = k === 'wall' ? (UI.wallAsm || 'asm-2x4') : UI[k === 'ceiling' ? 'ceilAsm' : 'soffitAsm']; S.asmView = 'lib'; S.selId = null; S.sel.clear(); setDockTab('asm'); });
  const ot = body.querySelector('#dwOT'), ow = body.querySelector('#dwOW'), oh = body.querySelector('#dwOH');
  if (ot) { ot.onchange = () => { UI.open.t = ot.value; if (ot.value === 'window' && UI.open.h === 7) { UI.open.h = 4; oh.value = fmtFtIn(4); } saveUI(); };
    const sz = (el, f) => el.onchange = () => { const v = parseFtIn(el.value); if (v > 0) { UI.open[f] = +v.toFixed(4); saveUI(); } else toast('Size like 3\' or 2\'8"'); }; sz(ow, 'w'); sz(oh, 'h'); }
  const gm = body.querySelector('#dwGridM'); if (gm) gm.onchange = () => { const v = parseFtIn(gm.value); if (v > 0) { UI.gridMajorFt = v; saveUI(); renderOverlay(); } else toast('Major grid like 5\''); };
  const pg = body.querySelector('#dwPrGrid'); if (pg) pg.onchange = () => { UI.prGrid = pg.checked; saveUI(); };
}
const asmToolStyle = A => A ? { ...(A.style || {}) } : null;

/* ======================= v1.6: style controls (Bluebeam/OST conventions: color, line width, line style, fill, hatch, opacity) ======================= */
const hex6 = c => /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#000000';
const STYLE_FIELDS = {
  length: ['color', 'width', 'dash', 'opacity', 'show'],
  area: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'hatch', 'hscale', 'opacity', 'show'],
  count: ['color', 'opacity', 'show'],
  highlight: ['color', 'width', 'opacity'],
  pen: ['color', 'width', 'dash', 'opacity'], line: ['color', 'width', 'dash', 'opacity'], arrow: ['color', 'width', 'head', 'dash', 'opacity'],
  rect: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'opacity'], ellipse: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'opacity'], cloud: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'opacity'],
  text: ['color', 'fs', 'bold', 'pad', 'bg', 'border', 'opacity'],
  callout: ['color', 'tcolor', 'width', 'head', 'fs', 'bold', 'pad', 'bg', 'opacity'],
  opening: ['color', 'width'],
  dline: ['color', 'width', 'dash', 'opacity'], drect: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'hatch', 'hscale', 'opacity'], dim: ['color', 'width', 'fs', 'opacity'],
  wall: ['color', 'width', 'hatch', 'hscale', 'opacity', 'show'],
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
  if (F.includes('width')) h += rng('width', kind === 'callout' ? 'Leader width' : kind === 'wall' ? 'Line weight' : 'Line width', kind === 'wall' ? 0.25 : 0.5, kind === 'highlight' ? 48 : kind === 'wall' ? 12 : 16, kind === 'wall' ? 0.25 : 0.5, +st.width || (kind === 'wall' ? 1 : 2), ' pt');
  if (F.includes('head')) h += rng('head', 'Arrow head size', 0.3, 4, 0.1, +st.head || 1, '×');
  if (F.includes('tcolor')) h += `<label class="sg"><span>Text color</span><input type="color" data-k="tcolor" value="${hex6(st.tcolor || st.color)}" title="Text color"></label>`;
  if (F.includes('dash')) h += `<label class="sg"><span>Line style</span><select data-k="dash">${Object.entries(DASHES).map(([k, n]) => `<option value="${k}" ${st.dash === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  if (F.includes('fill')) h += `<label class="sg"><span>Fill</span><select data-k="fill"><option value="none" ${st.fill === 'none' ? 'selected' : ''}>No fill</option><option value="solid" ${st.fill !== 'none' ? 'selected' : ''}>Color fill</option></select></label>`;
  if (F.includes('fillOpacity')) h += rng('fillOpacity', 'Fill opacity', 0.05, 1, 0.05, st.fillOpacity ?? 0.2);
  if (F.includes('hscale')) h += rng('hscale', 'Hatch scale', 0.2, 5, 0.1, +st.hscale || 1, '×');
  if (F.includes('hatch')) h += `<div class="sg wide"><span>Pattern (hatch) <output>${esc(HATCHES[st.hatch || 'none'] || 'None')}</output></span>${HATCH_GROUPS.map(([g, ks]) => `<div class="hts"><i class="htg">${g}</i>${ks.map(k => `<button type="button" class="htb${(st.hatch || 'none') === k ? ' on' : ''}" data-k="hatch" data-v="${k}" title="${HATCHES[k]}" aria-label="Hatch ${HATCHES[k]}">${hatchIcon(k)}</button>`).join('')}</div>`).join('')}</div>`;
  if (F.includes('fs')) h += `<div class="sg fsrow"><span>Font size <output>${fmtStyle('fs', +st.fs || 16)} pt</output></span><div class="fsin"><input type="range" data-k="fs" min="4" max="200" step="1" value="${Math.min(200, +st.fs || 16)}"><input type="number" data-k="fs" min="2" max="800" step="1" value="${+st.fs || 16}" style="width:64px" title="Font size, pt"></div></div>`;
  if (F.includes('pad')) h += rng('pad', 'Padding', 0, 2, 0.05, st.pad != null && st.pad !== '' ? +st.pad : 0.35, '× size');
  if (F.includes('bold')) h += `<label class="sg chk"><input type="checkbox" data-k="bold" ${st.bold ? 'checked' : ''}> Bold</label>`;
  if (F.includes('bg')) { const BG = [['none', 'None'], ['#ffffff', 'White'], ['#fff7b0', 'Yellow'], ['#e8f1ff', 'Light blue']], cust = st.bg && !BG.some(([v]) => v === st.bg); h += `<label class="sg"><span>Background</span><span class="bgrow"><select data-k="bg">${BG.map(([v, n]) => `<option value="${v}" ${(st.bg || 'none') === v ? 'selected' : ''}>${n}</option>`).join('')}${cust ? `<option value="${esc(st.bg)}" selected>Custom</option>` : ''}</select><input type="color" data-k="bg" value="${hex6(st.bg && st.bg !== 'none' ? st.bg : '#ffffff')}" title="Custom background color"></span></label>`; }
  if (F.includes('border')) h += `<label class="sg chk"><input type="checkbox" data-k="border" ${st.border ? 'checked' : ''}> Border</label>`;
  if (F.includes('opacity')) h += rng('opacity', 'Opacity', 0.1, 1, 0.05, st.opacity ?? 1);
  if (F.includes('show')) h += `<div class="sg wide"><span>Show on drawing</span><label class="chk"><input type="checkbox" data-k="showLabel" ${st.showLabel !== false ? 'checked' : ''}> Label</label> <label class="chk"><input type="checkbox" data-k="showValue" ${st.showValue !== false ? 'checked' : ''}> Measurement</label></div>`;
  return h + '</div>';
}
const fmtStyle = (k, v) => /opacity/i.test(k) ? Math.round(v * 100) + '%' : String(+(+v).toFixed(1));
function bindStyle(root, set) {   // set(key, value, final)
  root.querySelectorAll('[data-k]').forEach(el => {
    const k = el.dataset.k;
    const val = () => el.type === 'checkbox' ? el.checked : el.dataset.v ?? (el.type === 'range' || el.type === 'number' ? parseFloat(el.value) : el.value);
    if (el.tagName === 'BUTTON') { el.onclick = () => set(k, val(), true); return; }
    el.oninput = () => { const o = el.parentElement.querySelector('output') || el.closest('.sg')?.querySelector('output'); if (o) o.textContent = fmtStyle(k, val()) + (k === 'width' || k === 'fs' ? ' pt' : k === 'head' || k === 'hscale' ? '×' : k === 'pad' ? '× size' : ''); if (el.type === 'range' || el.type === 'color') set(k, val(), false); };
    el.onchange = () => set(k, val(), true);
  });
}
let styleUndo = false;
function styleSetter(ms, scope) {   // scope 'product': change the product's look (all its markups, OST "condition" style); else these markups only
  return (k, v, final) => {
    if (scope === 'asm') {
      const as = [...new Set(ms.map(asmOf).filter(Boolean))];
      if (!styleUndo) { pushUndo(); styleUndo = true; }
      for (const a of as) { a.style = { ...(a.style || {}), [k]: v }; for (const m of S.project.markups) if (m.asm === a.id && m.style && k in m.style) { delete m.style[k]; if (!Object.keys(m.style).length) delete m.style; } }
      renderOverlay();
      if (final) { styleUndo = false; saveAsms(); touch(); refreshPanel(); renderDock(true); }
      return;
    }
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
S.dockTab = ['props', 'fx', 'prod', 'scale', 'print', 'draw', 'asm'].includes(UI.dockTab) ? UI.dockTab : 'fx';
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
  const key = [S.dockTab, [...S.sel].join(','), S.activeProductId, S.tool, S.dockNew ? 'n' : '', S.calib ? 'c' : '', S.project?.id, S.docId, S.pageNum, S.styleScope, S.fxScope, S.dockTab === 'draw' ? (S.drawing?.pts.length ? 1 : 0) + ':' + (curScale()?.ftPerPt || '') : '', S.dockTab === 'asm' ? (S.asmView || '') + ':' + (S.asmEdit || '') : ''].join('|');
  if (!force && key === dockKey && body.contains(document.activeElement)) { dockLive(); return; }
  dockKey = key; dockLive = () => { };
  ({ props: dockProps, fx: dockFx, prod: dockProd, scale: dockScale, print: dockPrint, draw: dockDraw, asm: dockAsm })[S.dockTab](body);
  const ms = selMarks(), ctx = $('#dockCtx');
  ctx.textContent = ms.length > 1 ? `${ms.length} selected` : ms.length ? `Selected: ${markName(ms[0])}${ms[0].label ? ' · ' + ms[0].label : ''}` : isAnnTool(S.tool) || isDraftTool(S.tool) || isAsmTool(S.tool) ? `Tool: ${NOTE_NAMES[S.tool] || ASM_TOOL_NAMES[S.tool] || 'Wall'}${S.tool === 'wall' && asmById(UI.wallAsm) ? ' · ' + asmById(UI.wallAsm).name : ''}` : prodById(S.activeProductId) ? `Next: ${prodById(S.activeProductId).name}` : '';
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
  const m = ms[0], one = ms.length === 1, allQty = ms.every(isQty), hasProd = allQty && ms.some(x => prodById(x.productId)), hasAsm = allQty && ms.some(x => asmOf(x));
  const scope = (S.styleScope === 'product' && hasProd) || (S.styleScope === 'asm' && hasAsm) ? S.styleScope : 'markup';
  const kinds = new Set(ms.map(x => isQty(x) ? x.type : x.kind));
  const F = kinds.size === 1 ? fieldsFor(m) : ['color', 'opacity'];
  const st = styleOf(m);
  let h = '<div class="dgrid"><div class="dcol">';
  if (one && isQty(m)) {
    const g = geo(m), p = prodById(m.productId), q = p ? qtyFor(m, p) : null;
    h += `<div class="big-val">${esc(valueText(m).split(' · ')[0])}</div>
      ${m.type === 'area' && !g.noscale ? `<div class="muted small">Perimeter ${fmtFtIn(g.lf)} (${fmtN(g.lf)} LF)</div>` : ''}
      ${p && q != null ? `<div class="small">Counts as <b>${fmtQty(q, p.unit)} ${esc(p.unit)}</b> of ${esc(p.name)}</div>` : asmOf(m) ? (() => { const B = asmBreakdown(m); return `<div class="small">${ASM_KINDS[asmOf(m).kind]}: <b>${esc(asmOf(m).name)}</b>${B ? ` · ${fmt$(B.total)} (material ${fmt$(B.mat)}, labor ${fmt$(B.labor)})` : ''} <button class="small" data-goto="asm">Breakdown</button></div>`; })() : `<div class="small muted">${p ? '' : 'No product yet: pick one in the Product tab below or the Product box at the top.'}</div>`}
      <label class="field"><span>Label</span><input id="sLabel" value="${esc(m.label)}" placeholder="e.g. Kitchen north wall"></label>
      ${m.wall ? wallPresetHTML(m.wall, 'pw') : ''}
      ${m.type === 'length' ? `<label class="field"><span>${m.wall ? 'Wall height ft (area = LF × height)' : 'Wall height ft (turns length into SF)'}</span><input id="sHeight" inputmode="decimal" value="${m.height || ''}" placeholder="e.g. 9"></label>` : ''}
      <div class="actions">${m.type === 'count' ? '<button class="small" id="sAddCount">+ Add to this count</button>' : ''}<button class="small" data-goto="fx">ƒx Formula</button><button class="small danger" id="sDel">Delete</button></div>`;
  } else if (one) {
    h += `<div class="dhead"><b>${NOTE_NAMES[m.kind]}</b><span class="muted small">${DRAFT_KINDS[m.kind] ? 'Plan linework' : 'Drawing note'}: prints on the drawing, never counts in quantities.${m.kind === 'dim' ? ' Reads ' + esc(dimText(m)) + '.' : ''}</span></div>
      ${m.kind === 'text' || m.kind === 'callout' ? `<label class="field"><span>Text</span><textarea id="sText" rows="2">${esc(m.text)}</textarea></label>` : ''}
      ${m.kind === 'opening' ? `<div class="fxRow"><select id="opT"><option value="door" ${m.ot !== 'window' ? 'selected' : ''}>Door</option><option value="window" ${m.ot === 'window' ? 'selected' : ''}>Window</option></select><label class="sg"><span>Width</span><input id="opW" value="${esc(fmtFtIn(+m.ow))}" style="width:64px"></label><label class="sg"><span>Height</span><input id="opH" value="${esc(fmtFtIn(+m.oh))}" style="width:64px"></label><button class="small" id="opF">⇅ Flip swing</button></div><div class="muted small">${fmtN(m.ow * m.oh)} SF off ${(() => { const w = S.project.markups.find(x => x.id === m.wallId); return w ? esc(markName(w)) : 'no wall (deleted)'; })()}. Drag it to slide along the wall.</div>` : ''}
      <label class="field"><span>Label (shows in the markup list)</span><input id="sLabel" value="${esc(m.label)}" placeholder="optional"></label>
      <div class="actions"><button class="small danger" id="sDel">Delete</button></div>`;
  } else {
    h += `<div class="dhead"><b>${ms.length} selected</b><span class="muted small">Style changes apply to all of them. Drag one to move them all.</span></div><div class="actions"><button class="small danger" id="sDel">Delete ${ms.length}</button></div>`;
  }
  h += `</div><div class="dcol grow">${hasProd || hasAsm ? `<div class="seg" role="group" aria-label="Apply style to"><button type="button" data-scope="markup" class="${scope === 'markup' ? 'on' : ''}">This markup</button>${hasProd ? `<button type="button" data-scope="product" class="${scope === 'product' ? 'on' : ''}">Whole product</button>` : ''}${hasAsm ? `<button type="button" data-scope="asm" class="${scope === 'asm' ? 'on' : ''}">Whole ${m.wall ? 'wall type' : 'assembly'}</button>` : ''}</div>` : ''}${styleHTML(st, F, m.kind || m.type)}</div></div>`;
  body.innerHTML = h;
  bindStyle(body.querySelector('.dcol.grow'), styleSetter(ms, scope));
  body.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { S.styleScope = b.dataset.scope; renderDock(true); });
  body.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => setDockTab(b.dataset.goto));
  const lab = body.querySelector('#sLabel'); if (lab) lab.onchange = () => { pushUndo(); m.label = lab.value.trim(); touch(); renderOverlay(); refreshPanel(); };
  if (m.wall) bindWallPreset(body, 'pw', w => { pushUndo(); m.wall = w; touch(); renderOverlay(); refreshPanel(); renderDock(true); });
  const hEl = body.querySelector('#sHeight'); if (hEl) hEl.onchange = () => { pushUndo(); const v = num(hEl.value, 0); m.height = v > 0 ? v : null; touch(); renderOverlay(); refreshPanel(); renderDock(true); };
  const tx = body.querySelector('#sText'); if (tx) { let u = false; tx.oninput = () => { if (!u) { pushUndo(); u = true; } m.text = tx.value; renderOverlay(); }; tx.onchange = () => { u = false; touch(); refreshPanel(); }; }
  const del = body.querySelector('#sDel'); if (del) del.onclick = () => one ? deleteMarkup(m.id) : deleteSelected();
  if (m.kind === 'opening') { const re = () => { touch(); renderOverlay(); refreshPanel(); renderDock(true); };
    body.querySelector('#opT').onchange = e => { pushUndo(); m.ot = e.target.value; re(); };
    for (const [id, f] of [['#opW', 'ow'], ['#opH', 'oh']]) body.querySelector(id).onchange = e => { const v = parseFtIn(e.target.value); if (!(v > 0)) return toast('Size like 3\' or 2\'8"'); pushUndo(); m[f] = +v.toFixed(4); re(); };
    body.querySelector('#opF').onclick = () => { pushUndo(); m.flip = !m.flip; re(); }; }
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
  const { m, p } = dockTarget(), sq = selMarks().filter(isQty);
  const pick = `<label class="sg dpPick"><span>${m ? (sq.length > 1 ? `Product for ${sq.length} selected` : 'Product for ' + esc(markName(m))) : 'Draw with'}</span><select id="dpPick">${productOptions(m ? m.productId : S.activeProductId, S.products.length ? '— No product —' : '— No products yet —')}<option value="__new">＋ Add new product…</option></select></label>`;
  const dbl = m && m.productId && asmOf(m) ? `<p class="small warn">This ${m.wall ? 'wall' : 'markup'} also has the assembly “${esc(asmOf(m).name)}”. Both count in the estimate; clear one to avoid counting twice.</p>` : '';
  const bindPick = () => body.querySelector('#dpPick').onchange = e => {
    const v = e.target.value; if (v === '__new') { e.target.value = m ? m.productId || '' : S.activeProductId || ''; openNewProduct(); return; }
    if (m) { pushUndo(); for (const x of sq) { x.productId = v || null; x.color = v ? null : x.asm ? asmColor(asmById(x.asm) || {}) : x.wall ? '#333333' : TYPE_COLOR[x.type]; } touch(); renderOverlay(); refreshPanel(); markThumb(); refreshActiveProduct(); renderDock(true); toast(`${sq.length} markup${sq.length > 1 ? 's' : ''} → ${prodById(v)?.name || 'no product'}`); return; }
    S.activeProductId = v; S.countId = null; updateFinish(); refreshActiveProduct(); renderDock(true);
  };
  if (!p) { body.innerHTML = `<div class="dhead"><b>Product</b>${pick}<span class="muted small">${m ? 'No product on this ' + (m.wall ? 'wall' : 'markup') + ' yet: pick one here.' : 'No product picked. Pick one here or in the Product box at the top.'}</span><button class="small accent" id="npOpen">＋ New product</button></div>${dbl}`; bindPick(); body.querySelector('#npOpen').onclick = openNewProduct; return; }
  body.innerHTML = `<div class="dhead"><span class="sw" style="background:${p.color}"></span><b>${esc(p.name)}</b>${pick}<span class="muted small">Edits save as you go and apply everywhere this product is used.</span><button class="small" id="npOpen">＋ New product</button></div>${dbl}${productFormHTML(p)}`;
  bindPick(); bindProductForm(body, p); body.querySelector('#npOpen').onclick = openNewProduct;
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
    <label class="chk"><input type="checkbox" id="prLeg" ${UI.prLegend === false ? '' : 'checked'}> Quantity legend</label><label class="chk"><input type="checkbox" id="prGrid" ${UI.prGrid ? 'checked' : ''}> Print grid</label><button class="accent" id="prGo">🖨 Print drawing</button></div>`;
  body.querySelectorAll('[name=prW]').forEach(r => r.onchange = () => { UI.prAll = r.value === 'all' && r.checked; saveUI(); });
  body.querySelector('#prLeg').onchange = e => { UI.prLegend = e.target.checked; saveUI(); };
  body.querySelector('#prGrid').onchange = e => { UI.prGrid = e.target.checked; saveUI(); };
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
        <div class="pdBox"><img src="${url}" alt=""><svg class="mk" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${UI.prGrid ? gridSVG(zP, W, H, sc?.ftPerPt, `g${secs.length}-`, true) : ''}${markupsSVG(ms, zP, () => false, `p${secs.length}-`)}</svg></div>
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
