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
      "function btnBack(",
      "function btnNext(",
      "function btnSpare(",
      "function btnPlayPause(",
      "function drawReadout(",
      "function paint(",
      "preset.userFunctions"
    ]) {
      expect(SURFACE_MAIN_LUA).toContain(fn);
    }
    // v27 userFunctions wiring: the table reuses the btn* handlers (one
    // source of truth for both the dormant pads and the manual-bind route).
    // Hardware-button dispatch is firmware-locked on fw v4.1.4; this table
    // is the actual working route after a one-time Preset-Menu bind.
    for (const entry of [
      'call = btnBack',
      'call = btnNext',
      'call = btnSpare',
      'call = btnPlayPause',
      'name = "Back"',
      'name = "Next"',
      'name = "Spare"',
      'name = "Play/Pause"'
    ]) {
      expect(SURFACE_MAIN_LUA).toContain(entry);
    }
    // shared discrete editor + toggle/enum picker rendering are present
    for (const fn of [
      "local function stepDiscrete(",
      "local function drawToggle(",
      "local function drawEnum("
    ]) {
      expect(SURFACE_MAIN_LUA).toContain(fn);
    }
    // Unit-glyph rendering: dispatcher + composers for the curated set;
    // anything outside the set falls through to graphics.print text. Wire
    // tokens are 7-bit ASCII ("deg" not "°", "u" not "μ").
    for (const fn of [
      "local function drawDegree(",
      "local function drawM(",
      "local function drawX(",
      "local function drawUnit("
    ]) {
      expect(SURFACE_MAIN_LUA).toContain(fn);
    }
    // drawUnit dispatches on the curated tokens and is invoked by drawReadout.
    for (const tok of ['unit == "deg"', 'unit == "m"', 'unit == "x"', 'unit == "s"', 'unit == "d"']) {
      expect(SURFACE_MAIN_LUA).toContain(tok);
    }
    expect(SURFACE_MAIN_LUA).toContain("drawUnit(f.unit");
    // The SSP A-payload parser MUST take unit from c[10] and opts from c[11]
    // (any future column reshuffle has to update the host encode in lockstep).
    expect(SURFACE_MAIN_LUA).toContain("unit = (c[10]");
    expect(SURFACE_MAIN_LUA).toContain("opts = (c[11]");
    // direct-edit semantic path + highlight + greying are present
    expect(SURFACE_MAIN_LUA).toContain("scp dv ");
    expect(SURFACE_MAIN_LUA).toContain("scp vc ");
    expect(SURFACE_MAIN_LUA).toContain("highlightedKnob");
    // recenterAll(): the differential-mid reset is defined once and invoked
    // at every surface/page/focus/lifecycle update + host value push.
    // 10 = 1 definition occurrence + 9 invocations (ssp C/A/V, applyPage,
    // focusSlot, touch-highlight, onLoad/onReady/onEnter).
    expect(SURFACE_MAIN_LUA).toContain("local function recenterAll(");
    expect((SURFACE_MAIN_LUA.match(/recenterAll\(\)/g) ?? []).length).toBe(10);
    // Recenter MUST go through the Message (hardware-verified API): a Control
    // has no setValue and ControlValue:overrideValue is visual-only. Guard the
    // exact regression where recenter called a nil Control method (silently
    // pcall-eaten -> recenter never worked).
    expect(SURFACE_MAIN_LUA).toContain("local function setPotMid(");
    expect(SURFACE_MAIN_LUA).toContain(":getValue():getMessage():setValue(64)");
    expect(SURFACE_MAIN_LUA).not.toContain("ctrl:setValue(64)");
    expect(SURFACE_MAIN_LUA).not.toContain("c:setValue(64)");
    expect(SURFACE_MAIN_LUA).not.toContain("pages.display");
    expect(SURFACE_MAIN_LUA).not.toContain("function draw7(");
    expect(SURFACE_MAIN_LUA).not.toContain("function drillKnob(");
    expect(SURFACE_MAIN_LUA).not.toContain("function slotChanged(");
    // Zoom-/Zoom+ removed: the value encoder edits directly, and the
    // digit-window pan is reached by touching a digit encoder.
    expect(SURFACE_MAIN_LUA).not.toContain("function zoomOut(");
    expect(SURFACE_MAIN_LUA).not.toContain("function zoomIn(");
    expect(SURFACE_MAIN_LUA).not.toContain('name = "Zoom-"');
    expect(SURFACE_MAIN_LUA).not.toContain('name = "Zoom+"');
  });

  it("preset JSON has 4 pad controls at potIds 9-12 for hardware buttons 3-6", () => {
    const preset = JSON.parse(SURFACE_PRESET_JSON) as {
      controls: Array<{
        id: number;
        type: string;
        name?: string;
        inputs?: Array<{ potId: number; valueId: string }>;
        values?: Array<{ function?: string }>;
      }>;
    };
    const pads = preset.controls.filter((c) => c.type === "pad");
    expect(pads).toHaveLength(4);
    const byPot = new Map(pads.map((p) => [p.inputs?.[0].potId, p]));
    expect(byPot.get(9)?.values?.[0].function).toBe("btnBack");
    expect(byPot.get(10)?.values?.[0].function).toBe("btnNext");
    expect(byPot.get(11)?.values?.[0].function).toBe("btnSpare");
    expect(byPot.get(12)?.values?.[0].function).toBe("btnPlayPause");
    expect(byPot.get(9)?.name).toBe("Back");
    expect(byPot.get(12)?.name).toBe("Play/Pause");
  });

  it("Lua emits scp btn <action> for spare/playpause only (back/next are device-local)", () => {
    expect(SURFACE_MAIN_LUA).toContain('sspEmit("scp btn spare")');
    expect(SURFACE_MAIN_LUA).toContain('sspEmit("scp btn playpause")');
    // back/next route through pagePrev/pageNext (no host emit by design)
    expect(SURFACE_MAIN_LUA).not.toContain('sspEmit("scp btn back")');
    expect(SURFACE_MAIN_LUA).not.toContain('sspEmit("scp btn next")');
  });
});

describe("buildSurfaceLua render-option variants", () => {
  const VARIANTS = [
    { capStyle: "round", ghostSegments: true },
    { capStyle: "round", ghostSegments: false },
    { capStyle: "flat", ghostSegments: true },
    { capStyle: "flat", ghostSegments: false },
    { capStyle: "polygon", ghostSegments: true },
    { capStyle: "polygon", ghostSegments: false },
    { capStyle: "triangle", ghostSegments: true },
    { capStyle: "triangle", ghostSegments: false }
  ] as const;

  it("default options reproduce the back-compat SURFACE_MAIN_LUA", () => {
    expect(buildSurfaceLua(DEFAULT_RENDER_OPTIONS)).toBe(SURFACE_MAIN_LUA);
    expect(buildSurfaceLua()).toBe(SURFACE_MAIN_LUA);
  });

  it("every variant stays 7-bit ASCII, stamps the version, keeps core fns", () => {
    for (const v of VARIANTS) {
      const lua = buildSurfaceLua(v);
      expect(() => asciiBytes(lua)).not.toThrow();
      expect(parseBundleVersion(lua)).toBe(SURFACE_BUNDLE_VERSION);
      for (const fn of [
        "function drawReadout(",
        "function paint(",
        "function drawSeg(",
        "local function recenterAll("
      ]) {
        expect(lua).toContain(fn);
      }
    }
  });

  it("flat cap omits the disc/JOINT code; round, polygon & triangle include it", () => {
    const round = buildSurfaceLua({ capStyle: "round", ghostSegments: true });
    expect(round).toContain("local function drawDisc(");
    expect(round).toContain("local JOINT = 2");
    expect(round).toContain("math.sqrt(r * r - dy * dy)"); // exact disc RLE

    const poly = buildSurfaceLua({ capStyle: "polygon", ghostSegments: true });
    expect(poly).toContain("local function drawDisc(");
    expect(poly).toContain("local JOINT = 2");
    expect(poly).toContain("Polygon cap: a fixed 3-band octagon");
    expect(poly).toContain("nb = 3");
    expect(poly).not.toContain("math.sqrt(r * r - dy * dy)"); // no per-row loop

    const tri = buildSurfaceLua({ capStyle: "triangle", ghostSegments: true });
    expect(tri).toContain("local function drawDisc(");
    expect(tri).toContain("local JOINT = 2");
    expect(tri).toContain("r - math.abs(dy)"); // linear-taper profile, RLE'd
    expect(tri).not.toContain("math.sqrt(r * r - dy * dy)"); // not the disc
    expect(tri).not.toContain("Polygon cap: a fixed 3-band octagon"); // not polygon

    const flat = buildSurfaceLua({ capStyle: "flat", ghostSegments: true });
    expect(flat).not.toContain("local function drawDisc(");
    expect(flat).not.toContain("local JOINT = 2");
    expect(flat).not.toContain("drawDisc(discHW");
    expect(flat).toContain("Flat rectangle segments");
  });

  it("ghostSegments OFF omits COL_OFF and the off-pass; ON includes them", () => {
    const on = buildSurfaceLua({ capStyle: "round", ghostSegments: true });
    expect(on).toContain("local COL_OFF = 0x000000");
    expect(on).toContain(', "abcdefg", discHW, r, COL_OFF)');

    const off = buildSurfaceLua({ capStyle: "round", ghostSegments: false });
    expect(off).not.toContain("local COL_OFF =");
    expect(off).not.toContain("COL_OFF)");
  });
});
