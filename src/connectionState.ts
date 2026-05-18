// Plain (React-free) session controller. All Web MIDI + lifecycle logic lives
// here; the React components are thin subscribers. Keeping this out of React
// also sidesteps the dual-React-instance hazard for dynamically-loaded plugin
// bundles (see README "Known load-time verification items").

import {
  MIN_FIRMWARE,
  SURFACE_BUNDLE_VERSION,
  type ElectraConnectionPhase,
  type ElectraConnectionState,
  type ElectraLogEntry
} from "./types";
import { openElectra, webMidiSupported, type WebMidiHandle } from "./webMidiService";
import {
  buildDeviceInfoRequest,
  isElectraSysex,
  isMiniCompatible,
  parseDeviceInfoResponse
} from "./electraSysex";

const DEVICE_INFO_TIMEOUT_MS = 2000;
const LOG_CAP = 60;

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
  private state: ElectraConnectionState = {
    phase: "unavailable",
    summary: "Not started.",
    midiInputPortName: null,
    midiOutputPortName: null,
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
    // New object identity each change so React `useSyncExternalStore` /
    // selector consumers re-render.
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

  private set(phase: ElectraConnectionPhase, summary: string): void {
    this.state.phase = phase;
    this.state.summary = summary;
    this.log(phase === "error" || phase === "incompatible" ? "warn" : "info", summary);
    this.emit();
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
      this.state.lastError = null;

      const support = webMidiSupported();
      if (!support.available) {
        this.set("unavailable", support.reason);
        return;
      }

      this.set("detecting", "Requesting Web MIDI access and locating the Electra One…");
      let handle: WebMidiHandle;
      try {
        handle = await openElectra();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.state.lastError = detail;
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

      // Re-detect on hot-plug / port change.
      handle.onStateChange(() => {
        if (!this.disposed) {
          this.log("info", "MIDI port state changed; re-detecting.");
          void this.start();
        }
      });

      this.set("checking-firmware", `Connected to ${handle.inputName}. Requesting device info…`);
      const info = await this.requestDeviceInfo(handle);
      if (this.disposed) {
        return;
      }

      if (!info) {
        // No reply: treat as connected-but-unknown in Phase 1 (no firmware
        // gate yet). Provisioning (Phase 2) will harden this.
        this.log("warn", "No device-info reply within timeout; proceeding with unknown firmware.");
        this.set(
          "ready",
          "Electra One connected (device info unavailable). Provisioning lands in Phase 2."
        );
        return;
      }

      this.state.device = info;
      if (!isMiniCompatible(info)) {
        this.set("incompatible", `Unsupported device model "${info.model}".`);
        return;
      }
      if (MIN_FIRMWARE && compareFirmware(info.firmware, MIN_FIRMWARE) < 0) {
        this.set(
          "incompatible",
          `Firmware ${info.firmware} is below the required ${MIN_FIRMWARE}.`
        );
        return;
      }

      // TODO Phase 2: slot discovery, BUNDLE_VERSION compare, preset + Lua
      // upload, Switch Preset Slot, persistence → phase "provisioning" → "ready".
      this.set(
        "ready",
        `Electra One ${info.model} (fw ${info.firmware}) connected. Provisioning lands in Phase 2.`
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

  private requestDeviceInfo(handle: WebMidiHandle): Promise<ReturnType<typeof parseDeviceInfoResponse>> {
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
        handle.send(buildDeviceInfoRequest());
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
