// Daniel Takeoff — Voice Estimator parser. 100% local: no servers, no AI APIs.
// parseSpeech(text) -> items; propose(text, products) -> rows with matched product + qty/unit.

const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD_FRAC = { half: 2, halves: 2, third: 3, thirds: 3, quarter: 4, quarters: 4, fourth: 4, fourths: 4, eighth: 8, eighths: 8, sixteenth: 16, sixteenths: 16 };
const UNITS = new Set(['ft', 'in', 'lf', 'sf', 'sy', 'ea']);
const STOP = new Set('of the a an about around roughly approximately approx some we i need needs want add get have got um uh like and with for to on total worth more another also please ok okay so lets let us put give me it is there are be will maybe just our my at that this those these then plus another of\'s gonna going call say do make roughly'.split(/\s+/));
const SYN = {
  uppers: 'upper', upper: 'upper', wall: 'upper',
  lowers: 'base', lower: 'base', base: 'base', bases: 'base',
  counter: 'countertop', counters: 'countertop', countertop: 'countertop', countertops: 'countertop', top: 'countertop', tops: 'countertop',
  shelf: 'shelf', shelves: 'shelf', shelving: 'shelf', shelfs: 'shelf',
  sheetrock: 'drywall', gypsum: 'drywall', drywall: 'drywall', gyp: 'drywall',
  cab: 'cabinet', cabs: 'cabinet', cabinets: 'cabinet', cabinetry: 'cabinet',
  pull: 'pull', pulls: 'pull', handle: 'pull', handles: 'pull',
  knobs: 'knob', hinges: 'hinge', drawers: 'drawer', doors: 'door', rods: 'rod',
  moulding: 'molding', mouldings: 'molding', moldings: 'molding',
};

export function stem(w) {
  w = String(w).toLowerCase();
  if (SYN[w]) return SYN[w];
  if (/^\d/.test(w)) return w;
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && /(sses|xes|ches|shes)$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.length > 6 && s.endsWith('ing')) s = s.slice(0, -3);
  return SYN[s] || s;
}

function normalize(text) {
  let t = ' ' + String(text || '').toLowerCase() + ' ';
  t = t.replace(/[’‘`]/g, "'").replace(/[“”″]/g, '"').replace(/′/g, "'");
  t = t.replace(/(\d),(\d{3})/g, '$1$2');
  t = t.replace(/(\d)\s*(?:'|ft\.?)\s*-?\s*(\d+(?:\.\d+)?)\s*(?:"|in\.?|inch(?:es)?)?(?=[\s,;.]|$)/g, '$1 ft $2 in ');   // 12'6"  12' 6
  t = t.replace(/(\d)\s*"/g, '$1 in ').replace(/(\d)\s*'/g, '$1 ft ');
  t = t.replace(/(\d)\s*[x×]\s*(\d)/g, '$1 by $2');
  t = t.replace(/(\w)-(\w)/g, '$1 $2');
  t = t.replace(/\bsquare\s+(?:feet|foot|ft)\b|\bsq\.?\s*(?:ft|feet|foot)\.?|\bsqft\b|\bs\.f\.|\bsf\b/g, ' sf ');
  t = t.replace(/\bsquare\s+yards?\b|\bsq\.?\s*yds?\.?|\bsy\b/g, ' sy ');
  t = t.replace(/\b(?:linear|lineal|running)\s+(?:feet|foot|ft)\b|\blin\.?\s*(?:ft|feet)\.?|\bl\.f\.|\blf\b/g, ' lf ');
  t = t.replace(/\b(?:feet|foot|ft)\b\.?/g, ' ft ');
  t = t.replace(/\b(?:inches|inch)\b/g, ' in ');
  t = t.replace(/(\d)\s*in\b\.?/g, '$1 in ');
  t = t.replace(/\b(?:each|ea|pieces?|pcs?|qty|count|units?)\b/g, ' ea ');
  t = t.replace(/\b(?:by|times)\b/g, ' by ');
  return t;
}
function tokenize(t) { return t.match(/\d+(?:\.\d+)?(?:\/\d+)?|[a-z]+(?:'[a-z]+)?|[,;]|\.(?!\d)/g) || []; }

const isNumWord = w => w in SMALL || w in TENS || w === 'hundred' || w === 'thousand' || w === 'dozen' || w === 'couple' || w === 'pair' || w === 'half';
const isNumStart = (tok, next) => /^\d/.test(tok || '') || (tok && (tok in SMALL || tok in TENS || tok === 'half')) || ((tok === 'a' || tok === 'an') && next && (next === 'dozen' || next === 'couple' || next === 'pair' || next === 'half' || /^\d/.test(next) || next in SMALL || next in TENS));

// parse a number starting at i; returns {v, j} or null
function parseNum(T, i) {
  let j = i, v = null;
  const t = T[j];
  if (t === undefined) return null;
  if (/^\d/.test(t)) {
    if (t.includes('/')) { const [a, b] = t.split('/').map(Number); v = b ? a / b : 0; j++; }
    else { v = parseFloat(t); j++; if (T[j] && /^\d+\/\d+$/.test(T[j])) { const [a, b] = T[j].split('/').map(Number); if (b) v += a / b; j++; } }
  } else if ((t === 'a' || t === 'an') && T[j + 1] && /^(dozen|couple|pair|half)$/.test(T[j + 1])) { v = 1; j++; if (T[j] === 'couple' || T[j] === 'pair') { v = 2; j++; if (T[j] === 'of') j++; return { v, j }; } if (T[j] === 'half') { v = 0.5; j++; return { v, j }; } }
  else if ((t === 'a' || t === 'an') && T[j + 1] && (/^\d/.test(T[j + 1]) || T[j + 1] in SMALL || T[j + 1] in TENS)) { return { v: 1, j: j + 1, article: true }; }
  else if (t === 'couple' || t === 'pair') { v = 2; j++; if (T[j] === 'of') j++; return { v, j }; }
  else if (t === 'half') { j++; if (T[j] === 'a' || T[j] === 'an') j++; return { v: 0.5, j }; }
  else if (t in SMALL || t in TENS) {
    let total = 0, cur = 0, any = false;
    while (j < T.length) {
      const w = T[j];
      const lo = cur % 100;
      if (w in SMALL) { if (any && (lo % 10 !== 0 || (lo >= 10 && lo < 20) || (lo >= 20 && SMALL[w] >= 10))) break; cur += SMALL[w]; any = true; j++; }   // "two thirty" = 2, 30 (not 32)
      else if (w in TENS) { if (any && lo !== 0) break; cur += TENS[w]; any = true; j++; }
      else if (w === 'hundred' && any) { cur = (cur || 1) * 100; j++; }
      else if (w === 'thousand' && any) { total += (cur || 1) * 1000; cur = 0; j++; }
      else if (w === 'and' && any && (T[j - 1] === 'hundred' || T[j - 1] === 'thousand') && T[j + 1] && (T[j + 1] in SMALL || T[j + 1] in TENS)) j++;
      else break;
    }
    v = total + cur;
    // "point five"
    if (T[j] === 'point' && T[j + 1] && (T[j + 1] in SMALL || /^\d+$/.test(T[j + 1]))) { j++; let ds = ''; while (T[j] && (T[j] in SMALL && SMALL[T[j]] < 10 || /^\d+$/.test(T[j]))) { ds += T[j] in SMALL ? SMALL[T[j]] : T[j]; j++; } v = parseFloat(v + '.' + ds); }
    // "three quarters", "one half" as fraction
    if (T[j] in ORD_FRAC && v > 0 && v < ORD_FRAC[T[j]]) { v = v / ORD_FRAC[T[j]]; j++; }
  } else return null;
  // "and a half", "and three quarters"
  if (T[j] === 'and' && (T[j + 1] === 'a' || T[j + 1] === 'an') && T[j + 2] in ORD_FRAC) { v += 1 / ORD_FRAC[T[j + 2]]; j += 3; }
  else if (T[j] === 'and' && T[j + 1] in SMALL && T[j + 2] in ORD_FRAC) { v += SMALL[T[j + 1]] / ORD_FRAC[T[j + 2]]; j += 3; }
  if (T[j] === 'dozen') { v *= 12; j++; if (T[j] === 'of') j++; }
  return { v, j };
}

function segments(T) {
  const out = []; let cur = [];
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const split = t === ',' || t === ';' || t === '.' || t === 'plus' || t === 'also' || t === 'then' || t === 'next'
      || (t === 'and' && !/^(hundred|thousand)$/.test(T[i - 1] || '') && !((T[i + 1] === 'a' || T[i + 1] === 'an') && T[i + 2] in ORD_FRAC) && !(T[i + 1] in SMALL && T[i + 2] in ORD_FRAC) && isNumStart(T[i + 1], T[i + 2]));
    if (split) { if (cur.length) out.push(cur); cur = []; } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

const fmtSize = (v, u) => (Math.round(v * 1000) / 1000) + (u === 'in' ? 'in' : 'ft');

function parseSegment(T) {
  const meas = [], words = [], dims = []; let byArea = null;
  for (let i = 0; i < T.length;) {
    const n = parseNum(T, i);
    if (n) {
      let j = n.j, unit = null, v = n.v;
      if (n.article) { meas.push({ v: 1, unit: null, of: false, article: true }); i = j; continue; }
      if (UNITS.has(T[j])) {
        unit = T[j]; j++;
        if (unit === 'ft') { const m2 = parseNum(T, j); if (m2 && (T[m2.j] === 'in' || !T[m2.j] || T[m2.j] === 'of' || (!UNITS.has(T[m2.j]) && T[m2.j] !== 'by' && m2.v < 12 && T[m2.j] !== 'ft'))) { if (T[m2.j] === 'in') { v += m2.v / 12; j = m2.j + 1; } else if (m2.v < 12 && T[m2.j] === 'of') { v += m2.v / 12; j = m2.j; } } }
      }
      // N by M  -> area
      if (T[j] === 'by') {
        const m2 = parseNum(T, j + 1);
        if (m2) {
          let k = m2.j, u2 = unit, b = m2.v; if (UNITS.has(T[k])) { u2 = T[k]; k++; }
          const a = unit === 'in' ? v / 12 : v, bb = u2 === 'in' ? b / 12 : b;
          byArea = { sf: a * bb, label: `${fmtSize(v, unit || 'ft')} x ${fmtSize(b, u2 || 'ft')}` }; i = k; continue;
        }
      }
      meas.push({ v, unit, of: T[j] === 'of', at: words.length }); i = j; continue;
    }
    if (UNITS.has(T[i])) { if (!meas.length) meas.push({ v: 1, unit: T[i], of: T[i + 1] === 'of', implied: true }); i++; continue; }  // "linear feet of crown" without a number
    words.push(T[i]); i++;
  }
  const item = words.filter(w => !STOP.has(w));
  const heard = T.join(' ').replace(/ ([,;.])/g, '$1');
  let qty = null, unit = null, count = null, sizeFt = null;
  const toUnit = u => ({ ft: 'LF', lf: 'LF', sf: 'SF', sy: 'SY', ea: 'EA', in: 'LF' }[u] || 'EA');
  let m0 = meas[0], m1 = meas[1];
  if (byArea) {
    const c = m0 && !m0.unit ? m0.v : 1; qty = byArea.sf * c; unit = 'SF'; dims.push(byArea.label);
  } else if (!m0) {
    qty = null; unit = null;
  } else if (!m0.unit || m0.unit === 'ea') {
    count = m0.v; qty = m0.v; unit = 'EA';
    if (m1 && (m1.unit === 'in' || m1.unit === 'ft')) { sizeFt = m1.unit === 'in' ? m1.v / 12 : m1.v; dims.push(fmtSize(m1.v, m1.unit)); if (m1.of) { qty = count * sizeFt; unit = 'LF'; count = null; } }
    else if (m1 && (m1.unit === 'sf' || m1.unit === 'lf' || m1.unit === 'sy')) { qty = m0.v * m1.v; unit = toUnit(m1.unit); count = null; }
  } else if (m0.unit === 'in') {
    if (m0.of || !item.length || m0.at >= item.length) { qty = m0.v / 12; unit = 'LF'; }
    else { count = 1; qty = 1; unit = 'EA'; sizeFt = m0.v / 12; dims.push(fmtSize(m0.v, 'in')); }
  } else { qty = m0.v; unit = toUnit(m0.unit); }
  if (qty != null) qty = Math.round(qty * 10000) / 10000;
  return { heard, words: item, dims, qty, unit, count, sizeFt };
}

export function parseSpeech(text) {
  return segments(tokenize(normalize(text))).map(parseSegment).filter(s => s.words.length || s.qty != null);
}

/* ---------- fuzzy product matching ---------- */
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function sim(a, b) {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.5 + 0.4 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (a.length < 4 || b.length < 4) return 0;
  const r = 1 - lev(a, b) / Math.max(a.length, b.length);
  return r >= 0.7 ? r * 0.9 : 0;
}
const DIM_RE = /^(\d+(?:\.\d+)?)(in|ft)$/;
function prodTokens(s) {
  const n = normalize(s).replace(/(\d+(?:\.\d+)?) (in|ft)\b/g, '$1$2');
  return (n.match(/\d+(?:\.\d+)?(?:in|ft)|[a-z]+|\d+/g) || []).filter(w => !STOP.has(w) && !UNITS.has(w)).map(stem);
}
export function scoreProduct(item, p) {
  const words = item.words.map(stem).filter(w => !/^\d+$/.test(w));
  if (!words.length) return 0;
  const nameT = prodTokens(p.name), catT = prodTokens(p.category || '');
  let sum = 0, usedName = new Set();
  for (const w of words) {
    let best = 0, bi = -1;
    nameT.forEach((t, i) => { const s = sim(w, t); if (s > best) { best = s; bi = i; } });
    for (const t of catT) best = Math.max(best, sim(w, t) * 0.6);
    if (bi >= 0 && best === sim(w, nameT[bi])) usedName.add(bi);
    sum += best;
  }
  const nonDimName = nameT.filter(t => !DIM_RE.test(t));
  let score = 0.75 * (sum / words.length) + 0.25 * (nonDimName.length ? [...usedName].filter(i => !DIM_RE.test(nameT[i])).length / nonDimName.length : 0);
  // size in the name ("30in upper") must agree with what was said
  const dimsSaid = item.dims.map(d => d.replace(/\.0+(in|ft)$/, '$1'));
  const nameDims = nameT.filter(t => DIM_RE.test(t));
  if (nameDims.length && dimsSaid.length) score += nameDims.some(d => dimsSaid.includes(d)) ? 0.15 : -0.2;
  const pu = String(p.unit || '').toUpperCase();
  if (item.unit && pu === item.unit) score += 0.08;
  else if (item.unit && item.count != null && item.sizeFt && pu === 'LF') score += 0.04;
  return Math.round(score * 1000) / 1000;
}
export function matchProduct(item, products, threshold = 0.55) {
  const ranked = products.map(p => ({ p, s: scoreProduct(item, p) })).sort((a, b) => b.s - a.s);
  return ranked[0] && ranked[0].s >= threshold ? ranked[0] : null;
}
// qty/unit for a chosen product (handles "two 36 inch bases" priced per LF, multipliers, etc.)
export function resolveQty(item, p) {
  let qty = item.qty, unit = item.unit, warn = '';
  if (!p) return { qty, unit: unit || 'EA', warn: qty == null ? 'No quantity heard' : '' };
  const pu = String(p.unit || 'EA').toUpperCase(), mult = p.mult > 0 ? p.mult : 1;
  if (qty == null) return { qty: null, unit: pu, warn: 'No quantity heard' };
  if (pu === unit) return { qty, unit, warn };
  if (pu === 'LF' && item.count != null && item.sizeFt) return { qty: Math.round(item.count * item.sizeFt * 10000) / 10000, unit: 'LF', warn: '' };
  if (!['LF', 'SF', 'EA'].includes(pu) && mult !== 1) return { qty: Math.round(qty * mult * 10000) / 10000, unit: pu, warn: '' };
  return { qty, unit: pu, warn: `Heard ${unit}, but this product is priced per ${pu}` };
}
export function propose(text, products) {
  return parseSpeech(text).map(it => {
    const m = matchProduct(it, products), r = resolveQty(it, m?.p || null);
    return { ...it, productId: m?.p.id || '', score: m?.s || 0, qty: r.qty, unit: r.unit, warn: m ? r.warn : 'No matching product', parsedQty: it.qty, parsedUnit: it.unit };
  });
}
