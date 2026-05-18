import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  PluginDefinition,
  PluginInspectorComponentProps,
  PluginRuntimeComponentProps
} from "./contracts";
import { ElectraSession } from "./connectionState";
import type { ElectraConnectionPhase, ElectraConnectionState } from "./types";

/* The runtime component (always mounted by the host's PluginRuntimeHost) owns
 * the session lifecycle. The inspector (mounted only when the plugin entity is
 * selected) is a read-only subscriber. Both resolve the same module singleton
 * so the panel always sees the live session. */
let sharedSession: ElectraSession | null = null;

function getSession(): ElectraSession {
  if (!sharedSession) {
    sharedSession = new ElectraSession();
  }
  return sharedSession;
}

function useSessionState(session: ElectraSession): ElectraConnectionState {
  return useSyncExternalStore(
    (onChange) => session.subscribe(onChange),
    () => session.getState()
  );
}

const PHASE_TONE: Record<ElectraConnectionPhase, "default" | "warning" | "error"> = {
  unavailable: "warning",
  detecting: "default",
  "checking-firmware": "default",
  incompatible: "error",
  provisioning: "default",
  ready: "default",
  error: "error"
};

/** Always-on watcher: keeps the device session alive, tracks the selected
 *  actor. Renders nothing. */
export function ElectraOneRuntime(props: PluginRuntimeComponentProps) {
  useEffect(() => {
    const session = getSession();
    void session.start();
    return () => {
      session.dispose();
      sharedSession = null;
    };
  }, []);

  const first = props.host.selectedActors[0];
  useEffect(() => {
    sharedSession?.setMirroredActor(first ? { id: first.id, name: first.name } : null);
  }, [first?.id, first?.name]);

  return null;
}

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 10
};

function Row(props: { label: string; value: string; tone?: "default" | "warning" | "error" }) {
  const color =
    props.tone === "error" ? "#ff8a80" : props.tone === "warning" ? "#ffd180" : "inherit";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "2px 0" }}>
      <span style={{ opacity: 0.7 }}>{props.label}</span>
      <span style={{ color, textAlign: "right", wordBreak: "break-word" }}>{props.value}</span>
    </div>
  );
}

function PortPicker(props: { session: ElectraSession; state: ElectraConnectionState }) {
  const { session, state } = props;
  const sel: React.CSSProperties = { flex: 1, minWidth: 0 };
  return (
    <div style={cardStyle}>
      <strong style={{ opacity: 0.8 }}>MIDI port</strong>
      <div style={{ opacity: 0.65, fontSize: 12, margin: "4px 0 8px" }}>
        Pick the <b>Electra Controller</b> port (not “Electra Port 1/2”). “Auto”
        prefers a port named “…Controller”.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <select
          style={sel}
          value={state.portOverride.input ?? ""}
          onChange={(e) =>
            void session.setPortOverride({
              input: e.target.value || null,
              output: state.portOverride.output
            })
          }
        >
          <option value="">In: Auto</option>
          {state.availablePorts.inputs.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          style={sel}
          value={state.portOverride.output ?? ""}
          onChange={(e) =>
            void session.setPortOverride({
              input: state.portOverride.input,
              output: e.target.value || null
            })
          }
        >
          <option value="">Out: Auto</option>
          {state.availablePorts.outputs.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DebugTools(props: { session: ElectraSession; state: ElectraConnectionState }) {
  const { session, state } = props;
  const [bank, setBank] = useState(1);
  const [slot, setSlot] = useState(1);
  const [hex, setHex] = useState("F0 00 21 45 02 7F F7");
  const [error, setError] = useState<string | null>(null);

  const guard = (fn: () => void) => {
    try {
      setError(null);
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={cardStyle}>
      <strong style={{ opacity: 0.8 }}>Debug tools</strong>
      <div style={{ opacity: 0.65, fontSize: 12, margin: "4px 0 8px" }}>
        Phase 1 does not upload or draw anything, so the device screen will not
        change on its own. <b>Switch preset slot</b> is the quickest way to
        prove the link — the device screen visibly changes.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={() => guard(() => void session.sendDeviceInfoRequest())}>
          Request device info
        </button>
        <span>bank</span>
        <input
          type="number"
          value={bank}
          min={1}
          style={{ width: 52 }}
          onChange={(e) => setBank(Number(e.target.value))}
        />
        <span>slot</span>
        <input
          type="number"
          value={slot}
          min={1}
          style={{ width: 52 }}
          onChange={(e) => setSlot(Number(e.target.value))}
        />
        <button type="button" onClick={() => guard(() => session.switchPresetSlot(bank, slot))}>
          Switch preset slot
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          style={{ flex: 1, fontFamily: "monospace" }}
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          placeholder="F0 00 21 45 … F7"
        />
        <button type="button" onClick={() => guard(() => session.sendRawSysex(hex))}>
          Send raw SysEx
        </button>
      </div>
      {error ? <div style={{ color: "#ff8a80", marginTop: 6 }}>{error}</div> : null}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
        <strong style={{ opacity: 0.8 }}>MIDI monitor</strong>
        <button type="button" onClick={() => session.clearMonitor()}>
          Clear
        </button>
      </div>
      <div
        style={{
          marginTop: 6,
          maxHeight: 160,
          overflowY: "auto",
          fontFamily: "monospace",
          fontSize: 11,
          lineHeight: 1.5
        }}
      >
        {state.midiMonitor.length === 0 ? (
          <div style={{ opacity: 0.5 }}>No traffic yet.</div>
        ) : (
          state.midiMonitor
            .slice()
            .reverse()
            .map((m, i) => (
              <div key={`${m.atIso}-${i}`} style={{ color: m.dir === "in" ? "#80d8ff" : "#b9f6ca" }}>
                {m.atIso.slice(11, 19)} {m.dir === "in" ? "◀ IN " : "▶ OUT"} {m.hex}
              </div>
            ))
        )}
      </div>
    </div>
  );
}

/** Status + diagnostics panel, shown when the plugin entity is selected. */
export function ElectraOneInspector(props: PluginInspectorComponentProps) {
  const session = getSession();
  const state = useSessionState(session);

  useEffect(() => {
    void session.refreshPorts();
  }, [session]);

  const selected = props.host.selectedActors;

  return (
    <div className="inspector-pane-root custom-inspector">
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Electra One Surface</strong>
          <span style={{ color: PHASE_TONE[state.phase] === "error" ? "#ff8a80" : "inherit" }}>
            {state.phase}
          </span>
        </div>
        <div style={{ opacity: 0.78, marginTop: 6 }}>{state.summary}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => void session.start()}>
            Re-detect
          </button>
          <button type="button" onClick={() => void session.reprovision()}>
            Re-provision
          </button>
        </div>
      </div>

      <div style={cardStyle}>
        <strong style={{ opacity: 0.8 }}>Connecting the Electra One</strong>
        <ul style={{ opacity: 0.72, fontSize: 12, margin: "6px 0 0", paddingLeft: 18 }}>
          <li>Connect via USB and power the device; leave it on the normal preset/home screen (not the boot/upgrade screen).</li>
          <li>USB MIDI must be enabled on the Electra (Electra One: on by default; if you set “USB Disabled”, re-enable it in the device settings).</li>
          <li>The Electra shows several MIDI ports — control/SysEx uses the <b>Electra Controller</b> port. If auto-detect grabbed “Electra Port 1/2”, pick the right one below.</li>
          <li>Phase 1 only detects the device; provisioning (uploading the surface) is Phase 2. Use the debug tools to confirm two-way MIDI now.</li>
        </ul>
      </div>

      <PortPicker session={session} state={state} />

      <div style={cardStyle}>
        <Row label="Phase" value={state.phase} tone={PHASE_TONE[state.phase]} />
        <Row label="MIDI in" value={state.midiInputPortName ?? "—"} />
        <Row label="MIDI out" value={state.midiOutputPortName ?? "—"} />
        <Row
          label="Device info"
          value={state.deviceInfoReceived ? "received ✓" : "no reply (check port)"}
          tone={state.deviceInfoReceived ? "default" : "warning"}
        />
        <Row label="Model" value={state.device?.model ?? "—"} />
        <Row label="Firmware" value={state.device?.firmware ?? "—"} />
        <Row
          label="Bundle (device / build)"
          value={`${state.onDeviceBundleVersion ?? "—"} / ${state.buildBundleVersion}`}
        />
        <Row
          label="Mirrored actor"
          value={state.mirroredActor ? state.mirroredActor.name : selected[0]?.name ?? "(none selected)"}
        />
        {state.lastError ? <Row label="Last error" value={state.lastError} tone="error" /> : null}
      </div>

      <DebugTools session={session} state={state} />

      <div style={cardStyle}>
        <strong style={{ opacity: 0.8 }}>Diagnostics</strong>
        <div
          style={{
            marginTop: 6,
            maxHeight: 160,
            overflowY: "auto",
            fontFamily: "monospace",
            fontSize: 11,
            lineHeight: 1.5
          }}
        >
          {state.log.length === 0 ? (
            <div style={{ opacity: 0.5 }}>No log entries.</div>
          ) : (
            state.log
              .slice()
              .reverse()
              .map((entry, index) => (
                <div
                  key={`${entry.atIso}-${index}`}
                  style={{
                    color:
                      entry.level === "error"
                        ? "#ff8a80"
                        : entry.level === "warn"
                          ? "#ffd180"
                          : "inherit"
                  }}
                >
                  {entry.atIso.slice(11, 19)} {entry.message}
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
}

export function createElectraOnePlugin(): PluginDefinition {
  return {
    id: "plugin.electraOneMini",
    name: "Electra One Surface",
    actorDescriptors: [],
    componentDescriptors: [],
    viewDescriptors: [],
    inspectorComponent: ElectraOneInspector,
    runtimeComponent: ElectraOneRuntime
  };
}
