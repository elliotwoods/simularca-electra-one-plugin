// The surface bundle uploaded to the device once (SPEC §4.1).
//
// Split-row model (single page, no DRILL page, no encoder-push):
//   bottom row (encoders 5-8) = up to 4 parameter VALUES
//   top row    (encoders 1-4) = the DETAIL editor for the focused value
//   centre band = a custom control painting a 7-segment readout + scrollbar
// Touch a value encoder to focus it (persists); the focused number's own
// bottom encoder pans the digit window (zoom); the 4 top encoders are the
// digit places. Prev/Next user-functions page through >4 fields.
//
// Host -> device: Execute-Lua ssp("<payload>"). Device -> host: print() lines
// (Log SysEx, parsed by sspCodec): `scp vc` (coarse), `scp dv` (digit),
// `scp focus <absIdx>`. Indices are ABSOLUTE field indices (page-independent).
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
    color: "FFFFFF",
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
-- The pot that currently owns the capacitive touch. While set, touch
-- events on any other dial are ignored (an accidental brush must not steal
-- focus / move the highlight). Cleared on the owner's release.
local touchOwner = nil
local digitCx = {}
local linkTopY = 0
-- Discrete (toggle/list) rotary sensitivity: accumulate raw encoder delta
-- and only advance one option per DISC_SENS units (~5x less sensitive than
-- one-step-per-callback). On-device tunable.
local DISC_SENS = 5
local discAccum = {}

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
  if f.kind == "number" then
    local prec = f.prec or 0
    return string.format("%." .. tostring(prec) .. "f", tonumber(f.value) or 0)
  end
  return tostring(f.value)
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

local function drawReadout()
  digitCx = {}
  local f = focusedIdx ~= nil and slots[focusedIdx] or nil
  if f == nil then
    graphics.setColor(0x6f86a8)
    graphics.print(0, math.floor(BANDH / 2) - 8, "touch a value", 800, CENTER)
    return
  end
  -- The variable title is shown on the 4 digit-place knob controls for
  -- numbers, so the readout heading is only drawn for non-number fields.
  if not (f.kind == "number" and editing ~= nil) then
    graphics.setColor(0x9fb4cf)
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
${ghostMinus}    graphics.setColor(highlightedKnob ~= nil and dim(COL_NORMAL, 0.5) or COL_NORMAL)
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
    -- When a digit encoder is touched, dim every non-touched digit to 50%
    -- so the selected one stands out.
    if highlightedKnob ~= nil and not selected then
      col = dim(col, 0.5)
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
        dpc = dim(dpc, 0.5)
      end
      graphics.setColor(dpc)
      graphics.fillRect(x, yTop + dh - dt * 2, dt * 2, dt * 2)
      x = x + dt * 2 + gap
    end
  end
end

function paint()
  graphics.setColor(0x0a0f17)
  graphics.fillRect(0, 0, 800, BANDH)
  drawReadout()
  -- link lines (control-relative): a 6px vertical stub at the top aligned
  -- with the rotary control, a diagonal across, then a 6px vertical stub
  -- aligned with the digit whose bottom sits 5px above the digit top.
  for k = 0, 3 do
    local cx = digitCx[k]
    local ex = DETAIL_CX[k + 1]
    if cx ~= nil and ex ~= nil then
      graphics.setColor((k == highlightedKnob) and COL_HI or 0x44607f)
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
  if f == nil or f.kind ~= "number" then
    editing = nil
    return
  end
  local v = tonumber(f.value) or 0
  local prec = f.prec or 0
  editing = { value = v, prec = prec, mn = f.mn, mx = f.mx }
  editing.ws = clampWS(v == 0 and 0 or msd(v), v, prec)
end

local function focusSlot(abs)
  if slots[abs] == nil then
    return
  end
  focusedIdx = abs
  buildEditing(abs)
  discAccum[abs] = 0
  sspEmit("scp focus " .. abs)
  repaint()
end

local function emitDigit()
  sspEmit("scp dv " .. focusedIdx .. " " .. string.format("%." .. tostring(editing.prec) .. "f", editing.value))
end

local function recenter(ctrl, pot)
  pcall(function()
    if ctrl ~= nil and ctrl.setValue ~= nil then
      ctrl:setValue(64)
      lastPot[pot] = 64
    end
  end)
end

-- ---- protocol ----
function ssp(cmd)
  if cmd == "C" then
    slots = {}
    nslots = 0
    pageOffset = 0
    focusedIdx = nil
    editing = nil
    repaint()
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
          opts = (c[10] ~= nil and c[10] ~= "") and splitc(c[10], ",") or nil
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
    if focusedIdx ~= nil and slots[focusedIdx] == nil then
      focusedIdx = nil
      editing = nil
    end
    repaint()
  elseif head[1] == "V" then
    local idx = tonumber(head[2]) or 0
    if slots[idx] ~= nil then
      slots[idx].value = head[3] or ""
      if focusedIdx == idx and editing ~= nil then
        editing.value = tonumber(head[3]) or editing.value
      end
      repaint()
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
    return
  end
  local f = slots[focusedIdx]
  if f == nil then
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
  elseif stepDiscrete(focusedIdx, f, delta) then
    repaint()
  end
  recenter(ctrl, id)
end

-- Touch a bottom value encoder = focus it (persists). Touch is hover only.
pcall(function()
  if events ~= nil and events.subscribe ~= nil then
    events.subscribe(POTS)
    -- A touch "owns" the surface until released: while one dial is held,
    -- stray capacitive touches on other dials are dropped. Rotations are
    -- never gated -- only these touch-change events are.
    function events.onPotTouchChange(potId, controlId, touched)
      if touched then
        if touchOwner ~= nil and touchOwner ~= potId then
          return
        end
        touchOwner = potId
      else
        if touchOwner ~= potId then
          return
        end
        touchOwner = nil
      end
      if potId >= 5 and potId <= 8 then
        local abs = pageOffset + (potId - 5)
        if touched and slots[abs] ~= nil then
          focusSlot(abs)
        end
      elseif potId >= 1 and potId <= 4 then
        -- digit encoder touched = preview which digit it controls
        if touched then
          highlightedKnob = potId - 1
        elseif highlightedKnob == potId - 1 then
          highlightedKnob = nil
        end
        repaint()
      end
    end
  end
end)

-- ---- paging (Preset Menu user-functions; assignable to a hardware button) ----
local function applyPage(off)
  local maxOff = math.max(0, nslots - 4)
  if off < 0 then
    off = 0
  end
  if off > maxOff then
    off = maxOff
  end
  pageOffset = off
  repaint()
end

function pagePrev()
  applyPage(pageOffset - 4)
end

function pageNext()
  applyPage(pageOffset + 4)
end

-- Zoom = pan the 4-digit window of a focused number (value encoder no longer
-- zooms; it edits directly). Exposed as Preset-Menu user-functions.
function zoomOut()
  if editing ~= nil then
    editing.ws = clampWS(editing.ws - 1, editing.value, editing.prec)
    repaint()
  end
end

function zoomIn()
  if editing ~= nil then
    editing.ws = clampWS(editing.ws + 1, editing.value, editing.prec)
    repaint()
  end
end

preset.userFunctions = {
  pot1 = { call = pagePrev, name = "Prev", close = true },
  pot2 = { call = pageNext, name = "Next", close = true },
  pot3 = { call = zoomOut, name = "Zoom-", close = true },
  pot4 = { call = zoomIn, name = "Zoom+", close = true }
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
end

function preset.onReady()
  registerPaint()
  sspEmit("simularca:ready bundle=" .. BUNDLE_VERSION)
end

function preset.onEnter()
  sspEmit("simularca:ready bundle=" .. BUNDLE_VERSION)
end
`;
}

/** Default-options build, kept as a const for back-compat (tests + the
 *  device mock). Tracks DEFAULT_RENDER_OPTIONS (currently triangle caps,
 *  ghost off). */
export const SURFACE_MAIN_LUA = buildSurfaceLua(DEFAULT_RENDER_OPTIONS);

export { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER };
