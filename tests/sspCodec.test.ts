import { describe, expect, it } from "vitest";
import {
  clearCommand,
  decodeDeviceLine,
  decodeSurfacePayload,
  encodeSurfacePayload,
  sanitizeToken,
  setActorCommand,
  setFieldValueCommand,
  type SurfaceDescriptor
} from "../src/sspCodec";

const desc: SurfaceDescriptor = {
  actorId: "a1",
  actorName: "Cube",
  fields: [
    { key: "on", idx: 0, kind: "toggle", label: "On", value: "1" },
    { key: "size", idx: 1, kind: "number", label: "Size", value: "2.50", min: 0, max: 10, step: 0.5 },
    { key: "mode", idx: 2, kind: "list", label: "Mode", value: "1", options: ["a", "b", "c"] }
  ]
};

describe("sanitizeToken", () => {
  it("strips quotes/backslash/control/non-ASCII and caps length", () => {
    expect(sanitizeToken('a"b\\c')).toBe("a'b'c");
    expect(sanitizeToken("xy\tz")).toBe("x y z");
    expect(sanitizeToken("café")).toBe("caf");
    expect(sanitizeToken("abcdefghij", 5)).toBe("abcd~");
  });
});

describe("surface payload round-trip", () => {
  it("decode(encode(x)) preserves fields", () => {
    const round = decodeSurfacePayload(encodeSurfacePayload(desc));
    expect(round?.actorName).toBe("Cube");
    expect(round?.fields).toEqual([
      { key: "", idx: 0, kind: "toggle", label: "On", value: "1", min: undefined, max: undefined, step: undefined, precision: undefined, options: undefined },
      { key: "", idx: 1, kind: "number", label: "Size", value: "2.50", min: 0, max: 10, step: 0.5, precision: undefined, options: undefined },
      { key: "", idx: 2, kind: "list", label: "Mode", value: "1", min: undefined, max: undefined, step: undefined, precision: undefined, options: ["a", "b", "c"] }
    ]);
  });

  it("round-trips the precision column", () => {
    const d = {
      actorId: "a",
      actorName: "N",
      fields: [{ key: "n", idx: 0, kind: "number" as const, label: "N", value: "1.50", min: 0, max: 9, step: 0.1, precision: 2 }]
    };
    expect(decodeSurfacePayload(encodeSurfacePayload(d))?.fields[0]).toMatchObject({
      min: 0,
      max: 9,
      step: 0.1,
      precision: 2
    });
  });

  it("decodeSurfacePayload rejects a non-A payload", () => {
    expect(decodeSurfacePayload("nope")).toBeNull();
  });
});

describe("command framing", () => {
  it("wraps payloads in ssp(\"…\") with no literal-breaking chars", () => {
    const cmd = setActorCommand(desc);
    expect(cmd.startsWith('ssp("')).toBe(true);
    expect(cmd.endsWith('")')).toBe(true);
    expect(cmd.slice(5, -2)).not.toMatch(/["\\]/);
    expect(setFieldValueCommand(3, "9")).toContain('ssp("V');
    expect(clearCommand()).toBe('ssp("C")');
  });
});

describe("decodeDeviceLine", () => {
  it("parses value / dvalue / drill / ready / focus / log, ignores noise", () => {
    expect(decodeDeviceLine("scp vc 4 0.75")).toEqual({ type: "value", idx: 4, value: "0.75" });
    expect(decodeDeviceLine("scp dv 1 -3.250")).toEqual({ type: "dvalue", idx: 1, value: "-3.250" });
    expect(decodeDeviceLine("scp drill 5")).toEqual({ type: "drill", idx: 5 });
    expect(decodeDeviceLine("scp drillx")).toEqual({ type: "drillexit" });
    expect(decodeDeviceLine("scp focus 2")).toEqual({ type: "focus", idx: 2 });
    expect(decodeDeviceLine("simularca:ready bundle=4")).toEqual({ type: "ready", bundle: 4 });
    expect(decodeDeviceLine("scp ready bundle=3")).toEqual({ type: "ready", bundle: 3 });
    expect(decodeDeviceLine("scp hello world")).toEqual({ type: "log", text: "hello world" });
    expect(decodeDeviceLine("unrelated device chatter")).toBeNull();
  });

  it("accepts Lua float-rendered indices (hardware emits 'scp dv 0.0 …')", () => {
    // The device computes some indices via arithmetic that yields a Lua
    // float; Electra's tostring renders it "N.0". A strict \d+ silently
    // dropped EVERY such line on real hardware — all top-row digit-editor
    // edits and all focus events — while the bottom row stayed integer.
    expect(decodeDeviceLine("scp dv 0.0 100.0")).toEqual({
      type: "dvalue",
      idx: 0,
      value: "100.0"
    });
    expect(decodeDeviceLine("scp focus 0.0")).toEqual({ type: "focus", idx: 0 });
    expect(decodeDeviceLine("scp vc 3.0 64")).toEqual({
      type: "value",
      idx: 3,
      value: "64"
    });
    expect(decodeDeviceLine("scp drill 2.0")).toEqual({ type: "drill", idx: 2 });
    // Integer indices still parse exactly as before (no regression).
    expect(decodeDeviceLine("scp focus 12")).toEqual({ type: "focus", idx: 12 });
  });

  it("strips the Electra log millisecond + lua: prefixes", () => {
    // Real device Log SysEx text: "<ms-from-start> lua: <print output>".
    expect(decodeDeviceLine("147362 lua: scp vc 4 0.75")).toEqual({
      type: "value",
      idx: 4,
      value: "0.75"
    });
    expect(decodeDeviceLine("88 lua: scp dv 1 -3.250")).toEqual({
      type: "dvalue",
      idx: 1,
      value: "-3.250"
    });
    expect(decodeDeviceLine("9001 lua: simularca:ready bundle=12")).toEqual({
      type: "ready",
      bundle: 12
    });
    // ms prefix without the lua: prefix, and lua: without ms — both tolerated.
    expect(decodeDeviceLine("42 scp focus 2")).toEqual({ type: "focus", idx: 2 });
    expect(decodeDeviceLine("lua: scp vc 0 127")).toEqual({
      type: "value",
      idx: 0,
      value: "127"
    });
    // Generic firmware logger chatter (now streaming once logging is on).
    expect(decodeDeviceLine("147362 ElectraApp: preset successfully loaded")).toBeNull();
  });
});
