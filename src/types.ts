import type { ParameterValues } from "./contracts";

// Plugin-local types. See SPEC.md for the full design; Phase 1 implements
// detection + the connection state machine + the inspector status panel.
// Provisioning (Phase 2) and the Simularca Surface Protocol / digit editor
// (Phases 3+) are declared here but not yet driven.

/**
 * Connection lifecycle (SPEC §8 useElectraOneDevice). `incompatible` is a
 * terminal-ish state reached when the device firmware/model is unsupported.
 */
export type ElectraConnectionPhase =
  | "unavailable" // Web MIDI denied/unsupported, or no Electra port present
  | "detecting" // enumerating MIDI ports
  | "checking-firmware" // device-info requested, awaiting/validating reply
  | "incompatible" // model not Mini-compatible or firmware < MIN_FIRMWARE
  | "provisioning" // uploading preset.json / main.lua (Phase 2)
  | "ready" // surface live
  | "error";

export interface ElectraDeviceInfo {
  manufacturerId: string; // hex triplet, e.g. "00 21 45"
  model: string;
  firmware: string; // e.g. "4.1.2"
  serial?: string;
}

export interface ElectraMidiMonitorEntry {
  atIso: string;
  dir: "in" | "out";
  hex: string;
}

export interface ElectraPortLists {
  inputs: string[];
  outputs: string[];
}

export interface ElectraPortOverride {
  input: string | null;
  output: string | null;
}

/** 7-segment end-cap rendering style (frame-rate vs. looks trade-off):
 *  - `flat`    one fillRect per lit segment — fewest device calls, square ends.
 *  - `round`   exact scanline-disc "stadium" caps (run-length-banded). Best
 *              looking; verticals still cost 1+2*nb fillRects/segment.
 *  - `polygon` a coarse 3-band octagon/hexagon cap stretched along both axes —
 *              a constant 3 fillRects/segment regardless of size: rounded-
 *              looking but nearly as cheap as flat.
 *  - `triangle` authentic 7-seg/LCD hexagon segments: an exact linear-taper
 *              point (`hw = r-|o|`) RLE'd like `round`. The linear profile
 *              barely compresses (nb≈2r+1) so it is the costliest style —
 *              looks-over-speed. */
export type ElectraCapStyle = "flat" | "round" | "polygon" | "triangle";

/** Device-side render detail flags. These do NOT branch at runtime on the
 *  device: `buildSurfaceLua()` assembles a different Lua bundle per option so
 *  the device only ever runs the minimal code (the Mini's paint loop is the
 *  bottleneck). Changing these requires re-provisioning. */
export interface ElectraRenderOptions {
  /** End-cap style (see ElectraCapStyle). */
  capStyle: ElectraCapStyle;
  /** The black "8" ghost skeleton painted behind every lit digit. Off =
   *  only lit segments drawn (~halves the per-frame fillRect count). */
  ghostSegments: boolean;
}

export const DEFAULT_RENDER_OPTIONS: ElectraRenderOptions = {
  capStyle: "triangle",
  ghostSegments: false
};

/** Stable signature of a render-options set, used to tell whether the
 *  device's provisioned bundle still matches the current options. */
export function renderOptionsSig(o: ElectraRenderOptions): string {
  return `c${o.capStyle[0]}g${o.ghostSegments ? 1 : 0}`;
}

export interface ElectraConnectionState {
  phase: ElectraConnectionPhase;
  /** Human-readable summary for the inspector status panel. */
  summary: string;
  midiInputPortName: string | null;
  midiOutputPortName: string | null;
  /** All MIDI ports seen at last detection (for the manual picker). */
  availablePorts: ElectraPortLists;
  /** User-pinned exact port names (persisted), or nulls for auto. */
  portOverride: ElectraPortOverride;
  /** True once a device-info reply actually parsed (vs. timeout fallback). */
  deviceInfoReceived: boolean;
  /** Recent MIDI traffic (newest last) for the inspector monitor. */
  midiMonitor: ElectraMidiMonitorEntry[];
  device: ElectraDeviceInfo | null;
  /** On-device surface bundle version parsed during provisioning (Phase 2). */
  onDeviceBundleVersion: number | null;
  /** Build-time surface bundle version this plugin ships. */
  buildBundleVersion: number;
  /** Device-side render detail flags (persisted). Applied on next provision. */
  renderOptions: ElectraRenderOptions;
  /** renderOptionsSig() captured at the last successful provision, or null if
   *  never provisioned this session. Drives the "options changed — provision"
   *  hint when it differs from the current renderOptions. */
  provisionedRenderSig: string | null;
  /** Where the surface will be / was provisioned (0-based, persisted). */
  targetSlot: { bank: number; slot: number };
  /** Active provisioned preset location once provisioned. */
  presetSlot: { bank: number; slot: number } | null;
  /** Set when provisioning refused to overwrite a non-Simularca preset —
   *  drives the inspector "Force overwrite" button. Null otherwise. */
  overwriteBlocked: { bank: number; slot: number; name: string } | null;
  /** Id/name of the actor currently mirrored to the device, if any. */
  mirroredActor: { id: string; name: string } | null;
  /** Absolute field index currently focused on the device, or null. */
  focusedSlot: number | null;
  /** Current values of the synthetic 4-control "test surface" when the user
   *  enables it from the inspector (to exercise the device round-trip with no
   *  real actor selected); null when disabled. */
  testSurface: ParameterValues | null;
  lastError: string | null;
  /** Rolling diagnostics for the inspector log group (newest last). */
  log: ElectraLogEntry[];
}

export interface ElectraLogEntry {
  atIso: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** Earliest Electra Mini firmware known to support every Lua feature this
 *  surface needs. Pinned during Phase 2 against the Electra docs (SPEC §10);
 *  null disables the firmware gate until then. */
export const MIN_FIRMWARE: string | null = null;

/** Bumped whenever preset.json or any Lua module changes (SPEC §4.1). v21 =
 *  v20 with the device->host port fix: sspEmit now calls
 *  `midi.sendSysex(0, t)` instead of `midi.sendSysex(PORT_CTRL, t)`.
 *  `PORT_CTRL` is not a defined Lua global on fw v4.1.4, so the pcall'd send
 *  always threw and every device->host message (and the `scp hb …`
 *  heartbeat) was silently dropped — the long-standing reason device->app
 *  editing never worked. Hardware-verified via the live probe matrix. v20 =
 *  v19 plus a third cap style: `polygon` — a coarse 3-band octagon/hexagon
 *  cap stretched along BOTH axes, a constant 3 fillRects/segment regardless
 *  of size (round verticals cost 1+2*nb). `round` Lua is byte-identical to
 *  v19. v19 = v18 with the run-length-banded rounded renderer (pixel-
 *  identical to v18, ~2-4x fewer fillRects). v18 = v17 plus device->host off
 *  the firmware logger (self-emitted SSP SysEx) + the `scp hb …` heartbeat.
 *  v22 = adds the `triangle` cap style (authentic linear-taper hexagon 7-seg;
 *  reuses round's RLE + polygon's transposed vertical stretch). flat/round/
 *  polygon Lua unchanged except this version stamp. */
export const SURFACE_BUNDLE_VERSION = 22;

/** Preset name marker used for cheap discovery on the device (SPEC §4.2). */
export const SURFACE_PRESET_MARKER = "Simularca Surface";
