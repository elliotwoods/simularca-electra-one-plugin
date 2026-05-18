// The surface bundle uploaded to the device once (SPEC §4.1).
//
// Phase 4: 8-slot surface (page 1) + an on-device digit editor (page 2,
// "DRILL") entered by a pot tap on a numeric slot. The Electra Lua API has no
// encoder-push callback, so "tap" = touch-down then touch-up with no turn in
// between (events.onPotTouchChange).
//
// Host -> device: Execute-Lua ssp("<payload>"). Device -> host: print() lines
// (Log SysEx, parsed by sspCodec): `scp vc` (fader), `scp dv` (digit editor,
// direct value), `scp drill <idx>` / `scp drillx`.
//
// The device-side Lua (custom control paint, page switch, relative encoder
// deltas) is the on-device iteration point; the host/protocol/maths side is
// fully unit-tested (digits.ts mirrors the Lua algorithm).

import { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER } from "./types";

const COLS = [8, 206, 404, 602];
const ROWS = [70, 280];
const CTRL_W = 184;
const CTRL_H = 150;

function surfaceControls(): Record<string, unknown>[] {
  const controls: Record<string, unknown>[] = [];
  for (let i = 0; i < 8; i += 1) {
    controls.push({
      id: i + 1,
      type: "fader",
      name: `Slot ${i + 1}`,
      color: "FFFFFF",
      bounds: [COLS[i % 4], ROWS[Math.floor(i / 4)], CTRL_W, CTRL_H],
      pageId: 1,
      controlSetId: 1,
      visible: true,
      inputs: [{ potId: i + 1, valueId: "value" }],
      values: [
        {
          id: "value",
          function: "slotChanged",
          message: { deviceId: 1, type: "cc7", parameterNumber: i + 1, min: 0, max: 127 }
        }
      ]
    });
  }
  return controls;
}

function drillControls(): Record<string, unknown>[] {
  // 8 invisible faders on page 2 so the encoders drive `drillKnob`, plus one
  // full-window custom control we paint the digit editor into.
  const controls: Record<string, unknown>[] = [];
  for (let i = 0; i < 8; i += 1) {
    controls.push({
      id: 100 + i,
      type: "fader",
      name: "",
      bounds: [0, 0, 1, 1],
      pageId: 2,
      controlSetId: 1,
      visible: false,
      inputs: [{ potId: i + 1, valueId: "value" }],
      values: [
        {
          id: "value",
          function: "drillKnob",
          message: { deviceId: 1, type: "cc7", parameterNumber: 100 + i, min: 0, max: 127 }
        }
      ]
    });
  }
  controls.push({
    id: 120,
    type: "custom",
    name: "DRILL",
    bounds: [0, 0, 1024, 575],
    pageId: 2,
    controlSetId: 1,
    visible: true
  });
  return controls;
}

export const SURFACE_PRESET: Record<string, unknown> = {
  version: 2,
  name: SURFACE_PRESET_MARKER,
  projectId: "simularca",
  pages: [
    { id: 1, name: "SURFACE" },
    { id: 2, name: "DRILL" }
  ],
  devices: [{ id: 1, name: "Simularca", port: 1, channel: 1 }],
  groups: [],
  overlays: [],
  controls: [...surfaceControls(), ...drillControls()]
};

export const SURFACE_PRESET_JSON = JSON.stringify(SURFACE_PRESET);

// Must stay 7-bit ASCII (uploaded raw over SysEx; asciiBytes() throws otherwise).
// The digit math mirrors src/digits.ts (which is exhaustively unit-tested).
export const SURFACE_MAIN_LUA = `-- Simularca Surface - generated bundle (Phase 4)
local BUNDLE_VERSION = ${SURFACE_BUNDLE_VERSION}
local US = string.char(31)
local RS = string.char(30)
local WIN = 4
local slots = {}
local editing = nil
local lastPot = {}
local touchMoved = {}

local function splitc(s, sep)
  local t = {}
  for part in (s .. sep):gmatch("(.-)" .. sep) do
    t[#t + 1] = part
  end
  return t
end

local function redraw(i)
  local c = controls.get(i + 1)
  if c == nil then
    return
  end
  local s = slots[i]
  if s == nil then
    c:setName("")
    c:setVisible(false)
    return
  end
  c:setVisible(true)
  c:setName(s.label .. ": " .. s.value)
  c:repaint()
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
  return math.floor(v * s + 0.5 + (v < 0 and -1 or 0) * 0) / s
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

local function drillPaint(control)
  pcall(function()
    graphics.setColor(0x000000)
    graphics.fillRect(0, 0, 1024, 575)
    if editing == nil then
      return
    end
    local s = slots[editing.idx]
    graphics.setColor(0x9fb4cf)
    graphics.print(20, 20, (s ~= nil and s.label or "value"))
    local fmt = "%." .. tostring(editing.prec) .. "f"
    local txt = string.format(fmt, editing.value)
    graphics.setColor(0xffffff)
    graphics.print(40, 200, txt)
    -- active window hint
    graphics.setColor(0x6f86a8)
    local hint = "knob1=zoom  knobs5-8=digits  ws=10^" .. tostring(editing.ws) .. "  tap=exit"
    graphics.print(20, 520, hint)
  end)
end

local function emitDigit()
  local fmt = "%." .. tostring(editing.prec) .. "f"
  print("scp dv " .. editing.idx .. " " .. string.format(fmt, editing.value))
end

local function repaintDrill()
  local c = controls.get(120)
  if c ~= nil then
    c:repaint()
  end
end

local function enterDigit(idx)
  local s = slots[idx]
  if s == nil or s.kind ~= "number" then
    return
  end
  local v = tonumber(s.value) or 0
  local prec = s.prec or 0
  editing = { idx = idx, value = v, prec = prec, mn = s.mn, mx = s.mx }
  editing.ws = clampWS(v == 0 and 0 or msd(v), v, prec)
  print("scp drill " .. idx)
  pcall(function()
    pages.display(2)
  end)
  repaintDrill()
end

local function exitDigit()
  editing = nil
  print("scp drillx")
  pcall(function()
    pages.display(1)
  end)
end

local function nudge(knob, detents)
  if editing == nil or detents == 0 then
    return
  end
  local place = 10 ^ (editing.ws - knob)
  local v = roundp(clampRange(editing.value + detents * place, editing.mn, editing.mx), editing.prec)
  editing.value = v
  editing.ws = clampWS(editing.ws, v, editing.prec)
  emitDigit()
  repaintDrill()
end

local function zoomf(detents)
  if editing == nil or detents == 0 then
    return
  end
  editing.ws = clampWS(editing.ws + detents, editing.value, editing.prec)
  repaintDrill()
end

-- ---- protocol ----
function ssp(cmd)
  if cmd == "C" then
    for i = 0, 7 do
      slots[i] = nil
      redraw(i)
    end
    return
  end
  local recs = splitc(cmd, RS)
  local head = splitc(recs[1] or "", US)
  if head[1] == "A" then
    for i = 0, 7 do
      slots[i] = nil
    end
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
          prec = tonumber(c[9]) or 0
        }
      end
    end
    for i = 0, 7 do
      redraw(i)
    end
  elseif head[1] == "V" then
    local idx = tonumber(head[2]) or 0
    if slots[idx] ~= nil then
      slots[idx].value = head[3] or ""
      redraw(idx)
      if editing ~= nil and editing.idx == idx then
        editing.value = tonumber(head[3]) or editing.value
        repaintDrill()
      end
    end
  end
end

-- encoder turn on the surface page
function slotChanged(valueObject, value)
  local idx = 0
  local ok, ctrl = pcall(function()
    return valueObject:getControl()
  end)
  if ok and ctrl ~= nil then
    idx = ctrl:getId() - 1
  end
  touchMoved[idx + 1] = true
  print("scp vc " .. idx .. " " .. tostring(value))
  local s = slots[idx]
  if s ~= nil then
    s.value = tostring(value)
    redraw(idx)
  end
end

-- encoder turn on the DRILL page (relative delta from last absolute value)
function drillKnob(valueObject, value)
  local pot = 1
  local ok, ctrl = pcall(function()
    return valueObject:getControl()
  end)
  if ok and ctrl ~= nil then
    pot = ctrl:getId() - 99
  end
  touchMoved[pot] = true
  local prev = lastPot[pot] or value
  local delta = value - prev
  lastPot[pot] = value
  if editing == nil or delta == 0 then
    return
  end
  if pot == 1 then
    zoomf(delta)
  elseif pot >= 5 and pot <= 8 then
    nudge(pot - 5, delta)
  end
end

-- pot tap (touch down then up with no turn) toggles the digit editor.
pcall(function()
  if events ~= nil and events.subscribe ~= nil then
    events.subscribe(POTS)
    function events.onPotTouchChange(potId, controlId, touched)
      if touched then
        touchMoved[potId] = false
        return
      end
      if touchMoved[potId] then
        return
      end
      if editing ~= nil then
        exitDigit()
      else
        local idx = potId - 1
        if slots[idx] ~= nil and slots[idx].kind == "number" then
          enterDigit(idx)
        else
          print("scp focus " .. idx)
        end
      end
    end
  end
end)

function preset.onReady()
  pcall(function()
    local c = controls.get(120)
    if c ~= nil then
      c:setPaintCallback(drillPaint)
    end
  end)
  print("simularca:ready bundle=" .. BUNDLE_VERSION)
end

function preset.onEnter()
  print("simularca:ready bundle=" .. BUNDLE_VERSION)
end
`;

export { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER };
