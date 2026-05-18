// Renderer-side MIDI via the browser Web MIDI API. This is what makes the
// plugin a true self-contained external plugin: no Node-side MIDI host, no
// IPC. Requires the host to permit the `midiSysex` permission (a one-time
// setPermissionCheckHandler/RequestHandler in the Simularca main process —
// see SPEC §3 "host prerequisite").

export interface MidiPortRef {
  id: string;
  name: string;
}

export interface MidiPortList {
  inputs: MidiPortRef[];
  outputs: MidiPortRef[];
}

export interface WebMidiHandle {
  inputName: string;
  outputName: string;
  ports: MidiPortList;
  /** Send a raw SysEx (or any) message. */
  send(bytes: number[]): void;
  /** Subscribe to inbound messages; returns an unsubscribe. */
  onMessage(listener: (bytes: number[]) => void): () => void;
  /** Subscribe to port connect/disconnect; returns an unsubscribe. */
  onStateChange(listener: () => void): () => void;
  close(): void;
}

export type WebMidiAvailability =
  | { available: true }
  | { available: false; reason: string };

export interface OpenOptions {
  /** Exact port names to use (from the manual picker), overriding scoring. */
  inputName?: string | null;
  outputName?: string | null;
}

/**
 * Score a MIDI port name for "is this the Electra control/SysEx port?".
 * Electra One enumerates several USB-MIDI ports; the control + Lua-command +
 * SysEx traffic must go to the **Electra Controller** port, NOT "Electra
 * Port 1/2" (those are MIDI thru). Higher score = better. 0 = not Electra.
 * Pure + exported for unit testing.
 */
export function scoreElectraPortName(name: string): number {
  const n = name.toLowerCase();
  if (!n.includes("electra")) {
    return 0;
  }
  if (n.includes("controller") || n.includes("ctrl")) {
    return 100;
  }
  // A bare "Electra One" with no "Port N" suffix is usually the control port.
  if (!/port\s*\d/.test(n)) {
    return 60;
  }
  // "Electra Port 1/2" — usable as a last resort but de-prioritised.
  return 20;
}

/** Pick the best port, honouring an exact-name override. Pure + testable. */
export function pickPort(
  ports: MidiPortRef[],
  override?: string | null
): MidiPortRef | null {
  if (override) {
    return ports.find((p) => p.name === override) ?? null;
  }
  let best: MidiPortRef | null = null;
  let bestScore = 0;
  for (const port of ports) {
    const score = scoreElectraPortName(port.name);
    if (score > bestScore) {
      best = port;
      bestScore = score;
    }
  }
  return best;
}

export function webMidiSupported(): WebMidiAvailability {
  if (typeof navigator === "undefined" || typeof navigator.requestMIDIAccess !== "function") {
    return { available: false, reason: "Web MIDI API is not available in this renderer." };
  }
  return { available: true };
}

async function requestAccess(): Promise<MIDIAccess> {
  try {
    return await navigator.requestMIDIAccess({ sysex: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Web MIDI access (sysex) was denied: ${detail}. The Simularca host must permit the midiSysex permission.`
    );
  }
}

function refList<T extends MIDIInput | MIDIOutput>(map: Iterable<T>): MidiPortRef[] {
  const out: MidiPortRef[] = [];
  for (const port of map) {
    out.push({ id: port.id, name: port.name ?? port.id });
  }
  return out;
}

/** Enumerate all MIDI ports (for the inspector's manual port picker). */
export async function enumerateMidiPorts(): Promise<MidiPortList> {
  const support = webMidiSupported();
  if (!support.available) {
    throw new Error(support.reason);
  }
  const access = await requestAccess();
  return {
    inputs: refList(access.inputs.values()),
    outputs: refList(access.outputs.values())
  };
}

/**
 * Open the Electra input+output pair (manual override wins, else best-scored).
 * Rejects with a descriptive error when access is denied or no port matches.
 */
export async function openElectra(options: OpenOptions = {}): Promise<WebMidiHandle> {
  const access = await requestAccess();

  const inputs = refList(access.inputs.values());
  const outputs = refList(access.outputs.values());
  const ports: MidiPortList = { inputs, outputs };

  const inRef = pickPort(inputs, options.inputName);
  const outRef = pickPort(outputs, options.outputName);
  if (!inRef || !outRef) {
    throw new Error(
      "No Electra One control port found. Connect the device via USB and, if it has multiple ports, pick the 'Electra Controller' port in the plugin inspector."
    );
  }

  let input: MIDIInput | undefined;
  for (const candidate of access.inputs.values()) {
    if (candidate.id === inRef.id) {
      input = candidate;
      break;
    }
  }
  let output: MIDIOutput | undefined;
  for (const candidate of access.outputs.values()) {
    if (candidate.id === outRef.id) {
      output = candidate;
      break;
    }
  }
  if (!input || !output) {
    throw new Error("Selected MIDI port disappeared during open.");
  }

  await input.open();
  await output.open();

  const messageListeners = new Set<(bytes: number[]) => void>();
  const stateListeners = new Set<() => void>();

  const handleMidiMessage = (event: MIDIMessageEvent) => {
    const data = event.data;
    if (!data) {
      return;
    }
    const bytes = Array.from(data);
    for (const listener of messageListeners) {
      listener(bytes);
    }
  };
  input.addEventListener("midimessage", handleMidiMessage);

  const handleStateChange = () => {
    for (const listener of stateListeners) {
      listener();
    }
  };
  access.addEventListener("statechange", handleStateChange);

  return {
    inputName: input.name ?? inRef.name,
    outputName: output.name ?? outRef.name,
    ports,
    send(bytes: number[]) {
      output.send(bytes);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    close() {
      input.removeEventListener("midimessage", handleMidiMessage as EventListener);
      access.removeEventListener("statechange", handleStateChange);
      messageListeners.clear();
      stateListeners.clear();
      void input.close();
      void output.close();
    }
  };
}
