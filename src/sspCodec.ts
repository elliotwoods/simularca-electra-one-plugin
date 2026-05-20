// Simularca Surface Protocol (SSP) — Phase 3 baseline.
//
// Host → device: carried inside Electra "Execute Lua command" (`08 0D`) as a
//   call into the uploaded Lua app: `ssp("<payload>")`. Payloads are terse and
//   7-bit (no JSON dependency on the device). Field/record separators are the
//   ASCII unit/record separators (0x1F / 0x1E) — control chars are 7-bit and
//   are stripped from sanitised labels/values so they never collide.
// Device → host: the Lua app self-emits each `scp <verb> <args…>` line as a
//   SysEx via `midi.sendSysex(0, …)` — wire form `F0 7D 53 53 50 <ascii> F7`
//   (parsed by parseSspSysex in electraSysex.ts). This is the SOLE
//   device→host channel: the earlier print()/firmware-logger Log-SysEx path
//   is dead on fw v4.1.4 (the logger never delivers Log SysEx even when
//   explicitly enabled). decodeDeviceLine still tolerates a leading
//   `<ms> ` + `lua:` prefix as cheap defensive parsing in case a future
//   firmware revives that path, but no live code depends on it.

export type SurfaceSlotKind = "toggle" | "number" | "list" | "readonly" | "color";

export interface SurfaceField {
  /** Actor param key — the host write target. */
  key: string;
  /** Device slot index 0..7. */
  idx: number;
  kind: SurfaceSlotKind;
  label: string;
  /** Terse current value: toggle "0"/"1", number decimal, list option index,
   *  colour hex `#RRGGBB` or `#RRGGBBAA`. */
  value: string;
  sectionLabel?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Fractional digits the field allows — drives the on-device digit editor. */
  precision?: number;
  /** Short unit suffix (e.g. "m", "°", "x", "m/s"); rendered next to the
   *  value on the device. Empty/undefined → no unit shown. */
  unit?: string;
  options?: string[];
  /** Only meaningful when `kind === "color"`. When true, the zoomed-in
   *  control binds encoder 4 to alpha; otherwise it binds to HSV V
   *  (brightness). The hex value already carries the alpha bits when this
   *  is true, but the flag drives device-side painter + encoder labelling
   *  without re-parsing the hex on every paint. */
  hasAlpha?: boolean;
  /** True when an explicit default value is available; gates the Reset pad
   *  visibility on the device. Encoded on the wire so the device can flip
   *  the pad on focus transition without a host round-trip. */
  hasDefault?: boolean;
  /** Serialised default in the same string-encoding family as `value` — host
   *  decodes it back through the regular `decodeFieldValue` path when the
   *  device emits `scp btn reset <idx>`. */
  defaultValue?: string;
  /** Host-only pagination hint: all SurfaceFields sharing this groupKey MUST
   *  land on the same paginated page (no split across the 4-slot window).
   *  Not encoded on the wire — pagination is settled host-side and the
   *  device just receives the resulting idx assignments with optional gaps. */
  groupKey?: string;
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
      sanitizeToken(f.unit ?? "", 8),
      (f.options ?? []).map((o) => sanitizeToken(o, 16)).join(","),
      f.kind === "color" ? (f.hasAlpha ? "1" : "0") : "",
      f.hasDefault ? "1" : "",
      f.defaultValue != null ? sanitizeToken(f.defaultValue, 24) : ""
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
      unit: c[9] ? c[9] : undefined,
      options: c[10] ? c[10].split(",") : undefined,
      hasAlpha: c[11] === "1" ? true : undefined,
      hasDefault: c[12] === "1" ? true : undefined,
      defaultValue: c[13] ? c[13] : undefined
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

/** Push the host's transport play state to the device. The device-side `ssp`
 *  handler (T branch) updates the Play/Pause pad's label + colour to match. */
export function setTransportCommand(playing: boolean): string {
  return luaCall("T" + (playing ? "1" : "0"));
}

/* ----------------------------------------------------- device → host */

export type DeviceEvent =
  | { type: "value"; idx: number; value: string } // fader path (0..127, scaled host-side)
  | { type: "dvalue"; idx: number; value: string } // digit editor (direct semantic value)
  | { type: "drill"; idx: number } // entered the digit editor on slot idx
  | { type: "drillexit" } // left the digit editor
  | { type: "ready"; bundle: number | null }
  | { type: "focus"; idx: number }
  | { type: "button"; action: string } // Mini hardware button (3-6) pressed
  | { type: "log"; text: string };

/** Parse one device SSP line. Returns null for unrelated text. */
export function decodeDeviceLine(line: string): DeviceEvent | null {
  // Defensive: if a future firmware revives the print()/logger path, Log
  // SysEx text is "<ms-from-start> <message>" with print() additionally
  // prefixed "lua:" — tolerate both so the SSP grammar stays anchored. The
  // live path emits bare lines via parseSspSysex (no prefix), so this is a
  // no-op in practice; bare "scp …" lines start with a letter and neither
  // strip touches them.
  const t = line
    .trim()
    .replace(/^\d+\s+/, "")
    .replace(/^lua:\s*/i, "")
    .trim();
  // Field indices may arrive as a Lua FLOAT render ("0.0", "12.0"): the
  // device computes some indices via arithmetic that yields a float, and
  // Electra's tostring renders that as "N.0". A strict `\d+` silently
  // dropped every such line (the top-row digit editor's `scp dv`/`scp focus`
  // all emit float indices) while the bottom row happened to stay integer.
  // Accept an optional fractional part and truncate to the integer index.
  const idx = (s: string): number => Math.trunc(Number(s));
  let m = /^scp\s+vc\s+(\d+(?:\.\d+)?)\s+(.+)$/.exec(t);
  if (m) {
    return { type: "value", idx: idx(m[1]), value: m[2] };
  }
  m = /^scp\s+dv\s+(\d+(?:\.\d+)?)\s+(.+)$/.exec(t);
  if (m) {
    return { type: "dvalue", idx: idx(m[1]), value: m[2] };
  }
  m = /^scp\s+drill\s+(\d+(?:\.\d+)?)$/.exec(t);
  if (m) {
    return { type: "drill", idx: idx(m[1]) };
  }
  if (t === "scp drillx") {
    return { type: "drillexit" };
  }
  // `-1` (or any negative) is the device's "defocus" / "back to mini-view"
  // signal, emitted when a page change scrolls the focused field off-screen
  // (the zoom-out rule). connectionState treats idx < 0 as null focus.
  m = /^scp\s+focus\s+(-?\d+(?:\.\d+)?)$/.exec(t);
  if (m) {
    return { type: "focus", idx: idx(m[1]) };
  }
  m = /^(?:scp\s+ready|simularca:ready)\s+bundle=(\d+)$/.exec(t);
  if (m) {
    return { type: "ready", bundle: Number(m[1]) };
  }
  // Hardware-button press from a pad control (Mini buttons 3-6). Must sit
  // ABOVE the generic scp-log catch-all so `scp btn playpause` doesn't
  // regress into {type:"log"}. Multi-token actions (e.g. `reset 7`) are
  // packed into `action` verbatim; the consumer parses arguments off it.
  m = /^scp\s+btn\s+(.+)$/.exec(t);
  if (m) {
    return { type: "button", action: m[1] };
  }
  if (t.startsWith("scp ")) {
    return { type: "log", text: t.slice(4) };
  }
  return null;
}
