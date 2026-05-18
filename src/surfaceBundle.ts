// The surface bundle uploaded to the device once (SPEC §4.1). Phase 2 ships a
// MINIMAL "hello" bundle: a valid preset whose name is the discovery marker,
// and a Lua app that stamps BUNDLE_VERSION, paints a visible marker on load,
// and `print()`s a line (Electra turns print() into a Log SysEx, so the host
// sees proof the Run-Lua path works). The real 8-slot surface + Simularca
// Surface Protocol land in Phase 3.

import { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER } from "./types";

/** Minimal valid Electra preset (v2). Name == discovery marker (≤ 20 chars). */
export const SURFACE_PRESET: Record<string, unknown> = {
  version: 2,
  name: SURFACE_PRESET_MARKER,
  projectId: "simularca",
  pages: [{ id: 1, name: "SURFACE" }],
  devices: [{ id: 1, name: "Simularca", port: 1, channel: 1 }],
  groups: [],
  overlays: [],
  controls: [
    {
      id: 1,
      type: "fader",
      name: "Status",
      color: "FFFFFF",
      bounds: [0, 40, 146, 56],
      pageId: 1,
      controlSetId: 1,
      values: [
        {
          id: "value",
          message: { deviceId: 1, type: "cc7", parameterNumber: 1, min: 0, max: 127 }
        }
      ]
    }
  ]
};

/** Minified preset JSON, as uploaded over SysEx. */
export const SURFACE_PRESET_JSON = JSON.stringify(SURFACE_PRESET);

/** Lua main script. BUNDLE_VERSION is stamped from the single source of truth
 *  in types.ts so the on-device value and the build value cannot drift. */
// Must stay 7-bit ASCII (uploaded raw over SysEx; asciiBytes() throws otherwise).
export const SURFACE_MAIN_LUA = `-- Simularca Surface - generated bundle (Phase 2 hello)
local BUNDLE_VERSION = ${SURFACE_BUNDLE_VERSION}

function emitReady()
  -- Electra routes print() to a Log SysEx (7F 00); the host watches for this.
  print("simularca:ready bundle=" .. BUNDLE_VERSION)
end

function preset.onReady()
  local c = controls.get(1)
  if c ~= nil then
    c:setName("Simularca v" .. BUNDLE_VERSION)
  end
  emitReady()
end

function preset.onEnter()
  emitReady()
end

-- Phase 3 host->device entrypoint (invoked via "Execute Lua command").
-- For now it just echoes to the log so the round-trip can be verified.
function ssp(cmd)
  print("simularca:ssp " .. tostring(cmd))
end
`;

export { SURFACE_BUNDLE_VERSION, SURFACE_PRESET_MARKER };
