// Plain (React-free) session controller. All Web MIDI + lifecycle logic lives
// here; the React components are thin subscribers. Keeping this out of React
// also sidesteps the dual-React-instance hazard for dynamically-loaded plugin
// bundles (see README "Known load-time verification items").

import {
  MIN_FIRMWARE,
  SURFACE_BUNDLE_VERSION,
  type ElectraConnectionPhase,
  type ElectraConnectionState,
  type ElectraLogEntry,
  type ElectraPortOverride
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
  buildSwitchPresetSlot,
  bytesToHex,
  hexToBytes,
  isElectraSysex,
  isMiniCompatible,
  parseDeviceInfoResponse
} from "./electraSysex";

const DEVICE_INFO_TIMEOUT_MS = 2000;
const LOG_CAP = 60;
const MONITOR_CAP = 40;
const STORAGE_KEY = "simularca:electra-one:port-override";

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
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
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
    presetSlot: null,
    mirroredActor: null,
    lastError: null,
    log: []
  };

  private readonly listeners = new Set<() => void>();
  private handle: WebMidiHandle | null = null;
  private disposed = false;
  private starting = false;

  constructor(deps: SessionDeps = {}) {
    this.open = deps.open ?? openElectra;
    this.enumerate = deps.enumerate ?? enumerateMidiPorts;
    this.checkSupport = deps.checkSupport ?? webMidiSupported;
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    this.state.portOverride = this.loadOverride();
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
  }

  private loadOverride(): ElectraPortOverride {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ElectraPortOverride>;
        return { input: parsed.input ?? null, output: parsed.output ?? null };
      }
    } catch {
      /* ignore */
    }
    return { input: null, output: null };
  }

  private saveOverride(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state.portOverride));
    } catch {
      /* ignore */
    }
  }

  /** Pin (or clear with nulls) the exact MIDI port names, then reconnect. */
  async setPortOverride(next: ElectraPortOverride): Promise<void> {
    this.state.portOverride = { input: next.input ?? null, output: next.output ?? null };
    this.saveOverride();
    this.log("info", `Port override set: in=${next.input ?? "auto"} out=${next.output ?? "auto"}`);
    this.emit();
    await this.start();
  }

  /** Enumerate ports without (re)connecting — for the inspector picker. */
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

  setMirroredActor(actor: { id: string; name: string } | null): void {
    const current = this.state.mirroredActor;
    if (current?.id === actor?.id && current?.name === actor?.name) {
      return;
    }
    this.state.mirroredActor = actor;
    // TODO Phase 3: build the SET_ACTOR descriptor via inspectorMapping and
    // push it to the device over the Simularca Surface Protocol.
    this.emit();
  }

  /** Begin (or restart) detection. Idempotent while in flight. */
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
        // Still surface what ports exist so the user can pick manually.
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

      // Persistent inbound monitor.
      handle.onMessage((bytes) => {
        this.monitor("in", bytes);
        this.emit();
      });
      handle.onStateChange(() => {
        if (!this.disposed) {
          this.log("info", "MIDI port state changed; re-detecting.");
          void this.start();
        }
      });

      this.set("checking-firmware", `Connected to ${handle.inputName}. Requesting device info…`);
      const info = await this.awaitDeviceInfo(handle);
      if (this.disposed) {
        return;
      }

      if (!info) {
        this.log(
          "warn",
          "No device-info reply within timeout. Likely the wrong USB port — pick the 'Electra Controller' port below."
        );
        this.set(
          "ready",
          "Electra connected but did NOT answer device info (probably the wrong port). Use the port picker / debug tools below."
        );
        return;
      }

      this.state.device = info;
      this.state.deviceInfoReceived = true;
      if (!isMiniCompatible(info)) {
        this.set("incompatible", `Unsupported device model "${info.model}".`);
        return;
      }
      if (MIN_FIRMWARE && compareFirmware(info.firmware, MIN_FIRMWARE) < 0) {
        this.set("incompatible", `Firmware ${info.firmware} is below the required ${MIN_FIRMWARE}.`);
        return;
      }

      // TODO Phase 2: slot discovery, BUNDLE_VERSION compare, preset + Lua
      // upload, Switch Preset Slot, persistence → "provisioning" → "ready".
      this.set(
        "ready",
        `Electra One ${info.model} (fw ${info.firmware}) talking. Provisioning lands in Phase 2 — use the debug tools to verify the link.`
      );
    } finally {
      this.starting = false;
    }
  }

  /** Phase 2 entry point for the inspector "Re-provision" button. */
  async reprovision(): Promise<void> {
    this.log("info", "Re-provision requested.");
    await this.start();
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

  /** Debug: (re)send the device-info request and log the parsed reply. */
  async sendDeviceInfoRequest(): Promise<void> {
    const handle = this.requireHandle();
    const info = await this.awaitDeviceInfo(handle);
    if (info) {
      this.state.device = info;
      this.state.deviceInfoReceived = true;
      this.log("info", `Device info: ${info.model} fw ${info.firmware}`);
    } else {
      this.log("warn", "Device-info request: no reply (wrong port?).");
    }
    this.emit();
  }

  /** Debug: switch the active preset — a *visible* effect on the device. */
  switchPresetSlot(bank: number, slot: number): void {
    this.sendMonitored(buildSwitchPresetSlot(bank, slot));
    this.log("info", `Sent Set Preset Slot bank=${bank} slot=${slot} (watch the device screen).`);
  }

  /** Debug: send an arbitrary SysEx/MIDI message from a hex string. */
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

  private awaitDeviceInfo(
    handle: WebMidiHandle
  ): Promise<ReturnType<typeof parseDeviceInfoResponse>> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: ReturnType<typeof parseDeviceInfoResponse>) => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = handle.onMessage((bytes) => {
        if (!isElectraSysex(bytes)) {
          return;
        }
        const parsed = parseDeviceInfoResponse(bytes);
        if (parsed) {
          finish(parsed);
        }
      });
      const timer = setTimeout(() => finish(null), DEVICE_INFO_TIMEOUT_MS);
      try {
        const request = buildDeviceInfoRequest();
        handle.send(request);
        this.monitor("out", request);
      } catch (error) {
        this.log("error", `Failed to send device-info request: ${String(error)}`);
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
