// Simularca Surface Protocol (SSP) — Phase 3 baseline.
//
// Host → device: carried inside Electra "Execute Lua command" (`08 0D`) as a
//   call into the uploaded Lua app: `ssp("<payload>")`. Payloads are terse and
//   7-bit (no JSON dependency on the device). Field/record separators are the
//   ASCII unit/record separators (0x1F / 0x1E) — control chars are 7-bit and
//   are stripped from sanitised labels/values so they never collide.
// Device → host: the Lua app `print()`s lines (Electra wraps print() in a Log
//   SysEx `7F 00`, already received by ElectraSession). Lines are
//   `scp <verb> <args…>`.

export type SurfaceSlotKind = "toggle" | "number" | "list" | "readonly";

export interface SurfaceField {
  /** Actor param key — the host write target. */
  key: string;
  /** Device slot index 0..7. */
  idx: number;
  kind: SurfaceSlotKind;
  label: string;
  /** Terse current value: toggle "0"/"1", number decimal, list option index. */
  value: string;
  sectionLabel?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Fractional digits the field allows — drives the on-device digit editor. */
  precision?: number;
  options?: string[];
}

export interface SurfaceDescriptor {
  actorId: string;
  actorName: string;
  fields: SurfaceField[];
}

const RS = String.fromCharCode(0x1e); // between fields
const US = String.fromCharCode(0x1f); // between a field's columns

/**
 * Make a string safe both as an SSP token and inside a Lua double-quoted
 * literal: drop control bytes (incl. the separators) and anything non-7-bit,
 * replace `"`/`\` (Lua literal hazards), collapse whitespace, length-cap with
 * an ASCII marker.
 */
export function sanitizeToken(text: string, max = 24): string {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      out += " ";
    } else if (ch === '"' || ch === "\\") {
      out += "'";
    } else {
      out += ch;
    }
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}~` : out;
}

/* ----------------------------------------------------- host → device */

/** Encode just the payload (no `ssp("")` wrapper) — used by round-trip tests. */
export function encodeSurfacePayload(desc: SurfaceDescriptor): string {
  const head = ["A", sanitizeToken(desc.actorName, 20)].join(US);
  const rows = desc.fields.map((f) =>
    [
      "F",
      String(f.idx),
      f.kind,
      sanitizeToken(f.label, 22),
      sanitizeToken(f.value, 24),
      f.min ?? "",
      f.max ?? "",
      f.step ?? "",
      f.precision ?? "",
      (f.options ?? []).map((o) => sanitizeToken(o, 16)).join(",")
    ].join(US)
  );
  return [head, ...rows].join(RS);
}

export function decodeSurfacePayload(payload: string): SurfaceDescriptor | null {
  const records = payload.split(RS);
  const head = (records[0] ?? "").split(US);
  if (head[0] !== "A") {
    return null;
  }
  const fields: SurfaceField[] = [];
  for (const rec of records.slice(1)) {
    const c = rec.split(US);
    if (c[0] !== "F") {
      continue;
    }
    fields.push({
      key: "",
      idx: Number(c[1]),
      kind: c[2] as SurfaceSlotKind,
      label: c[3] ?? "",
      value: c[4] ?? "",
      min: c[5] ? Number(c[5]) : undefined,
      max: c[6] ? Number(c[6]) : undefined,
      step: c[7] ? Number(c[7]) : undefined,
      precision: c[8] ? Number(c[8]) : undefined,
      options: c[9] ? c[9].split(",") : undefined
    });
  }
  return { actorId: "", actorName: head[1] ?? "", fields };
}

function luaCall(payload: string): string {
  // payload is sanitised (no " or \), so a plain Lua string literal is safe.
  return `ssp("${payload}")`;
}

export function setActorCommand(desc: SurfaceDescriptor): string {
  return luaCall(encodeSurfacePayload(desc));
}

export function setFieldValueCommand(idx: number, value: string): string {
  return luaCall(["V", String(idx), sanitizeToken(value, 24)].join(US));
}

export function clearCommand(): string {
  return luaCall("C");
}

/* ----------------------------------------------------- device → host */

export type DeviceEvent =
  | { type: "value"; idx: number; value: string } // fader path (0..127, scaled host-side)
  | { type: "dvalue"; idx: number; value: string } // digit editor (direct semantic value)
  | { type: "drill"; idx: number } // entered the digit editor on slot idx
  | { type: "drillexit" } // left the digit editor
  | { type: "ready"; bundle: number | null }
  | { type: "focus"; idx: number }
  | { type: "log"; text: string };

/** Parse one device `print()` line. Returns null for unrelated log text. */
export function decodeDeviceLine(line: string): DeviceEvent | null {
  const t = line.trim();
  let m = /^scp\s+vc\s+(\d+)\s+(.+)$/.exec(t);
  if (m) {
    return { type: "value", idx: Number(m[1]), value: m[2] };
  }
  m = /^scp\s+dv\s+(\d+)\s+(.+)$/.exec(t);
  if (m) {
    return { type: "dvalue", idx: Number(m[1]), value: m[2] };
  }
  m = /^scp\s+drill\s+(\d+)$/.exec(t);
  if (m) {
    return { type: "drill", idx: Number(m[1]) };
  }
  if (t === "scp drillx") {
    return { type: "drillexit" };
  }
  m = /^scp\s+focus\s+(\d+)$/.exec(t);
  if (m) {
    return { type: "focus", idx: Number(m[1]) };
  }
  m = /^(?:scp\s+ready|simularca:ready)\s+bundle=(\d+)$/.exec(t);
  if (m) {
    return { type: "ready", bundle: Number(m[1]) };
  }
  if (t.startsWith("scp ")) {
    return { type: "log", text: t.slice(4) };
  }
  return null;
}
