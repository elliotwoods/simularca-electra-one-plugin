import { describe, expect, it } from "vitest";
import { asciiBytes, parseBundleVersion } from "../src/electraSysex";
import { SURFACE_BUNDLE_VERSION, SURFACE_MAIN_LUA, SURFACE_PRESET_JSON } from "../src/surfaceBundle";

describe("surface bundle", () => {
  it("preset JSON and Lua are strict 7-bit ASCII (SysEx-safe)", () => {
    expect(() => asciiBytes(SURFACE_PRESET_JSON)).not.toThrow();
    expect(() => asciiBytes(SURFACE_MAIN_LUA)).not.toThrow();
  });

  it("Lua stamps the single-sourced bundle version", () => {
    expect(parseBundleVersion(SURFACE_MAIN_LUA)).toBe(SURFACE_BUNDLE_VERSION);
  });

  it("preset JSON parses and carries the discovery marker name", () => {
    const preset = JSON.parse(SURFACE_PRESET_JSON) as { name: string; pages: unknown[] };
    expect(preset.name).toBe("Simularca Surface");
    expect(preset.pages.length).toBeGreaterThan(0);
  });

  it("every control is encoder-bound (inputs/potId) with the value function", () => {
    const preset = JSON.parse(SURFACE_PRESET_JSON) as {
      controls: Array<{
        controlSetId: number;
        inputs: Array<{ potId: number; valueId: string }>;
        values: Array<{ function?: string; id: string }>;
      }>;
    };
    expect(preset.controls).toHaveLength(8);
    preset.controls.forEach((c, i) => {
      expect(c.controlSetId).toBe(1);
      expect(c.inputs[0]).toEqual({ potId: i + 1, valueId: "value" });
      expect(c.values[0].function).toBe("slotChanged");
    });
    expect(SURFACE_MAIN_LUA).toContain("function slotChanged(");
  });
});
