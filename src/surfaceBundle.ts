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

import { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER } from "./types";

const COLS = [8, 206, 404, 602];
const CTRL_W = 184;
// Mini is 800x480, non-touch. Thin fader strips top & bottom; the custom
// control owns the centre. Bottom strip ends ~462 to clear MENU/CONTEXT.
const TOP_Y = 8;
const BOT_Y = 392;
const STRIP_H = 70;
const BAND_Y = 86;
const BAND_H = 300;

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
export const SURFACE_MAIN_LUA = `-- Simularca Surface - generated bundle (split-row, v${SURFACE_BUNDLE_VERSION})
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

local function drawDigit(x, y, w, h, t, mask)
  local h2 = math.floor(h / 2)
  if hasSeg(mask, "a") then
    graphics.fillRect(x + t, y, w - 2 * t, t)
  end
  if hasSeg(mask, "f") then
    graphics.fillRect(x, y + t, t, h2 - t)
  end
  if hasSeg(mask, "b") then
    graphics.fillRect(x + w - t, y + t, t, h2 - t)
  end
  if hasSeg(mask, "g") then
    graphics.fillRect(x + t, y + h2 - math.floor(t / 2), w - 2 * t, t)
  end
  if hasSeg(mask, "e") then
    graphics.fillRect(x, y + h2, t, h2 - t)
  end
  if hasSeg(mask, "c") then
    graphics.fillRect(x + w - t, y + h2, t, h2 - t)
  end
  if hasSeg(mask, "d") then
    graphics.fillRect(x + t, y + h - t, w - 2 * t, t)
  end
end

-- Render text (digits, '-', '.', ' ') centred at vertical y over full width.
local function draw7(text, cy, scale)
  local w = math.floor(20 * scale)
  local h = math.floor(34 * scale)
  local t = math.max(2, math.floor(3 * scale))
  local gap = math.floor(8 * scale)
  -- measure
  local total = 0
  for i = 1, #text do
    local ch = string.sub(text, i, i)
    if ch == "." then
      total = total + math.floor(t * 2) + gap
    else
      total = total + w + gap
    end
  end
  total = total - gap
  local x = math.floor((800 - total) / 2)
  local y = cy - math.floor(h / 2)
  for i = 1, #text do
    local ch = string.sub(text, i, i)
    if ch == "." then
      graphics.fillRect(x, y + h - t * 2, t * 2, t * 2)
      x = x + t * 2 + gap
    else
      local mask = SEG[ch] or ""
      drawDigit(x, y, w, h, t, mask)
      x = x + w + gap
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
      local e = editing.ws - k
      nameOf(1 + k, "10^" .. tostring(e) .. " = " .. tostring(digitAt(editing.value, e)))
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

function paint()
  graphics.setColor(0x0a0f17)
  graphics.fillRect(0, ${BAND_Y}, 800, ${BAND_H})
  local f = focusedIdx ~= nil and slots[focusedIdx] or nil
  if f ~= nil then
    graphics.setColor(0x9fb4cf)
    graphics.print(0, ${BAND_Y} + 8, f.label, 800, CENTER)
    local txt = fmtValue(f)
    graphics.setColor(0x6fd0ff)
    draw7(txt, ${BAND_Y} + 150, 3)
  else
    graphics.setColor(0x6f86a8)
    graphics.print(0, ${BAND_Y} + 130, "touch a value", 800, CENTER)
  end
  -- scrollbar
  local total = nslots
  local tx, tw = 60, 680
  local sy = ${BAND_Y} + ${BAND_H} - 40
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
    graphics.print(0, sy + 14, tostring(a) .. "-" .. tostring(b) .. " / " .. tostring(total), 800, CENTER)
  end
end

local function repaint()
  local c = controls.get(9)
  if c ~= nil then
    c:repaint()
  end
  renderRows()
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
  print("scp focus " .. abs)
  repaint()
end

local function emitDigit()
  print("scp dv " .. focusedIdx .. " " .. string.format("%." .. tostring(editing.prec) .. "f", editing.value))
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

-- bottom row (ids 5-8): coarse value, or zoom when its number is focused
function valueChanged(valueObject, value)
  local id, ctrl = potOf(valueObject, 5)
  local slot = id - 5
  local abs = pageOffset + slot
  local f = slots[abs]
  if f == nil then
    return
  end
  if focusedIdx == abs and f.kind == "number" and editing ~= nil then
    local prev = lastPot[id] or value
    local delta = value - prev
    lastPot[id] = value
    if delta ~= 0 then
      editing.ws = clampWS(editing.ws + delta, editing.value, editing.prec)
      repaint()
      recenter(ctrl, id)
    end
    return
  end
  -- coarse: host scales 0..127 (decodeDeviceRaw)
  print("scp vc " .. abs .. " " .. tostring(value))
  f.value = tostring(value)
  repaint()
end

-- top row (ids 1-4): detail editor for the focused field
function detailChanged(valueObject, value)
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
  elseif f.kind == "list" and f.opts ~= nil then
    local cur = (tonumber(f.value) or 0) + delta
    if cur < 0 then
      cur = 0
    end
    if cur > #f.opts - 1 then
      cur = #f.opts - 1
    end
    f.value = tostring(cur)
    print("scp vc " .. focusedIdx .. " " .. cur)
    repaint()
  elseif f.kind == "toggle" then
    local v = (f.value == "1") and "0" or "1"
    f.value = v
    print("scp vc " .. focusedIdx .. " " .. v)
    repaint()
  end
  recenter(ctrl, id)
end

-- Touch a bottom value encoder = focus it (persists). Touch is hover only.
pcall(function()
  if events ~= nil and events.subscribe ~= nil then
    events.subscribe(POTS)
    function events.onPotTouchChange(potId, controlId, touched)
      if potId >= 5 and potId <= 8 then
        local abs = pageOffset + (potId - 5)
        if touched and slots[abs] ~= nil then
          focusSlot(abs)
        end
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

preset.userFunctions = {
  pot1 = { call = pagePrev, name = "Prev", close = true },
  pot2 = { call = pageNext, name = "Next", close = true }
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
  print("simularca:ready bundle=" .. BUNDLE_VERSION)
end

function preset.onEnter()
  print("simularca:ready bundle=" .. BUNDLE_VERSION)
end
`;

export { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER };
