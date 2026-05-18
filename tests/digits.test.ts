import { describe, expect, it } from "vitest";
import {
  WINDOW,
  createDigitState,
  display,
  formatValue,
  knobExponent,
  mostSignificantExponent,
  nudge,
  zoom
} from "../src/digits";

describe("mostSignificantExponent", () => {
  it("is 0 for |v| < 1, floor(log10) otherwise", () => {
    expect(mostSignificantExponent(0)).toBe(0);
    expect(mostSignificantExponent(0.004)).toBe(0);
    expect(mostSignificantExponent(7)).toBe(0);
    expect(mostSignificantExponent(42)).toBe(1);
    expect(mostSignificantExponent(-1234)).toBe(3);
    expect(mostSignificantExponent(1000)).toBe(3);
  });
});

describe("createDigitState", () => {
  it("sits the window on the most-significant digits, clamps + rounds", () => {
    const s = createDigitState(1234.567, { precision: 2 });
    expect(s.value).toBe(1234.57);
    expect(s.windowStart).toBe(3); // 10^3..10^0
    expect(createDigitState(0, { precision: 3 }).windowStart).toBe(0);
    expect(createDigitState(12, { precision: 0 }).windowStart).toBe(3); // bottom can't pass 10^0
    expect(createDigitState(50, { precision: 0, min: 0, max: 10 }).value).toBe(10);
  });
});

describe("nudge — place value, carry/borrow, sign", () => {
  it("adds magnitude at the knob's place", () => {
    let s = createDigitState(100, { precision: 0 }); // windowStart 3 (1000s..1s)
    s = nudge(s, 1, 1); // knob1 = 10^2
    expect(s.value).toBe(200);
  });

  it("carry/borrow propagate through the whole number", () => {
    let s = createDigitState(9, { precision: 0 });
    s = nudge(s, 3, 1); // ones +1 -> tens carry
    expect(s.value).toBe(10);
    s = createDigitState(100, { precision: 0 });
    s = nudge(s, 3, -1); // ones -1 -> borrow across hundreds
    expect(s.value).toBe(99);
  });

  it("crossing zero flips the sign naturally", () => {
    let s = createDigitState(0, { precision: 0 });
    s = nudge(s, 3, -1);
    expect(s.value).toBe(-1);
    s = nudge(s, 3, -2);
    expect(s.value).toBe(-3);
    s = nudge(s, 3, 5);
    expect(s.value).toBe(2);
  });

  it("clamps to [min,max] when ranged", () => {
    let s = createDigitState(8, { precision: 0, min: 0, max: 10 });
    s = nudge(s, 3, 5);
    expect(s.value).toBe(10);
    s = nudge(s, 3, -50);
    expect(s.value).toBe(0);
  });

  it("is exact at precision (no float drift)", () => {
    let s = createDigitState(0, { precision: 1 });
    s = nudge(s, knobIndexForExp(s, -1), 1);
    s = nudge(s, knobIndexForExp(s, -1), 1);
    s = nudge(s, knobIndexForExp(s, -1), 1);
    expect(s.value).toBe(0.3);
    expect(formatValue(s.value, 1)).toBe("0.3");
  });

  it("ignores out-of-range knobs / zero detents", () => {
    const s = createDigitState(5, { precision: 0 });
    expect(nudge(s, -1, 1)).toBe(s);
    expect(nudge(s, WINDOW, 1)).toBe(s);
    expect(nudge(s, 0, 0)).toBe(s);
  });
});

function knobIndexForExp(s: { windowStart: number }, exp: number): number {
  return s.windowStart - exp;
}

describe("zoom — clamp + growth", () => {
  it("pans within [minWindowStart, mostSignificant]", () => {
    let s = createDigitState(12345.678, { precision: 3 }); // start 4
    expect(s.windowStart).toBe(4);
    s = zoom(s, -1);
    expect(s.windowStart).toBe(3);
    for (let i = 0; i < 20; i += 1) {
      s = zoom(s, -1);
    }
    expect(s.windowStart).toBe(0); // bottom = 10^0..10^-3, can't go further
    for (let i = 0; i < 20; i += 1) {
      s = zoom(s, 1);
    }
    expect(s.windowStart).toBe(4); // can't pass the most-significant digit
  });

  it("the number can grow leading digits", () => {
    let s = createDigitState(9999, { precision: 0 });
    s = nudge(s, 3, 1); // 9999 + 1 -> 10000
    expect(s.value).toBe(10000);
    expect(display(s).digits.map((d) => d.digit).join("")).toBe("10000");
  });

  it("knobExponent maps knob 0..3 left→right (most→less significant)", () => {
    const s = createDigitState(1234, { precision: 0 });
    expect(knobExponent(s, 0)).toBe(s.windowStart);
    expect(knobExponent(s, 3)).toBe(s.windowStart - 3);
  });
});

describe("display", () => {
  it("lists digits MSB→LSB with point + active/knob flags", () => {
    const s = createDigitState(1234.5, { precision: 1 }); // windowStart 3
    const d = display(s);
    expect(d.negative).toBe(false);
    expect(d.digits.map((x) => x.exponent)).toEqual([3, 2, 1, 0, -1]);
    expect(d.digits.map((x) => x.digit)).toEqual([1, 2, 3, 4, 5]);
    expect(d.pointIndex).toBe(3); // point sits just after the 10^0 digit
    expect(d.digits.filter((x) => x.active).map((x) => x.exponent)).toEqual([3, 2, 1, 0]);
    expect(d.digits[0].knob).toBe(0);
    expect(d.digits[3].knob).toBe(3);
    expect(d.digits[4].knob).toBeNull();
  });

  it("renders the emergent negative sign and clamps runaway width", () => {
    expect(display(createDigitState(-12.5, { precision: 1 })).negative).toBe(true);
    const big = createDigitState(123456789012, { precision: 0 });
    expect(display(big, 6).digits.length).toBeLessThanOrEqual(6);
  });
});

describe("formatValue", () => {
  it("fixed precision, normalises -0", () => {
    expect(formatValue(1.2, 3)).toBe("1.200");
    expect(formatValue(-0, 2)).toBe("0.00");
    expect(formatValue(42, 0)).toBe("42");
  });
});
