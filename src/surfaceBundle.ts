// The surface bundle uploaded to the device once (SPEC §4.1).
//
// Phase 3: an 8-slot surface (4x2) + the Simularca Surface Protocol.
// Host -> device: Electra "Execute Lua command" calls ssp("<payload>").
// Device -> host: Lua print() lines (arrive as Log SysEx, parsed by sspCodec).
//
// The device-side Lua control API (formatter binding, valueObject:getControl)
// is per the Electra docs but is the on-device iteration point — the
// host/protocol/TS side is fully unit-tested; the rendering + encoder->host
// emit may need tuning against the physical device.

import { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER } from "./types";

const COLS = [8, 206, 404, 602];
const ROWS = [70, 280];
const CTRL_W = 184;
const CTRL_H = 150;

function buildControls(): Record<string, unknown>[] {
  const controls: Record<string, unknown>[] = [];
  for (let i = 0; i < 8; i += 1) {
    const x = COLS[i % 4];
    const y = ROWS[Math.floor(i / 4)];
    controls.push({
      id: i + 1,
      type: "fader",
      name: `Slot ${i + 1}`,
      color: "FFFFFF",
      bounds: [x, y, CTRL_W, CTRL_H],
      pageId: 1,
      controlSetId: 1,
      visible: true,
      values: [
        {
          id: "value",
          formatter: "slotFmt",
          message: { deviceId: 1, type: "cc7", parameterNumber: i + 1, min: 0, max: 127 }
        }
      ]
    });
  }
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
export const SURFACE_MAIN_LUA = `-- Simularca Surface - generated bundle (Phase 3)
local BUNDLE_VERSION = ${SURFACE_BUNDLE_VERSION}
local US = string.char(31)
local RS = string.char(30)
local slots = {}

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
        slots[idx] = { kind = c[3], label = c[4] or "", value = c[5] or "" }
      end
    end
    for i = 0, 7 do
      redraw(i)
    end
    print("scp ack actor " .. tostring(#recs - 1))
  elseif head[1] == "V" then
    local idx = tonumber(head[2]) or 0
    if slots[idx] ~= nil then
      slots[idx].value = head[3] or ""
      redraw(idx)
    end
  end
end

-- Bound to every control's value in the preset JSON: returns the display
-- string AND emits the physical change back to the host.
function slotFmt(valueObject, value)
  local idx = 0
  local ok, ctrl = pcall(function()
    return valueObject:getControl()
  end)
  if ok and ctrl ~= nil then
    idx = ctrl:getId() - 1
  end
  print("scp vc " .. idx .. " " .. tostring(value))
  local s = slots[idx]
  if s ~= nil then
    return s.label .. ": " .. tostring(value)
  end
  return tostring(value)
end

function preset.onReady()
  print("simularca:ready bundle=" .. BUNDLE_VERSION)
end

function preset.onEnter()
  print("simularca:ready bundle=" .. BUNDLE_VERSION)
end
`;

export { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER };
