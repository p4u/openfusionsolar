// The `calculate` tool (spec 3.6 step 8): numbers, + - * / and parentheses, read by a hand-written recursive-descent
// parser (no eval). Every literal must be in the grounded set G (same rounding rule as the answer check) or one of the
// fixed constants, so arithmetic only ever starts from figures the model was given.
import { isGrounded } from './grounding.js';

export const CONSTANTS = [2, 7, 12, 24, 60, 100, 365, 1000];
const MAX_LEN = 200;

export class CalcError extends Error {}
const fail = (m) => { throw new CalcError(m); };

function tokens(expr) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([-+*/()]))/y;
  let i = 0;
  while (i < expr.length) {
    re.lastIndex = i;
    const m = re.exec(expr);
    if (!m) {
      if (/^\s*$/.test(expr.slice(i))) break;
      const c = expr.slice(i).trim()[0];
      fail(c === ',' ? 'use a dot for decimals and no thousands separator' : `unexpected character ${JSON.stringify(c)}`);
    }
    out.push(m[1] != null ? { num: m[1] } : { op: m[2] });
    i = re.lastIndex;
  }
  return out;
}

// expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := ('-'|'+') factor | number | '(' expr ')'
export function calculate(expr, G) {
  if (typeof expr !== 'string' || !expr.trim()) fail('expr must be a non-empty string');
  if (expr.length > MAX_LEN) fail(`expr is too long: at most ${MAX_LEN} characters`);
  const ts = tokens(expr);
  let p = 0;
  const peek = () => ts[p];
  const literal = (s) => {
    const d = s.includes('.') ? s.split('.')[1].length : 0;
    const value = Number(s);
    if (!CONSTANTS.includes(value) && !isGrounded({ unit: null, readings: [{ value, d }] }, G)) {
      fail(`${s} is not a figure from this conversation turn: use numbers exactly as the tools gave them`);
    }
    return value;
  };
  function factor(depth) {
    if (depth > 50) fail('expr is nested too deeply');
    const t = ts[p++];
    if (!t) fail('expr ends too early');
    if (t.op === '-') return -factor(depth + 1);
    if (t.op === '+') return factor(depth + 1);
    if (t.num != null) return literal(t.num);
    if (t.op === '(') {
      const v = sum(depth + 1);
      if (ts[p++]?.op !== ')') fail('a parenthesis is not closed');
      return v;
    }
    return fail(`unexpected ${t.op}`);
  }
  function product(depth) {
    let v = factor(depth);
    while (peek()?.op === '*' || peek()?.op === '/') {
      const op = ts[p++].op;
      const r = factor(depth);
      if (op === '/' && r === 0) fail('division by zero');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function sum(depth) {
    let v = product(depth);
    while (peek()?.op === '+' || peek()?.op === '-') {
      const op = ts[p++].op;
      const r = product(depth);
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const v = sum(0);
  if (p < ts.length) fail(`unexpected ${ts[p].op ?? ts[p].num}`);
  if (!Number.isFinite(v)) fail('the result is not a finite number');
  return { expr, value: Math.round(v * 100) / 100 + 0, rounded: Math.round(v) + 0 };
}
