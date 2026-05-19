import { describe, expect, it } from "vitest";
import { asciiBytes, parseBundleVersion } from "../src/electraSysex";
import {
  buildSurfaceLua,
  SURFACE_BUNDLE_VERSION,
  SURFACE_MAIN_LUA,
  SURFACE_PRESET_JSON
} from "../src/surfaceBundle";
import { DEFAULT_RENDER_OPTIONS } from "../src/types";

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

  it("Lua has the split-row + paging + readout functions, not the old ones", () => {
    for (const fn of [
      "function valueChanged(",
      "function detailChanged(",
      "function pagePrev(",
      "function pageNext(",
      "function zoomOut(",
      "function zoomIn(",
      "function drawReadout(",
      "function paint(",
      "preset.userFunctions"
    ]) {
      expect(SURFACE_MAIN_LUA).toContain(fn);
    }
    for (const n of ['name = "Prev"', 'name = "Next"', 'name = "Zoom-"', 'name = "Zoom+"']) {
      expect(SURFACE_MAIN_LUA).toContain(n);
    }
    // shared discrete editor + toggle/enum picker rendering are present
    for (const fn of [
      "local function stepDiscrete(",
      "local function drawToggle(",
      "local function drawEnum("
    ]) {
      expect(SURFACE_MAIN_LUA).toContain(fn);
    }
    // direct-edit semantic path + highlight + greying are present
    expect(SURFACE_MAIN_LUA).toContain("scp dv ");
    expect(SURFACE_MAIN_LUA).toContain("scp vc ");
    expect(SURFACE_MAIN_LUA).toContain("highlightedKnob");
    expect(SURFACE_MAIN_LUA).not.toContain("pages.display");
    expect(SURFACE_MAIN_LUA).not.toContain("function draw7(");
    expect(SURFACE_MAIN_LUA).not.toContain("function drillKnob(");
    expect(SURFACE_MAIN_LUA).not.toContain("function slotChanged(");
  });
});

describe("buildSurfaceLua render-option variants", () => {
  const VARIANTS = [
    { roundedCaps: true, ghostSegments: true },
    { roundedCaps: true, ghostSegments: false },
    { roundedCaps: false, ghostSegments: true },
    { roundedCaps: false, ghostSegments: false }
  ];

  it("default options reproduce the back-compat SURFACE_MAIN_LUA", () => {
    expect(buildSurfaceLua(DEFAULT_RENDER_OPTIONS)).toBe(SURFACE_MAIN_LUA);
    expect(buildSurfaceLua()).toBe(SURFACE_MAIN_LUA);
  });

  it("every variant stays 7-bit ASCII, stamps the version, keeps core fns", () => {
    for (const v of VARIANTS) {
      const lua = buildSurfaceLua(v);
      expect(() => asciiBytes(lua)).not.toThrow();
      expect(parseBundleVersion(lua)).toBe(SURFACE_BUNDLE_VERSION);
      for (const fn of ["function drawReadout(", "function paint(", "function drawSeg("]) {
        expect(lua).toContain(fn);
      }
    }
  });

  it("roundedCaps OFF omits the disc/JOINT code; ON includes it", () => {
    const on = buildSurfaceLua({ roundedCaps: true, ghostSegments: true });
    expect(on).toContain("local function drawDisc(");
    expect(on).toContain("local JOINT = 2");

    const off = buildSurfaceLua({ roundedCaps: false, ghostSegments: true });
    expect(off).not.toContain("local function drawDisc(");
    expect(off).not.toContain("local JOINT = 2");
    expect(off).not.toContain("drawDisc(discHW");
    expect(off).toContain("Flat rectangle segments");
  });

  it("ghostSegments OFF omits COL_OFF and the off-pass; ON includes them", () => {
    const on = buildSurfaceLua({ roundedCaps: true, ghostSegments: true });
    expect(on).toContain("local COL_OFF = 0x000000");
    expect(on).toContain(', "abcdefg", discHW, r, COL_OFF)');

    const off = buildSurfaceLua({ roundedCaps: true, ghostSegments: false });
    expect(off).not.toContain("local COL_OFF =");
    expect(off).not.toContain("COL_OFF)");
  });
});
