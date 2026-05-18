import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  PluginDefinition,
  PluginInspectorComponentProps,
  PluginRuntimeComponentProps
} from "./contracts";
import { ElectraSession } from "./connectionState";
import type { ElectraConnectionPhase } from "./types";

/* The runtime component (always mounted by the host's PluginRuntimeHost) owns
 * the session lifecycle. The inspector (mounted only when the plugin entity is
 * selected) is a read-only subscriber, so the two share one session. */
let sharedSession: ElectraSession | null = null;

function acquireSession(): ElectraSession {
  if (!sharedSession) {
    sharedSession = new ElectraSession();
  }
  return sharedSession;
}

function useSessionState(session: ElectraSession | null) {
  return useSyncExternalStore(
    (onChange) => (session ? session.subscribe(onChange) : () => undefined),
    () => session?.getState() ?? null
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

/** Always-on watcher: keeps the device session alive and tracks the selected
 *  actor. Renders nothing. */
export function ElectraOneRuntime(props: PluginRuntimeComponentProps) {
  const sessionRef = useRef<ElectraSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = acquireSession();
  }

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    void session.start();
    return () => {
      session.dispose();
      if (sharedSession === session) {
        sharedSession = null;
      }
      sessionRef.current = null;
    };
  }, []);

  // Mirror the first selected actor (Phase 3 will push its inspector schema
  // over the Simularca Surface Protocol; for now we just track it).
  const first = props.host.selectedActors[0];
  useEffect(() => {
    sessionRef.current?.setMirroredActor(first ? { id: first.id, name: first.name } : null);
  }, [first?.id, first?.name]);

  return null;
}

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

/** Status + diagnostics panel, shown when the plugin entity is selected. */
export function ElectraOneInspector(props: PluginInspectorComponentProps) {
  const session = sharedSession;
  const state = useSessionState(session);

  const selected = props.host.selectedActors;
  const cardStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8,
    padding: 12,
    marginBottom: 10
  };

  if (!session || !state) {
    return (
      <div className="inspector-pane-root custom-inspector">
        <div style={cardStyle}>
          <strong>Electra One Surface</strong>
          <div style={{ opacity: 0.7, marginTop: 6 }}>
            Runtime not active. Enable the plugin to start the device session.
          </div>
        </div>
      </div>
    );
  }

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
        <Row label="Phase" value={state.phase} tone={PHASE_TONE[state.phase]} />
        <Row label="MIDI in" value={state.midiInputPortName ?? "—"} />
        <Row label="MIDI out" value={state.midiOutputPortName ?? "—"} />
        <Row label="Model" value={state.device?.model ?? "—"} />
        <Row label="Firmware" value={state.device?.firmware ?? "—"} />
        <Row
          label="Bundle (device / build)"
          value={`${state.onDeviceBundleVersion ?? "—"} / ${state.buildBundleVersion}`}
        />
        <Row
          label="Preset slot"
          value={state.presetSlot ? `bank ${state.presetSlot.bank}, slot ${state.presetSlot.slot}` : "—"}
        />
        <Row
          label="Mirrored actor"
          value={state.mirroredActor ? state.mirroredActor.name : selected[0]?.name ?? "(none selected)"}
        />
        {state.lastError ? <Row label="Last error" value={state.lastError} tone="error" /> : null}
      </div>

      <div style={cardStyle}>
        <strong style={{ opacity: 0.8 }}>Diagnostics</strong>
        <div
          style={{
            marginTop: 6,
            maxHeight: 180,
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
