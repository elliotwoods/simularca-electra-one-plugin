// The surface bundle uploaded to the device once (SPEC §4.1).
//
// Split-row model (single page, no DRILL page, no encoder-push):
//   bottom row (encoders 5-8) = up to 4 parameter VALUES
//   top row    (encoders 1-4) = the DETAIL editor for the focused value
//   centre band = a custom control painting a 7-segment readout + scrollbar
// Touch a value encoder to focus it (persists); the focused number's own
// bottom encoder pans the digit window (zoom); the 4 top encoders are the
// digit places. Mini hardware buttons page through >4 fields and trigger
// Spare/Play-Pause via preset.userFunctions (one-time user bind on the
// device); pad controls at potIds 9-12 are also wired as a forward-looking
// hedge for any future firmware that dispatches hardware buttons directly.
//
// Host -> device: Execute-Lua ssp("<payload>"). Device -> host: the Lua app
// self-emits each `scp …` line as a SysEx via `midi.sendSysex(0, …)` -- wire
// form F0 7D 53 53 50 <ascii> F7, parsed host-side by parseSspSysex. Verbs
// are `scp vc` (coarse), `scp dv` (digit), `scp focus <absIdx>`; indices are
// ABSOLUTE field indices (page-independent). The earlier print()/firmware-
// logger Log-SysEx path is dead on fw v4.1.4 (the logger never delivers Log
// SysEx, even when explicitly enabled) -- self-emitted SysEx is the sole
// device->host channel.
//
// The digit math mirrors src/digits.ts (exhaustively unit-tested). Device-side
// layout / 7-seg scale / fader-vs-custom coexistence are on-device tunables.

import {
  DEFAULT_RENDER_OPTIONS,
  type ElectraRenderOptions,
  SURFACE_BUNDLE_VERSION,
  SURFACE_PRESET_MARKER
} from "./types";

const COLS = [8, 206, 404, 602];
const CTRL_W = 184;
// Mini is 800x480, non-touch. Detail (digit) faders top strip; readout band;
// value faders below it. The readout band + value row were moved UP by
// ~1.5*STRIP_H so they no longer sit too low / overlap MENU/CONTEXT
// (~120px clearance below the value row). All tunable on-device.
const TOP_Y = 8;
const STRIP_H = 70; // detail (digit) faders: screen 8..78
// The readout custom control fills the gap between the detail row and the
// value row. Custom-control paint is RELATIVE to these bounds (0..BAND_H);
// digits auto-size to fill it. ~4px gap above the value row.
const BAND_Y = 82; // readout band: screen 82..283
const BAND_H = 201;
const BOT_Y = 287; // value faders: screen 287..357 (clears MENU/CONTEXT)
const BTN_Y = 362; // hardware-button pad row: screen 362..413 (matches the
                   // JX-3P Organix Mod preset's working y=363 placement).
const BTN_H = 51;  // matches JX-3P; leaves ~67 px below for menu chrome.
// The Mini has 6 hardware buttons in a row across the bottom; buttons 1-2
// are firmware-fixed (MENU, CONTEXT) on the LEFT 2/6 of the strip; buttons
// 3-6 are the assignable ones on the RIGHT 4/6. Our 4 pad labels must align
// with the right 4/6, NOT span the whole screen. x positions match JX-3P
// exactly (each slot is ~133 px, width 117 leaves ~13 px between).
const BTN_COLS = [277, 407, 537, 667];
const BTN_W = 117;

// v42: the firmware-painted faders are a "hack" -- the real interaction surface
// is the custom centre band, and the faders only exist for the CC7 pot
// plumbing. Make them recede with a subtle dark colour. The bottom row
// (ids 5-8) gets dynamically brightened by refreshSlotColors() when its
// visible slot's value diverges from a declared default; the top row stays
// at this baseline forever (it isn't 1:1 with slots).
const FADER_COL_DARK = "33455C"; // mirrors device-side COL_GREY (0x33455C)
const FADER_COL_BRIGHT = "6FD0FF"; // mirrors device-side COL_NORMAL (0x6FD0FF)

function fader(
  id: number,
  potId: number,
  fn: string,
  y: number,
  col: number
): Record<string, unknown> {
  return {
    id,
    type: "fader",
    name: "",
    color: FADER_COL_DARK,
    bounds: [COLS[col], y, CTRL_W, STRIP_H],
    pageId: 1,
    controlSetId: 1,
    visible: true,
    inputs: [{ potId, valueId: "value" }],
    values: [
      {
        id: "value",
        function: fn,
        message: { deviceId: 1, type: "cc7", parameterNumber: id, min: 0, max: 127 }
      }
    ]
  };
}

// Hardware-button pad (Mini buttons 3-6 = potIds 9-12). Shape ported from
// the JX-3P Organix Mod preset (the user supplied it as a known-working
// reference). The `message:{type:"none"}` field is what binds the potId to
// hardware-button DISPATCH without emitting MIDI -- our v26/v27 attempt
// omitted `message` entirely and the firmware silently treated each pad as
// decorative (presses dispatched nowhere, hardware-verified via the live
// debug bridge). `visible:true` with on-canvas bounds also appears
// required on fw v4.1.4 (Phase 2 empirically showed `setVisible(false)` on
// a fader killed its rotation callback; pads likely behave the same).
// parameterNumber must be unique per pad but the value is immaterial since
// no MIDI is sent; 100+(id-10) keeps it disjoint from the cc7 fader range
// 1-8. `function` names a Lua global declared in the bundle
// (btnReset/btnPlayPause as of v37).
function pad(
  id: number,
  potId: number,
  fn: string,
  label: string,
  col: number,
  color: string
): Record<string, unknown> {
  return {
    id,
    type: "pad",
    mode: "momentary",
    name: label,
    color,
    bounds: [BTN_COLS[col], BTN_Y, BTN_W, BTN_H],
    pageId: 1,
    controlSetId: 1,
    visible: true,
    inputs: [{ potId, valueId: "value" }],
    values: [
      {
        id: "value",
        function: fn,
        message: {
          type: "none",
          deviceId: 1,
          parameterNumber: 100 + (id - 10),
          onValue: 127
        }
      }
    ]
  };
}

function buildControls(): Record<string, unknown>[] {
  const controls: Record<string, unknown>[] = [];
  // Detail row = top, pots 1-4, ids 1-4.
  for (let i = 0; i < 4; i += 1) {
    controls.push(fader(i + 1, i + 1, "detailChanged", TOP_Y, i));
  }
  // Value row = bottom, pots 5-8, ids 5-8.
  for (let i = 0; i < 4; i += 1) {
    controls.push(fader(i + 5, i + 5, "valueChanged", BOT_Y, i));
  }
  // Centre custom control (no pot) — painted in Lua.
  controls.push({
    id: 9,
    type: "custom",
    name: "",
    bounds: [0, BAND_Y, 800, BAND_H],
    pageId: 1,
    controlSetId: 1,
    visible: true
  });
  // Hardware-button pads. Layout reworked in v37: Back/Next paging is now
  // covered by the top-left page encoder, and Clear-to-defocus is now the
  // automatic touch-off behaviour, so those three pads are gone. The remaining
  // pads are:
  //   - col 2 (hw button 5): Reset to default. Hidden when not zoomed-in
  //     onto a field that declares a default (reconfigureButtons() at runtime
  //     toggles setVisible based on focus + hasDefault).
  //   - col 3 (hw button 6): Play/Pause transport toggle.
  // Pad ids are preserved across the rework: Reset takes Clear's old id 12
  // (and orange colour) so the ssp T handler's controls.get(13) for the
  // Play/Pause pad still resolves identically.
  controls.push(pad(12, 11, "btnReset", "Reset", 2, "F49500"));
  controls.push(pad(13, 12, "btnPlayPause", "Play", 3, "03A598"));
  return controls;
}

export const SURFACE_PRESET: Record<string, unknown> = {
  version: 2,
  name: SURFACE_PRESET_MARKER,
  projectId: "simularca",
  pages: [{ id: 1, name: "SURFACE" }],
  devices: [{ id: 1, name: "Simularca", port: 1, channel: 1 }],
  groups: [],
  overlays: [],
  controls: buildControls()
};

export const SURFACE_PRESET_JSON = JSON.stringify(SURFACE_PRESET);

// Must stay 7-bit ASCII (uploaded raw over SysEx; asciiBytes() throws otherwise).
// The bundle is ASSEMBLED per render-options: each disabled detail OMITS its
// Lua entirely (no on-device `if` branch) so the Mini's paint loop runs the
// minimal code. Default options are capStyle "triangle" + ghostSegments off
// (authentic linear-taper 7-seg, no black "8" skeleton).
export function buildSurfaceLua(
  opts: ElectraRenderOptions = DEFAULT_RENDER_OPTIONS
): string {
  // `flat` = square ends; `round`/`polygon` both emit JOINT + the band
  // machinery, differing only in how discPre builds the bands and how a
  // vertical bar is drawn (round = exact body+2 discs; polygon = a coarse
  // 3-band cap stretched along both axes for a constant 3 fillRects/seg).
  const rounded = opts.capStyle !== "flat";
  const polygon = opts.capStyle === "polygon";
  // `triangle` reuses the polygon transposed-band-stretch vertical bar: the
  // diamond profile (hw = r-|o|) is x/y symmetric so the stretch is exact and
  // cheaper than round's body+2-discs for this profile.
  const bandStretch = polygon || opts.capStyle === "triangle";
  const ghost = opts.ghostSegments;
  const jointDisc = rounded
    ? `-- px gap held between adjacent segments where they meet at a corner.
-- MUST be declared before drawSeg -- drawSeg closes over it (a local
-- declared after the function would resolve to a nil global instead).
local JOINT = 2

-- The device has no circle/stroke primitive, so caps are scanlines -- but
-- the half-width profile is reduced ONCE per frame (see discPre) to a few
-- constant-width bands: bands.o[k]/w[k]/h[k] = {offset from centre, half
-- width, run length}, bands.nb of them. round = the exact disc RLE; polygon
-- = a coarse 3-band octagon. drawDisc paints a standalone cap (collapsed
-- segment) as bands.nb fillRects instead of 2r+1.
local function drawDisc(bands, cx, cy)
  for k = 1, bands.nb do
    local hw = bands.w[k]
    graphics.fillRect(cx - hw, cy + bands.o[k], 2 * hw + 1, bands.h[k])
  end
end
`
    : "";
  const vertBar = bandStretch
    ? `    -- Vertical bar (polygon): the octagon profile is x/y symmetric, so
    -- the same bands stretch transposed -- a constant bands.nb fillRects,
    -- no body rect, no per-end disc. Approximate by design.
    local span = bcy - tcy
    for k = 1, bands.nb do
      local hw = bands.w[k]
      graphics.fillRect(xc + bands.o[k], tcy - hw, bands.h[k], span + 2 * hw + 1)
    end`
    : `    -- Vertical bar (round): body rect + a band-RLE disc at each end. The
    -- bands losslessly merge the v18 horizontal scanlines, so this is pixel-
    -- identical to the old body+2-discs, just far fewer fillRect calls.
    graphics.fillRect(xc - r, tcy, 2 * r + 1, bcy - tcy)
    drawDisc(bands, xc, tcy)
    drawDisc(bands, xc, bcy)`;
  const drawSegBody = rounded
    ? `-- One "stadium"/octagon segment: the cap bar between two end centres,
-- painted as the cap profile's bands STRETCHED along the segment axis. The
-- body + both caps become one set of ~bands.nb fillRects (no separate body
-- rect, no doubled cap overdraw). round bands are the exact disc RLE
-- (horizontal pixel-identical to v18); polygon bands are a coarse octagon.
-- Endpoints are inset by r+JOINT from the digit corner so perpendicular
-- neighbours stand ~JOINT px apart. Collapsed bar -> a single cap.
local function drawSeg(seg, x, y, w, h, bands, r)
  local h2 = math.floor(h / 2)
  local J = JOINT
  local xl = x + r
  local xr = x + w - r
  local ya = y + r
  local yg = y + h2
  local yd = y + h - r
  if seg == "a" or seg == "g" or seg == "d" then
    local yc = (seg == "a") and ya or ((seg == "g") and yg or yd)
    local lcx = xl + r + J
    local rcx = xr - r - J
    if rcx - lcx > 0 then
      local span = rcx - lcx
      for k = 1, bands.nb do
        local hw = bands.w[k]
        graphics.fillRect(lcx - hw, yc + bands.o[k], span + 2 * hw + 1, bands.h[k])
      end
    else
      drawDisc(bands, math.floor((xl + xr) / 2), yc)
    end
    return
  end
  local xc, yA, yB
  if seg == "f" then
    xc, yA, yB = xl, ya, yg
  elseif seg == "b" then
    xc, yA, yB = xr, ya, yg
  elseif seg == "e" then
    xc, yA, yB = xl, yg, yd
  else
    xc, yA, yB = xr, yg, yd
  end
  local tcy = yA + r + J
  local bcy = yB - r - J
  if bcy - tcy > 0 then
${vertBar}
  else
    drawDisc(bands, xc, math.floor((yA + yB) / 2))
  end
end`
    : `-- Flat rectangle segments (flat cap style): one fillRect per lit
-- segment, no disc caps -- the fewest draw calls = fastest device paint.
-- discHW/r are accepted but unused (drawDigit's signature is constant).
local function drawSeg(seg, x, y, w, h, discHW, r)
  local h2 = math.floor(h / 2)
  local t = math.max(2, math.floor(h / 12))
  if seg == "a" then
    graphics.fillRect(x + t, y, w - 2 * t, t)
  elseif seg == "f" then
    graphics.fillRect(x, y + t, t, h2 - t)
  elseif seg == "b" then
    graphics.fillRect(x + w - t, y + t, t, h2 - t)
  elseif seg == "g" then
    graphics.fillRect(x + t, y + h2 - math.floor(t / 2), w - 2 * t, t)
  elseif seg == "e" then
    graphics.fillRect(x, y + h2, t, h2 - t)
  elseif seg == "c" then
    graphics.fillRect(x + w - t, y + h2, t, h2 - t)
  else
    graphics.fillRect(x + t, y + h - t, w - 2 * t, t)
  end
end`;
  const colOff = ghost
    ? `-- Unlit ("ghost") 7-seg: a full black "8" painted behind every lit digit.
local COL_OFF = 0x000000`
    : `-- (ghost off-segments disabled: COL_OFF and the off-pass are not emitted)`;
  const discPreRound = `  -- Cap radius is frame-constant (dt is): build the scanline-disc profile
  -- once, then run-length-encode equal-width rows into a few bands so a
  -- whole rounded segment is ~discHW.nb fillRects (was 1 + 2*(2r+1)).
  -- Shared across every cap of every digit (ghost + lit passes).
  local r = math.max(1, math.floor(dt / 2))
  local discHW = { nb = 0, o = {}, w = {}, h = {} }
  do
    local prof = {}
    local N = 2 * r + 1
    for dy = -r, r do
      prof[dy + r + 1] = math.floor(math.sqrt(r * r - dy * dy) + 0.5)
    end
    local i = 1
    while i <= N do
      local hw = prof[i]
      local j = i
      while j + 1 <= N and prof[j + 1] == hw do
        j = j + 1
      end
      local k = discHW.nb + 1
      discHW.nb = k
      discHW.o[k] = i - 1 - r
      discHW.w[k] = hw
      discHW.h[k] = j - i + 1
      i = j + 1
    end
  end`;
  // Coarse 3-band octagon: full-width middle, a chamfered slab top & bottom
  // (chamfer depth c ~= r/2). Always exactly 3 bands -> a constant 3
  // fillRects/segment via the stretched-both-axes drawSeg. h sums to 2r+1.
  const discPrePoly = `  -- Polygon cap: a fixed 3-band octagon (no per-row sqrt loop, no RLE).
  local r = math.max(1, math.floor(dt / 2))
  local c = math.max(1, math.floor(r / 2))
  local discHW = {
    nb = 3,
    o = { -r, -r + c, r - c + 1 },
    w = { r - c, r, r - c },
    h = { c, 2 * (r - c) + 1, c }
  }`;
  // Authentic 7-seg/LCD "hexagon" cap: linear-taper half-width (hw = r-|dy|, a
  // straight 45-deg point), RLE'd with the exact same loop as the round disc --
  // only the profile formula differs. The linear profile almost never repeats
  // so nb ~= 2r+1: this is the costliest style, by design (looks over speed).
  const discPreTri = `  -- Triangle cap: exact linear-taper point (authentic 7-seg hexagon),
  -- RLE'd like the round disc; linear profile rarely repeats (nb~=2r+1)
  -- so this is the costliest style. Shared across every cap of every digit.
  local r = math.max(1, math.floor(dt / 2))
  local discHW = { nb = 0, o = {}, w = {}, h = {} }
  do
    local prof = {}
    local N = 2 * r + 1
    for dy = -r, r do
      prof[dy + r + 1] = r - math.abs(dy)
    end
    local i = 1
    while i <= N do
      local hw = prof[i]
      local j = i
      while j + 1 <= N and prof[j + 1] == hw do
        j = j + 1
      end
      local k = discHW.nb + 1
      discHW.nb = k
      discHW.o[k] = i - 1 - r
      discHW.w[k] = hw
      discHW.h[k] = j - i + 1
      i = j + 1
    end
  end`;
  const discPre = !rounded
    ? `  -- flat cap style: drawSeg ignores these; kept for arg parity
  local r = 0
  local discHW = nil`
    : polygon
      ? discPrePoly
      : opts.capStyle === "triangle"
        ? discPreTri
        : discPreRound;
  const ghostMinus = ghost
    ? `    drawDigit(x, yTop, dw, dh, "g", discHW, r, COL_OFF)
`
    : "";
  const ghostDigit = ghost
    ? `    drawDigit(x, yTop, dw, dh, "abcdefg", discHW, r, COL_OFF)
`
    : "";
  return `-- Simularca Surface - generated bundle (split-row, v${SURFACE_BUNDLE_VERSION}, caps=${opts.capStyle}, ghost=${ghost ? "on" : "off"})
local BUNDLE_VERSION = ${SURFACE_BUNDLE_VERSION}
local US = string.char(31)
local RS = string.char(30)
local WIN = 4
local slots = {}
local nslots = 0
local pageOffset = 0
local focusedIdx = nil
local editing = nil
local lastPot = {}
local highlightedKnob = nil
-- v37 touch model: track every held pot in a set so focus only releases when
-- ALL related dials are off (so the user can release the bottom dial without
-- exiting the zoomed editor while still adjusting a top digit knob).
--   touched    - map<potId, bool> of currently-held dials.
--   focusAnchor - bottom potId that started the current focus (5..8). While
--                 set, brush-touches on a DIFFERENT bottom dial are rejected
--                 so an accidental graze can never steal focus.
local touched = {}
local focusAnchor = nil
local function anyBottomHeld()
  for id = 5, 8 do
    if touched[id] then
      return true
    end
  end
  return false
end
local function anyTopHeld()
  for id = 1, 4 do
    if touched[id] then
      return true
    end
  end
  return false
end
local function shouldUnfocus()
  -- Focus persists while any bottom anchor OR any top per-digit knob is held.
  return (not anyBottomHeld()) and (not anyTopHeld())
end
local digitCx = {}
local linkTopY = 0
-- Discrete (toggle/list) rotary sensitivity: accumulate raw encoder delta
-- and only advance one option per DISC_SENS units (~5x less sensitive than
-- one-step-per-callback). On-device tunable.
local DISC_SENS = 5
local discAccum = {}
-- v41: page-change uses its own (lower) gain than the multi-select stepper
-- because a single page is 4 fields, not one option -- 4 detents per page
-- feels right (v39's 2 was too sensitive in practice; 5 was too slow).
-- Wiped alongside discAccum on every recenterAll() so stale partial-pages
-- don't survive a focus / page / surface transition.
local PAGE_SENS = 4
local pageAccum = 0

local function splitc(s, sep)
  local t = {}
  for part in (s .. sep):gmatch("(.-)" .. sep) do
    t[#t + 1] = part
  end
  return t
end

-- ---- digit math (mirror of src/digits.ts) ----
local function msd(v)
  local a = math.abs(v)
  if a < 1 then
    return 0
  end
  return math.floor(math.log(a, 10) + 1e-9)
end

local function minWS(prec)
  return WIN - 1 - prec
end

local function clampWS(ws, v, prec)
  local lo = minWS(prec)
  local hi = math.max(msd(v), lo)
  if ws < lo then
    return lo
  end
  if ws > hi then
    return hi
  end
  return ws
end

local function roundp(v, prec)
  local s = 10 ^ prec
  return math.floor(v * s + 0.5) / s
end

local function clampRange(v, mn, mx)
  if mn ~= nil and v < mn then
    v = mn
  end
  if mx ~= nil and v > mx then
    v = mx
  end
  return v
end

local function digitAt(v, e)
  return math.floor(math.abs(v) / (10 ^ e)) % 10
end

-- ---- colour helpers (RGB <-> HSV, hex parse/format, byte pack) ----
-- All channels are floats in 0..1. Hex strings accept the same shapes the
-- inspector normaliser accepts: 6 or 8 digits, with or without a leading "#".
local function parseHex(s)
  if s == nil then s = "" end
  if string.sub(s, 1, 1) == "#" then s = string.sub(s, 2) end
  local n = #s
  if n ~= 6 and n ~= 8 then
    return 0, 0, 0, 1
  end
  local r = (tonumber(string.sub(s, 1, 2), 16) or 0) / 255
  local g = (tonumber(string.sub(s, 3, 4), 16) or 0) / 255
  local b = (tonumber(string.sub(s, 5, 6), 16) or 0) / 255
  local a = (n == 8) and ((tonumber(string.sub(s, 7, 8), 16) or 255) / 255) or 1
  return r, g, b, a
end

local function fmtHex(r, g, b, a, hasAlpha)
  local function byte(c)
    if c < 0 then c = 0 end
    if c > 1 then c = 1 end
    return math.floor(c * 255 + 0.5)
  end
  if hasAlpha then
    return string.format("#%02x%02x%02x%02x", byte(r), byte(g), byte(b), byte(a))
  end
  return string.format("#%02x%02x%02x", byte(r), byte(g), byte(b))
end

-- Pack 0..1 floats into a 0xRRGGBB integer for graphics.setColor (firmware
-- expects a number, not a hex string -- v31's setColor fix established this).
local function rgbInt(r, g, b)
  local function byte(c)
    if c < 0 then c = 0 end
    if c > 1 then c = 1 end
    return math.floor(c * 255 + 0.5)
  end
  return byte(r) * 65536 + byte(g) * 256 + byte(b)
end

local function rgbToHsv(r, g, b)
  local mx = math.max(r, g, b)
  local mn = math.min(r, g, b)
  local d = mx - mn
  local v = mx
  local s = (mx <= 0) and 0 or (d / mx)
  local h = 0
  if d > 0 then
    if mx == r then
      h = ((g - b) / d) % 6
    elseif mx == g then
      h = (b - r) / d + 2
    else
      h = (r - g) / d + 4
    end
    h = h / 6
    if h < 0 then h = h + 1 end
  end
  return h, s, v
end

local function hsvToRgb(h, s, v)
  if s <= 0 then
    return v, v, v
  end
  local hh = (h % 1) * 6
  local i = math.floor(hh)
  local f = hh - i
  local p = v * (1 - s)
  local q = v * (1 - s * f)
  local t = v * (1 - s * (1 - f))
  if i == 0 then return v, t, p
  elseif i == 1 then return q, v, p
  elseif i == 2 then return p, v, t
  elseif i == 3 then return p, q, v
  elseif i == 4 then return t, p, v
  else return v, p, q
  end
end

-- HSV V is also the encoder-driven "brightness" axis. Refresh the slot's
-- cached H/S whenever R/G/B (or the host) writes a new colour, so a later
-- V-scrub round-trip through V==0 still recovers the user's hue. Returns
-- the freshly cached (h, s).
local function refreshHsCache(f, r, g, b)
  local h, s = rgbToHsv(r, g, b)
  f.cachedH = h
  f.cachedS = s
  return h, s
end

-- ---- 7-segment renderer ----
-- segments: a top, b top-right, c bottom-right, d bottom, e bottom-left,
-- f top-left, g middle.
local SEG = {
  ["0"] = "abcdef",
  ["1"] = "bc",
  ["2"] = "abged",
  ["3"] = "abgcd",
  ["4"] = "fgbc",
  ["5"] = "afgcd",
  ["6"] = "afgecd",
  ["7"] = "abc",
  ["8"] = "abcdefg",
  ["9"] = "abcdfg",
  ["-"] = "g",
  [" "] = ""
}

local function hasSeg(mask, ch)
  return string.find(mask, ch, 1, true) ~= nil
end

${jointDisc}
local ALLSEG = { "a", "b", "c", "d", "e", "f", "g" }

${drawSegBody}

-- offCol ~= nil -> ghost pass: drawDigit owns the colour, paints the given
-- mask in offCol (callers pass the full "8" for digits, "g" for a minus).
-- offCol == nil -> lit pass: the caller already set the colour; never set it.
local function drawDigit(x, y, w, h, mask, discHW, r, offCol)
  if offCol ~= nil then
    graphics.setColor(offCol)
  end
  for i = 1, 7 do
    local seg = ALLSEG[i]
    if hasSeg(mask, seg) then
      drawSeg(seg, x, y, w, h, discHW, r)
    end
  end
end

-- ---- rendering ----
local function fmtValue(f)
  if f == nil then
    return ""
  end
  local s
  if f.kind == "number" then
    local prec = f.prec or 0
    s = string.format("%." .. tostring(prec) .. "f", tonumber(f.value) or 0)
  else
    s = tostring(f.value)
  end
  -- Mini-view + non-editing centered text get the unit suffix automatically
  -- (the editing 7-seg path renders units via drawUnit instead).
  if f.unit ~= nil and f.unit ~= "" then
    s = s .. " " .. f.unit
  end
  return s
end

local function nameOf(id, text)
  local c = controls.get(id)
  if c ~= nil then
    c:setName(text)
    c:repaint()
  end
end

local function renderRows()
  -- value row (ids 5-8) shows the 4 fields at pageOffset
  for i = 0, 3 do
    local abs = pageOffset + i
    local f = slots[abs]
    if f == nil then
      nameOf(5 + i, "")
    else
      local mark = (focusedIdx == abs) and "> " or ""
      nameOf(5 + i, mark .. f.label .. ": " .. fmtValue(f))
    end
  end
  -- detail row (ids 1-4)
  local f = focusedIdx ~= nil and slots[focusedIdx] or nil
  if f == nil then
    for i = 1, 4 do
      nameOf(i, "")
    end
  elseif f.kind == "number" and editing ~= nil then
    for k = 0, 3 do
      nameOf(1 + k, f.label)
    end
  elseif f.kind == "color" and editing ~= nil then
    -- Top-row encoders bind to R/G/B/{A,V}: alpha if the param declared it,
    -- otherwise HSV V (the same brightness axis as the un-zoomed bottom
    -- encoder, surfaced here for fine control).
    nameOf(1, "R")
    nameOf(2, "G")
    nameOf(3, "B")
    nameOf(4, editing.hasAlpha and "A" or "V")
  elseif f.kind == "list" and f.opts ~= nil then
    local cur = tonumber(f.value) or 0
    for k = 0, 3 do
      local oi = cur - 1 + k
      local label = (f.opts[oi + 1] ~= nil) and f.opts[oi + 1] or ""
      nameOf(1 + k, (oi == cur and "[" .. label .. "]" or label))
    end
  elseif f.kind == "toggle" then
    nameOf(1, f.value == "1" and "[ON]" or "ON")
    nameOf(2, f.value == "0" and "[OFF]" or "OFF")
    nameOf(3, "")
    nameOf(4, "")
  else
    for i = 1, 4 do
      nameOf(i, "")
    end
  end
end

local DETAIL_CX = { ${COLS.map((c) => c + Math.floor(CTRL_W / 2)).join(", ")} }
local COL_NORMAL = 0x6fd0ff
local COL_GREY = 0x33455c
local COL_HI = 0xffffff
-- Non-selected picker cell fill: the scrollbar-track dark, so the
-- COL_NORMAL label on top stays readable.
local COL_CELL_BG = 0x223044
${colOff}

-- Scale a 0xRRGGBB colour's brightness by pct (per channel). Used to dim
-- the non-touched digits while a digit encoder is held.
local function dim(rgb, pct)
  local r = math.floor(math.floor(rgb / 65536) % 256 * pct)
  local g = math.floor(math.floor(rgb / 256) % 256 * pct)
  local b = math.floor(rgb % 256 * pct)
  return r * 65536 + g * 256 + b
end

-- Draw the focused number as a big adaptive 7-seg "digit window": the 4
-- knob-controlled places plus the rest of the number; places outside the
-- value's significant range are greyed zeros; the touched digit is bright.
-- Records each knob digit's centre-x in digitCx for the link lines.
-- NOTE: a custom control's paint callback draws in coordinates RELATIVE to
-- the control's own bounds (0,0 = control top-left), not absolute screen.
-- BAND_H is the control height; everything here is 0..BAND_H.
local BANDH = ${BAND_H}

-- ---- toggle / enum picker cells ----
-- No stroke primitive on the device: a border is 4 thin fillRects (the
-- drawDigit precedent). Active cell is filled bright, so its label is drawn
-- in the background colour (white-on-white guard).
local function cellRect(x, y, w, h, active)
  graphics.setColor(active and COL_HI or COL_CELL_BG)
  graphics.fillRect(x, y, w, h)
  graphics.setColor(active and COL_HI or COL_NORMAL)
  local bt = 3
  graphics.fillRect(x, y, w, bt)
  graphics.fillRect(x, y + h - bt, w, bt)
  graphics.fillRect(x, y, bt, h)
  graphics.fillRect(x + w - bt, y, bt, h)
end

local function cellLabel(x, y, w, h, text, active)
  graphics.setColor(active and 0x0a0f17 or COL_NORMAL)
  graphics.print(x, y + math.floor(h / 2) - 8, text, w, CENTER)
end

local function drawToggle(f)
  local on = (f.value == "1")
  local areaTop = 40
  local areaH = (BANDH - 30) - areaTop
  local GAP = 10
  local cw = math.floor((760 - GAP) / 2)
  local ch = math.min(areaH, 84)
  local cy = areaTop + math.floor((areaH - ch) / 2)
  local x0 = 20
  cellRect(x0, cy, cw, ch, not on)
  cellLabel(x0, cy, cw, ch, "OFF", not on)
  local x1 = x0 + cw + GAP
  cellRect(x1, cy, cw, ch, on)
  cellLabel(x1, cy, cw, ch, "ON", on)
end

local function drawEnum(f)
  local n = #f.opts
  if n <= 0 then
    graphics.setColor(COL_NORMAL)
    graphics.print(0, math.floor(BANDH / 2) - 8, fmtValue(f), 800, CENTER)
    return
  end
  local cur = tonumber(f.value) or 0
  local areaTop = 40
  local areaH = (BANDH - 30) - areaTop
  local GAP = 10
  local cols = (n <= 4) and n or 4
  local rows = math.floor((n + cols - 1) / cols)
  local cw = math.floor((760 - (cols - 1) * GAP) / cols)
  local rh = math.floor((areaH - (rows - 1) * GAP) / rows)
  if rh > 64 then
    rh = 64
  end
  local gh = rows * rh + (rows - 1) * GAP
  local gy0 = areaTop + math.floor((areaH - gh) / 2)
  for oi = 0, n - 1 do
    local r = math.floor(oi / cols)
    local c = oi % cols
    local inRow = n - r * cols
    if inRow > cols then
      inRow = cols
    end
    local rowW = inRow * cw + (inRow - 1) * GAP
    local rx0 = math.floor((800 - rowW) / 2)
    local x = rx0 + c * (cw + GAP)
    local y = gy0 + r * (rh + GAP)
    local active = (oi == cur)
    cellRect(x, y, cw, rh, active)
    cellLabel(x, y, cw, rh, f.opts[oi + 1] or "", active)
  end
end

-- ---- colour focused painter ----
-- Big colour swatch up top (full width) + four channel columns underneath
-- centred on the top-row encoders. Letters R/G/B/{A,V} above each column;
-- vertical bar filled bottom-up by the channel value; numeric 0..100 below.
-- Alpha is shown by the A column when present; when absent, the 4th column
-- is the V (brightness) axis -- the same axis the un-zoomed bottom-row
-- encoder scrubs, surfaced here for fine control.
local function drawChannelColumn(letter, ratio, cx, top, w, h)
  -- Title letter (top stub).
  graphics.setColor(0x9fb4cf)
  graphics.print(cx - math.floor(w / 2), top, letter, w, CENTER)
  -- Bar track (dim background) + bright bottom-up fill.
  local barX = cx - math.floor(w / 2) + 6
  local barW = w - 12
  local barTop = top + 22
  local barH = h - 44
  graphics.setColor(COL_GREY)
  graphics.fillRect(barX, barTop, barW, barH)
  local r = ratio
  if r < 0 then r = 0 end
  if r > 1 then r = 1 end
  local fillH = math.floor(barH * r)
  graphics.setColor(COL_NORMAL)
  graphics.fillRect(barX, barTop + barH - fillH, barW, fillH)
  -- Percent readout.
  graphics.setColor(COL_NORMAL)
  graphics.print(cx - math.floor(w / 2), top + h - 18, tostring(math.floor(r * 100 + 0.5)) .. "%", w, CENTER)
end

local function drawColor(f)
  local r, g, b, a = parseHex(f.value)
  local hasAlpha = f.hasAlpha == true
  -- Swatch band at the top of the readout area. Use the un-modulated RGB
  -- (alpha is shown numerically by the A column rather than blended -- the
  -- device has no checkerboard primitive to make blending readable).
  local swTop = 22
  local swH = math.floor((BANDH - 50) * 0.42)
  graphics.setColor(rgbInt(r, g, b))
  graphics.fillRect(20, swTop, 760, swH)
  -- Thin border so the swatch reads as a control, not a background flood.
  local bt = 3
  graphics.setColor(COL_NORMAL)
  graphics.fillRect(20, swTop, 760, bt)
  graphics.fillRect(20, swTop + swH - bt, 760, bt)
  graphics.fillRect(20, swTop, bt, swH)
  graphics.fillRect(20 + 760 - bt, swTop, bt, swH)
  -- Channel columns, centred under the top-row encoders.
  local colTop = swTop + swH + 10
  local colH = BANDH - 28 - colTop
  local colW = 160
  local fourth = hasAlpha and a or select(3, rgbToHsv(r, g, b))
  drawChannelColumn("R", r, DETAIL_CX[1], colTop, colW, colH)
  drawChannelColumn("G", g, DETAIL_CX[2], colTop, colW, colH)
  drawChannelColumn("B", b, DETAIL_CX[3], colTop, colW, colH)
  drawChannelColumn(hasAlpha and "A" or "V", fourth, DETAIL_CX[4], colTop, colW, colH)
end

-- ---- unit glyph rendering ----
-- A curated 7-seg-styled glyph set aligned with the digit row in
-- drawReadout. Any unit token NOT in the table falls back to firmware text
-- via graphics.print, so the wire stays unconstrained while the common
-- units (m, deg, x, s, d) get a glyph that matches the digit style.
-- WIRE NOTE: SSP payloads are 7-bit ASCII (sanitizeToken strips bytes > 0x7E),
-- so non-ASCII unit characters never reach here. The host sends the ASCII
-- token "deg" for rotation; we render the degree symbol below.
local function drawDegree(x, y, w, h)
  -- Small filled square at the top-centre of the slot (~h/5).
  local sz = math.max(3, math.floor(math.min(w, h) / 5))
  graphics.fillRect(x + math.floor((w - sz) / 2), y, sz, sz)
end

local function drawM(x, y, w, h)
  -- Lowercase "m": three short verticals from the middle down to the bottom,
  -- joined by a thin bar across the top of the lower half.
  local t = math.max(2, math.floor(h / 10))
  local h2 = math.floor(h / 2)
  graphics.fillRect(x, y + h2, w, t)
  graphics.fillRect(x, y + h2, t, h - h2)
  graphics.fillRect(x + math.floor((w - t) / 2), y + h2, t, h - h2)
  graphics.fillRect(x + w - t, y + h2, t, h - h2)
end

local function drawX(x, y, w, h)
  -- Axis-aligned "x" -- two stepped diagonals built from small fillRects (the
  -- device has no diagonal primitive).
  local t = math.max(2, math.floor(h / 10))
  local steps = math.max(3, math.floor(math.min(w, h) / t))
  local sx = math.floor((w - t) / (steps - 1))
  local sy = math.floor((h - t) / (steps - 1))
  for i = 0, steps - 1 do
    graphics.fillRect(x + i * sx, y + i * sy, t, t)
    graphics.fillRect(x + (steps - 1 - i) * sx, y + i * sy, t, t)
  end
end

-- Caller owns colour (so the highlight/dim state still applies). Falls
-- through to firmware text for unrecognised tokens (m/s, 1/s, px, %, ...).
local function drawUnit(unit, x, y, w, h, discHW, r)
  if unit == nil or unit == "" then
    return
  end
  if unit == "deg" then
    drawDegree(x, y, w, h)
  elseif unit == "m" then
    drawM(x, y, w, h)
  elseif unit == "x" then
    drawX(x, y, w, h)
  elseif unit == "s" or unit == "S" then
    drawDigit(x, y, w, h, "afgcd", discHW, r)
  elseif unit == "d" then
    drawDigit(x, y, w, h, "bcdeg", discHW, r)
  else
    graphics.print(x, y + math.floor(h / 2) - 8, unit, w, CENTER)
  end
end

-- ---- 4-column mini-view (unfocused/empty state) ----
-- Painted in the centre band when no field is focused. One column per
-- currently-visible bottom-row field (pageOffset + 0..3), x-aligned with
-- the value encoders beneath.
--
-- Per kind:
--   toggle   -> drawMiniOptionList({"OFF","ON"}, sel)
--   list     -> drawMiniOptionList(f.opts, sel)  (labels, not indices)
--   number,  ranged   -> drawMiniRangedNumber: dim full-column bar +
--                        bright bottom-up fill + mini 7-seg digits on top
--   number,  rangeless -> drawMiniNumber: mini 7-seg only
--   other    -> graphics.print fmtValue (text fallback)
--
-- All glyphs use a self-contained flat-cap 7-seg painter (drawMiniSeg/
-- drawMiniDigit) so the main readout's chosen capStyle does NOT propagate
-- here -- rounded caps are invisible at this size anyway, and skipping
-- discHW/bands keeps the mini-view loop tight and the code isolated.

-- Flat-cap 7-segment painter for mini digits. t = stroke thickness.
local function drawMiniSeg(seg, x, y, w, h, t)
  local h2 = math.floor(h / 2)
  if seg == "a" then
    graphics.fillRect(x + t, y, w - 2 * t, t)
  elseif seg == "f" then
    graphics.fillRect(x, y + t, t, h2 - t)
  elseif seg == "b" then
    graphics.fillRect(x + w - t, y + t, t, h2 - t)
  elseif seg == "g" then
    graphics.fillRect(x + t, y + h2 - math.floor(t / 2), w - 2 * t, t)
  elseif seg == "e" then
    graphics.fillRect(x, y + h2, t, h2 - t)
  elseif seg == "c" then
    graphics.fillRect(x + w - t, y + h2, t, h2 - t)
  else
    graphics.fillRect(x + t, y + h - t, w - 2 * t, t)
  end
end

local function drawMiniDigit(x, y, w, h, mask, t)
  for i = 1, 7 do
    local seg = ALLSEG[i]
    if hasSeg(mask, seg) then
      drawMiniSeg(seg, x, y, w, h, t)
    end
  end
end

-- Mini 7-seg display for a number field. Caller owns colour. Sizes digits
-- to fit w x h; treats decimal point as a small square and minus as the
-- middle segment only (matches the main readout's conventions).
local function drawMini7Seg(f, x, y, w, h)
  local prec = f.prec or 0
  local s = string.format("%." .. tostring(prec) .. "f", tonumber(f.value) or 0)
  local n = #s
  local dh = math.min(h - 4, 40)
  local dw = math.floor(dh * 0.55)
  if dw < 4 then dw = 4 end
  local gap = math.max(2, math.floor(dw * 0.18))
  local total = n * dw + (n - 1) * gap
  if total > w then
    local scale = w / total
    dw = math.max(3, math.floor(dw * scale))
    dh = math.max(6, math.floor(dh * scale))
    gap = math.max(1, math.floor(gap * scale))
    total = n * dw + (n - 1) * gap
  end
  local dt = math.max(2, math.floor(dh / 8))
  local sx = x + math.floor((w - total) / 2)
  local sy = y + math.floor((h - dh) / 2)
  for k = 1, n do
    local ch = s:sub(k, k)
    if ch == "." then
      graphics.fillRect(sx, sy + dh - dt * 2, dt * 2, dt * 2)
      sx = sx + dt * 2 + gap
    elseif ch == "-" then
      drawMiniDigit(sx, sy, dw, dh, "g", dt)
      sx = sx + dw + gap
    else
      drawMiniDigit(sx, sy, dw, dh, SEG[ch] or "", dt)
      sx = sx + dw + gap
    end
  end
end

-- Ranged number: dim full-column bar (the 100% baseline) + bright bottom-up
-- fill by value-ratio + mini 7-seg digits overlaid centred. White digits
-- read clearly over both the dim and the bright portions.
local function drawMiniRangedNumber(f, x, y, w, h)
  local v = tonumber(f.value) or 0
  local ratio = (v - f.mn) / (f.mx - f.mn)
  if ratio < 0 then ratio = 0 end
  if ratio > 1 then ratio = 1 end
  graphics.setColor(COL_GREY)
  graphics.fillRect(x, y, w, h)
  local fillH = math.floor(h * ratio)
  graphics.setColor(0x44607f)
  graphics.fillRect(x, y + h - fillH, w, fillH)
  graphics.setColor(COL_HI)
  drawMini7Seg(f, x, y, w, h)
end

local function drawMiniNumber(f, x, y, w, h)
  graphics.setColor(COL_NORMAL)
  drawMini7Seg(f, x, y, w, h)
end

-- Mini swatch + brightness bar. The brightness bar is the same HSV V axis
-- the un-zoomed bottom-row encoder scrubs, so the indicator reads as
-- "what this encoder does" rather than as a redundant value display.
local function drawMiniColor(f, x, y, w, h)
  local r, g, b, a = parseHex(f.value)
  local _, _, v = rgbToHsv(r, g, b)
  -- Top ~75% of the cell is the swatch with a thin border.
  local swH = math.max(16, math.floor(h * 0.72))
  graphics.setColor(rgbInt(r, g, b))
  graphics.fillRect(x, y, w, swH)
  local bt = 2
  graphics.setColor(COL_NORMAL)
  graphics.fillRect(x, y, w, bt)
  graphics.fillRect(x, y + swH - bt, w, bt)
  graphics.fillRect(x, y, bt, swH)
  graphics.fillRect(x + w - bt, y, bt, swH)
  -- Brightness bar underneath: dim track + bright bottom-up fill by V.
  local barTop = y + swH + 4
  local barH = math.max(4, h - swH - 4 - 14)
  graphics.setColor(COL_GREY)
  graphics.fillRect(x, barTop, w, barH)
  local fillW = math.floor(w * (v < 0 and 0 or (v > 1 and 1 or v)))
  graphics.setColor(COL_NORMAL)
  graphics.fillRect(x, barTop, fillW, barH)
  -- Alpha hint: when present and not opaque, show "Aa%" caption underneath.
  if f.hasAlpha == true and a < 0.999 then
    graphics.setColor(0x9fb4cf)
    graphics.print(x, barTop + barH + 1, "A " .. tostring(math.floor(a * 100 + 0.5)) .. "%", w, CENTER)
  end
end

-- Full-width vertical option list: one row per option, selected one
-- highlighted (filled background + inverted text). Wraps to 2 sub-columns
-- inside the field's mini-cell when there are too many rows to fit.
-- Shows OPTION LABELS, not numeric indices.
local function drawMiniOptionList(opts, sel, x, y, w, h)
  local n = #opts
  if n == 0 then return end
  local rowH = 16
  local maxRows = math.max(1, math.floor(h / rowH))
  local cols = (n > maxRows) and 2 or 1
  local rowsPerCol = math.ceil(n / cols)
  local colW = math.floor(w / cols)
  for j = 1, n do
    local col = math.floor((j - 1) / rowsPerCol)
    local row = (j - 1) % rowsPerCol
    local rx = x + col * colW
    local ry = y + row * rowH
    local active = (j == sel)
    if active then
      graphics.setColor(COL_NORMAL)
      graphics.fillRect(rx, ry, colW, rowH)
    end
    graphics.setColor(active and 0x0a0f17 or COL_NORMAL)
    graphics.print(rx, ry + math.floor(rowH / 2) - 8, opts[j], colW, CENTER)
  end
end

local function drawMiniView()
  local CW = 184
  local labelY = 2
  local indY = 18
  local indH = BANDH - indY - 24 -- leave bottom 24 px for the scrollbar
  for i = 0, 3 do
    local abs = pageOffset + i
    local f = slots[abs]
    if f ~= nil then
      local cx = i * 200 + 8
      graphics.setColor(0x9fb4cf)
      graphics.print(cx, labelY, f.label, CW, CENTER)
      if f.kind == "toggle" then
        local sel = (f.value == "1") and 2 or 1
        drawMiniOptionList({ "OFF", "ON" }, sel, cx, indY, CW, indH)
      elseif f.kind == "list" and f.opts ~= nil then
        local sel = (tonumber(f.value) or 0) + 1
        drawMiniOptionList(f.opts, sel, cx, indY, CW, indH)
      elseif f.kind == "number" then
        if f.mn ~= nil and f.mx ~= nil and f.mx > f.mn then
          drawMiniRangedNumber(f, cx, indY, CW, indH)
        else
          drawMiniNumber(f, cx, indY, CW, indH)
        end
      elseif f.kind == "color" then
        drawMiniColor(f, cx, indY, CW, indH)
      else
        graphics.setColor(COL_NORMAL)
        graphics.print(cx, indY + math.floor(indH / 2) - 8, fmtValue(f), CW, CENTER)
      end
    end
  end
end

local function drawReadout()
  digitCx = {}
  local f = focusedIdx ~= nil and slots[focusedIdx] or nil
  if f == nil then
    drawMiniView()
    return
  end
  -- v37 colour shift: when the bottom anchor has been released but a top
  -- per-digit knob is still held, fade out everything OTHER than the touched
  -- digit so the focus visibly collapses onto "the one digit I'm editing".
  -- (Focus persists until ALL touches release -- see onPotTouchChange.)
  local digitOnlyMode = (not anyBottomHeld()) and anyTopHeld()
  -- Non-touched dim ratio: 50% in normal touch-on, 25% in digitOnlyMode.
  local dimOther = digitOnlyMode and 0.25 or 0.5
  -- The variable title is shown on the 4 digit-place knob controls for
  -- numbers, so the readout heading is only drawn for non-number fields.
  if not (f.kind == "number" and editing ~= nil) then
    local labelCol = 0x9fb4cf
    if digitOnlyMode then
      labelCol = dim(labelCol, 0.3)
    end
    graphics.setColor(labelCol)
    graphics.print(0, 2, f.label, 800, CENTER)
  end
  if f.kind == "toggle" then
    drawToggle(f)
    return
  end
  if f.kind == "list" and f.opts ~= nil then
    drawEnum(f)
    return
  end
  if f.kind == "color" then
    drawColor(f)
    return
  end
  if f.kind ~= "number" or editing == nil then
    graphics.setColor(COL_NORMAL)
    graphics.print(0, math.floor(BANDH / 2) - 8, fmtValue(f), 800, CENTER)
    return
  end
  local v = editing.value
  local prec = editing.prec or 0
  local vmsd = math.max(msd(v), 0)
  local topE = math.max(editing.ws, vmsd, 0)
  local botE = math.min(editing.ws - 3, -prec)
  local count = (topE - botE + 1) + (v < 0 and 1 or 0) + ((prec > 0) and 1 or 0)
  local areaTop = 22
  local areaBot = BANDH - 28
  local areaH = areaBot - areaTop
  local maxW = math.floor(760 / count)
  local dw = math.min(math.floor(areaH * 0.62), maxW)
  if dw < 8 then
    dw = 8
  end
  local dh = math.min(areaH, math.floor(dw / 0.58))
  local dt = math.max(3, math.floor(dh / 12))
  local gap = math.max(4, math.floor(dw * 0.28))
${discPre}
  local total = -gap
  if v < 0 then
    total = total + dw + gap
  end
  for e = topE, botE, -1 do
    total = total + dw + gap
    if e == 0 and prec > 0 then
      total = total + dt * 2 + gap
    end
  end
  local x = math.floor((800 - total) / 2)
  local yTop = areaTop + math.floor((areaH - dh) / 2)
  linkTopY = yTop
  if v < 0 then
${ghostMinus}    graphics.setColor(highlightedKnob ~= nil and dim(COL_NORMAL, dimOther) or COL_NORMAL)
    drawDigit(x, yTop, dw, dh, "g", discHW, r)
    x = x + dw + gap
  end
  for e = topE, botE, -1 do
    local d = digitAt(v, e)
    local outOfRange = (e > vmsd) or (e < -prec)
    local knob = nil
    if e <= editing.ws and e >= editing.ws - 3 then
      knob = editing.ws - e
    end
    local selected = (knob ~= nil and knob == highlightedKnob)
    local col = COL_NORMAL
    if selected then
      col = COL_HI
    elseif outOfRange then
      col = COL_GREY
    end
    -- When a digit encoder is touched, dim every non-touched digit so the
    -- selected one stands out -- 50% in normal touch-on, 25% in
    -- digitOnlyMode (bottom released, top still held) for a stronger
    -- "this is the one I'm editing" emphasis.
    if highlightedKnob ~= nil and not selected then
      col = dim(col, dimOther)
    end
${ghostDigit}    graphics.setColor(col)
    drawDigit(x, yTop, dw, dh, SEG[tostring(d)] or "", discHW, r)
    if knob ~= nil then
      digitCx[knob] = x + math.floor(dw / 2)
    end
    x = x + dw + gap
    if e == 0 and prec > 0 then
      local dpc = outOfRange and COL_GREY or COL_NORMAL
      if highlightedKnob ~= nil then
        dpc = dim(dpc, dimOther)
      end
      graphics.setColor(dpc)
      graphics.fillRect(x, yTop + dh - dt * 2, dt * 2, dt * 2)
      x = x + dt * 2 + gap
    end
  end
  -- Unit glyph slot, right of the rightmost digit. Sized ~60% of digit width
  -- so it reads as an annotation rather than a digit. Inherits the normal
  -- colour (dimmed when any knob is touched, matching the digit row).
  if f.unit ~= nil and f.unit ~= "" then
    local uw = math.floor(dw * 0.6)
    local uc = COL_NORMAL
    if highlightedKnob ~= nil then
      uc = dim(uc, dimOther)
    end
    graphics.setColor(uc)
    drawUnit(f.unit, x, yTop, uw, dh, discHW, r)
    x = x + uw + gap
  end
  -- Vertical range bar to the right of the digit row + any unit glyph. Dim
  -- background represents the full 100% range; bright bottom-up fill shows
  -- the current value's position. Only painted when min/max are set.
  if f.mn ~= nil and f.mx ~= nil and f.mx > f.mn then
    local v = tonumber(f.value) or 0
    local ratio = (v - f.mn) / (f.mx - f.mn)
    if ratio < 0 then ratio = 0 end
    if ratio > 1 then ratio = 1 end
    local barW = 12
    local barX = x
    graphics.setColor(COL_GREY)
    graphics.fillRect(barX, yTop, barW, dh)
    local fillH = math.floor(dh * ratio)
    graphics.setColor(COL_NORMAL)
    graphics.fillRect(barX, yTop + dh - fillH, barW, fillH)
  end
end

function paint()
  graphics.setColor(0x0a0f17)
  graphics.fillRect(0, 0, 800, BANDH)
  drawReadout()
  -- link lines (control-relative): a 6px vertical stub at the top aligned
  -- with the rotary control, a diagonal across, then a 6px vertical stub
  -- aligned with the digit whose bottom sits 5px above the digit top.
  local linkDigitOnly = (not anyBottomHeld()) and anyTopHeld()
  for k = 0, 3 do
    local cx = digitCx[k]
    local ex = DETAIL_CX[k + 1]
    if cx ~= nil and ex ~= nil then
      local linkCol
      if k == highlightedKnob then
        linkCol = COL_HI
      else
        linkCol = linkDigitOnly and dim(0x44607f, 0.4) or 0x44607f
      end
      graphics.setColor(linkCol)
      local botY = linkTopY - 5 -- 5px above the digit top
      local botY0 = botY - 6 -- bottom stub is 6px tall
      graphics.drawLine(ex, 0, ex, 6) -- top vertical stub (6px)
      graphics.drawLine(ex, 6, cx, botY0) -- diagonal between the stubs
      graphics.drawLine(cx, botY0, cx, botY) -- bottom vertical stub (6px)
    end
  end
  -- scrollbar
  local total = nslots
  local tx, tw = 60, 680
  local sy = BANDH - 22
  graphics.setColor(0x223044)
  graphics.fillRect(tx, sy, tw, 8)
  if total > 0 then
    local visible = 4
    local thumbW = tw
    local thumbX = tx
    if total > visible then
      thumbW = math.max(24, math.floor(tw * visible / total))
      local maxOff = total - visible
      thumbX = tx + math.floor((tw - thumbW) * (pageOffset / maxOff))
    end
    graphics.setColor(0x6fd0ff)
    graphics.fillRect(thumbX, sy, thumbW, 8)
    local a = pageOffset + 1
    local b = math.min(pageOffset + visible, total)
    graphics.setColor(0x6f86a8)
    graphics.print(0, sy + 12, tostring(a) .. "-" .. tostring(b) .. " / " .. tostring(total), 800, CENTER)
  end
end

local function repaint()
  local c = controls.get(9)
  if c ~= nil then
    c:repaint()
  end
  renderRows()
end

-- ---- device->host SSP transport ----
-- Self-emitted SysEx -- NO firmware-logger dependency (unlike print(), which
-- is dead on fw v4.1.4: the logger never delivers Log SysEx even when the
-- host enables it).
-- THE PORT ARG MUST BE THE NUMERIC INDEX 0, *NOT* PORT_CTRL. Hardware-
-- verified on Electra Mini fw v4.1.4 via the live probe matrix: PORT_CTRL
-- is NOT a defined global in this firmware Lua env, so the pcall'd
-- midi.sendSysex(PORT_CTRL, t) threw "attempt to call with a nil value"
-- and every device->host message was silently dropped -- the entire reason
-- device->app editing never worked. Port 0 is the host-facing "Electra
-- Controller" USB port (host listens there). Ports 1/2 and PORT_USB_DEV do
-- not reach the host.
-- midi.sendSysex AUTO-FRAMES with F0..F7 (firmware-confirmed) and rejects
-- bytes > 0x7F, so the table is the INNER bytes only: prototype manufacturer
-- id 0x7D + magic "SSP" (0x53,0x53,0x50) + the terse ASCII line. The SSP
-- grammar is structurally 7-bit (0x20..0x7E), so every byte is SysEx-legal --
-- no escaping. Payloads >=64 chars verified intact. Host decodes via
-- parseSspSysex() in electraSysex.ts; the wire form is
-- F0 7D 53 53 50 <ascii> F7. Defined before its first use (focusSlot) -- a
-- local declared later would resolve to a nil global.
local SSP_PORT = 0
local function sspEmit(s)
  local t = { 0x7D, 0x53, 0x53, 0x50 }
  for i = 1, #s do
    t[#t + 1] = string.byte(s, i)
  end
  pcall(function()
    midi.sendSysex(SSP_PORT, t)
    if midi.flush ~= nil then
      midi.flush()
    end
  end)
end

-- ---- focus / editing ----
local function buildEditing(abs)
  local f = slots[abs]
  if f == nil then
    editing = nil
    return
  end
  if f.kind == "color" then
    -- Drilled colour: top-row encoders 1-4 edit R/G/B and (alpha OR HSV V).
    -- Cache H/S on the slot so V scrubbing past 0 still recovers the hue.
    local r, g, b, a = parseHex(f.value)
    local h, s, v = rgbToHsv(r, g, b)
    if f.cachedH == nil then f.cachedH = h end
    if f.cachedS == nil then f.cachedS = s end
    editing = {
      kind = "color",
      r = r, g = g, b = b, a = a, v = v,
      h = f.cachedH, s = f.cachedS,
      hasAlpha = f.hasAlpha == true
    }
    return
  end
  if f.kind ~= "number" then
    editing = nil
    return
  end
  local v = tonumber(f.value) or 0
  local prec = f.prec or 0
  editing = { value = v, prec = prec, mn = f.mn, mx = f.mx }
  editing.ws = clampWS(v == 0 and 0 or msd(v), v, prec)
end

-- Electra value model (hardware-verified on fw v4.1.4 via the live debug
-- bridge): controls.get(id) -> Control, which has NO setValue. Control:
-- getValue() -> ControlValue, whose overrideValue() is VISUAL-ONLY (it does
-- NOT move the logical value the pot accumulates from -- probed: getValue
-- stayed 17 after overrideValue(64)). ControlValue:getMessage() -> Message,
-- and Message:setValue(v) writes the LOGICAL value (probed: a fader went
-- 17 -> 64). So the endless-encoder mid-reset MUST go through the Message.
-- The previous code called setValue on the Control itself -- a nil method,
-- silently eaten by pcall -- which is why recenter never did anything.
local function setPotMid(id)
  return pcall(function()
    local c = controls.get(id)
    if c ~= nil then
      c:getValue():getMessage():setValue(64)
    end
  end)
end

-- Snap every rotary (ids 1-8) back to the differential mid so the next delta
-- starts from a known centre and the fader can travel either way before
-- pinning. lastPot is re-seeded BEFORE setValue: Message:setValue may
-- synchronously re-enter valueChanged, and with lastPot already 64 that echo
-- is delta==0 and returns harmlessly (no recursion, no phantom delta).
-- discAccum is wiped: a surface/page/focus change invalidates any in-progress
-- discrete step. Declared before its earliest caller (focusSlot) -- a local
-- referenced before its declaration resolves to a nil global.
local function recenterAll()
  for id = 1, 8 do
    lastPot[id] = 64
    setPotMid(id)
  end
  discAccum = {}
  pageAccum = 0
end

-- Mode-switching encoder reconfig. Unfocused (zoomed-out): top-left encoder
-- is the Page selector (renamed, bounds set to the current page count via
-- Message:setMin/setMax if the firmware exposes them); top encoders 2-4 are
-- hidden because their detailChanged handlers no-op in this mode. Focused
-- (zoomed-in): restore all four to their digit-editor roles. Wrapped in
-- pcall: setVisible / setMin / setMax are unverified on fw v4.1.4 and a
-- nil call would throw; the bundle's own notes warn that setVisible(false)
-- on a fader can disable its rotation callback -- we restore visibility on
-- every entry into focused mode to guard. Declared BEFORE focusSlot (its
-- earliest caller) -- a local referenced before its declaration would
-- resolve to a nil global at call time.
local function reconfigureEncoders()
  pcall(function()
    if focusedIdx == nil then
      local c1 = controls.get(1)
      if c1 ~= nil then
        c1:setName("Page")
        -- v37: if the previous focus was a list/toggle, the focused arm
        -- hid encoder 1 along with 2-4. Re-show it explicitly here so the
        -- Page control is always available in zoomed-out view -- the
        -- rename alone is invisible on a hidden control.
        c1:setVisible(true)
      end
      for id = 2, 4 do
        local c = controls.get(id)
        if c ~= nil then
          c:setVisible(false)
        end
      end
      -- Mid-park encoder 1 (the same way recenterAll does for every other
      -- encoder) so the next rotation has 63 detents of headroom in either
      -- direction. Paging is delta-based in detailChanged below -- the
      -- absolute value is irrelevant, only the per-turn delta matters.
      pcall(function()
        local m = c1:getValue():getMessage()
        m:setValue(64)
        lastPot[1] = 64
      end)
    else
      -- v37: list/toggle in zoomed-in hide ALL top encoders. They had no
      -- meaningful function there (the bottom main encoder steps options)
      -- and removing them removes the option-label clutter at the top.
      local f = slots[focusedIdx]
      local hideAllTop = (f ~= nil and (f.kind == "list" or f.kind == "toggle"))
      local c1 = controls.get(1)
      if c1 ~= nil then
        c1:setName("")
      end
      if hideAllTop then
        for id = 1, 4 do
          local c = controls.get(id)
          if c ~= nil then
            c:setVisible(false)
          end
        end
      else
        -- All four top encoders are visible: encoder 1 is the digit-window
        -- pan (number) or R channel (color), encoders 2-4 are the digit-place
        -- editors (number) or G/B/A|V (color). Explicitly re-show encoder 1
        -- in case the prior focus was a list/toggle that hid it.
        for id = 1, 4 do
          local c = controls.get(id)
          if c ~= nil then
            c:setVisible(true)
          end
        end
        pcall(function()
          local m = c1:getValue():getMessage()
          m:setValue(64)
          lastPot[1] = 64
        end)
      end
    end
  end)
end

-- v37 context-swap: the Reset pad (id 12) is visible ONLY when we're
-- zoomed-in onto a field that declares a default. Wrapped in pcall because
-- setVisible on pads is unverified on fw v4.1.4; if the firmware ignores it
-- the pad will simply be always-present but inert when the focused field has
-- no default (the btnReset handler short-circuits in that case).
local function reconfigureButtons()
  pcall(function()
    local reset = controls.get(12)
    if reset == nil then
      return
    end
    local show = false
    if focusedIdx ~= nil then
      local f = slots[focusedIdx]
      show = (f ~= nil and f.hasDefault == true)
    end
    reset:setVisible(show)
  end)
end

-- v42: faders are visually a "hack" -- the real UI is the custom centre
-- band. Bottom-row faders (ids 5-8) glow when their visible slot's value
-- diverges from a declared default, and recede otherwise -- giving an
-- at-a-glance map of "what's been edited" across the visible page. Top
-- row stays at the preset JSON's dark baseline (those encoders aren't 1:1
-- with slots -- they're the page selector / digit-place / channel /
-- option stepper).
local FADER_COL_DARK = 0x33455C   -- matches COL_GREY + the JSON baseline
local FADER_COL_BRIGHT = 0x6FD0FF -- matches COL_NORMAL
local function refreshSlotColors()
  for id = 5, 8 do
    local abs = pageOffset + (id - 5)
    local f = slots[abs]
    local bright = (f ~= nil
                    and f.hasDefault == true
                    and f.defaultValue ~= nil
                    and f.value ~= f.defaultValue)
    pcall(function()
      local c = controls.get(id)
      if c ~= nil and c.setColor ~= nil then
        c:setColor(bright and FADER_COL_BRIGHT or FADER_COL_DARK)
        c:repaint()
      end
    end)
  end
end

local function focusSlot(abs)
  if slots[abs] == nil then
    return
  end
  focusedIdx = abs
  buildEditing(abs)
  discAccum[abs] = 0
  sspEmit("scp focus " .. abs)
  recenterAll()
  reconfigureEncoders()
  reconfigureButtons()
  repaint()
end

local function emitDigit()
  sspEmit("scp dv " .. focusedIdx .. " " .. string.format("%." .. tostring(editing.prec) .. "f", editing.value))
end

-- Per-turn mid-reset for the single control just turned. The ctrl arg is
-- kept for call-site compatibility but unused -- the real setter is by
-- control id via the Message (see setPotMid). lastPot first for the
-- re-entrancy reason above.
local function recenter(ctrl, pot)
  lastPot[pot] = 64
  setPotMid(pot)
end

-- ---- protocol ----
function ssp(cmd)
  if cmd == "C" then
    slots = {}
    nslots = 0
    pageOffset = 0
    focusedIdx = nil
    editing = nil
    recenterAll()
    reconfigureEncoders()
    reconfigureButtons()
    repaint()
    refreshSlotColors()
    return
  end
  -- Transport state push from the host: "T1" = playing, "T0" = paused.
  -- Update the Play/Pause pad (id 13) label + colour so the device mirrors
  -- the app's transport state visibly. setColor takes a NUMBER on fw v4.1.4
  -- (the hex literals match the preset JSON string colours), NOT a string --
  -- empirically verified via the live debug bridge ("number expected, got
  -- string" thrown by a string-arg call).
  if string.sub(cmd, 1, 1) == "T" then
    local on = (string.sub(cmd, 2, 2) == "1")
    pcall(function()
      local c = controls.get(13)
      if c == nil then return end
      c:setName(on and "Pause" or "Play")
      if c.setColor ~= nil then
        c:setColor(on and 0xF45C51 or 0x03A598)
      end
      c:repaint()
    end)
    return
  end
  local recs = splitc(cmd, RS)
  local head = splitc(recs[1] or "", US)
  if head[1] == "A" then
    slots = {}
    local n = 0
    for r = 2, #recs do
      local c = splitc(recs[r], US)
      if c[1] == "F" then
        local idx = tonumber(c[2]) or 0
        slots[idx] = {
          kind = c[3],
          label = c[4] or "",
          value = c[5] or "",
          mn = tonumber(c[6]),
          mx = tonumber(c[7]),
          step = tonumber(c[8]),
          prec = tonumber(c[9]) or 0,
          unit = (c[10] ~= nil and c[10] ~= "") and c[10] or nil,
          opts = (c[11] ~= nil and c[11] ~= "") and splitc(c[11], ",") or nil,
          hasAlpha = (c[12] == "1"),
          -- v37: optional default value, drives Reset pad visibility +
          -- the host-side reset action. The host owns the actual reset
          -- write (via applyFn on 'scp btn reset <idx>'), but v42 also
          -- stores the serialised default string here so refreshSlotColors
          -- can compare it against f.value to decide whether the fader
          -- should glow (value != default) or recede (value == default).
          hasDefault = (c[13] == "1"),
          defaultValue = (c[14] ~= nil and c[14] ~= "") and c[14] or nil
        }
        if idx + 1 > n then
          n = idx + 1
        end
      end
    end
    nslots = n
    local maxOff = math.max(0, nslots - 4)
    if pageOffset > maxOff then
      pageOffset = maxOff
    end
    -- Every SET_ACTOR is treated as a fresh focus context. A guarded clear
    -- (only when the old slot vanished) would leave the centre band zoomed
    -- on a DIFFERENT actor's field at the same absolute index whenever the
    -- new actor still has a field there -- common in practice.
    focusedIdx = nil
    editing = nil
    recenterAll()
    reconfigureEncoders()
    reconfigureButtons()
    repaint()
    refreshSlotColors()
  elseif head[1] == "V" then
    local idx = tonumber(head[2]) or 0
    if slots[idx] ~= nil then
      slots[idx].value = head[3] or ""
      if focusedIdx == idx and editing ~= nil then
        if slots[idx].kind == "color" then
          -- Re-derive the colour editing state from the freshly pushed hex.
          -- buildEditing also re-seeds cachedH/S, so a host push doesn't
          -- desync the V-axis hue.
          buildEditing(idx)
        else
          editing.value = tonumber(head[3]) or editing.value
        end
      end
      recenterAll()
      repaint()
      refreshSlotColors()
    end
  end
end

-- ---- encoder handlers ----
local function potOf(valueObject, base)
  local id = base
  local ok, ctrl = pcall(function()
    return valueObject:getControl()
  end)
  if ok and ctrl ~= nil then
    return ctrl:getId(), ctrl
  end
  return id, nil
end

local function numberStep(f)
  if f.step ~= nil and f.step ~= 0 then
    return f.step
  end
  if f.mn ~= nil and f.mx ~= nil then
    return (f.mx - f.mn) / 100
  end
  return 10 ^ (-(f.prec or 0))
end

-- Shared discrete editor for toggle/list fields. Accumulates raw encoder
-- delta and advances one option per DISC_SENS units (less sensitive). Index
-- CLAMPS at both ends -- no wrap, so turning past the last option does not
-- skip back to the start. Stores f.value as "0"/"1" (toggle) or the
-- option-INDEX string (list) -- NEVER the raw 0..127 position -- and emits
-- the same scp vc raw decodeDeviceRaw expects (toggle: 0/127; list: index
-- -> 0..127). Returns true only when the value actually changed.
local function stepDiscrete(abs, f, delta)
  local isToggle = (f.kind == "toggle")
  local isList = (f.kind == "list" and f.opts ~= nil)
  if not (isToggle or isList) then
    return false
  end
  local acc = (discAccum[abs] or 0) + delta
  local steps = 0
  while acc >= DISC_SENS do
    steps = steps + 1
    acc = acc - DISC_SENS
  end
  while acc <= -DISC_SENS do
    steps = steps - 1
    acc = acc + DISC_SENS
  end
  discAccum[abs] = acc
  if steps == 0 then
    return false
  end
  if isToggle then
    local cur = ((f.value == "1") and 1 or 0) + steps
    if cur < 0 then
      cur = 0
    end
    if cur > 1 then
      cur = 1
    end
    f.value = (cur == 1) and "1" or "0"
    sspEmit("scp vc " .. abs .. " " .. ((cur == 1) and 127 or 0))
    return true
  end
  local n = #f.opts
  local cur = (tonumber(f.value) or 0) + steps
  if cur < 0 then
    cur = 0
  end
  if cur > n - 1 then
    cur = n - 1
  end
  f.value = tostring(cur)
  local raw = (n > 1) and math.floor(cur / (n - 1) * 127 + 0.5) or 0
  sspEmit("scp vc " .. abs .. " " .. raw)
  return true
end

-- bottom row (ids 5-8): the parameter's own encoder directly edits the value
-- (scaled). Numbers go via the semantic scp dv path so the host applies the
-- real value (works even without min/max).
function valueChanged(valueObject, value)
  sspEmit("scp hb vc " .. tostring(value)) -- unconditional: proves the firmware invoked the handler
  local id, ctrl = potOf(valueObject, 5)
  local abs = pageOffset + (id - 5)
  local f = slots[abs]
  if f == nil then
    return
  end
  if f.kind == "number" then
    local prev = lastPot[id] or value
    local delta = value - prev
    lastPot[id] = value
    if delta == 0 then
      return
    end
    local prec = f.prec or 0
    local nv = roundp(clampRange((tonumber(f.value) or 0) + delta * numberStep(f), f.mn, f.mx), prec)
    f.value = string.format("%." .. tostring(prec) .. "f", nv)
    if focusedIdx == abs and editing ~= nil then
      editing.value = nv
    end
    sspEmit("scp dv " .. abs .. " " .. f.value)
    repaint()
    refreshSlotColors()
    recenter(ctrl, id)
    return
  end
  if f.kind == "color" then
    -- The "main" (un-zoomed) encoder for a colour scrubs HSV V (brightness).
    -- H and S come from the slot's cached values so a V-trip through 0
    -- preserves the user's hue. Same axis as encoder 4 in the drilled RGBV
    -- layout; the zoomed control is the fine-control twin of this preview.
    local prev = lastPot[id] or value
    local delta = value - prev
    lastPot[id] = value
    if delta == 0 then
      return
    end
    local r0, g0, b0, a = parseHex(f.value)
    if f.cachedH == nil or f.cachedS == nil then
      refreshHsCache(f, r0, g0, b0)
    end
    local _, _, v0 = rgbToHsv(r0, g0, b0)
    local v = v0 + delta * (1 / 127)
    if v < 0 then v = 0 end
    if v > 1 then v = 1 end
    local r, g, b = hsvToRgb(f.cachedH, f.cachedS, v)
    f.value = fmtHex(r, g, b, a, f.hasAlpha == true)
    if focusedIdx == abs and editing ~= nil and editing.kind == "color" then
      editing.r = r; editing.g = g; editing.b = b; editing.v = v
    end
    sspEmit("scp dv " .. abs .. " " .. f.value)
    repaint()
    refreshSlotColors()
    recenter(ctrl, id)
    return
  end
  -- toggle / list: discrete edit (one option per detent), not raw 0..127
  local prev = lastPot[id] or value
  local delta = value - prev
  lastPot[id] = value
  if delta == 0 then
    return
  end
  if stepDiscrete(abs, f, delta) then
    repaint()
    refreshSlotColors()
  end
  -- recenter every callback so lastPot resets to 64 and the accumulator
  -- keeps summing cleanly (endless feel; never pins the fader).
  recenter(ctrl, id)
end

-- top row (ids 1-4): detail editor for the focused field
function detailChanged(valueObject, value)
  sspEmit("scp hb dc " .. tostring(value)) -- unconditional: proves the firmware invoked the handler
  local id, ctrl = potOf(valueObject, 1)
  local knob = id - 1
  if focusedIdx == nil then
    -- Unfocused: encoder 1 (top-left) pages -- DELTA based, same pattern as
    -- the other encoders. The encoder sits mid-parked at 64 (reconfigure
    -- Encoders + recenterAll keep it there) and we read the per-detent
    -- delta against lastPot. Going through pageNext/pagePrev means the
    -- recenterAll inside applyPage mid-resets the encoder on every page
    -- change, and the synchronous m:setValue(64) re-entry arrives with
    -- delta=0 against the freshly-set lastPot=64 -- harmless. Absolute-
    -- value paging was attempted but ping-ponged because the recenterAll
    -- echo computed a different page each pass. Encoders 2-4 stay silent.
    if id == 1 then
      local prev = lastPot[id] or value
      local delta = value - prev
      lastPot[id] = value
      if delta ~= 0 then
        -- v39: paginate at PAGE_SENS detents per page. Without an accumulator
        -- every detent flipped a whole page; PAGE_SENS gives a snappier-than
        -- -multi-select feel since a page is already 4 fields.
        pageAccum = pageAccum + delta
        while pageAccum >= PAGE_SENS do
          pageAccum = pageAccum - PAGE_SENS
          pageNext()
        end
        while pageAccum <= -PAGE_SENS do
          pageAccum = pageAccum + PAGE_SENS
          pagePrev()
        end
      end
    end
    return
  end
  local f = slots[focusedIdx]
  if f == nil then
    return
  end
  -- v37: list/toggle in zoomed-in hides all top encoders, but the firmware
  -- may still dispatch detailChanged for a hidden-but-still-bound control.
  -- Drop it explicitly so a stray turn can't step options through the top
  -- row (the bottom main encoder is the sole stepper).
  if f.kind == "list" or f.kind == "toggle" then
    return
  end
  local prev = lastPot[id] or value
  local delta = value - prev
  lastPot[id] = value
  if delta == 0 then
    return
  end
  if f.kind == "number" and editing ~= nil then
    local place = 10 ^ (editing.ws - knob)
    editing.value = roundp(clampRange(editing.value + delta * place, editing.mn, editing.mx), editing.prec)
    editing.ws = clampWS(editing.ws, editing.value, editing.prec)
    f.value = string.format("%." .. tostring(editing.prec) .. "f", editing.value)
    emitDigit()
    repaint()
    refreshSlotColors()
  elseif f.kind == "color" and editing ~= nil and editing.kind == "color" then
    -- knob 0..2 -> R/G/B; knob 3 -> A (when hasAlpha) or V (otherwise).
    -- Step matches the bottom-row preview encoder (1/127 per tick) so the
    -- fine-control encoders feel like the same axis at a different gain.
    local step = 1 / 127
    if knob == 0 then
      editing.r = math.max(0, math.min(1, editing.r + delta * step))
    elseif knob == 1 then
      editing.g = math.max(0, math.min(1, editing.g + delta * step))
    elseif knob == 2 then
      editing.b = math.max(0, math.min(1, editing.b + delta * step))
    elseif knob == 3 then
      if editing.hasAlpha then
        editing.a = math.max(0, math.min(1, editing.a + delta * step))
      else
        editing.v = math.max(0, math.min(1, editing.v + delta * step))
        local r, g, b = hsvToRgb(editing.h, editing.s, editing.v)
        editing.r = r; editing.g = g; editing.b = b
      end
    end
    -- Re-cache H/S whenever the user touched an R/G/B encoder so the V
    -- axis stays aligned to the freshly-authored hue.
    if knob <= 2 then
      local h, s = refreshHsCache(f, editing.r, editing.g, editing.b)
      editing.h = h; editing.s = s
      local _, _, v = rgbToHsv(editing.r, editing.g, editing.b)
      editing.v = v
    end
    f.value = fmtHex(editing.r, editing.g, editing.b, editing.a, editing.hasAlpha)
    sspEmit("scp dv " .. focusedIdx .. " " .. f.value)
    repaint()
    refreshSlotColors()
  elseif stepDiscrete(focusedIdx, f, delta) then
    repaint()
    refreshSlotColors()
  end
  recenter(ctrl, id)
end

-- v37 touch model: touching a bottom value encoder focuses the slot (and
-- locks in as the focusAnchor so brushing a different bottom dial mid-edit
-- cannot steal focus). Touching a top encoder previews the digit it edits.
-- Focus releases ONLY when EVERY related touch is gone -- so the user can
-- release the bottom dial while still adjusting a top digit knob without
-- snapping back to mini-view.
pcall(function()
  if events ~= nil and events.subscribe ~= nil then
    events.subscribe(POTS)
    function events.onPotTouchChange(potId, controlId, isTouched)
      -- Bottom-row brush guard: if a different bottom dial is anchored,
      -- reject the brush touch outright (do NOT record it in the touched
      -- set), so it can never extend focus past the anchor's release.
      if isTouched and potId >= 5 and potId <= 8
         and focusAnchor ~= nil and focusAnchor ~= potId then
        return
      end
      if isTouched then
        touched[potId] = true
      else
        touched[potId] = nil
      end
      if potId >= 5 and potId <= 8 then
        if isTouched then
          local abs = pageOffset + (potId - 5)
          if slots[abs] ~= nil then
            focusAnchor = potId
            focusSlot(abs)
          end
        end
      elseif potId >= 1 and potId <= 4 then
        if isTouched then
          highlightedKnob = potId - 1
        elseif highlightedKnob == potId - 1 then
          highlightedKnob = nil
        end
        recenterAll()
      end
      -- Unified exit: only when EVERY relevant touch is gone does focus
      -- release. The earliest a touch transition can fire it is the last
      -- finger leaving the surface.
      if shouldUnfocus() and focusedIdx ~= nil then
        focusedIdx = nil
        editing = nil
        focusAnchor = nil
        recenterAll()
        reconfigureEncoders()
        reconfigureButtons()
        sspEmit("scp focus -1")
      end
      repaint()
    end
  end
end)

-- ---- paging (called from btnBack/btnNext, themselves invoked via the
--      preset.userFunctions table OR the dormant pads at potIds 9-10) ----
local function applyPage(off)
  local maxOff = math.max(0, nslots - 4)
  if off < 0 then
    off = 0
  end
  if off > maxOff then
    off = maxOff
  end
  pageOffset = off
  -- If the zoomed-in centre band is attached to a field no longer in the
  -- visible 4-field window, drop focus so the band falls back to mini-view
  -- (the "if the zoomed-in control isn't in the zoomed-out view, zoom out"
  -- rule). Tell the host so its focusedSlot UI hint stays in sync.
  if focusedIdx ~= nil and (focusedIdx < pageOffset or focusedIdx >= pageOffset + 4) then
    focusedIdx = nil
    editing = nil
    sspEmit("scp focus -1")
  end
  recenterAll()
  reconfigureEncoders()
  reconfigureButtons()
  repaint()
  refreshSlotColors()
end

function pagePrev()
  applyPage(pageOffset - 4)
end

function pageNext()
  applyPage(pageOffset + 4)
end

-- Hardware-button handlers. Wired through inputs.potId 11..12 on pad controls
-- (Electra Mini buttons 5-6). Momentary pads fire press = 127 and release = 0;
-- gate on release so each physical press fires exactly once.
--
-- v37: Back/Next/Clear are gone -- paging is the top-left page encoder,
-- defocus is automatic on touch-off (see onPotTouchChange above). What
-- remains:
--   - btnReset: emits "scp btn reset <idx>" so the host writes the focused
--     field's declared defaultValue. Guards on focusedIdx + hasDefault so a
--     stale press (e.g., focus dropped between repaint and press) is inert.
--   - btnPlayPause: forwards to the host transport (the host applies the
--     toggle and pushes back T0/T1, which updates the pad label).
function btnReset(valueObject, value)
  if value == 0 then return end
  if focusedIdx == nil then
    return
  end
  local f = slots[focusedIdx]
  if f == nil or f.hasDefault ~= true then
    return
  end
  sspEmit("scp btn reset " .. focusedIdx)
end

function btnPlayPause(valueObject, value)
  if value == 0 then return end
  sspEmit("scp btn playpause")
end

-- Preset-Menu user-functions (per-device one-time bind via the Mini's
-- Preset Menu -> User Functions, mapping each hardware button to one of the
-- entries below). The pad controls at potIds 11-12 would route presses
-- directly with no setup, BUT fw v4.1.4 does not dispatch hardware buttons
-- to preset pads or to any events.* handler (empirically verified). So the
-- pads stay as a forward-looking hedge and this table is the actual working
-- route today. v37 drops pot1/pot2 (used to be Back/Next) -- old bindings
-- on those hardware buttons become silently inert.
preset.userFunctions = {
  pot3 = { call = btnReset,     name = "Reset",      close = true },
  pot4 = { call = btnPlayPause, name = "Play/Pause", close = true }
}

local function registerPaint()
  pcall(function()
    local c = controls.get(9)
    if c ~= nil then
      c:setPaintCallback(paint)
    end
  end)
end

registerPaint()

function preset.onLoad()
  registerPaint()
  recenterAll()
  reconfigureEncoders()
  reconfigureButtons()
  refreshSlotColors()
end

function preset.onReady()
  registerPaint()
  recenterAll()
  reconfigureEncoders()
  reconfigureButtons()
  refreshSlotColors()
  sspEmit("simularca:ready bundle=" .. BUNDLE_VERSION)
end

function preset.onEnter()
  recenterAll()
  reconfigureEncoders()
  reconfigureButtons()
  refreshSlotColors()
  sspEmit("simularca:ready bundle=" .. BUNDLE_VERSION)
end
`;
}

/** Default-options build, kept as a const for back-compat (tests + the
 *  device mock). Tracks DEFAULT_RENDER_OPTIONS (currently triangle caps,
 *  ghost off). */
export const SURFACE_MAIN_LUA = buildSurfaceLua(DEFAULT_RENDER_OPTIONS);

export { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER };
