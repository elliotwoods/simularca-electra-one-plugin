# Simularca Electra One Surface Plugin

Turns an [Electra One Mini](https://electra.one) into a hardware control
surface for the **currently selected actor's inspector** in
[Simularca](https://github.com/elliotwoods/simularca). Same role as the
built-in Roto-Control addon, but built natively for the Electra platform and
shipped as a self-contained **external** plugin.

It is renderer-only: MIDI is the browser **Web MIDI API** (SysEx enabled), so
there is no Node-side MIDI host and no IPC. The device runs a self-contained
Lua application; at runtime the host and device exchange compact messages (the
Simularca Surface Protocol). See [`SPEC.md`](./SPEC.md) for the full design and
the phased plan.

## Status

Phase 1 (plumbing) + Phase 2 (provisioning): Web MIDI detection with a manual
port picker, the connection state machine, the inspector
status/diagnostics/debug panel, and **provisioning** — a minimal "hello"
preset + Lua app is uploaded to a chosen (never-overwriting) slot and
activated, so the device screen shows "Simularca vN". The surface renderers,
the digit editor and the Simularca Surface Protocol land in later phases — see
`SPEC.md §11`.

## Install / build

```bash
npm install
npm run build      # → dist/index.js (+ dist/index.d.ts)
npm run typecheck
```

## Load in Simularca

Auto-discovered after build from
`plugins-external/simularca-electra-one-plugin/dist/index.js`. Or from the
Simularca console:

```
plugin.load("file:///C:/dev/simularca/plugins-external/simularca-electra-one-plugin/dist/index.js")
```

In Electron+Vite dev mode Simularca rewrites local `file:///…` plugin URLs to
Vite `@fs` imports automatically.

## Host prerequisites

This plugin needs two one-time changes in the **Simularca host repo** (it is an
app-wide surface, which external plugins cannot be without them — see
`SPEC.md §3`). They live on the `feature/electra-one-plugin-host-bridge` branch:

1. **`midiSysex` permission** — a `setPermissionCheckHandler` /
   `setPermissionRequestHandler` in `electron/main.ts` so the renderer may call
   `navigator.requestMIDIAccess({ sysex: true })`.
2. **Plugin host bridge** — `PluginRuntimeComponentProps` /
   `PluginInspectorComponentProps` gain a `host: PluginHostBridge`
   (selected-actor snapshots + a `updateActorParams` path). External plugins
   cannot import host modules, so this sanctioned prop is how the surface reads
   the selection and writes values.

`src/contracts.ts` mirrors the host plugin-API slice and **must be kept in sync**
with `src/features/plugins/pluginApi.ts` in the Simularca repo.

## Known load-time verification items

Resolve these when first running against a real device + app build:

- **Single React instance.** Components use React hooks; this requires the
  dynamically-loaded plugin bundle to share the host's React instance (via the
  host's `expectedExternals` mechanism). Simularca notes a separate-instance
  hazard for `three` in plugins; verify hooks work and, if not, treat React as
  a host-provided external.
- **Electra USB-MIDI port name** — matched by the substring `electra`
  (`SPEC.md §10`); confirm against the real device.
- **Electra SysEx framings** — device-info request/response is best-effort
  (`src/electraSysex.ts`); validate against
  <https://docs.electra.one/developers/midiimplementation.html>.

## License

MIT
