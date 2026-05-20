import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ActorVisibilityMode,
  NumberParameterDefinition,
  ParameterDefinition,
  ParameterValue,
  PluginDefinition,
  PluginInspectorComponentProps,
  PluginRuntimeComponentProps,
  SelectParameterDefinition
} from "./contracts";
import { ElectraSession, TEST_SCHEMA } from "./connectionState";
import { renderOptionsSig } from "./types";
import type { ElectraCapStyle, ElectraConnectionPhase, ElectraConnectionState } from "./types";

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
    // Dev/hardware-debug handle: the session is a module singleton not
    // otherwise reachable from the live debug bridge's renderer eval. This
    // lets `debug-session.mjs renderer --eval` drive sendRawSysex and read
    // back midiMonitor for on-device protocol probing.
    (window as unknown as { __electraSession?: ElectraSession }).__electraSession = session;
    return () => {
      session.dispose();
      sharedSession = null;
      delete (window as unknown as { __electraSession?: ElectraSession }).__electraSession;
    };
  }, []);

  const host = props.host;
  useEffect(() => {
    // Synthetic "@"-prefixed keys (from inspectorMapping.commonFields) route
    // to the transform / enabled / visibility bridge methods; everything else
    // is a normal descriptor param.
    sharedSession?.setApply((actorId, key, value, opts) => {
      if (key === "@enabled") {
        host.updateActorEnabled(actorId, Boolean(value));
        return;
      }
      if (key === "@visibility") {
        host.updateActorVisibility(actorId, String(value) as ActorVisibilityMode);
        return;
      }
      const m = /^@(pos|rot|scl)\.([0-2])$/.exec(key);
      if (m) {
        const tKey = m[1] === "pos" ? "position" : m[1] === "rot" ? "rotation" : "scale";
        const axis = Number(m[2]);
        const actor = host.selectedActors.find((a) => a.id === actorId);
        if (!actor) {
          return;
        }
        const src = actor.transform[tKey];
        const next: [number, number, number] = [src[0], src[1], src[2]];
        next[axis] = tKey === "rotation" ? (Number(value) * Math.PI) / 180 : Number(value);
        host.updateActorTransform(actorId, tKey, next, opts);
        return;
      }
      host.updateActorParams(actorId, { [key]: value }, opts);
    });
    // Transport: device's Play/Pause pad fires this; we forward to the host.
    sharedSession?.setTransportToggle(() => host.toggleTransport());
  }, [host]);

  // Push the host transport state to the device so the Play/Pause pad label
  // (and colour) mirrors `state.time.running`. Fires both directions:
  // device→host (button press toggles host) and host→device (any toggle,
  // incl. Space-bar or the toolbar button, repaints the pad label). The
  // session early-returns until phase === "ready", and we re-fire on phase
  // transitions so the initial state lands right after (re)provision.
  const sessionPhase = useSyncExternalStore(
    (onChange) => (sharedSession ? sharedSession.subscribe(onChange) : () => {}),
    () => sharedSession?.getState().phase ?? "unavailable"
  );
  useEffect(() => {
    sharedSession?.setTransportPlaying(host.transportPlaying);
  }, [host.transportPlaying, sessionPhase]);

  const sel = props.host.selectedActors[0] ?? null;
  // Signature covers params + schema + transform/enabled/visibility so any of
  // them changing (incl. externally) re-pushes the surface.
  const sig = sel
    ? `${sel.id}|${sel.schema?.id ?? ""}|${JSON.stringify(sel.params)}|${JSON.stringify(
        sel.transform
      )}|${sel.enabled}|${sel.visibilityMode}`
    : "";
  useEffect(() => {
    sharedSession?.setSelectedActor(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return null;
}

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 10,
  // The host mounts this plugin inside `.custom-inspector` (display: grid).
  // Grid items default to `min-width: auto`, so a card refuses to shrink below
  // its widest non-wrapping child (the port <select>s, the raw-SysEx <input>),
  // pinning the single grid track wider than the user-resized inspector and
  // forcing a horizontal scrollbar. `minWidth: 0` lets the card shrink so the
  // track collapses to the available width and text reflows instead.
  minWidth: 0,
  maxWidth: "100%"
};

// Shared style for the scrolling monospace log panes (MIDI monitor,
// diagnostics). `minWidth: 0` keeps them shrinkable; a long unbreakable token
// scrolls within the box (overflowX) / wraps (overflowWrap) instead of
// widening the whole inspector.
const logPaneStyle: React.CSSProperties = {
  marginTop: 6,
  maxHeight: 160,
  minWidth: 0,
  overflowY: "auto",
  overflowX: "auto",
  overflowWrap: "anywhere",
  fontFamily: "monospace",
  fontSize: 11,
  lineHeight: 1.5
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

function ProvisioningCard(props: { session: ElectraSession; state: ElectraConnectionState }) {
  const { session, state } = props;
  return (
    <div style={cardStyle}>
      <strong style={{ opacity: 0.8 }}>Provisioning (target slot)</strong>
      <div style={{ opacity: 0.65, fontSize: 12, margin: "4px 0 8px" }}>
        The surface preset + Lua app are uploaded here, then activated (the
        device screen switches to it). 0-based. A non-Simularca preset in this
        slot is never overwritten — pick an empty/own slot.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span>bank</span>
        <input
          type="number"
          min={0}
          value={state.targetSlot.bank}
          style={{ width: 52 }}
          onChange={(e) => session.setTargetSlot(Number(e.target.value), state.targetSlot.slot)}
        />
        <span>slot</span>
        <input
          type="number"
          min={0}
          value={state.targetSlot.slot}
          style={{ width: 52 }}
          onChange={(e) => session.setTargetSlot(state.targetSlot.bank, Number(e.target.value))}
        />
        <button type="button" onClick={() => void session.provision()}>
          Provision now
        </button>
      </div>
      {state.overwriteBlocked ? (
        <div
          style={{
            marginTop: 10,
            padding: 8,
            border: "1px solid rgba(255,138,128,0.5)",
            borderRadius: 6,
            background: "rgba(255,138,128,0.08)"
          }}
        >
          <div style={{ color: "#ff8a80", fontSize: 12 }}>
            Bank {state.overwriteBlocked.bank} slot {state.overwriteBlocked.slot} holds the
            non-Simularca preset “{state.overwriteBlocked.name}”. Forcing will permanently
            overwrite it on the device.
          </div>
          <button
            type="button"
            style={{ marginTop: 8, color: "#ff8a80" }}
            onClick={() => void session.provision(true)}
          >
            Force overwrite this slot
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* The plugin inspector is mounted inside the host DOM, so the host's global
 * `.widget-*` rules (src/styles.css) apply. Reusing those class names + the
 * InspectorFieldRow markup makes the test surface render with the same native
 * controls (label row, toggle switch, select, slider) as real actor params. */
function WidgetRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="widget-row widget-row-field">
      <div className="widget-row-header">
        <label className="widget-label">{props.label}</label>
      </div>
      <div className="widget-row-control-wrap">
        <div className="widget-row-control">{props.children}</div>
      </div>
    </div>
  );
}

function NumberControl(props: {
  def: NumberParameterDefinition;
  value: number;
  onChange: (n: number) => void;
}) {
  const { def } = props;
  const hasRange = def.min !== undefined && def.max !== undefined;
  const numberInput = (
    <input
      type="number"
      className="widget-text"
      style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}
      min={def.min}
      max={def.max}
      step={def.step}
      value={props.value}
      onChange={(e) => props.onChange(Number(e.target.value))}
    />
  );
  if (!hasRange) {
    return (
      <div className="widget-number-input-wrap widget-number-input-wrap-fill">
        {numberInput}
        {def.unit ? <span className="widget-number-unit">{def.unit}</span> : null}
      </div>
    );
  }
  const min = def.min as number;
  const max = def.max as number;
  const pct = max > min ? ((props.value - min) / (max - min)) * 100 : 0;
  return (
    <div className="widget-number">
      <input
        className="widget-number-slider"
        type="range"
        min={min}
        max={max}
        step={def.step ?? 1}
        value={props.value}
        style={{ ["--fill" as string]: `${Math.max(0, Math.min(100, pct))}%` }}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <div className="widget-number-input-wrap widget-number-input-wrap-fill">
        {numberInput}
        {def.unit ? <span className="widget-number-unit">{def.unit}</span> : null}
      </div>
    </div>
  );
}

function ToggleControl(props: { checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      type="button"
      className={`widget-toggle${props.checked ? " on" : ""}`}
      role="switch"
      aria-checked={props.checked}
      title={props.checked ? "On" : "Off"}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="widget-toggle-track">
        <span className="widget-toggle-thumb" />
      </span>
      <span className="widget-toggle-label">{props.checked ? "On" : "Off"}</span>
    </button>
  );
}

function TestControl(props: {
  def: ParameterDefinition;
  value: ParameterValue | undefined;
  onChange: (v: ParameterValue) => void;
}) {
  const { def } = props;
  if (def.type === "number") {
    return (
      <NumberControl
        def={def as NumberParameterDefinition}
        value={Number(props.value ?? 0)}
        onChange={props.onChange}
      />
    );
  }
  if (def.type === "boolean") {
    return (
      <ToggleControl checked={Boolean(props.value)} onChange={props.onChange} />
    );
  }
  if (def.type === "select") {
    const options = (def as SelectParameterDefinition).options;
    return (
      <select
        className="widget-select"
        value={String(props.value ?? options[0] ?? "")}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="widget-text"
      value={String(props.value ?? "")}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

/**
 * Synthetic 4-control surface (one per main param type) so the Electra One
 * round-trip can be tested when no real actor is selected. Always on while the
 * plugin is selected. Edits here push to the device; edits on the device loop
 * straight back into these values.
 */
function TestSurfaceCard(props: { session: ElectraSession; state: ElectraConnectionState }) {
  const { session, state } = props;
  const params = state.testSurface ?? {};
  return (
    <div style={cardStyle}>
      <strong style={{ opacity: 0.8 }}>Test surface</strong>
      <div style={{ opacity: 0.65, fontSize: 12, margin: "4px 0 8px" }}>
        Four dummy controls (one per main param type) mirrored to the Electra
        whenever no real actor is selected. Edit them on the device and watch
        them change here, or edit here to push to the device. “Test String” is
        read-only on the device (string params map to a display slot).
      </div>
      <div className="custom-inspector" style={{ gap: 8 }}>
        {TEST_SCHEMA.params.map((def) => (
          <WidgetRow key={def.key} label={def.label}>
            <TestControl
              def={def}
              value={params[def.key]}
              onChange={(v) => session.setTestParam(def.key, v)}
            />
          </WidgetRow>
        ))}
      </div>
    </div>
  );
}

/**
 * Collapsible submenu: device-side render detail toggles + a Provision
 * button + live device status. Each toggle OMITS code from the uploaded
 * Lua (assembled host-side) rather than branching on-device — the Mini's
 * paint loop is the frame-rate bottleneck.
 */
function DeviceRenderingCard(props: { session: ElectraSession; state: ElectraConnectionState }) {
  const { session, state } = props;
  const opts = state.renderOptions;
  const curSig = renderOptionsSig(opts);
  const dirty = state.provisionedRenderSig !== curSig;
  const busy =
    state.phase === "provisioning" ||
    state.phase === "detecting" ||
    state.phase === "checking-firmware";
  return (
    <details style={cardStyle}>
      <summary style={{ cursor: "pointer", fontWeight: 600, opacity: 0.85 }}>
        Device rendering &amp; provisioning
      </summary>
      <div style={{ opacity: 0.65, fontSize: 12, margin: "6px 0 8px" }}>
        Turning a detail OFF removes that code from the bundle uploaded to the
        device (no on-device branch), so the Mini paints faster. Changing a
        toggle needs a re-provision to take effect.
      </div>
      <div className="custom-inspector" style={{ gap: 8 }}>
        <WidgetRow label="End-cap style">
          <select
            className="widget-select"
            value={opts.capStyle}
            onChange={(e) =>
              session.setRenderOptions({ capStyle: e.target.value as ElectraCapStyle })
            }
          >
            <option value="flat">Flat (fastest, square ends)</option>
            <option value="round">Round (best looking, slower)</option>
            <option value="polygon">Polygon (rounded, ~as fast as flat)</option>
            <option value="triangle">Triangle (authentic 7-seg, slowest)</option>
          </select>
        </WidgetRow>
        <WidgetRow label="Ghost background">
          <ToggleControl
            checked={opts.ghostSegments}
            onChange={(v) => session.setRenderOptions({ ghostSegments: v })}
          />
        </WidgetRow>
      </div>
      {dirty ? (
        <div style={{ marginTop: 8, color: "#ffd180", fontSize: 12 }}>
          Options changed — Provision to rebuild &amp; upload the bundle.
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button type="button" disabled={busy} onClick={() => void session.provision()}>
          Provision
        </button>
        <button type="button" disabled={busy} onClick={() => void session.reprovision()}>
          Re-provision
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        <Row label="Phase" value={state.phase} tone={PHASE_TONE[state.phase]} />
        <Row label="Model" value={state.device?.model ?? "—"} />
        <Row label="Firmware" value={state.device?.firmware ?? "—"} />
        <Row
          label="Bundle (device / build)"
          value={`${state.onDeviceBundleVersion ?? "—"} / ${state.buildBundleVersion}`}
          tone={
            state.onDeviceBundleVersion === state.buildBundleVersion ? "default" : "warning"
          }
        />
        <Row
          label="Provisioned slot"
          value={
            state.presetSlot
              ? `bank ${state.presetSlot.bank}, slot ${state.presetSlot.slot}`
              : "—"
          }
        />
        <Row
          label="Render on device"
          value={
            state.provisionedRenderSig
              ? dirty
                ? `${state.provisionedRenderSig} (stale, want ${curSig})`
                : curSig
              : "not provisioned"
          }
          tone={dirty ? "warning" : "default"}
        />
        {state.lastError ? <Row label="Last error" value={state.lastError} tone="error" /> : null}
      </div>
    </details>
  );
}

function DebugTools(props: { session: ElectraSession; state: ElectraConnectionState }) {
  const { session, state } = props;
  const [bank, setBank] = useState(0);
  const [slot, setSlot] = useState(0);
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
          min={0}
          style={{ width: 52 }}
          onChange={(e) => setBank(Number(e.target.value))}
        />
        <span>slot</span>
        <input
          type="number"
          value={slot}
          min={0}
          style={{ width: 52 }}
          onChange={(e) => setSlot(Number(e.target.value))}
        />
        <button type="button" onClick={() => guard(() => session.switchPresetSlot(bank, slot))}>
          Switch preset slot (0-based)
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          // flex:1 with the default min-width:auto makes this input refuse to
          // shrink below its intrinsic text size — a prime contributor to the
          // inspector overflow. minWidth:0 lets it collapse with the card.
          style={{ flex: 1, minWidth: 0, fontFamily: "monospace" }}
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
      <div style={logPaneStyle}>
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
    // The test surface is always on while the plugin is selected so the
    // device round-trip works without picking a real actor (idempotent; a
    // real selected actor still takes precedence in effectiveSnapshot()).
    session.setTestSurface(true);
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
      <ProvisioningCard session={session} state={state} />
      <DeviceRenderingCard session={session} state={state} />

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
          tone={
            state.onDeviceBundleVersion === state.buildBundleVersion ? "default" : "warning"
          }
        />
        <Row
          label="Provisioned slot"
          value={
            state.presetSlot
              ? `bank ${state.presetSlot.bank}, slot ${state.presetSlot.slot}`
              : "—"
          }
        />
        <Row
          label="Mirrored actor"
          value={state.mirroredActor ? state.mirroredActor.name : selected[0]?.name ?? "(none selected)"}
        />
        {state.lastError ? <Row label="Last error" value={state.lastError} tone="error" /> : null}
      </div>

      <TestSurfaceCard session={session} state={state} />

      <DebugTools session={session} state={state} />

      <div style={cardStyle}>
        <strong style={{ opacity: 0.8 }}>Diagnostics</strong>
        <div style={logPaneStyle}>
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
