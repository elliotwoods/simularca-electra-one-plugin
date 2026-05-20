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
      "function btnClear(",
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
      'call = btnClear',
      'call = btnPlayPause',
      'name = "Back"',
      'name = "Next"',
      'name = "Clear"',
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
    // 11 = 1 definition + 10 invocations (ssp C/A/V, applyPage, focusSlot,
    // touch-highlight, onLoad/onReady/onEnter, plus v28's btnClear defocus).
    expect(SURFACE_MAIN_LUA).toContain("local function recenterAll(");
    expect((SURFACE_MAIN_LUA.match(/recenterAll\(\)/g) ?? []).length).toBe(11);
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
    // Phase 1: SET_ACTOR unconditionally clears focus. The old guarded
    // clear (only when the old slot vanished) left the centre band zoomed
    // on a different actor's field at the same absolute index.
    expect(SURFACE_MAIN_LUA).not.toMatch(
      /if\s+focusedIdx\s+~=\s+nil\s+and\s+slots\[focusedIdx\]\s+==\s+nil\s+then/
    );
    // Phase 1B: Spare button became Clear. Both the preset binding and the
    // Lua handler must be renamed; the handler clears focus and emits
    // "scp btn clear" for host diagnostics.
    expect(SURFACE_MAIN_LUA).not.toContain("function btnSpare(");
    expect(SURFACE_MAIN_LUA).toContain("function btnClear(");
    expect(SURFACE_MAIN_LUA).toContain('sspEmit("scp btn clear")');
    expect(SURFACE_PRESET_JSON).not.toContain("btnSpare");
    expect(SURFACE_PRESET_JSON).toContain("btnClear");
    // v36 Phase B (final): unfocused encoder 1 is DELTA-based paging (same
    // pattern as every other encoder on the surface). The absolute-value
    // / proportional-mapping variant ping-ponged because the recenterAll
    // echo inside applyPage computed a different page each pass; delta-
    // based mode sees that echo as delta=0 and returns harmlessly. The
    // branch lives BEFORE the focusedIdx==nil early-return so it actually
    // fires; focused mode below keeps the digit-place pan.
    expect(SURFACE_MAIN_LUA).toMatch(
      /if\s+focusedIdx\s+==\s+nil\s+then[\s\S]{0,1500}?if\s+id\s+==\s+1\s+then[\s\S]{0,800}?pageNext\(\)/
    );
    expect(SURFACE_MAIN_LUA).toMatch(/pagePrev\(\)/);
    // The pageMutating re-entry guard is gone (delta=0 echo-suppression
    // handles the same case automatically).
    expect(SURFACE_MAIN_LUA).not.toContain("pageMutating");
    // applyPage(page * 4) was the absolute-mapping call -- gone too.
    expect(SURFACE_MAIN_LUA).not.toMatch(/applyPage\(page\s*\*\s*4\)/);
    // pagePrev / pageNext are still defined (btnBack/btnNext call them) but
    // no longer wired from the encoder-1-unfocused branch.
    expect(SURFACE_MAIN_LUA).toMatch(/function pagePrev\(/);
    expect(SURFACE_MAIN_LUA).toMatch(/function pageNext\(/);
    expect(SURFACE_MAIN_LUA).not.toMatch(
      /if\s+focusedIdx\s+==\s+nil\s+then[\s\S]{0,500}?if\s+id\s+==\s+1\s+then[\s\S]{0,300}?pageNext\(\)/
    );
    // Phase 3: the unfocused empty state is the 4-column mini-view, not
    // the "touch a value" placeholder.
    expect(SURFACE_MAIN_LUA).toContain("local function drawMiniView(");
    expect(SURFACE_MAIN_LUA).toContain("drawMiniView()");
    expect(SURFACE_MAIN_LUA).not.toContain('"touch a value"');
    // v29 Phase A: drawMiniView dispatches on field kind to a curated set of
    // mini renderers. The old Phase-3 cellRect/horizontal-slider painter
    // inside drawMiniView is gone (cellRect stays for the focused-mode
    // drawToggle).
    expect(SURFACE_MAIN_LUA).toContain("local function drawMiniSeg(");
    expect(SURFACE_MAIN_LUA).toContain("local function drawMiniDigit(");
    expect(SURFACE_MAIN_LUA).toContain("local function drawMini7Seg(");
    expect(SURFACE_MAIN_LUA).toContain("local function drawMiniRangedNumber(");
    expect(SURFACE_MAIN_LUA).toContain("local function drawMiniOptionList(");
    expect(SURFACE_MAIN_LUA).not.toMatch(/local function drawMiniView[\s\S]{0,4000}?cellRect\(/);
    // Zoomed-view range bar: drawReadout paints a vertical bar (dim bg +
    // bright bottom-up fill) when the focused number has min/max.
    expect(SURFACE_MAIN_LUA).toMatch(
      /Vertical range bar to the right of the digit row[\s\S]{0,1200}?fillRect\(barX/
    );
    // v29 Phase B: reconfigureEncoders defined and invoked at every focus-
    // mutation site (focusSlot, ssp C, ssp A, applyPage, btnClear, onLoad,
    // onReady, onEnter = 8 invocations + 1 definition).
    expect(SURFACE_MAIN_LUA).toContain("local function reconfigureEncoders(");
    const reconfCalls = (SURFACE_MAIN_LUA.match(/reconfigureEncoders\(\)/g) ?? []).length;
    expect(reconfCalls).toBeGreaterThanOrEqual(9);
    // Encoder 1 renamed by mode; encoders 2-4 hidden/restored.
    expect(SURFACE_MAIN_LUA).toContain('c1:setName("Page")');
    expect(SURFACE_MAIN_LUA).toContain('c1:setName("")');
    expect(SURFACE_MAIN_LUA).toMatch(/c:setVisible\(false\)/);
    expect(SURFACE_MAIN_LUA).toMatch(/c:setVisible\(true\)/);
  });

  it("preset JSON has 4 pad controls at potIds 9-12 for hardware buttons 3-6", () => {
    const preset = JSON.parse(SURFACE_PRESET_JSON) as {
      controls: Array<{
        id: number;
        type: string;
        name?: string;
        color?: string;
        visible?: boolean;
        bounds?: number[];
        inputs?: Array<{ potId: number; valueId: string }>;
        values?: Array<{
          function?: string;
          message?: { type?: string; deviceId?: number; parameterNumber?: number; onValue?: number };
        }>;
      }>;
    };
    const pads = preset.controls.filter((c) => c.type === "pad");
    expect(pads).toHaveLength(4);
    const byPot = new Map(pads.map((p) => [p.inputs?.[0].potId, p]));
    expect(byPot.get(9)?.values?.[0].function).toBe("btnBack");
    expect(byPot.get(10)?.values?.[0].function).toBe("btnNext");
    expect(byPot.get(11)?.values?.[0].function).toBe("btnClear");
    expect(byPot.get(12)?.values?.[0].function).toBe("btnPlayPause");
    expect(byPot.get(9)?.name).toBe("Back");
    expect(byPot.get(11)?.name).toBe("Clear");
    // Initial Play/Pause label is "Play"; the device flips to "Pause" when
    // the host pushes `ssp T1` (state.time.running -> true).
    expect(byPot.get(12)?.name).toBe("Play");
    // v29: every pad must carry the JX-3P-pattern message that binds the
    // potId to hardware-button dispatch (type:"none" = bound but no MIDI).
    // The v26/v27 message-less shape was empirically dead on fw v4.1.4.
    // visible:true + on-canvas bounds are also required (Phase 2 found that
    // setVisible(false) kills the dispatch callback).
    for (const p of pads) {
      const msg = p.values?.[0].message;
      expect(msg).toBeTruthy();
      expect(msg?.type).toBe("none");
      expect(msg?.deviceId).toBe(1);
      expect(msg?.onValue).toBe(127);
      expect(p.visible).toBe(true);
      // Bounds must be on-canvas (Mini is 800x480). v29 places the pad row
      // at y=362 h=51 (JX-3P's y=363 placement). v30: pads occupy the right
      // 4/6 of the screen (Mini buttons 1-2 = MENU/CONTEXT on the left 2/6).
      expect(p.bounds?.[1]).toBe(362);
      expect(p.bounds?.[3]).toBe(51);
      expect(p.bounds?.[0]).toBeGreaterThanOrEqual(267); // start of right 4/6
      expect(p.bounds?.[2]).toBe(117); // BTN_W
    }
    // v30: per-button colours (Back/Next blue, Clear orange, Play teal).
    expect(byPot.get(9)?.color).toBe("529DEC");
    expect(byPot.get(10)?.color).toBe("529DEC");
    expect(byPot.get(11)?.color).toBe("F49500");
    expect(byPot.get(12)?.color).toBe("03A598");
  });

  it("Lua has the v31 transport-state branch for ssp T<0|1>", () => {
    // Host pushes the current transport state via setTransportCommand; the
    // Lua updates the Play/Pause pad label + colour to match. v31: setColor
    // takes a NUMBER on fw v4.1.4 (Lua hex literal), not a string.
    expect(SURFACE_MAIN_LUA).toContain('string.sub(cmd, 1, 1) == "T"');
    expect(SURFACE_MAIN_LUA).toContain('c:setName(on and "Pause" or "Play")');
    expect(SURFACE_MAIN_LUA).toContain("c:setColor(on and 0xF45C51 or 0x03A598)");
    expect(SURFACE_MAIN_LUA).not.toContain('c:setColor(on and "F45C51"');
  });

  it("Lua applyPage defocuses if the zoomed field scrolls off-screen", () => {
    // The "if the zoomed-in control is no longer in the zoomed-out view,
    // zoom out" rule: paging away from the focused field drops focus AND
    // notifies the host via `scp focus -1`.
    expect(SURFACE_MAIN_LUA).toMatch(
      /focusedIdx\s+<\s+pageOffset\s+or\s+focusedIdx\s+>=\s+pageOffset\s+\+\s+4/
    );
    expect(SURFACE_MAIN_LUA).toContain('sspEmit("scp focus -1")');
  });

  it("Lua emits scp btn <action> for clear/playpause only (back/next are device-local)", () => {
    expect(SURFACE_MAIN_LUA).toContain('sspEmit("scp btn clear")');
    expect(SURFACE_MAIN_LUA).toContain('sspEmit("scp btn playpause")');
    // back/next route through pagePrev/pageNext (no host emit by design)
    expect(SURFACE_MAIN_LUA).not.toContain('sspEmit("scp btn back")');
    expect(SURFACE_MAIN_LUA).not.toContain('sspEmit("scp btn next")');
    // Spare is gone; the third pad is now Clear (defocus shortcut).
    expect(SURFACE_MAIN_LUA).not.toContain('sspEmit("scp btn spare")');
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
