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

/**
 * Mirror of the host's `inferDisplayPrecision` in
 * `src/ui/widgets/numberEditing.ts`: when a `number` ParameterDefinition has no
 * explicit `precision`, infer it from the `step` value (count the decimals).
 *
 * Without this, fields declared as `{ type: "number", step: 0.05, unit: "m" }`
 * (no precision) — the canonical curve-actor "Radius" pattern — were sent to
 * the device with `precision: undefined`, so `formatNumber` fell through to
 * `String(n)` and the device's mini-view rendered "1" instead of "1.00",
 * and the digit editor had no fractional digits to scrub. The main inspector
 * uses 2 dp (inferred from `0.05`); the Electra surface now matches.
 *
 * Rule: explicit precision wins. Otherwise: `|step| >= 1` → 0; sub-1 step →
 * decimals in the canonical string form (including scientific notation
 * `1e-3` → 3). Undefined when no signal is available.
 */
function inferPrecision(precision?: number, step?: number): number | undefined {
  if (precision !== undefined && precision >= 0) {
    return precision;
  }
  if (!step || !Number.isFinite(step)) {
    return undefined;
  }
  const normalized = Math.abs(step);
  if (normalized >= 1) {
    return 0;
  }
  const asText = normalized.toString();
  const scientificMatch = asText.match(/e-(\d+)$/i);
  if (scientificMatch) {
    const exponent = Number.parseInt(scientificMatch[1] ?? "0", 10);
    return Number.isFinite(exponent) ? exponent : undefined;
  }
  const decimalIndex = asText.indexOf(".");
  if (decimalIndex === -1) {
    return undefined;
  }
  return asText.length - decimalIndex - 1;
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
  /** Only set for `kind === "color"`; mirrors the param def's `alpha` flag. */
  hasAlpha?: boolean;
  /** Serialised default for this slot (string-encoded the same way as `value`).
   *  Undefined when the schema doesn't declare a defaultValue — Reset stays
   *  hidden in that case (strict policy). */
  defaultValue?: string;
}

/**
 * One pseudo-field result from `mapFieldExpanded`. Vector defs expand into N
 * entries with a shared `groupKey` so pagination keeps them on one page.
 */
interface Expanded {
  /** Empty for singletons; `.0`/`.1`/`.2` for vector axes (appended to def.key). */
  keySuffix: string;
  label: string;
  mapped: Mapped;
  groupKey?: string;
}

/** Normalise a hex colour to lowercase `#rrggbb` or `#rrggbbaa`. Accepts the
 *  same shapes the inspector ColorField does (3/6/8-digit hex, with or without
 *  leading `#`), plus a defensive empty-string fallback to opaque black. */
function normalizeHex(raw: unknown, hasAlpha: boolean): string {
  const s = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  const body = s.startsWith("#") ? s.slice(1) : s;
  if (/^[0-9a-f]{3}$/.test(body)) {
    const r = body[0];
    const g = body[1];
    const b = body[2];
    return hasAlpha ? `#${r}${r}${g}${g}${b}${b}ff` : `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^[0-9a-f]{6}$/.test(body)) {
    return hasAlpha ? `#${body}ff` : `#${body}`;
  }
  if (/^[0-9a-f]{8}$/.test(body)) {
    return hasAlpha ? `#${body}` : `#${body.slice(0, 6)}`;
  }
  return hasAlpha ? "#000000ff" : "#000000";
}

/**
 * Serialise a param def's `defaultValue` into the same string-encoding family
 * as `value` (so the device can stash it verbatim and the host's
 * `decodeFieldValue` can round-trip it on Reset). Returns undefined when no
 * explicit default exists — Reset is hidden in that case (strict policy).
 *
 * Vector defaults are NOT handled here; `mapFieldExpanded` slices the array
 * per axis.
 */
function serializeDefault(def: ParameterDefinition): string | undefined {
  const dv = def.defaultValue;
  if (dv === undefined) {
    return undefined;
  }
  switch (def.type) {
    case "boolean":
      return dv ? "1" : "0";
    case "number":
      if (typeof dv !== "number") {
        return undefined;
      }
      return formatNumber(dv, inferPrecision(def.precision, def.step));
    case "select": {
      const opts = def.options ?? [];
      const i = opts.indexOf(String(dv));
      return i >= 0 ? String(i) : undefined;
    }
    case "color":
      return typeof dv === "string" ? normalizeHex(dv, def.alpha === true) : undefined;
    default:
      return undefined;
  }
}

/** Map one parameter definition + current value to a slot, or null to omit. */
function mapField(def: ParameterDefinition, params: ParameterValues): Mapped | null {
  const raw = params[def.key];
  switch (def.type) {
    case "boolean":
      return { kind: "toggle", value: raw ? "1" : "0", defaultValue: serializeDefault(def) };
    case "number": {
      const prec = inferPrecision(def.precision, def.step);
      return {
        kind: "number",
        value: formatNumber(raw, prec),
        min: def.min,
        max: def.max,
        step: def.step,
        precision: prec,
        unit: def.unit,
        defaultValue: serializeDefault(def)
      };
    }
    case "select": {
      const options = def.options ?? [];
      const idx = Math.max(0, options.indexOf(String(raw)));
      return { kind: "list", value: String(idx), options, defaultValue: serializeDefault(def) };
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
      // Handled by `mapFieldExpanded` — expanded into 3 number slots with a
      // shared groupKey so pagination keeps the axes on one page. This branch
      // remains as a defensive fallback for callers that bypass the expander.
      return {
        kind: "readonly",
        value: Array.isArray(raw) ? (raw as unknown[]).join(", ") : String(raw ?? ""),
        unit: def.unit
      };
    case "color": {
      const hasAlpha = def.alpha === true;
      return {
        kind: "color",
        value: normalizeHex(raw, hasAlpha),
        hasAlpha,
        defaultValue: serializeDefault(def)
      };
    }
    default:
      // location / datetime / timezone / file / material-slots /
      // dxf-layer-states — unsupported on the surface; omit.
      return null;
  }
}

/**
 * Like `mapField` but returns 1..N pseudo-fields for kinds that expand into
 * multiple slots (currently only `vector3` → x/y/z). Multi-slot results carry
 * a shared `groupKey` so `paginate` keeps them on one page.
 *
 * Per-component keys use a `<base>.<i>` synthetic suffix; the runtime
 * component's `applyFn` wrapper translates these back into a whole-array
 * write before they cross the host bridge (so synthetic axis keys never
 * escape the plugin).
 */
function mapFieldExpanded(def: ParameterDefinition, params: ParameterValues): Expanded[] {
  if (def.type === "vector3") {
    const raw = params[def.key];
    const arr: number[] = Array.isArray(raw)
      ? (raw as unknown[]).map((v) => (typeof v === "number" ? v : Number(v) || 0))
      : [0, 0, 0];
    const dv = Array.isArray(def.defaultValue) ? (def.defaultValue as unknown[]) : undefined;
    const axes = ["X", "Y", "Z"] as const;
    const prec = inferPrecision(def.precision, def.step);
    return axes.map((axis, i) => {
      const dvi = dv && typeof dv[i] === "number" ? (dv[i] as number) : undefined;
      return {
        keySuffix: `.${i}`,
        label: `${def.label || def.key} ${axis}`,
        groupKey: `vec:${def.key}`,
        mapped: {
          kind: "number",
          value: formatNumber(arr[i] ?? 0, prec),
          min: def.min,
          max: def.max,
          step: def.step,
          precision: prec,
          unit: def.unit,
          defaultValue: dvi !== undefined ? formatNumber(dvi, prec) : undefined
        }
      };
    });
  }
  const single = mapField(def, params);
  return single
    ? [{ keySuffix: "", label: def.label || def.key, mapped: single }]
    : [];
}

/**
 * Pack fields into 4-slot pages, never splitting a group (matching `groupKey`
 * run) across a page boundary. Singletons (no `groupKey`) fill the remainder
 * of the current page greedily; if the next group doesn't fit, a new page
 * begins and the previous page is padded with gaps (idx values are simply
 * skipped). The device's `slots[idx]` table is sparse-tolerant, so no
 * device-side changes are needed to handle gaps.
 *
 * The returned array preserves field order; only `idx` is rewritten.
 */
export function paginate(fields: SurfaceField[], slotsPerPage = 4): SurfaceField[] {
  // Collect runs: a singleton, or a maximal run of equal defined groupKey.
  const runs: SurfaceField[][] = [];
  let i = 0;
  while (i < fields.length) {
    const g = fields[i].groupKey;
    if (g === undefined) {
      runs.push([fields[i]]);
      i += 1;
    } else {
      const start = i;
      while (i < fields.length && fields[i].groupKey === g) i += 1;
      runs.push(fields.slice(start, i));
    }
  }
  const out: SurfaceField[] = [];
  let pageNum = 0;
  let slotInPage = 0;
  for (const run of runs) {
    // Defensive: a single group larger than a page would never paginate.
    // Truncate to fit; vector4 is the largest current case (still ≤ 4).
    if (run.length > slotsPerPage) {
      run.length = slotsPerPage;
    }
    if (slotInPage + run.length > slotsPerPage) {
      pageNum += 1;
      slotInPage = 0;
    }
    for (const f of run) {
      out.push({ ...f, idx: pageNum * slotsPerPage + slotInPage });
      slotInPage += 1;
    }
  }
  return out;
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
    unit: string | undefined,
    defaultNum: number,
    groupKey: string
  ): SurfaceField => ({
    key,
    idx: 0,
    kind: "number",
    label,
    value: value.toFixed(precision),
    step,
    precision,
    unit,
    hasDefault: true,
    defaultValue: defaultNum.toFixed(precision),
    groupKey
  });
  const axes = ["X", "Y", "Z"] as const;
  const fields: SurfaceField[] = [
    {
      key: "@enabled",
      idx: 0,
      kind: "toggle",
      label: "Enabled",
      value: snapshot.enabled ? "1" : "0",
      hasDefault: true,
      defaultValue: "1"
    },
    {
      key: "@visibility",
      idx: 0,
      kind: "list",
      label: "Visibility",
      value: String(Math.max(0, VISIBILITY_MODES.indexOf(snapshot.visibilityMode))),
      options: [...VISIBILITY_MODES],
      hasDefault: true,
      defaultValue: "0"
    }
  ];
  // Position / Rotation / Scale — each axis triple shares a groupKey so
  // pagination keeps them on one page (3 axes + 1 gap per page).
  for (let i = 0; i < 3; i += 1) {
    fields.push(num(`@pos.${i}`, `Pos ${axes[i]}`, t.position[i], 0.001, 3, "m", 0, "common:pos"));
  }
  for (let i = 0; i < 3; i += 1) {
    // Wire token "deg" (not "°") — the SSP payload is 7-bit ASCII so UTF-8
    // multi-byte characters would not survive sanitizeToken / asciiBytes. The
    // device renders a degree-symbol glyph for the "deg" token in the zoomed
    // readout; the mini-view fader label shows the literal text "deg".
    fields.push(num(`@rot.${i}`, `Rot ${axes[i]}`, t.rotation[i] * RAD_TO_DEG, 1, 1, "deg", 0, "common:rot"));
  }
  for (let i = 0; i < 3; i += 1) {
    fields.push(num(`@scl.${i}`, `Scl ${axes[i]}`, t.scale[i], 0.001, 3, "x", 1, "common:scl"));
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
    // Preserve the commonField's groupKey/hasDefault/defaultValue; only idx
    // gets rewritten by `paginate` below.
    fields.push({ ...cf });
  }
  for (const def of snapshot.schema?.params ?? []) {
    if (fields.length >= maxSlots) {
      break;
    }
    if (!visible(def, snapshot.params)) {
      continue;
    }
    const expanded = mapFieldExpanded(def, snapshot.params);
    for (const e of expanded) {
      if (fields.length >= maxSlots) {
        break;
      }
      fields.push({
        key: `${def.key}${e.keySuffix}`,
        idx: 0, // paginated below
        kind: e.mapped.kind,
        label: e.label,
        value: e.mapped.value,
        sectionLabel: def.groupKey ? def.groupLabel ?? def.groupKey : undefined,
        min: e.mapped.min,
        max: e.mapped.max,
        step: e.mapped.step,
        precision: e.mapped.precision,
        unit: e.mapped.unit,
        options: e.mapped.options,
        hasAlpha: e.mapped.hasAlpha,
        hasDefault: e.mapped.defaultValue !== undefined ? true : undefined,
        defaultValue: e.mapped.defaultValue,
        groupKey: e.groupKey
      });
    }
  }
  if (fields.length === 0) {
    return null;
  }
  // Final pagination pass: pack groups + singletons into 4-slot pages with
  // gaps where a group wouldn't fit (idx values are skipped).
  return { actorId: snapshot.id, actorName: snapshot.name, fields: paginate(fields) };
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
 * Colour edits arrive from the device as a hex string (`scp dv <idx> <hex>`).
 * The device authors the new hex locally — applying R/G/B/A/V channel deltas
 * — so the host just validates + normalises before writing back.
 */
export function decodeColorHex(
  field: Pick<SurfaceField, "hasAlpha">,
  raw: string
): string | undefined {
  const normalised = normalizeHex(raw, field.hasAlpha === true);
  // normalizeHex always returns a valid string; only reject if the input was
  // truly garbage (no hex digits at all) — distinguish via the fallback path.
  const body = String(raw).trim().toLowerCase().replace(/^#/, "");
  if (!/^[0-9a-f]{3,8}$/.test(body)) {
    return undefined;
  }
  return normalised;
}

/**
 * Convert a terse value coming back from the device into a host param value
 * for the given field. Returns `undefined` for kinds the device cannot edit
 * (so the caller skips the write).
 */
export function decodeFieldValue(
  field: Pick<SurfaceField, "kind" | "options" | "hasAlpha">,
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
    case "color":
      return decodeColorHex(field, raw);
    default:
      return undefined;
  }
}
