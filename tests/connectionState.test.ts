import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectraSession, type SessionDeps } from "../src/connectionState";
import { frameElectraSysex } from "../src/electraSysex";
import type { WebMidiHandle } from "../src/webMidiService";

function deviceInfoReply(obj: unknown): number[] {
  return frameElectraSysex(Array.from(JSON.stringify(obj), (c) => c.charCodeAt(0)));
}

interface FakeOpts {
  reply?: unknown | null;
  inputName?: string;
}

function makeFakeHandle(opts: FakeOpts): WebMidiHandle {
  const messageListeners = new Set<(b: number[]) => void>();
  return {
    inputName: opts.inputName ?? "Electra Controller",
    outputName: "Electra Controller",
    ports: {
      inputs: [{ id: "i", name: "Electra Controller" }],
      outputs: [{ id: "o", name: "Electra Controller" }]
    },
    send() {
      if (opts.reply != null) {
        const bytes = deviceInfoReply(opts.reply);
        queueMicrotask(() => {
          for (const l of messageListeners) {
            l(bytes);
          }
        });
      }
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onStateChange() {
      return () => undefined;
    },
    close() {
      messageListeners.clear();
    }
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
    open: async () => over.handle ?? makeFakeHandle({ reply: null }),
    storage: over.storage ?? fakeStorage(),
    ...over
  };
  return new ElectraSession(deps);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ElectraSession", () => {
  it("reports unavailable when Web MIDI is unsupported", async () => {
    const session = makeSession({
      checkSupport: () => ({ available: false, reason: "no web midi" })
    });
    await session.start();
    expect(session.getState().phase).toBe("unavailable");
    expect(session.getState().summary).toBe("no web midi");
  });

  it("reaches ready with parsed device info", async () => {
    const session = makeSession({
      handle: makeFakeHandle({ reply: { hwId: "electra-one-mini", versionText: "4.1.2" } })
    });
    await session.start();
    const s = session.getState();
    expect(s.phase).toBe("ready");
    expect(s.deviceInfoReceived).toBe(true);
    expect(s.device?.model).toBe("electra-one-mini");
    expect(s.midiInputPortName).toBe("Electra Controller");
    expect(s.midiMonitor.some((m) => m.dir === "out")).toBe(true);
    expect(s.midiMonitor.some((m) => m.dir === "in")).toBe(true);
  });

  it("reaches ready-but-no-reply on the wrong port (timeout)", async () => {
    vi.useFakeTimers();
    const session = makeSession({ handle: makeFakeHandle({ reply: null }) });
    const p = session.start();
    await vi.advanceTimersByTimeAsync(2100);
    await p;
    const s = session.getState();
    expect(s.phase).toBe("ready");
    expect(s.deviceInfoReceived).toBe(false);
    expect(s.summary).toMatch(/wrong port/i);
  });

  it("is incompatible for an unsupported model", async () => {
    const session = makeSession({
      handle: makeFakeHandle({ reply: { model: "Launchpad", versionText: "1.0" } })
    });
    await session.start();
    expect(session.getState().phase).toBe("incompatible");
  });

  it("persists and reloads the port override", async () => {
    const storage = fakeStorage();
    const a = makeSession({ storage, handle: makeFakeHandle({ reply: { model: "Electra One" } }) });
    await a.setPortOverride({ input: "Electra Controller", output: "Electra Port 2" });
    expect(JSON.parse(storage.store.get("simularca:electra-one:port-override") as string)).toEqual({
      input: "Electra Controller",
      output: "Electra Port 2"
    });
    const b = makeSession({ storage });
    expect(b.getState().portOverride).toEqual({
      input: "Electra Controller",
      output: "Electra Port 2"
    });
  });

  it("switchPresetSlot throws before connect, sends after", async () => {
    const session = makeSession({ handle: makeFakeHandle({ reply: { model: "Electra One" } }) });
    expect(() => session.switchPresetSlot(1, 1)).toThrow(/Not connected/);
    await session.start();
    session.switchPresetSlot(2, 3);
    const out = session.getState().midiMonitor.filter((m) => m.dir === "out");
    expect(out.at(-1)?.hex).toBe("f0 00 21 45 14 08 02 03 f7");
  });
});
