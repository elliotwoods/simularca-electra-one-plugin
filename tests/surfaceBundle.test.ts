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

  it("is one page: 4 detail (pots 1-4) + 4 value (pots 5-8) faders + 1 custom", () => {
    const preset = JSON.parse(SURFACE_PRESET_JSON) as {
      pages: Array<{ id: number; name: string }>;
      controls: Array<{
        id: number;
        type: string;
        pageId: number;
        controlSetId: number;
        visible?: boolean;
        inputs?: Array<{ potId: number; valueId: string }>;
        values?: Array<{ function?: string }>;
      }>;
    };
    expect(preset.pages).toHaveLength(1);
    expect(preset.pages[0]).toMatchObject({ id: 1, name: "SURFACE" });
    expect(preset.controls.every((c) => c.pageId === 1 && c.controlSetId === 1)).toBe(true);

    const detail = preset.controls.filter((c) => c.values?.[0].function === "detailChanged");
    const value = preset.controls.filter((c) => c.values?.[0].function === "valueChanged");
    const custom = preset.controls.filter((c) => c.type === "custom");
    expect(detail).toHaveLength(4);
    expect(value).toHaveLength(4);
    expect(custom).toHaveLength(1);

    detail.forEach((c, i) => expect(c.inputs?.[0]).toEqual({ potId: i + 1, valueId: "value" }));
    value.forEach((c, i) => expect(c.inputs?.[0]).toEqual({ potId: i + 5, valueId: "value" }));
    expect(custom[0].inputs).toBeUndefined(); // not encoder-bound
  });

  it("Lua has the split-row + paging + 7-seg functions, not the old DRILL ones", () => {
    for (const fn of [
      "function valueChanged(",
      "function detailChanged(",
      "function pagePrev(",
      "function pageNext(",
      "function draw7(",
      "function paint(",
      "preset.userFunctions"
    ]) {
      expect(SURFACE_MAIN_LUA).toContain(fn);
    }
    expect(SURFACE_MAIN_LUA).toContain('name = "Prev"');
    expect(SURFACE_MAIN_LUA).toContain('name = "Next"');
    expect(SURFACE_MAIN_LUA).not.toContain("pages.display");
    expect(SURFACE_MAIN_LUA).not.toContain("function drillKnob(");
    expect(SURFACE_MAIN_LUA).not.toContain("function slotChanged(");
  });
});
