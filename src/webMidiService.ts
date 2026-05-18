// Renderer-side MIDI via the browser Web MIDI API. This is what makes the
// plugin a true self-contained external plugin: no Node-side MIDI host, no
// IPC. Requires the host to permit the `midiSysex` permission (a one-time
// setPermissionCheckHandler/RequestHandler in the Simularca main process —
// see SPEC §3 "host prerequisite").

export interface MidiPortRef {
  id: string;
  name: string;
}

export interface WebMidiHandle {
  inputName: string;
  outputName: string;
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

/** Default Electra port matcher. Exact USB-MIDI names are an open item
 *  (SPEC §10); "electra" substring is the robust first cut. */
function isElectraPortName(name: string): boolean {
  return name.toLowerCase().includes("electra");
}

export function webMidiSupported(): WebMidiAvailability {
  if (typeof navigator === "undefined" || typeof navigator.requestMIDIAccess !== "function") {
    return { available: false, reason: "Web MIDI API is not available in this renderer." };
  }
  return { available: true };
}

interface OpenOptions {
  matchPortName?: (name: string) => boolean;
}

/**
 * Request SysEx-enabled MIDI access and open the first Electra input+output
 * pair. Rejects with a descriptive error when access is denied or no Electra
 * port is present.
 */
export async function openElectra(options: OpenOptions = {}): Promise<WebMidiHandle> {
  const support = webMidiSupported();
  if (!support.available) {
    throw new Error(support.reason);
  }
  const match = options.matchPortName ?? isElectraPortName;

  let access: MIDIAccess;
  try {
    access = await navigator.requestMIDIAccess({ sysex: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Web MIDI access (sysex) was denied: ${detail}. The Simularca host must permit the midiSysex permission.`
    );
  }

  const pickInput = (): MIDIInput | null => {
    for (const input of access.inputs.values()) {
      if (match(input.name ?? "")) {
        return input;
      }
    }
    return null;
  };
  const pickOutput = (): MIDIOutput | null => {
    for (const output of access.outputs.values()) {
      if (match(output.name ?? "")) {
        return output;
      }
    }
    return null;
  };

  const input = pickInput();
  const output = pickOutput();
  if (!input || !output) {
    throw new Error("No Electra One MIDI port found. Connect the device via USB.");
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
    inputName: input.name ?? "Electra (in)",
    outputName: output.name ?? "Electra (out)",
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
