// Digit-editing math (SPEC §6.2/6.3). The "core feature": editing a number by
// adding/subtracting magnitude at a place value, not by setting glyphs — so
// carry/borrow and the sign are emergent properties of arithmetic on the
// underlying value. Pure + fully unit-tested; the device-side Lua mirrors it.
//
// All math is done in integer space scaled by 10^precision to avoid binary
// floating-point drift (e.g. 0.1 + 0.2).

export const WINDOW = 4;

export interface DigitMeta {
  precision: number; // fractional digits the field allows (>= 0)
  min?: number;
  max?: number;
}

export interface DigitState {
  value: number;
  /** Exponent (power of ten) of the left-most of the 4 active digits. */
  windowStart: number;
  precision: number;
  min?: number;
  max?: number;
}

const pow10 = (e: number): number => 10 ** e;

function round(value: number, precision: number): number {
  const s = pow10(precision);
  return Math.round((value + Number.EPSILON * Math.sign(value || 1)) * s) / s;
}

function clampRange(value: number, min?: number, max?: number): number {
  let v = value;
  if (typeof min === "number") {
    v = Math.max(min, v);
  }
  if (typeof max === "number") {
    v = Math.min(max, v);
  }
  return v;
}

/** Exponent of the most-significant digit of |value| (0 for |value| < 1). */
export function mostSignificantExponent(value: number): number {
  const a = Math.abs(value);
  if (a < 1 || !Number.isFinite(a)) {
    return 0;
  }
  return Math.floor(Math.log10(a) + 1e-9);
}

/** Smallest allowed windowStart so the window bottom never goes past
 *  -precision (the least-significant editable place). */
function minWindowStart(precision: number): number {
  return WINDOW - 1 - precision;
}

function maxWindowStart(value: number, precision: number): number {
  return Math.max(mostSignificantExponent(value), minWindowStart(precision));
}

function clampWindow(windowStart: number, value: number, precision: number): number {
  const lo = minWindowStart(precision);
  const hi = maxWindowStart(value, precision);
  return Math.min(hi, Math.max(lo, windowStart));
}

/** On entry the window sits on the four most-significant positions of the
 *  current value; for zero it defaults to ones..(precision) clamped. */
export function createDigitState(value: number, meta: DigitMeta): DigitState {
  const precision = Math.max(0, Math.floor(meta.precision));
  const v = round(clampRange(value, meta.min, meta.max), precision);
  const start = v === 0 ? 0 : mostSignificantExponent(v);
  return {
    value: v,
    windowStart: clampWindow(start, v, precision),
    precision,
    min: meta.min,
    max: meta.max
  };
}

/** Place-value exponent driven by knob 0..3 (0 = most significant). */
export function knobExponent(state: DigitState, knob: number): number {
  return state.windowStart - knob;
}

/**
 * Add `detents * 10^place` to the value (knob 0..3). Carry/borrow propagate
 * through the whole number (including positions outside the window) because
 * it is plain arithmetic; crossing zero flips the sign naturally. Clamped to
 * [min,max] when ranged.
 */
export function nudge(state: DigitState, knob: number, detents: number): DigitState {
  if (knob < 0 || knob >= WINDOW || detents === 0) {
    return state;
  }
  const delta = detents * pow10(knobExponent(state, knob));
  const next = round(clampRange(state.value + delta, state.min, state.max), state.precision);
  return {
    ...state,
    value: next,
    // Growth may expand the integer part; keep the window valid.
    windowStart: clampWindow(state.windowStart, next, state.precision)
  };
}

/** Pan the 4-wide window: + = toward more significant, − = less significant. */
export function zoom(state: DigitState, detents: number): DigitState {
  return {
    ...state,
    windowStart: clampWindow(state.windowStart + detents, state.value, state.precision)
  };
}

export function formatValue(value: number, precision: number): string {
  const p = Math.max(0, Math.floor(precision));
  // -0 → 0
  const v = value === 0 ? 0 : value;
  return v.toFixed(p);
}

export interface DisplayDigit {
  exponent: number;
  digit: number;
  active: boolean;
  /** 0..3 when this digit is on an active knob, else null. */
  knob: number | null;
}

export interface DigitDisplay {
  negative: boolean;
  digits: DisplayDigit[];
  /** Index in `digits` *after which* the decimal point sits, or null. */
  pointIndex: number | null;
}

function digitAt(absScaled: number, exponent: number, precision: number): number {
  // absScaled = round(|value| * 10^precision). Digit for 10^exponent.
  return Math.floor(absScaled / pow10(exponent + precision)) % 10;
}

/**
 * Digits to render: from the most-significant in use (or window top) down to
 * -precision, each flagged active/knob. `maxIntDigits` clamps display width
 * for runaway growth.
 */
export function display(state: DigitState, maxIntDigits = 9): DigitDisplay {
  const { value, windowStart, precision } = state;
  const absScaled = Math.round(Math.abs(value) * pow10(precision));
  const topByValue = mostSignificantExponent(value);
  let top = Math.max(topByValue, windowStart, 0);
  if (top > maxIntDigits - 1) {
    top = maxIntDigits - 1;
  }
  const bottom = -precision;
  const digits: DisplayDigit[] = [];
  let pointIndex: number | null = null;
  for (let e = top; e >= bottom; e -= 1) {
    const active = e <= windowStart && e > windowStart - WINDOW;
    digits.push({
      exponent: e,
      digit: digitAt(absScaled, e, precision),
      active,
      knob: active ? windowStart - e : null
    });
    if (e === 0 && bottom < 0) {
      pointIndex = digits.length - 1; // point sits just after the ones digit
    }
  }
  return { negative: value < 0, digits, pointIndex };
}
