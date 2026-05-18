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

export interface ElectraConnectionState {
  phase: ElectraConnectionPhase;
  /** Human-readable summary for the inspector status panel. */
  summary: string;
  midiInputPortName: string | null;
  midiOutputPortName: string | null;
  device: ElectraDeviceInfo | null;
  /** On-device surface bundle version parsed during provisioning (Phase 2). */
  onDeviceBundleVersion: number | null;
  /** Build-time surface bundle version this plugin ships. */
  buildBundleVersion: number;
  /** Persisted/active preset location once provisioned (Phase 2). */
  presetSlot: { bank: number; slot: number } | null;
  /** Id/name of the actor currently mirrored to the device, if any. */
  mirroredActor: { id: string; name: string } | null;
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

/** Bumped whenever preset.json or any Lua module changes (SPEC §4.1). */
export const SURFACE_BUNDLE_VERSION = 1;

/** Preset name marker used for cheap discovery on the device (SPEC §4.2). */
export const SURFACE_PRESET_MARKER = "Simularca Surface";
