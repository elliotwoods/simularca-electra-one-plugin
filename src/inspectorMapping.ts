// Pure mapping: a selected actor (params + resolved schema, via the host
// bridge) → an ordered list of device surface fields. Flat param list,
// evaluate `visibleWhen`, single-level section labels. ALL visible fields are
// sent (capped at `MAX_FIELDS`); the device pages through 4 at a time. No
// device/React deps → fully unit tested.

import type {
  ParameterDefinition,
  ParameterValues,
  PluginHostActorSnapshot
} from "./contracts";
import type { SurfaceDescriptor, SurfaceField, SurfaceSlotKind } from "./sspCodec";

/** All visible fields are sent; the device pages 4 at a time. Cap guards a
 *  runaway schema / SysEx payload size. */
export const MAX_FIELDS = 64;

function visible(def: ParameterDefinition, params: ParameterValues): boolean {
  if (!def.visibleWhen || def.visibleWhen.length === 0) {
    return true;
  }
  return def.visibleWhen.every((cond) => {
    const current = params[cond.key];
    return Array.isArray(cond.equals)
      ? (cond.equals as unknown[]).includes(current as unknown)
      : current === cond.equals;
  });
}

function formatNumber(value: unknown, precision?: number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return "0";
  }
  return typeof precision === "number" ? n.toFixed(precision) : String(n);
}

interface Mapped {
  kind: SurfaceSlotKind;
  value: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  /** Optional unit suffix carried verbatim from the schema (e.g. "m", "°"). */
  unit?: string;
  options?: string[];
}

/** Map one parameter definition + current value to a slot, or null to omit. */
function mapField(def: ParameterDefinition, params: ParameterValues): Mapped | null {
  const raw = params[def.key];
  switch (def.type) {
    case "boolean":
      return { kind: "toggle", value: raw ? "1" : "0" };
    case "number":
      return {
        kind: "number",
        value: formatNumber(raw, def.precision),
        min: def.min,
        max: def.max,
        step: def.step,
        precision: def.precision,
        unit: def.unit
      };
    case "select": {
      const options = def.options ?? [];
      const idx = Math.max(0, options.indexOf(String(raw)));
      return { kind: "list", value: String(idx), options };
    }
    case "string":
      return { kind: "readonly", value: String(raw ?? "") };
    case "actor-ref":
    case "actor-ref-list":
    case "material-ref":
    case "mesh-lod-ref":
      // Dynamic candidate lists arrive in Phase 5; show read-only for now.
      return { kind: "readonly", value: String(raw ?? "—") };
    case "vector3":
      // Still rendered read-only until the Phase 5 vector renderer lands; we
      // forward the unit now so it lights up automatically when that ships.
      return {
        kind: "readonly",
        value: Array.isArray(raw) ? (raw as unknown[]).join(", ") : String(raw ?? ""),
        unit: def.unit
      };
    case "color":
      return {
        kind: "readonly",
        value: Array.isArray(raw) ? (raw as unknown[]).join(", ") : String(raw ?? "")
      };
    default:
      // location / datetime / timezone / file / material-slots /
      // dxf-layer-states — unsupported on the surface; omit.
      return null;
  }
}

/**
 * Build the device descriptor for the selected actor. Returns null when there
 * is nothing to show (no selection / no schema / no mappable fields) — the
 * caller then sends CLEAR.
 */
/** Visibility modes, in the order shown to the device list control. */
export const VISIBILITY_MODES = ["visible", "hidden", "selected"] as const;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * The "common" inspector controls (transform / enabled / visibility) live on
 * `actor.transform|enabled|visibilityMode`, not in `params`. Synthesize them
 * as the FIRST fields (so they are the device's first page). Keys are
 * `@`-prefixed so the runtime apply-dispatcher routes them to the right host
 * bridge method instead of `updateActorParams`.
 */
function commonFields(snapshot: PluginHostActorSnapshot): SurfaceField[] {
  const t = snapshot.transform;
  if (!t) {
    return [];
  }
  const num = (
    key: string,
    label: string,
    value: number,
    step: number,
    precision: number,
    unit?: string
  ): SurfaceField => ({
    key,
    idx: 0,
    kind: "number",
    label,
    value: value.toFixed(precision),
    step,
    precision,
    unit
  });
  const axes = ["X", "Y", "Z"] as const;
  const fields: SurfaceField[] = [
    {
      key: "@enabled",
      idx: 0,
      kind: "toggle",
      label: "Enabled",
      value: snapshot.enabled ? "1" : "0"
    },
    {
      key: "@visibility",
      idx: 0,
      kind: "list",
      label: "Visibility",
      value: String(Math.max(0, VISIBILITY_MODES.indexOf(snapshot.visibilityMode))),
      options: [...VISIBILITY_MODES]
    }
  ];
  for (let i = 0; i < 3; i += 1) {
    fields.push(num(`@pos.${i}`, `Pos ${axes[i]}`, t.position[i], 0.001, 3, "m"));
  }
  for (let i = 0; i < 3; i += 1) {
    // Wire token "deg" (not "°") — the SSP payload is 7-bit ASCII so UTF-8
    // multi-byte characters would not survive sanitizeToken / asciiBytes. The
    // device renders a degree-symbol glyph for the "deg" token in the zoomed
    // readout; the mini-view fader label shows the literal text "deg".
    fields.push(num(`@rot.${i}`, `Rot ${axes[i]}`, t.rotation[i] * RAD_TO_DEG, 1, 1, "deg"));
  }
  for (let i = 0; i < 3; i += 1) {
    fields.push(num(`@scl.${i}`, `Scl ${axes[i]}`, t.scale[i], 0.001, 3, "x"));
  }
  return fields;
}

export function mapInspectorToSurface(
  snapshot: PluginHostActorSnapshot | null,
  maxSlots = MAX_FIELDS
): SurfaceDescriptor | null {
  if (!snapshot) {
    return null;
  }
  const fields: SurfaceField[] = [];
  for (const cf of commonFields(snapshot)) {
    if (fields.length >= maxSlots) {
      break;
    }
    fields.push({ ...cf, idx: fields.length });
  }
  for (const def of snapshot.schema?.params ?? []) {
    if (fields.length >= maxSlots) {
      break;
    }
    if (!visible(def, snapshot.params)) {
      continue;
    }
    const mapped = mapField(def, snapshot.params);
    if (!mapped) {
      continue;
    }
    fields.push({
      key: def.key,
      idx: fields.length,
      kind: mapped.kind,
      label: def.label || def.key,
      value: mapped.value,
      sectionLabel: def.groupKey ? def.groupLabel ?? def.groupKey : undefined,
      min: mapped.min,
      max: mapped.max,
      step: mapped.step,
      precision: mapped.precision,
      unit: mapped.unit,
      options: mapped.options
    });
  }
  if (fields.length === 0) {
    return null;
  }
  return { actorId: snapshot.id, actorName: snapshot.name, fields };
}

/**
 * Phase 3 device→host: the slots are simple 0..127 faders, so the device
 * reports a raw 0..127 position. Scale it to the field's semantics. (Phase 4+
 * replaces this with semantic editing — the digit editor — on the device.)
 */
export function decodeDeviceRaw(
  field: Pick<SurfaceField, "kind" | "min" | "max" | "step" | "options">,
  raw127: number
): boolean | number | string | undefined {
  if (!Number.isFinite(raw127)) {
    return undefined;
  }
  const t = Math.min(1, Math.max(0, raw127 / 127));
  switch (field.kind) {
    case "toggle":
      return raw127 >= 64;
    case "number": {
      if (typeof field.min === "number" && typeof field.max === "number") {
        let v = field.min + t * (field.max - field.min);
        if (typeof field.step === "number" && field.step > 0) {
          v = field.min + Math.round((v - field.min) / field.step) * field.step;
        }
        return Math.min(field.max, Math.max(field.min, v));
      }
      return raw127;
    }
    case "list": {
      const opts = field.options ?? [];
      if (opts.length === 0) {
        return undefined;
      }
      return opts[Math.round(t * (opts.length - 1))];
    }
    default:
      return undefined;
  }
}

/**
 * Digit-editor (drill) values arrive as the *actual* semantic number, not a
 * 0..127 fader position. Parse + clamp to the field's range.
 */
export function decodeDirectNumber(
  field: Pick<SurfaceField, "min" | "max">,
  raw: string
): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  let v = n;
  if (typeof field.min === "number") {
    v = Math.max(field.min, v);
  }
  if (typeof field.max === "number") {
    v = Math.min(field.max, v);
  }
  return v;
}

/**
 * Convert a terse value coming back from the device into a host param value
 * for the given field. Returns `undefined` for kinds the device cannot edit
 * (so the caller skips the write).
 */
export function decodeFieldValue(
  field: Pick<SurfaceField, "kind" | "options">,
  raw: string
): boolean | number | string | undefined {
  switch (field.kind) {
    case "toggle":
      return raw === "1" || raw.toLowerCase() === "true";
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "list": {
      const opts = field.options ?? [];
      const i = Number(raw);
      if (Number.isInteger(i) && i >= 0 && i < opts.length) {
        return opts[i];
      }
      return opts.includes(raw) ? raw : undefined;
    }
    default:
      return undefined;
  }
}
