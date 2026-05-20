// Electra One native SysEx helpers (management plane). Manufacturer ID is
// `00 21 45`. All framings here are CONFIRMED against the Electra docs
// (docs.electra.one/developers/midiimplementation.html) — see SPEC §10.

import type { ElectraDeviceInfo } from "./types";

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
export const ELECTRA_MANUFACTURER = [0x00, 0x21, 0x45] as const;

/** Command + object byte pairs (the two bytes after the manufacturer id). */
export const ELECTRA_CMD = {
  REQUEST_DEVICE_INFO: [0x02, 0x7f],
  DEVICE_INFO_RESPONSE: [0x01, 0x7f],
  UPLOAD_PRESET: [0x01, 0x01],
  REQUEST_PRESET: [0x02, 0x01],
  PRESET_RESPONSE: [0x01, 0x01],
  UPLOAD_LUA: [0x01, 0x0c],
  REQUEST_LUA: [0x02, 0x0c],
  LUA_RESPONSE: [0x01, 0x0c],
  EXECUTE_LUA: [0x08, 0x0d],
  SET_PRESET_SLOT: [0x09, 0x08], // 0-based bank + slot
  ACK: [0x7e, 0x01],
  NACK: [0x7e, 0x00],
  LOG: [0x7f, 0x00]
} as const;

function hexTriplet(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** 7-bit ASCII encode (preset JSON / Lua source must stay in 7-bit range). */
export function asciiBytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw new Error(`Non-ASCII byte (0x${code.toString(16)}) at index ${i}; payload must be 7-bit.`);
    }
    out.push(code);
  }
  return out;
}

export function frameElectraSysex(payload: readonly number[]): number[] {
  return [SYSEX_START, ...ELECTRA_MANUFACTURER, ...payload, SYSEX_END];
}

export function isElectraSysex(message: readonly number[]): boolean {
  return (
    message.length >= 5 &&
    message[0] === SYSEX_START &&
    message[1] === ELECTRA_MANUFACTURER[0] &&
    message[2] === ELECTRA_MANUFACTURER[1] &&
    message[3] === ELECTRA_MANUFACTURER[2] &&
    message[message.length - 1] === SYSEX_END
  );
}

/** Inner payload bytes (between the manufacturer id and 0xF7). */
export function electraPayload(message: readonly number[]): number[] {
  if (!isElectraSysex(message)) {
    return [];
  }
  return [...message.slice(4, message.length - 1)];
}

/** Classify an inbound Electra message by its command+object bytes. */
export function electraMessageKind(
  message: readonly number[]
): keyof typeof ELECTRA_CMD | "unknown" {
  const p = electraPayload(message);
  if (p.length < 2) {
    return "unknown";
  }
  for (const [name, [c, o]] of Object.entries(ELECTRA_CMD)) {
    if (p[0] === c && p[1] === o) {
      return name as keyof typeof ELECTRA_CMD;
    }
  }
  return "unknown";
}

/* --------------------------------------------------------------- builders */

export function buildDeviceInfoRequest(): number[] {
  return frameElectraSysex([...ELECTRA_CMD.REQUEST_DEVICE_INFO]);
}

/** Switch the active preset. `bank`/`slot` are 0-based (CONFIRMED). */
export function buildSwitchPresetSlot(bank: number, slot: number): number[] {
  return frameElectraSysex([...ELECTRA_CMD.SET_PRESET_SLOT, bank & 0x7f, slot & 0x7f]);
}

export function buildUploadPreset(presetJson: string): number[] {
  return frameElectraSysex([...ELECTRA_CMD.UPLOAD_PRESET, ...asciiBytes(presetJson)]);
}

export function buildUploadLua(luaSource: string): number[] {
  return frameElectraSysex([...ELECTRA_CMD.UPLOAD_LUA, ...asciiBytes(luaSource)]);
}

export function buildRequestPreset(): number[] {
  return frameElectraSysex([...ELECTRA_CMD.REQUEST_PRESET]);
}

export function buildRequestLua(): number[] {
  return frameElectraSysex([...ELECTRA_CMD.REQUEST_LUA]);
}

export function buildExecuteLua(luaCommand: string): number[] {
  return frameElectraSysex([...ELECTRA_CMD.EXECUTE_LUA, ...asciiBytes(luaCommand)]);
}

/* The firmware-logger control SysEx (`buildSetLogger`/`buildSetLogPort`) and
 * destination-port enum (`ELECTRA_LOG_PORT`) plus the `parseLog` parser were
 * removed: empirically the logger never delivers Log SysEx on fw v4.1.4
 * (Execute-Lua `print` only ACKs, never a LOG frame), so the connect-time
 * enable handshake was dead code. `ELECTRA_CMD.LOG` is kept as a protocol
 * reference. */

/* ---------------------------------------------------------------- parsers */

function payloadTextAfterCmd(message: readonly number[]): string {
  const p = electraPayload(message);
  if (p.length <= 2) {
    return "";
  }
  return String.fromCharCode(...p.slice(2));
}

export function parseDeviceInfoResponse(
  message: readonly number[]
): ElectraDeviceInfo | null {
  const payload = electraPayload(message);
  if (payload.length === 0) {
    return null;
  }
  const braceIndex = payload.indexOf(0x7b /* '{' */);
  if (braceIndex === -1) {
    return null;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(String.fromCharCode(...payload.slice(braceIndex))) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown, fallback = ""): string =>
    typeof v === "string" ? v : v == null ? fallback : String(v);
  return {
    manufacturerId: hexTriplet(ELECTRA_MANUFACTURER),
    model: str(json.model ?? json.hwId ?? json.name, "unknown"),
    firmware: str(json.versionText ?? json.firmware ?? json.version, "unknown"),
    serial: typeof json.serial === "string" ? json.serial : undefined
  };
}

// NOTE: the Electra protocol reuses the same command bytes for an upload
// (host→device) and the matching response (device→host): Lua is `01 0C` both
// ways, preset is `01 01` both ways. So `electraMessageKind` (first match
// wins) is ambiguous for these — inbound parsers must check the bytes
// directly. Anything the device sends us with `01 0C`/`01 01` is a response.

function payloadStartsWith(message: readonly number[], a: number, b: number): boolean {
  const p = electraPayload(message);
  return p.length >= 2 && p[0] === a && p[1] === b;
}

/** Lua source returned by a REQUEST_LUA (`01 0C`). */
export function parseLuaResponse(message: readonly number[]): string | null {
  if (!payloadStartsWith(message, 0x01, 0x0c)) {
    return null;
  }
  return payloadTextAfterCmd(message);
}

/** Preset JSON returned by a REQUEST_PRESET (`01 01`). Empty/blank slots may
 *  return nothing parseable — callers treat null as "empty / safe to write". */
export function parsePresetResponse(
  message: readonly number[]
): Record<string, unknown> | null {
  if (!payloadStartsWith(message, 0x01, 0x01)) {
    return null;
  }
  const text = payloadTextAfterCmd(message).trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseAck(message: readonly number[]): { ok: boolean } | null {
  const kind = electraMessageKind(message);
  if (kind === "ACK") {
    return { ok: true };
  }
  if (kind === "NACK") {
    return { ok: false };
  }
  return null;
}

/**
 * Self-emitted device→host SSP SysEx — the logger-INDEPENDENT channel. The
 * Lua app sends each `scp …` line via `midi.sendSysex`; the firmware
 * auto-frames it F0..F7. Two accepted framings:
 *   primary:  F0 7D 53 53 50 <ascii> F7    (prototype mfr id 0x7D + "SSP")
 *   fallback: F0 00 21 45 7D 53 <ascii> F7 (Electra mfr id + op pair 7D 53,
 *             which collides with no ELECTRA_CMD pair)
 * Returns the ASCII payload (no F0/F7), or null when not an SSP frame. By
 * construction disjoint from isElectraSysex / electraMessageKind / any
 * ELECTRA_CMD op pair, so it never shadows a firmware response.
 */
export function parseSspSysex(message: readonly number[]): string | null {
  const n = message.length;
  if (n < 6 || message[0] !== SYSEX_START || message[n - 1] !== SYSEX_END) {
    return null;
  }
  if (
    message[1] === 0x7d &&
    message[2] === 0x53 &&
    message[3] === 0x53 &&
    message[4] === 0x50
  ) {
    return String.fromCharCode(...message.slice(5, n - 1));
  }
  if (
    message[1] === ELECTRA_MANUFACTURER[0] &&
    message[2] === ELECTRA_MANUFACTURER[1] &&
    message[3] === ELECTRA_MANUFACTURER[2] &&
    message[4] === 0x7d &&
    message[5] === 0x53
  ) {
    return String.fromCharCode(...message.slice(6, n - 1));
  }
  return null;
}

/** Extract `local BUNDLE_VERSION = <n>` from a Lua source string. */
export function parseBundleVersion(luaSource: string): number | null {
  const m = /BUNDLE_VERSION\s*=\s*(\d+)/.exec(luaSource);
  return m ? Number.parseInt(m[1], 10) : null;
}

export function bytesToHex(bytes: readonly number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(" ");
}

export function hexToBytes(text: string): number[] {
  const tokens = text
    .replace(/0x/gi, " ")
    .split(/[\s,]+/)
    .filter((t) => t.length > 0);
  return tokens.map((token) => {
    if (!/^[0-9a-f]{1,2}$/i.test(token)) {
      throw new Error(`Invalid hex byte: "${token}"`);
    }
    return Number.parseInt(token, 16);
  });
}

export function isMiniCompatible(info: ElectraDeviceInfo): boolean {
  const m = info.model.toLowerCase();
  return m.includes("electra") || m.includes("mini") || m === "unknown";
}
