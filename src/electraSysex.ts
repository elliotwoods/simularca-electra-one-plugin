// Electra One native SysEx helpers (management plane). Manufacturer ID is
// `00 21 45`. Framings marked CONFIRMED come from SPEC §10 / the Electra docs;
// those marked UNCONFIRMED are best-effort and must be validated against
// https://docs.electra.one/developers/midiimplementation.html during Phase 2.

import type { ElectraDeviceInfo } from "./types";

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
/** Electra One manufacturer / system-exclusive ID. */
export const ELECTRA_MANUFACTURER = [0x00, 0x21, 0x45] as const;

/** Electra SysEx command bytes (subset). CONFIRMED ones per SPEC §10. */
export const ELECTRA_CMD = {
  // UNCONFIRMED: device-info / version request. Electra replies with a JSON
  // payload describing the model + firmware. Validate the request bytes
  // against the MIDI implementation doc in Phase 2.
  REQUEST_DEVICE_INFO: [0x02, 0x7f] as const,
  // CONFIRMED (SPEC §10): preset upload prefix `00 21 45 01 01 …`.
  UPLOAD_PRESET: [0x01, 0x01] as const,
  // CONFIRMED (SPEC §10): Set Preset Slot `00 21 45 14 08 bank slot`.
  SET_PRESET_SLOT: [0x14, 0x08] as const
  // TODO Phase 2: Lua main-script upload, Switch Preset Slot, Run Lua Command,
  // preset-name listing, Get Lua script — fill from the Electra docs.
} as const;

function hexTriplet(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** Frame a payload as a complete Electra SysEx message. */
export function frameElectraSysex(payload: readonly number[]): number[] {
  return [SYSEX_START, ...ELECTRA_MANUFACTURER, ...payload, SYSEX_END];
}

/** True when a raw inbound MIDI message is an Electra SysEx frame. */
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

/** Build the device-info / version request message. */
export function buildDeviceInfoRequest(): number[] {
  return frameElectraSysex([...ELECTRA_CMD.REQUEST_DEVICE_INFO]);
}

/** Extract the inner payload bytes (between manufacturer id and 0xF7). */
export function electraPayload(message: readonly number[]): number[] {
  if (!isElectraSysex(message)) {
    return [];
  }
  return [...message.slice(4, message.length - 1)];
}

/**
 * Parse a device-info response. Electra returns a JSON object; depending on
 * firmware the JSON may start after a command byte or two. We scan the payload
 * for the first `{` and JSON-parse from there, which is tolerant of the
 * (UNCONFIRMED) exact response framing.
 */
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
  let text: string;
  try {
    text = String.fromCharCode(...payload.slice(braceIndex));
  } catch {
    return null;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const versionText = (() => {
    const v = json.versionText ?? json.firmware ?? json.version;
    return typeof v === "string" ? v : String(v ?? "");
  })();
  const model = (() => {
    const m = json.hwId ?? json.model ?? json.name;
    return typeof m === "string" ? m : String(m ?? "unknown");
  })();
  const serial = typeof json.serial === "string" ? json.serial : undefined;
  return {
    manufacturerId: hexTriplet(ELECTRA_MANUFACTURER),
    model,
    firmware: versionText || "unknown",
    serial
  };
}

/** Loose model check: Electra One Mini (and the larger Electra One, which is
 *  protocol-compatible for our purposes). Refined in Phase 2 against real
 *  device-info payloads. */
export function isMiniCompatible(info: ElectraDeviceInfo): boolean {
  const m = info.model.toLowerCase();
  return m.includes("electra") || m.includes("mini") || m === "unknown";
}
