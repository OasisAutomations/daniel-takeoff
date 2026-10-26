// Daniel Takeoff v1.4: tiny, safe formula engine (no eval). Everything runs on this device.
// evaluate('ceil(Area/32)*2', { area: 480 }) -> 30
// Names are case-insensitive. Strings use 'single' or "double" quotes. A leading "=" is optional.
const LEN = { in: 1 / 12, ft: 1, yd: 3, mm: 1 / 304.8, cm: 1 / 30.48, m: 1 / 0.3048, lf: 1 };
const AREA = { sf: 1, sy: 9, sq: 100, m2: 10.7639104167, ac: 43560, sqin: 1 / 144 };
export function conv(v, from, to) {
  from = String(from).toLowerCase(); to = String(to).toLowerCase();
  for (const T of [LEN, AREA]) if (from in T && to in T) return v * T[from] / T[to];
  throw new Error(`Can't convert ${from} to ${to}`);
}
const MATH = {
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, sqrt: Math.sqrt, pow: Math.pow, min: Math.min, max: Math.max,
  round: (x, d = 0) => { const k = Math.pow(10, d); return Math.round(x * k) / k; },
  mod: (a, b) => a % b,
  if: (c, a, b) => (c ? a : b),
  ceilto: (x, step) => Math.ceil(x / step - 1e-9) * step,    // round UP to a step, e.g. ceilTo(Length, 8) for 8' stock
  floorto: (x, step) => Math.floor(x / step + 1e-9) * step,
  clamp: (x, a, b) => Math.min(b, Math.max(a, x)),
  sum: (...a) => a.reduce((s, v) => s + v, 0),
  conv,
};
const CONST = { pi: Math.PI };
function tokenize(src) {
  const t = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    if ((m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i)))) { t.push({ k: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)))) { t.push({ k: 'id', v: m[0].toLowerCase() }); i += m[0].length; continue; }
    if (c === '"' || c === "'") { const j = src.indexOf(c, i + 1); if (j < 0) throw new Error('Missing closing quote'); t.push({ k: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
    if ('+-*/^%(),<>'.includes(c)) { t.push({ k: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected "${c}"`);
  }
  return t;
}
export function evaluate(src, scope = {}, funcs = {}) {
  src = String(src ?? '').trim().replace(/^=/, '').trim();
  if (!src) throw new Error('Empty formula');
  const vars = {}; for (const k of Object.keys(scope)) vars[k.toLowerCase()] = scope[k];
  const fns = { ...MATH }; for (const k of Object.keys(funcs)) fns[k.toLowerCase()] = funcs[k];
  const T = tokenize(src); let p = 0;
  const peek = () => T[p], isOp = v => T[p] && T[p].k === 'op' && T[p].v === v;
  const eat = v => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };
  const startsOperand = t => t && (t.k === 'num' || t.k === 'id' || t.k === 'str' || (t.k === 'op' && (t.v === '(' || t.v === '-')));
  const num = x => { if (typeof x === 'boolean') return x ? 1 : 0; if (typeof x !== 'number') throw new Error('Expected a number'); return x; };
  function or() { let a = and(); while (isOp('||')) { p++; const b = and(); a = (num(a) || num(b)) ? 1 : 0; } return a; }
  function and() { let a = cmp(); while (isOp('&&')) { p++; const b = cmp(); a = (num(a) && num(b)) ? 1 : 0; } return a; }
  function cmp() {
    let a = add();
    const t = peek();
    if (t && t.k === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(t.v)) {
      p++; const b = add(); a = num(a); const bb = num(b);
      return ({ '<': a < bb, '>': a > bb, '<=': a <= bb, '>=': a >= bb, '==': a === bb, '!=': a !== bb }[t.v]) ? 1 : 0;
    }
    return a;
  }
  function add() { let a = mul(); while (isOp('+') || isOp('-')) { const o = T[p++].v; const b = mul(); a = o === '+' ? num(a) + num(b) : num(a) - num(b); } return a; }
  function mul() {
    let a = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) { const o = T[p++].v; const b = unary(); a = o === '*' ? num(a) * num(b) : num(a) / num(b); }
      else if (isOp('%') && startsOperand(T[p + 1])) { p++; const b = unary(); a = num(a) % num(b); }   // modulo
      else break;
    }
    return a;
  }
  function unary() { if (isOp('-')) { p++; return -num(unary()); } if (isOp('+')) { p++; return num(unary()); } return pow(); }
  function pow() { let a = post(); if (isOp('^')) { p++; a = Math.pow(num(a), num(unary())); } return a; }
  function post() { let a = primary(); if (isOp('%') && !startsOperand(T[p + 1])) { p++; a = num(a) / 100; } return a; }   // 10% -> 0.1
  function primary() {
    const t = T[p++]; if (!t) throw new Error('Formula ends too soon');
    if (t.k === 'num') return t.v;
    if (t.k === 'str') return t.v;
    if (t.k === 'op' && t.v === '(') { const v = or(); eat(')'); return v; }
    if (t.k === 'id') {
      if (isOp('(')) {
        p++; const args = [];
        if (!isOp(')')) { for (;;) { args.push(or()); if (isOp(',')) { p++; continue; } break; } }
        eat(')');
        const f = fns[t.v]; if (!f) throw new Error(`Unknown function ${t.v}()`);
        return f(...args);
      }
      if (t.v in vars) return vars[t.v];
      if (t.v in CONST) return CONST[t.v];
      throw new Error(`Unknown name "${t.v}"`);
    }
    throw new Error(`Unexpected "${t.v}"`);
  }
  const out = or();
  if (p < T.length) throw new Error(`Unexpected "${T[p].v}"`);
  const n = num(out);
  if (!isFinite(n)) throw new Error('Result is not a finite number (divide by zero?)');
  return n;
}
export const SAMPLE_VARS = { length: 10, area: 100, perimeter: 40, count: 4, height: 8, qty: 10, mult: 1, lf: 10, sf: 100, ea: 4 };
export const PRESETS = [
  ['Drywall sheets (4×8)', 'ceil(Area / 32)'],
  ['Wall SF from length × height', 'Length * Height'],
  ['Wall SF, minus 2 doors (21 SF each)', 'Length * Height - Count * 21'],
  ['Paint gallons (350 SF/gal, 2 coats)', 'Area * 2 / 350'],
  ['Studs @ 16" o.c. (+1)', 'ceil(Length * 12 / 16) + 1'],
  ['Baseboard 8\' pieces', 'ceil(Length / 8)'],
  ['Flooring boxes (20 SF/box)', 'ceil(Area / 20)'],
  ['Square yards from SF', 'conv(Area, "sf", "sy")'],
  ['Roofing squares', 'conv(Area, "sf", "sq")'],
  ['3 hinges per door', 'Count * 3'],
  ['Cabinet door/drawer fronts from LF (avg 18")', 'ceil(Length / 1.5)'],
];
export const HELP_HTML = `
<p class="small">A formula turns what you measured into the quantity you buy. Type it in a product's <b>Quantity formula</b> box (runs for every markup that uses the product),
or start a manual estimate line's quantity with <b>=</b> to calculate it from other lines. Leave it blank for the normal measured × multiplier.</p>
<table class="grid fx"><tr><th>Name</th><th>Meaning</th></tr>
<tr><td><code>Length</code> (or <code>LF</code>)</td><td>Feet of the line. For an area this is the perimeter.</td></tr>
<tr><td><code>Area</code> (or <code>SF</code>)</td><td>Square feet. For a wall (length with a height) it's length × height.</td></tr>
<tr><td><code>Perimeter</code></td><td>Perimeter in feet (areas and lengths).</td></tr>
<tr><td><code>Count</code> (or <code>EA</code>)</td><td>Number of items in a count. A length or area counts as 1.</td></tr>
<tr><td><code>Height</code></td><td>Wall height you typed on the markup (0 if none).</td></tr>
<tr><td><code>Qty</code>, <code>Mult</code></td><td>The default quantity (measured × multiplier) and the product's multiplier.</td></tr>
</table>
<p class="small"><b>Math:</b> + − × / ^ ( ), percent like <code>10%</code>. <b>Functions:</b> ceil floor round(x, digits) abs sqrt pow min max mod if(test, a, b)
ceilTo(x, step) floorTo(x, step) clamp(x, lo, hi) sum(…) conv(value, "from", "to"). <b>Units for conv:</b> in ft yd mm cm m lf · sf sy sq (roofing square) m2 ac.</p>
<p class="small"><b>Estimate lines</b> (manual line quantity starting with =): <code>Q("Drywall")</code> measured quantity of a line, <code>QW("Drywall")</code> with waste,
<code>N("Drywall")</code> how many markups. Match by name (a unique part of the name works). Example: <code>=ceil(QW("Drywall 4x8") / 40)</code></p>
<p class="small">Waste % is added after the formula, as before. Nothing here is uploaded.</p>`;
