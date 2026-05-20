// Plain (React-free) session controller. All Web MIDI + lifecycle logic lives
// here; the React components are thin subscribers. Keeping this out of React
// also sidesteps the dual-React-instance hazard for dynamically-loaded plugin
// bundles (see README "Known load-time verification items").

import {
  DEFAULT_RENDER_OPTIONS,
  MIN_FIRMWARE,
  renderOptionsSig,
  SURFACE_BUNDLE_VERSION,
  type ElectraConnectionPhase,
  type ElectraConnectionState,
  type ElectraLogEntry,
  type ElectraCapStyle,
  type ElectraPortOverride,
  type ElectraRenderOptions
} from "./types";
import {
  enumerateMidiPorts,
  openElectra,
  webMidiSupported,
  type OpenOptions,
  type WebMidiAvailability,
  type WebMidiHandle
} from "./webMidiService";
import {
  buildDeviceInfoRequest,
  buildExecuteLua,
  buildRequestLua,
  buildRequestPreset,
  buildSwitchPresetSlot,
  buildUploadLua,
  buildUploadPreset,
  bytesToHex,
  hexToBytes,
  isElectraSysex,
  isMiniCompatible,
  parseAck,
  parseBundleVersion,
  parseDeviceInfoResponse,
  parseSspSysex,
  parseLuaResponse,
  parsePresetResponse
} from "./electraSysex";
import { buildSurfaceLua, SURFACE_PRESET_JSON, SURFACE_PRESET_MARKER } from "./surfaceBundle";
import type {
  ParameterSchema,
  ParameterValue,
  ParameterValues,
  PluginHostActorSnapshot
} from "./contracts";
import {
  decodeColorHex,
  decodeDeviceRaw,
  decodeDirectNumber,
  decodeFieldValue,
  mapInspectorToSurface
} from "./inspectorMapping";
import {
  clearCommand,
  setTransportCommand,
  decodeDeviceLine,
  setActorCommand,
  setFieldValueCommand,
  type SurfaceDescriptor,
  type SurfaceField
} from "./sspCodec";

export type SurfaceApplyFn = (
  actorId: string,
  key: string,
  value: boolean | number | string,
  options?: { history?: boolean }
) => void;

const DEVICE_INFO_TIMEOUT_MS = 2000;
const RESPONSE_TIMEOUT_MS = 1500;
const ACK_TIMEOUT_MS = 4000;
const POST_SWITCH_SETTLE_MS = 250;
const SURFACE_SUPPRESS_MS = 350;
const LOG_CAP = 80;
const MONITOR_CAP = 60;
const PORT_KEY = "simularca:electra-one:port-override";
const SLOT_KEY = "simularca:electra-one:target-slot";
const RENDER_KEY = "simularca:electra-one:render-options";
const RENDER_SIG_KEY = "simularca:electra-one:provisioned-render-sig";

const CAP_STYLES: ElectraCapStyle[] = ["flat", "round", "polygon", "triangle"];

/** Normalise persisted render options to the current shape. Pre-v20 stored a
 *  `roundedCaps` boolean instead of `capStyle`; map true→round, false→flat. */
function migrateRenderOptions(raw: Record<string, unknown>): ElectraRenderOptions {
  let capStyle = raw.capStyle as ElectraCapStyle | undefined;
  if (!capStyle || !CAP_STYLES.includes(capStyle)) {
    capStyle =
      typeof raw.roundedCaps === "boolean"
        ? raw.roundedCaps
          ? "round"
          : "flat"
        : DEFAULT_RENDER_OPTIONS.capStyle;
  }
  return {
    capStyle,
    ghostSegments:
      typeof raw.ghostSegments === "boolean"
        ? raw.ghostSegments
        : DEFAULT_RENDER_OPTIONS.ghostSegments
  };
}

/** Synthetic actor id for the inspector "test surface". It is never a real
 *  host actor, so device edits are looped back into a local store instead of
 *  through the host bridge. */
export const TEST_ACTOR_ID = "__electra-test-surface__";

/** Dummy controls so the Electra One round-trip can be exercised with no
 *  real actor selected: three numbers covering the distinct number cases
 *  (ranged-with-step → slider, rangeless float, rangeless integer), a
 *  select(list), and two colours (RGB-only + RGBA) exercising both zoomed
 *  channel layouts (R/G/B/V vs R/G/B/A). All are hardware-editable. */
export const TEST_SCHEMA: ParameterSchema = {
  id: "electra-test-surface",
  title: "Test Surface",
  params: [
    {
      key: "tRanged",
      label: "Ranged (step)",
      type: "number",
      min: 0,
      max: 100,
      step: 0.5,
      precision: 1
    },
    {
      key: "tRangeless",
      label: "Rangeless",
      type: "number",
      step: 0.1,
      precision: 2
    },
    {
      key: "tInt",
      label: "Integer",
      type: "number",
      step: 1,
      precision: 0
    },
    {
      key: "tSelect",
      label: "Test Select",
      type: "select",
      options: ["Alpha", "Bravo", "Charlie", "Delta"]
    },
    {
      key: "tColor",
      label: "Test Color",
      type: "color"
    },
    {
      key: "tColorAlpha",
      label: "Test Color+A",
      type: "color",
      alpha: true
    }
  ]
};

const TEST_DEFAULTS: ParameterValues = {
  tRanged: 25,
  tRangeless: 1.23,
  tInt: 3,
  tSelect: "Alpha",
  tColor: "#ff8a00",
  tColorAlpha: "#3366ccc0"
};

export interface SessionDeps {
  open?: (opts: OpenOptions) => Promise<WebMidiHandle>;
  enumerate?: () => Promise<{ inputs: { name: string }[]; outputs: { name: string }[] }>;
  checkSupport?: () => WebMidiAvailability;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function compareFirmware(a: string, b: string): number {
  const norm = (s: string) => s.replace(/^v/i, "");
  const pa = norm(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = norm(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

export class ElectraSession {
  private readonly open: (opts: OpenOptions) => Promise<WebMidiHandle>;
  private readonly enumerate: () => Promise<{
    inputs: { name: string }[];
    outputs: { name: string }[];
  }>;
  private readonly checkSupport: () => WebMidiAvailability;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;

  private state: ElectraConnectionState = {
    phase: "unavailable",
    summary: "Not started.",
    midiInputPortName: null,
    midiOutputPortName: null,
    availablePorts: { inputs: [], outputs: [] },
    portOverride: { input: null, output: null },
    deviceInfoReceived: false,
    midiMonitor: [],
    device: null,
    onDeviceBundleVersion: null,
    buildBundleVersion: SURFACE_BUNDLE_VERSION,
    renderOptions: { ...DEFAULT_RENDER_OPTIONS },
    provisionedRenderSig: null,
    targetSlot: { bank: 2, slot: 0 },
    presetSlot: null,
    overwriteBlocked: null,
    mirroredActor: null,
    focusedSlot: null,
    testSurface: null,
    lastError: null,
    log: []
  };

  private readonly listeners = new Set<() => void>();
  private handle: WebMidiHandle | null = null;
  private disposed = false;
  private starting = false;

  // Surface (SSP) state.
  private applyFn: SurfaceApplyFn | null = null;
  private transportToggleFn: (() => void) | null = null;
  /** Last transport-state we pushed to the device, so we don't spam `ssp T`
   *  on every host re-render when nothing changed. */
  private lastPushedTransportPlaying: boolean | null = null;
  private snapshot: PluginHostActorSnapshot | null = null;
  /** Test-surface param values, or null when the test surface is disabled. */
  private testParams: ParameterValues | null = null;
  private descriptor: SurfaceDescriptor | null = null;
  private suppressUntil = 0;
  private suppressKey: string | null = null;

  constructor(deps: SessionDeps = {}) {
    this.open = deps.open ?? openElectra;
    this.enumerate = deps.enumerate ?? enumerateMidiPorts;
    this.checkSupport = deps.checkSupport ?? webMidiSupported;
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    this.state.portOverride = this.loadJson(PORT_KEY, { input: null, output: null });
    this.state.targetSlot = this.loadJson(SLOT_KEY, { bank: 2, slot: 0 });
    this.state.renderOptions = migrateRenderOptions(
      this.loadJson<Record<string, unknown>>(RENDER_KEY, {})
    );
    try {
      const sig = this.storage?.getItem(RENDER_SIG_KEY);
      this.state.provisionedRenderSig = sig ? (JSON.parse(sig) as string) : null;
    } catch {
      /* ignore */
    }
  }

  getState(): ElectraConnectionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.state = { ...this.state };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private log(level: ElectraLogEntry["level"], message: string): void {
    const entry: ElectraLogEntry = { atIso: new Date().toISOString(), level, message };
    const next = [...this.state.log, entry];
    this.state.log = next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
  }

  private monitor(dir: "in" | "out", bytes: number[]): void {
    const entry = { atIso: new Date().toISOString(), dir, hex: bytesToHex(bytes) };
    const next = [...this.state.midiMonitor, entry];
    this.state.midiMonitor =
      next.length > MONITOR_CAP ? next.slice(next.length - MONITOR_CAP) : next;
  }

  private set(phase: ElectraConnectionPhase, summary: string): void {
    this.state.phase = phase;
    this.state.summary = summary;
    this.log(phase === "error" || phase === "incompatible" ? "warn" : "info", summary);
    this.emit();
    if (phase === "ready") {
      this.pushSurface();
    }
  }

  private loadJson<T>(key: string, fallback: T): T {
    try {
      const raw = this.storage?.getItem(key);
      if (raw) {
        return { ...fallback, ...(JSON.parse(raw) as object) } as T;
      }
    } catch {
      /* ignore */
    }
    return fallback;
  }

  private saveJson(key: string, value: unknown): void {
    try {
      this.storage?.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async setPortOverride(next: ElectraPortOverride): Promise<void> {
    this.state.portOverride = { input: next.input ?? null, output: next.output ?? null };
    this.saveJson(PORT_KEY, this.state.portOverride);
    this.log("info", `Port override: in=${next.input ?? "auto"} out=${next.output ?? "auto"}`);
    this.emit();
    await this.start();
  }

  setTargetSlot(bank: number, slot: number): void {
    this.state.targetSlot = { bank: Math.max(0, bank | 0), slot: Math.max(0, slot | 0) };
    this.state.overwriteBlocked = null;
    this.saveJson(SLOT_KEY, this.state.targetSlot);
    this.log("info", `Target slot set to bank ${this.state.targetSlot.bank} slot ${this.state.targetSlot.slot}.`);
    this.emit();
  }

  /** Update device-side render detail flags (persisted). Does NOT re-upload —
   *  the assembled Lua only changes on the next provision(); the inspector
   *  surfaces an "options changed — provision" hint via provisionedRenderSig. */
  setRenderOptions(partial: Partial<ElectraRenderOptions>): void {
    const next = { ...this.state.renderOptions, ...partial };
    if (renderOptionsSig(next) === renderOptionsSig(this.state.renderOptions)) {
      return;
    }
    this.state.renderOptions = next;
    this.saveJson(RENDER_KEY, next);
    this.log(
      "info",
      `Render options: caps=${next.capStyle} ghost=${next.ghostSegments ? "on" : "off"} (provision to apply on device).`
    );
    this.emit();
  }

  async refreshPorts(): Promise<void> {
    try {
      const list = await this.enumerate();
      this.state.availablePorts = {
        inputs: list.inputs.map((p) => p.name),
        outputs: list.outputs.map((p) => p.name)
      };
      this.emit();
    } catch (error) {
      this.log("warn", `Port enumeration failed: ${String(error)}`);
    }
  }

  /* -------------------------------------------------------- surface (SSP) */

  /** The runtime component injects the host param-write path here. */
  setApply(fn: SurfaceApplyFn | null): void {
    this.applyFn = fn;
  }

  /** The runtime component injects the host transport-toggle path here.
   *  Fired when the device emits `scp btn playpause`. */
  setTransportToggle(fn: (() => void) | null): void {
    this.transportToggleFn = fn;
  }

  /** Push the host's transport state to the device so the Play/Pause pad
   *  label + colour mirror it. No-op while not ready and on no-change. */
  setTransportPlaying(playing: boolean): void {
    if (this.state.phase !== "ready" || !this.state.presetSlot || !this.handle) {
      return;
    }
    if (this.lastPushedTransportPlaying === playing) {
      return;
    }
    this.lastPushedTransportPlaying = playing;
    this.sendSsp(setTransportCommand(playing));
  }

  /** Called by the runtime whenever the editor selection / its params change. */
  setSelectedActor(snapshot: PluginHostActorSnapshot | null): void {
    this.snapshot = snapshot;
    this.syncSurface();
  }

  /** A real selection always wins; the test surface is only a fallback so it
   *  never fights an actually-selected actor. */
  private effectiveSnapshot(): PluginHostActorSnapshot | null {
    if (this.snapshot) {
      return this.snapshot;
    }
    if (!this.testParams) {
      return null;
    }
    return {
      id: TEST_ACTOR_ID,
      name: "Test Surface",
      actorType: "test",
      params: this.testParams,
      schema: TEST_SCHEMA,
      // Transform omitted so commonFields() contributes nothing — the surface
      // is exactly the 4 dummy params, no transform/enabled/visibility rows.
      transform: undefined as unknown as PluginHostActorSnapshot["transform"],
      enabled: true,
      visibilityMode: "visible"
    };
  }

  /** Re-derive the mirrored actor and reconcile the device from whatever the
   *  effective (real-or-test) snapshot now is. */
  private syncSurface(): void {
    const eff = this.effectiveSnapshot();
    const mirror = eff ? { id: eff.id, name: eff.name } : null;
    const cur = this.state.mirroredActor;
    if (cur?.id !== mirror?.id || cur?.name !== mirror?.name) {
      this.state.mirroredActor = mirror;
      this.emit();
    }
    this.pushSurface();
  }

  /** Inspector toggle: enable/disable the synthetic 4-control test surface.
   *  It only reaches the device while no real actor is selected. */
  setTestSurface(enabled: boolean): void {
    if (enabled === (this.testParams !== null)) {
      return;
    }
    this.testParams = enabled ? { ...TEST_DEFAULTS } : null;
    this.state.testSurface = this.testParams;
    this.log(
      "info",
      enabled ? "Test surface enabled (4 dummy controls)." : "Test surface disabled."
    );
    this.emit();
    this.syncSurface();
  }

  /** Inspector edit of a test-surface control (host→device round-trip test). */
  setTestParam(key: string, value: ParameterValue): void {
    if (!this.testParams || !(key in this.testParams)) {
      return;
    }
    this.testParams = { ...this.testParams, [key]: value };
    this.state.testSurface = this.testParams;
    this.emit();
    this.syncSurface();
  }

  private structureSig(d: SurfaceDescriptor): string {
    return (
      d.actorId +
      "|" +
      d.fields.map((f) => `${f.idx},${f.key},${f.kind},${f.label},${(f.options ?? []).join("/")}`).join(";")
    );
  }

  private sendSsp(command: string): void {
    try {
      this.sendMonitored(buildExecuteLua(command));
    } catch (error) {
      this.log("error", `SSP send failed: ${String(error)}`);
    }
  }

  /** Reconcile the device with the current selection (full SET_ACTOR on a
   *  structure change, else per-field value pushes; CLEAR when nothing). */
  private pushSurface(): void {
    if (!this.handle || this.state.phase !== "ready" || !this.state.presetSlot) {
      return; // not provisioned yet — will push again once ready
    }
    const next = mapInspectorToSurface(this.effectiveSnapshot());
    if (!next) {
      if (this.descriptor) {
        this.sendSsp(clearCommand());
        this.descriptor = null;
      }
      return;
    }
    if (!this.descriptor || this.structureSig(this.descriptor) !== this.structureSig(next)) {
      this.sendSsp(setActorCommand(next));
      this.descriptor = next;
      return;
    }
    for (let i = 0; i < next.fields.length; i += 1) {
      const prev = this.descriptor.fields[i];
      const cur = next.fields[i];
      if (prev.value === cur.value) {
        continue;
      }
      const echo =
        this.suppressKey === cur.key && Date.now() < this.suppressUntil;
      if (!echo) {
        this.sendSsp(setFieldValueCommand(cur.idx, cur.value));
      }
      prev.value = cur.value;
    }
  }

  /**
   * Shared device→host edit path. Logs the precise reason at every guard so
   * "values don't update in Simularca" is diagnosable from the inspector's
   * Diagnostics panel rather than failing silently.
   */
  private applyDeviceEdit(
    tag: string,
    idx: number,
    decode: (field: SurfaceField) => boolean | number | string | undefined
  ): void {
    if (!this.descriptor) {
      this.log("warn", `${tag} ${idx}: ignored — no descriptor (no actor mirrored yet).`);
      return;
    }
    const field = this.descriptor.fields.find((f) => f.idx === idx);
    if (!field) {
      this.log(
        "warn",
        `${tag} ${idx}: no field at that index (descriptor has ${this.descriptor.fields.length}).`
      );
      return;
    }
    const decoded = decode(field);
    if (decoded === undefined) {
      this.log("warn", `${tag} ${field.label}: value not decodable for kind ${field.kind}.`);
      return;
    }
    // Loop prevention: the host re-render this triggers must not echo a
    // SET_FIELD_VALUE straight back (SPEC §8.1).
    this.suppressKey = field.key;
    this.suppressUntil = Date.now() + SURFACE_SUPPRESS_MS;
    const eff = this.effectiveSnapshot();
    if (eff?.id === TEST_ACTOR_ID && this.testParams) {
      // Self-contained: the test surface has no host actor, so loop the edit
      // back into the local store and re-push instead of the host bridge.
      this.testParams = { ...this.testParams, [field.key]: decoded };
      this.state.testSurface = this.testParams;
      this.log(
        "info",
        `${tag} ${field.label} (${field.key}) -> ${String(decoded)} [test surface]`
      );
      this.emit();
      this.syncSurface();
      return;
    }
    if (!this.applyFn || !eff) {
      this.log(
        "warn",
        `${tag} ${field.label} -> ${String(decoded)}: NOT applied — ${
          !this.applyFn ? "no apply callback" : "no selected actor"
        }.`
      );
      return;
    }
    this.log("info", `${tag} ${field.label} (${field.key}) -> ${String(decoded)} [applied]`);
    this.applyFn(eff.id, field.key, decoded, { history: false });
  }

  /**
   * Reset the focused field to its declared default. Triggered by the Reset
   * pad on the device emitting `scp btn reset <idx>`. Strict policy: fields
   * without an explicit `defaultValue` in the schema are silently ignored —
   * the device-side pad is hidden for them anyway, so this is just defence
   * against a stale focus.
   *
   * Unlike normal device edits (history:false, live-drag semantics), Reset
   * writes with history:true so the user can Cmd-Z back to the pre-reset
   * value.
   */
  private applyDeviceReset(idx: number): void {
    if (!this.descriptor) {
      this.log("warn", `reset ${idx}: ignored — no descriptor.`);
      return;
    }
    const field = this.descriptor.fields.find((f) => f.idx === idx);
    if (!field) {
      this.log("warn", `reset ${idx}: no field at that index.`);
      return;
    }
    if (!field.hasDefault || field.defaultValue == null) {
      this.log("warn", `reset ${field.label}: no default declared.`);
      return;
    }
    const decoded = decodeFieldValue(field, field.defaultValue);
    if (decoded === undefined) {
      this.log("warn", `reset ${field.label}: default could not be decoded.`);
      return;
    }
    // NOTE: do NOT set suppressKey/suppressUntil here. The echo-suppress
    // window guards against bouncing a value back to the device after the
    // device authored it locally (valueChanged / detailChanged). The Reset
    // pad's btnReset handler emits the request only — it does not update
    // the device's slots[idx].value. So we DO want pushSurface to send
    // setFieldValueCommand on the next reconciliation; otherwise the
    // device's mini-view stays stale at the old value for 350ms.
    const eff = this.effectiveSnapshot();
    if (eff?.id === TEST_ACTOR_ID && this.testParams) {
      this.testParams = { ...this.testParams, [field.key]: decoded };
      this.state.testSurface = this.testParams;
      this.log("info", `reset ${field.label} -> ${String(decoded)} [test surface]`);
      this.emit();
      this.syncSurface();
      return;
    }
    if (!this.applyFn || !eff) {
      this.log("warn", `reset ${field.label}: NOT applied — no apply callback or actor.`);
      return;
    }
    this.log("info", `reset ${field.label} (${field.key}) -> ${String(decoded)} [applied]`);
    this.applyFn(eff.id, field.key, decoded, { history: true });
  }

  private onDeviceValue(idx: number, raw: string): void {
    this.applyDeviceEdit("device edit", idx, (field) => decodeDeviceRaw(field, Number(raw)));
  }

  /** Direct-value path (`scp dv`): used by the digit editor for numbers AND
   *  by colour fields for both preview-brightness scrubbing and zoomed-in
   *  R/G/B/A/V channel edits — in both cases the device authors the new
   *  semantic value locally and emits the full string. Dispatch by kind. */
  private onDeviceDirect(idx: number, raw: string): void {
    this.applyDeviceEdit("direct edit", idx, (field) => {
      if (field.kind === "color") {
        return decodeColorHex(field, raw);
      }
      return decodeDirectNumber(field, raw);
    });
  }

  /**
   * Decode one device SSP line (carried in the self-emitted SSP SysEx) and
   * dispatch it. `scp hb …` heartbeats fall through decodeDeviceLine to a
   * `log` event — surfaced, never applied.
   */
  private handleDeviceLine(text: string): void {
    const ev = decodeDeviceLine(text);
    if (ev?.type === "value") {
      this.onDeviceValue(ev.idx, ev.value);
    } else if (ev?.type === "dvalue") {
      this.onDeviceDirect(ev.idx, ev.value);
    } else if (ev?.type === "focus") {
      if (ev.idx < 0) {
        this.state.focusedSlot = null;
        this.log("info", "device: defocused (page scrolled focus off-screen)");
      } else {
        this.state.focusedSlot = ev.idx;
        this.log("info", `device: focused field ${ev.idx}`);
      }
    } else if (ev?.type === "ready") {
      this.log("info", `device: surface ready (bundle ${ev.bundle ?? "?"})`);
    } else if (ev?.type === "button") {
      this.log("info", `device: button ${ev.action}`);
      if (ev.action === "playpause" && this.transportToggleFn) {
        // The host transport toggle. On the next host re-render the bridge's
        // transportPlaying flips, the runtime calls setTransportPlaying here,
        // and the device sees `ssp T<0|1>` -- which updates the pad label
        // to "Play"/"Pause" -- closing the round trip.
        this.transportToggleFn();
      } else if (ev.action.startsWith("reset ")) {
        const idx = Number(ev.action.slice(6));
        if (Number.isFinite(idx)) {
          this.applyDeviceReset(idx);
        }
      }
    } else if (ev?.type === "log") {
      this.log("info", `device: ${ev.text}`);
    }
    // Unrecognised lines (none in normal operation now that the firmware
    // logger is never enabled) are dropped silently — kept defensive so a
    // future firmware revival of any logger path can't crash the panel.
  }

  /* ----------------------------------------------------------- lifecycle */

  async start(): Promise<void> {
    if (this.disposed || this.starting) {
      return;
    }
    this.starting = true;
    try {
      this.teardownHandle();
      this.state.device = null;
      this.state.deviceInfoReceived = false;
      this.state.lastError = null;
      this.state.overwriteBlocked = null;

      const support = this.checkSupport();
      if (!support.available) {
        this.set("unavailable", support.reason);
        return;
      }

      this.set("detecting", "Requesting Web MIDI access and locating the Electra One…");
      let handle: WebMidiHandle;
      try {
        handle = await this.open({
          inputName: this.state.portOverride.input,
          outputName: this.state.portOverride.output
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.state.lastError = detail;
        await this.refreshPorts();
        this.set("unavailable", detail);
        return;
      }
      if (this.disposed) {
        handle.close();
        return;
      }
      this.handle = handle;
      this.state.midiInputPortName = handle.inputName;
      this.state.midiOutputPortName = handle.outputName;
      this.state.availablePorts = {
        inputs: handle.ports.inputs.map((p) => p.name),
        outputs: handle.ports.outputs.map((p) => p.name)
      };

      // Persistent inbound monitor + device SSP surfacing. Device→host is
      // the self-emitted SSP SysEx (parseSspSysex) — the sole channel on
      // fw v4.1.4; the print()/firmware-logger Log-SysEx path is dead and
      // the connect-time enable handshake has been removed.
      handle.onMessage((bytes) => {
        this.monitor("in", bytes);
        const ssp = parseSspSysex(bytes);
        if (ssp !== null) {
          this.handleDeviceLine(ssp);
        }
        this.emit();
      });
      handle.onStateChange(() => {
        if (!this.disposed) {
          this.log("info", "MIDI port state changed; re-detecting.");
          void this.start();
        }
      });

      this.set("checking-firmware", `Connected to ${handle.inputName}. Requesting device info…`);
      const info = await this.awaitResponse(
        () => this.sendMonitored(buildDeviceInfoRequest()),
        (m) => parseDeviceInfoResponse(m) !== null,
        DEVICE_INFO_TIMEOUT_MS
      );
      if (this.disposed) {
        return;
      }
      const parsed = info ? parseDeviceInfoResponse(info) : null;
      if (!parsed) {
        this.log(
          "warn",
          "No device-info reply. Likely the wrong USB port — pick the 'Electra Controller' port below."
        );
        this.set(
          "ready",
          "Electra connected but did NOT answer device info (probably the wrong port). Use the port picker."
        );
        return;
      }
      this.state.device = parsed;
      this.state.deviceInfoReceived = true;
      if (!isMiniCompatible(parsed)) {
        this.set("incompatible", `Unsupported device model "${parsed.model}".`);
        return;
      }
      if (MIN_FIRMWARE && compareFirmware(parsed.firmware, MIN_FIRMWARE) < 0) {
        this.set("incompatible", `Firmware ${parsed.firmware} is below the required ${MIN_FIRMWARE}.`);
        return;
      }

      await this.ensureProvisioned();
    } finally {
      this.starting = false;
    }
  }

  /** Skip upload when the target slot already runs our current bundle. */
  private async ensureProvisioned(): Promise<void> {
    const { bank, slot } = this.state.targetSlot;
    this.set("provisioning", `Checking target slot (bank ${bank}, slot ${slot})…`);
    this.sendMonitored(buildSwitchPresetSlot(bank, slot));
    await this.wait(POST_SWITCH_SETTLE_MS);

    const luaMsg = await this.awaitResponse(
      () => this.sendMonitored(buildRequestLua()),
      (m) => parseLuaResponse(m) !== null,
      RESPONSE_TIMEOUT_MS
    );
    const onDevice = luaMsg ? parseBundleVersion(parseLuaResponse(luaMsg) ?? "") : null;
    this.state.onDeviceBundleVersion = onDevice;

    if (onDevice === SURFACE_BUNDLE_VERSION) {
      this.state.presetSlot = { bank, slot };
      // The device may have been power-cycled (empty Lua state) since we last
      // pushed; force a full re-push so the surface is restored on reconnect.
      this.descriptor = null;
      this.lastPushedTransportPlaying = null;
      this.set(
        "ready",
        `Surface already provisioned (v${onDevice}) at bank ${bank} slot ${slot}. Device is live.`
      );
      return;
    }
    await this.provision();
  }

  /**
   * Upload preset + Lua to the target slot and activate it. Refuses to
   * overwrite a non-Simularca preset (SPEC §4: never clobber a user preset)
   * unless `force` is set (the inspector's explicit "Force overwrite" button).
   */
  async provision(force = false): Promise<boolean> {
    if (!this.handle) {
      this.set("error", "Cannot provision: not connected.");
      return false;
    }
    this.state.overwriteBlocked = null;
    const { bank, slot } = this.state.targetSlot;
    this.set("provisioning", `Inspecting bank ${bank} slot ${slot} before upload…`);
    this.sendMonitored(buildSwitchPresetSlot(bank, slot));
    await this.wait(POST_SWITCH_SETTLE_MS);

    const presetMsg = await this.awaitResponse(
      () => this.sendMonitored(buildRequestPreset()),
      (m) => parsePresetResponse(m) !== null,
      RESPONSE_TIMEOUT_MS
    );
    const existing = presetMsg ? parsePresetResponse(presetMsg) : null;
    const existingName = existing && typeof existing.name === "string" ? existing.name : null;
    if (existingName && existingName !== SURFACE_PRESET_MARKER) {
      if (!force) {
        this.state.overwriteBlocked = { bank, slot, name: existingName };
        this.set(
          "error",
          `Bank ${bank} slot ${slot} holds "${existingName}". Refusing to overwrite a non-Simularca preset — pick another target slot, or use "Force overwrite this slot" in the inspector.`
        );
        return false;
      }
      this.log("warn", `Force-overwriting "${existingName}" at bank ${bank} slot ${slot}.`);
    }

    this.set("provisioning", "Uploading preset…");
    const presetAck = await this.awaitResponse(
      () => this.sendMonitored(buildUploadPreset(SURFACE_PRESET_JSON)),
      (m) => parseAck(m) !== null,
      ACK_TIMEOUT_MS
    );
    if (!presetAck || parseAck(presetAck)?.ok !== true) {
      this.set("error", presetAck ? "Device rejected the preset upload (NACK)." : "Preset upload timed out (no ACK).");
      return false;
    }

    const opts = this.state.renderOptions;
    this.set(
      "provisioning",
      `Uploading Lua app (caps=${opts.capStyle}, ghost=${opts.ghostSegments ? "on" : "off"})…`
    );
    const luaAck = await this.awaitResponse(
      () => this.sendMonitored(buildUploadLua(buildSurfaceLua(opts))),
      (m) => parseAck(m) !== null,
      ACK_TIMEOUT_MS
    );
    if (!luaAck || parseAck(luaAck)?.ok !== true) {
      this.set("error", luaAck ? "Device rejected the Lua upload (NACK)." : "Lua upload timed out (no ACK).");
      return false;
    }

    // The device now holds the Lua built from these exact options.
    this.state.provisionedRenderSig = renderOptionsSig(opts);
    this.saveJson(RENDER_SIG_KEY, this.state.provisionedRenderSig);

    // Activate — the device screen now shows the Simularca Surface preset.
    this.sendMonitored(buildSwitchPresetSlot(bank, slot));
    await this.wait(POST_SWITCH_SETTLE_MS);
    this.state.presetSlot = { bank, slot };

    const verifyMsg = await this.awaitResponse(
      () => this.sendMonitored(buildRequestLua()),
      (m) => parseLuaResponse(m) !== null,
      RESPONSE_TIMEOUT_MS
    );
    const ver = verifyMsg ? parseBundleVersion(parseLuaResponse(verifyMsg) ?? "") : null;
    this.state.onDeviceBundleVersion = ver;
    // The device just reloaded a freshly-uploaded preset, so its Lua state is
    // empty (slots = {}). Drop our cached descriptor so the ready-triggered
    // pushSurface() re-sends a full SET_ACTOR — the (test) surface appears on
    // the device immediately after provisioning, not on the next selection.
    this.descriptor = null;
    this.lastPushedTransportPlaying = null;
    this.set(
      "ready",
      `Provisioned to bank ${bank} slot ${slot}. Device shows "Simularca v${ver ?? "?"}".`
    );
    return true;
  }

  /** Inspector "Re-provision": force a fresh upload. */
  async reprovision(): Promise<void> {
    this.log("info", "Re-provision requested.");
    if (!this.handle) {
      await this.start();
      return;
    }
    await this.provision();
  }

  /* -------------------------------------------------------- debug actions */

  private requireHandle(): WebMidiHandle {
    if (!this.handle) {
      throw new Error("Not connected to the Electra. Press Re-detect first.");
    }
    return this.handle;
  }

  private sendMonitored(bytes: number[]): void {
    const handle = this.requireHandle();
    handle.send(bytes);
    this.monitor("out", bytes);
    this.emit();
  }

  async sendDeviceInfoRequest(): Promise<void> {
    const msg = await this.awaitResponse(
      () => this.sendMonitored(buildDeviceInfoRequest()),
      (m) => parseDeviceInfoResponse(m) !== null,
      DEVICE_INFO_TIMEOUT_MS
    );
    const info = msg ? parseDeviceInfoResponse(msg) : null;
    if (info) {
      this.state.device = info;
      this.state.deviceInfoReceived = true;
      this.log("info", `Device info: ${info.model} fw ${info.firmware}`);
    } else {
      this.log("warn", "Device-info request: no reply (wrong port?).");
    }
    this.emit();
  }

  switchPresetSlot(bank: number, slot: number): void {
    this.sendMonitored(buildSwitchPresetSlot(bank, slot));
    this.log("info", `Sent Set Preset Slot bank=${bank} slot=${slot} (0-based; watch the device).`);
  }

  sendRawSysex(hex: string): void {
    const bytes = hexToBytes(hex);
    if (bytes.length === 0) {
      throw new Error("Nothing to send.");
    }
    this.sendMonitored(bytes);
    this.log("info", `Sent raw ${bytes.length} bytes.`);
  }

  clearMonitor(): void {
    this.state.midiMonitor = [];
    this.emit();
  }

  /* ----------------------------------------------------------- internals */

  private awaitResponse(
    send: () => void,
    match: (message: number[]) => boolean,
    timeoutMs: number
  ): Promise<number[] | null> {
    return new Promise((resolve) => {
      const handle = this.handle;
      if (!handle) {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value: number[] | null) => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = handle.onMessage((bytes) => {
        if (isElectraSysex(bytes) && match(bytes)) {
          finish(bytes);
        }
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      try {
        send();
      } catch (error) {
        this.log("error", `Send failed: ${String(error)}`);
        finish(null);
      }
    });
  }

  private teardownHandle(): void {
    if (this.handle) {
      this.handle.close();
      this.handle = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.teardownHandle();
    this.listeners.clear();
  }
}
