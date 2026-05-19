import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectraSession, type SessionDeps } from "../src/connectionState";
import {
  asciiBytes,
  electraMessageKind,
  electraPayload,
  frameElectraSysex
} from "../src/electraSysex";
import { SURFACE_BUNDLE_VERSION, SURFACE_MAIN_LUA } from "../src/surfaceBundle";
import type { WebMidiHandle } from "../src/webMidiService";

interface DeviceOpts {
  deviceInfo?: Record<string, unknown> | null;
  lua?: string | null; // null => no request-lua reply
  preset?: Record<string, unknown> | "empty" | null;
  ack?: boolean;
}

function makeDevice(opts: DeviceOpts) {
  let storedLua = opts.lua ?? null;
  const sent: string[] = [];
  const listeners = new Set<(b: number[]) => void>();
  const deliver = (bytes: number[]) =>
    queueMicrotask(() => {
      for (const l of [...listeners]) {
        l(bytes);
      }
    });
  const handle: WebMidiHandle = {
    inputName: "Electra Controller",
    outputName: "Electra Controller",
    ports: {
      inputs: [{ id: "i", name: "Electra Controller" }],
      outputs: [{ id: "o", name: "Electra Controller" }]
    },
    send(bytes) {
      const kind = electraMessageKind(bytes);
      sent.push(kind);
      if (kind === "REQUEST_DEVICE_INFO" && opts.deviceInfo != null) {
        deliver(frameElectraSysex([0x01, 0x7f, ...asciiBytes(JSON.stringify(opts.deviceInfo))]));
      } else if (kind === "REQUEST_LUA" && storedLua !== null) {
        deliver(frameElectraSysex([0x01, 0x0c, ...asciiBytes(storedLua)]));
      } else if (kind === "REQUEST_PRESET") {
        if (opts.preset === "empty") {
          deliver(frameElectraSysex([0x01, 0x01]));
        } else if (opts.preset && typeof opts.preset === "object") {
          deliver(frameElectraSysex([0x01, 0x01, ...asciiBytes(JSON.stringify(opts.preset))]));
        }
      } else if (kind === "UPLOAD_PRESET") {
        if (opts.ack !== false) {
          deliver(frameElectraSysex([0x7e, 0x01, 0, 0]));
        }
      } else if (kind === "UPLOAD_LUA") {
        storedLua = String.fromCharCode(...electraPayload(bytes).slice(2));
        if (opts.ack !== false) {
          deliver(frameElectraSysex([0x7e, 0x01, 0, 0]));
        }
      }
    },
    onMessage(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onStateChange() {
      return () => undefined;
    },
    close() {
      listeners.clear();
    }
  };
  return {
    handle,
    sentKinds: () => sent,
    emit: (bytes: number[]) =>
      queueMicrotask(() => {
        for (const l of [...listeners]) {
          l(bytes);
        }
      })
  };
}

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v)
  };
}

function makeSession(over: Partial<SessionDeps> & { handle?: WebMidiHandle }) {
  const deps: SessionDeps = {
    checkSupport: () => ({ available: true }),
    enumerate: async () => ({ inputs: [], outputs: [] }),
    open: async () => over.handle ?? makeDevice({ deviceInfo: null }).handle,
    storage: over.storage ?? fakeStorage(),
    ...over
  };
  return new ElectraSession(deps);
}

const GOOD_INFO = { model: "Electra One mini", versionText: "v4.1.4" };

afterEach(() => {
  vi.useRealTimers();
});

describe("ElectraSession lifecycle", () => {
  it("unavailable when Web MIDI unsupported", async () => {
    const s = makeSession({ checkSupport: () => ({ available: false, reason: "no web midi" }) });
    await s.start();
    expect(s.getState().phase).toBe("unavailable");
  });

  it("ready-but-no-reply on the wrong port (device-info timeout)", async () => {
    vi.useFakeTimers();
    const { handle } = makeDevice({ deviceInfo: null });
    const s = makeSession({ handle });
    const p = s.start();
    await vi.advanceTimersByTimeAsync(2100);
    await p;
    expect(s.getState().phase).toBe("ready");
    expect(s.getState().deviceInfoReceived).toBe(false);
    expect(s.getState().summary).toMatch(/wrong port/i);
  });

  it("incompatible for an unsupported model (before provisioning)", async () => {
    const { handle, sentKinds } = makeDevice({
      deviceInfo: { model: "Launchpad", versionText: "1.0" }
    });
    const s = makeSession({ handle });
    await s.start();
    expect(s.getState().phase).toBe("incompatible");
    expect(sentKinds()).not.toContain("UPLOAD_PRESET");
  });
});

describe("provisioning", () => {
  it("skips upload when the bundle version already matches", async () => {
    const { handle, sentKinds } = makeDevice({ deviceInfo: GOOD_INFO, lua: SURFACE_MAIN_LUA });
    const s = makeSession({ handle });
    await s.start();
    const st = s.getState();
    expect(st.phase).toBe("ready");
    expect(st.onDeviceBundleVersion).toBe(SURFACE_BUNDLE_VERSION);
    expect(st.presetSlot).toEqual({ bank: 2, slot: 0 });
    expect(sentKinds()).not.toContain("UPLOAD_PRESET");
  });

  it("uploads + activates when the slot is empty", async () => {
    const { handle, sentKinds } = makeDevice({
      deviceInfo: GOOD_INFO,
      lua: "",
      preset: "empty",
      ack: true
    });
    const s = makeSession({ handle });
    await s.start();
    const st = s.getState();
    expect(st.phase).toBe("ready");
    expect(sentKinds()).toContain("UPLOAD_PRESET");
    expect(sentKinds()).toContain("UPLOAD_LUA");
    expect(st.onDeviceBundleVersion).toBe(SURFACE_BUNDLE_VERSION);
    expect(st.presetSlot).toEqual({ bank: 2, slot: 0 });
  });

  it("refuses to overwrite a non-Simularca preset", async () => {
    const { handle, sentKinds } = makeDevice({
      deviceInfo: GOOD_INFO,
      lua: "",
      preset: { name: "User Synth" }
    });
    const s = makeSession({ handle });
    await s.start();
    expect(s.getState().phase).toBe("error");
    expect(s.getState().summary).toMatch(/refusing to overwrite/i);
    expect(sentKinds()).not.toContain("UPLOAD_PRESET");
    expect(s.getState().overwriteBlocked).toEqual({ bank: 2, slot: 0, name: "User Synth" });
  });

  it("force-overwrites an occupied slot when provision(true)", async () => {
    const { handle, sentKinds } = makeDevice({
      deviceInfo: GOOD_INFO,
      lua: "",
      preset: { name: "User Synth" },
      ack: true
    });
    const s = makeSession({ handle });
    await s.start();
    expect(s.getState().phase).toBe("error");

    const ok = await s.provision(true);
    expect(ok).toBe(true);
    expect(s.getState().phase).toBe("ready");
    expect(sentKinds()).toContain("UPLOAD_PRESET");
    expect(sentKinds()).toContain("UPLOAD_LUA");
    expect(s.getState().overwriteBlocked).toBeNull();
  });

  it("errors when an upload is not ACKed", async () => {
    const { handle } = makeDevice({
      deviceInfo: GOOD_INFO,
      lua: "",
      preset: "empty",
      ack: false
    });
    const s = makeSession({ handle });
    await s.start();
    expect(s.getState().phase).toBe("error");
    expect(s.getState().summary).toMatch(/timed out|NACK/i);
  }, 15000);
});

describe("controls + persistence", () => {
  it("persists and reloads port override + target slot", async () => {
    const storage = fakeStorage();
    const a = makeSession({ storage, handle: makeDevice({ deviceInfo: GOOD_INFO, lua: SURFACE_MAIN_LUA }).handle });
    a.setTargetSlot(2, 5);
    await a.setPortOverride({ input: "Electra Controller", output: "Electra Controller" });
    const b = makeSession({ storage });
    expect(b.getState().targetSlot).toEqual({ bank: 2, slot: 5 });
    expect(b.getState().portOverride.input).toBe("Electra Controller");
  });

  it("switchPresetSlot throws before connect, sends 09 08 after", async () => {
    const s = makeSession({ handle: makeDevice({ deviceInfo: GOOD_INFO, lua: SURFACE_MAIN_LUA }).handle });
    expect(() => s.switchPresetSlot(1, 1)).toThrow(/Not connected/);
    await s.start();
    s.switchPresetSlot(2, 3);
    const out = s.getState().midiMonitor.filter((m) => m.dir === "out");
    expect(out.at(-1)?.hex).toBe("f0 00 21 45 09 08 02 03 f7");
  });
});

describe("surface (SSP)", () => {
  const SNAP = {
    id: "a1",
    name: "Cube",
    actorType: "mesh",
    params: { on: true, size: 5 },
    schema: {
      id: "s",
      title: "Cube",
      params: [
        { key: "on", label: "On", type: "boolean" as const },
        { key: "size", label: "Size", type: "number" as const, min: 0, max: 10, step: 1 }
      ]
    }
  };

  it("sends SET_ACTOR once provisioned and applies device edits back", async () => {
    const dev = makeDevice({ deviceInfo: GOOD_INFO, lua: SURFACE_MAIN_LUA });
    const s = makeSession({ handle: dev.handle });
    const applied: unknown[] = [];
    s.setApply((id, k, v, o) => applied.push([id, k, v, o]));
    await s.start(); // version matches v2 -> ready + provisioned, no upload

    s.setSelectedActor(SNAP);
    const out = s.getState().midiMonitor.filter((m) => m.dir === "out").map((m) => m.hex);
    expect(out.some((h) => h.startsWith("f0 00 21 45 08 0d"))).toBe(true); // Execute-Lua ssp(...)

    // Device encoder moves slot 1 (size) to full -> max 10.
    dev.emit(frameElectraSysex([0x7f, 0x00, ...asciiBytes("scp vc 1 127")]));
    await new Promise((r) => setTimeout(r));
    expect(applied.at(-1)).toEqual(["a1", "size", 10, { history: false }]);
  });

  it("applies digit-editor (dv) values clamped, tracks focused slot", async () => {
    const dev = makeDevice({ deviceInfo: GOOD_INFO, lua: SURFACE_MAIN_LUA });
    const s = makeSession({ handle: dev.handle });
    const applied: unknown[] = [];
    s.setApply((id, k, v, o) => applied.push([id, k, v, o]));
    await s.start();
    s.setSelectedActor(SNAP);

    dev.emit(frameElectraSysex([0x7f, 0x00, ...asciiBytes("scp dv 1 7.5")]));
    await new Promise((r) => setTimeout(r));
    expect(applied.at(-1)).toEqual(["a1", "size", 7.5, { history: false }]);

    dev.emit(frameElectraSysex([0x7f, 0x00, ...asciiBytes("scp dv 1 99")]));
    await new Promise((r) => setTimeout(r));
    expect(applied.at(-1)).toEqual(["a1", "size", 10, { history: false }]); // clamped to max

    dev.emit(frameElectraSysex([0x7f, 0x00, ...asciiBytes("scp focus 1")]));
    await new Promise((r) => setTimeout(r));
    expect(s.getState().focusedSlot).toBe(1);
  });

  it("mirrors the 4-control test surface and loops device edits back locally", async () => {
    const dev = makeDevice({ deviceInfo: GOOD_INFO, lua: SURFACE_MAIN_LUA });
    const s = makeSession({ handle: dev.handle });
    const applied: unknown[] = [];
    s.setApply((id, k, v, o) => applied.push([id, k, v, o]));
    await s.start();

    s.setTestSurface(true);
    expect(s.getState().mirroredActor?.name).toBe("Test Surface");
    const out = s.getState().midiMonitor.filter((m) => m.dir === "out").map((m) => m.hex);
    expect(out.some((h) => h.startsWith("f0 00 21 45 08 0d"))).toBe(true); // SET_ACTOR

    // Fields are exactly the 4 schema params (no transform rows):
    //   0 ranged number, 1 rangeless number, 2 integer, 3 select(list).
    // Ranged maps raw 127 across [min,max]; the two rangeless numbers have
    // no min/max so decodeDeviceRaw returns the raw 0..127 directly.
    dev.emit(frameElectraSysex([0x7f, 0x00, ...asciiBytes("scp vc 0 127")]));
    await new Promise((r) => setTimeout(r));
    expect(s.getState().testSurface?.tRanged).toBe(100);

    dev.emit(frameElectraSysex([0x7f, 0x00, ...asciiBytes("scp vc 1 127")]));
    await new Promise((r) => setTimeout(r));
    expect(s.getState().testSurface?.tRangeless).toBe(127);

    dev.emit(frameElectraSysex([0x7f, 0x00, ...asciiBytes("scp vc 2 127")]));
    await new Promise((r) => setTimeout(r));
    expect(s.getState().testSurface?.tInt).toBe(127);

    dev.emit(frameElectraSysex([0x7f, 0x00, ...asciiBytes("scp vc 3 127")]));
    await new Promise((r) => setTimeout(r));
    expect(s.getState().testSurface?.tSelect).toBe("Delta");

    // Self-contained: nothing routed through the host bridge.
    expect(applied).toEqual([]);
  });

  it("disabling the test surface CLEARs the device", async () => {
    const dev = makeDevice({ deviceInfo: GOOD_INFO, lua: SURFACE_MAIN_LUA });
    const s = makeSession({ handle: dev.handle });
    await s.start();
    s.setTestSurface(true);
    s.setTestSurface(false);
    expect(s.getState().testSurface).toBeNull();
    const execs = s
      .getState()
      .midiMonitor.filter((m) => m.dir === "out")
      .map((m) => m.hex)
      .filter((h) => h.startsWith("f0 00 21 45 08 0d"));
    const body = (execs.at(-1) ?? "")
      .split(" ")
      .slice(6, -1)
      .map((b) => String.fromCharCode(parseInt(b, 16)))
      .join("");
    expect(body).toBe('ssp("C")');
  });

  it("CLEARs when selection goes away", async () => {
    const dev = makeDevice({ deviceInfo: GOOD_INFO, lua: SURFACE_MAIN_LUA });
    const s = makeSession({ handle: dev.handle });
    await s.start();
    s.setSelectedActor(SNAP);
    s.setSelectedActor(null);
    const out = s.getState().midiMonitor.filter((m) => m.dir === "out").map((m) => m.hex);
    // last Execute-Lua payload is ssp("C")
    const execs = out.filter((h) => h.startsWith("f0 00 21 45 08 0d"));
    const last = execs.at(-1) ?? "";
    const body = last
      .split(" ")
      .slice(6, -1)
      .map((b) => String.fromCharCode(parseInt(b, 16)))
      .join("");
    expect(body).toBe('ssp("C")');
  });
});
