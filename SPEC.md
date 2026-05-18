# Specification — Electra One Surface Plugin for Simularca

Status: implementation in progress (Phase 1 landed)
Scope: the self-contained external plugin (renderer TypeScript), the two host
prerequisites it depends on, the on-device Electra One preset shell, the
on-device Lua application, and the SysEx provisioning/runtime protocol.

---

## 0. Review changelog (how the design reached this point)

This document supersedes an earlier Simularca-side draft. The draft was
grounded against the codebase and corrected three times; the corrections are
recorded here so the design is auditable.

1. **Flat groups + conditional visibility (codebase fact).** `ParameterSchema`
   is one flat ordered `params: ParameterDefinition[]` list. Grouping is a
   *single* level via optional `groupKey` / `groupLabel`; there is no
   group-that-contains-fields tree and no "group field" kind. Every param may
   carry `visibleWhen`, so the visible field set is **dynamic**. The draft's
   nested navigation-stack / breadcrumb model was replaced with a flat,
   section-annotated, paginated model that re-publishes on visibility change
   (§5.4, §7).
2. **Renderer-only external plugin (architecture decision).** External plugins
   load in the renderer only; they cannot ship Electron-main code, IPC, or
   touch the host source. MIDI is therefore the **browser Web MIDI API**
   (`navigator.requestMIDIAccess({ sysex: true })`); Electra is MIDI-only so no
   serial path is needed. The draft's shared-MIDI-core extraction, Electron
   host and IPC slice were **deleted**.
3. **External plugins are actor/view providers, not app-wide addons
   (codebase fact).** A plugin's `runtimeComponent` / `inspectorComponent` are
   honoured for any plugin id, but they receive only `{ plugin }` — external
   plugins cannot import host modules (`@/…`) to reach the kernel store, the
   selected actor, or a param-write path. An app-wide surface (the Roto model)
   is impossible without a host change. Resolved by adding **one small,
   general host plugin-API bridge** (below).

### Two host prerequisites (Simularca repo, `feature/electra-one-plugin-host-bridge`)

- **`midiSysex` permission.** A `setPermissionCheckHandler` /
  `setPermissionRequestHandler` in `electron/main.ts` granting `midi` /
  `midiSysex` (behaviour-preserving for all other permissions).
- **Plugin host bridge.** `PluginRuntimeComponentProps` /
  `PluginInspectorComponentProps` gain `host: PluginHostBridge` —
  `selectedActors: PluginHostActorSnapshot[]` (id, name, actorType,
  pluginType, params, resolved `schema`) and
  `updateActorParams(actorId, partial, { history? })`. Built by
  `usePluginHostBridge()` / `buildPluginHostBridge()` from
  `useKernel()`/`useAppStore()`. Backward compatible — roto-control ignores it.

Everything else (the plugin code and repo) is fully self-contained and
external.

---

## 1. Summary

`plugin.electraOneMini` turns an Electra One Mini into a hardware control
surface for the currently selected actor's inspector — the role of the built-in
Roto-Control addon, built natively for Electra and shipped as an external repo.

The defining difference from Roto: the Electra runs Lua. Instead of
re-publishing a "bank" on every change, a self-contained application (preset
shell + Lua program) is uploaded **once**; at runtime only compact data
messages are exchanged. The device owns rendering, drill-down editors, carry
math and navigation; the plugin owns the actor model and is the source of truth
for values.

### 1.1 Key decisions

1. **All 8 slots are custom Lua-drawn components** — native control *types* are
   fixed in preset JSON and cannot be re-typed at runtime, but a slot must
   morph as the selected actor changes. Toggle/list renderers are *styled* to
   match the native Electra look.
2. **Host→device runtime data via Electra "Run Lua Command" SysEx**; device→host
   events as a custom SysEx sub-format. Cold-path (full descriptor) JSON,
   chunked; hot-path terse.
3. **True external plugin** in its own public repo, renderer-only, Web MIDI. The
   only shared layer is the sanctioned host bridge (a general plugin-API
   addition, not Electra-specific).

---

## 2. Target hardware (Electra One Mini)

- 8 endless touch-sensitive 360° encoders with push switches, 4×2.
  **Top row = knobs 1–4**, **bottom row = knobs 5–8** (left→right).
- 6 buttons; slots 1–2 are fixed system buttons (MENU, CONTEXT); **slots 3–6
  assignable**.
- 5″ non-touch LCD, 800×480. Input is knobs + 4 assignable buttons.
- 40 preset slots (5 banks × 8). USB-MIDI only (no serial).

Docs: `docs.electra.one/userguide-mini/overview.html`,
`/developers/midiimplementation.html`, `/developers/luaext.html`,
`/developers/presetformat.html`.

---

## 3. Architecture

Three parts:

1. **External plugin (renderer TypeScript)** — this repo. Detects the device
   via Web MIDI, provisions it, watches `host.selectedActors`, maps the
   inspector schema to a descriptor, keeps values in sync both ways, renders the
   inspector status panel.
2. **Device-side bundle** — `preset.json` (preset shell) + `main.lua` (Lua app),
   uploaded once.
3. **Two host prerequisites** in the Simularca repo (§0) — the `midiSysex`
   permission and the `PluginHostBridge`.

Communication planes:

- **Host bridge (in-process).** `host.selectedActors` (live, recomputed on
  selection/param/descriptor change) and `host.updateActorParams(...)`. No IPC.
- **Web MIDI (renderer ↔ device).** `navigator.requestMIDIAccess({ sysex:true })`;
  open the Electra input+output; send/receive SysEx directly.
- **Management plane (SysEx).** Electra native commands (`00 21 45`):
  device-info, Set Preset Slot, preset upload, Lua upload, Get Lua script,
  Switch Preset Slot, Run Lua Command.
- **Runtime plane (SysEx).** The *Simularca Surface Protocol* (SSP):
  host→device inside Run Lua Command; device→host as custom SysEx parsed by the
  plugin.

---

## 4. Provisioning and versioning (Phase 2)

### 4.1 Bundle

Shipped in-repo: `surfaceBundle/preset.json`, `surfaceBundle/main.lua`,
`SURFACE_BUNDLE_VERSION` (a monotonic integer in `src/types.ts`, independent of
the package version). A build step concatenates `surfaceBundle/lua/*.lua` into
`main.lua` and stamps the version into the Lua source
(`local BUNDLE_VERSION = <n>`) and the preset-name marker.

### 4.2 Launch handshake

On the runtime component mounting: **Detect** (Web MIDI; identify Electra port)
→ **Identify** (device-info SysEx; model + firmware; gate on `MIN_FIRMWARE`) →
**Locate our preset** (read preset names; check persisted `(bank,slot)`;
read-back Lua, parse `BUNDLE_VERSION`) → **Decide** (equal → no upload;
differ → re-upload same slot; missing → first empty slot banks 1→5; none →
error, never overwrite) → **Activate** (Switch Preset Slot) → **Persist** →
**Sync** (`SET_ACTOR` or `CLEAR`) → state `ready`.

### 4.3 Update strategy

Authoritative check is the integer compare of on-device `BUNDLE_VERSION` vs
build `SURFACE_BUNDLE_VERSION`. The preset-name marker only makes discovery
cheap. A "Re-provision" button forces upload.

---

## 5. Device-side application

### 5.1 Preset shell

Pages: `Surface` (8 custom slots, 4×2), `Drill` (full-window drill-down),
`Status` (optional). No group-navigation page, no Lua group stack. One virtual
device; 4 assignable buttons; preset-name marker carrying the bundle version.

### 5.2 Lua modules

`protocol` (SSP), `model` (flat ordered visible fields + per-field section
labels + page index; **no nav stack**), `render`, `digits`, `interaction`,
`app`.

### 5.3 Slot renderers

| Inspector kind | Device representation | Turn | Push |
|---|---|---|---|
| `boolean` | Toggle (native-pad styled) | flip at threshold | toggle |
| `select` | List (native-list styled) | scroll options | option drill-down |
| `actor-ref`, `material-ref`, `mesh-lod-ref` | Reference (= list over dynamic candidates) | scroll | option drill-down |
| `number` (ranged) | Ranged control: label, value, unit, position bar | nudge by `step` | digit drill-down |
| `number` (rangeless) | Rangeless control: label, value, unit, scrubbable | nudge by `step`/`dragSpeed` | digit drill-down |
| `vector3` | Vector control: label + X/Y/Z | adjust focused channel | vector-detail drill-down |
| `color` (tier 2) | Swatch; drill-down reuses vector-detail | — | channel drill-down |
| `string` | Read-only display | — | — |

No "embedded group" row — grouping is a **section label** on fields
(`groupKey`/`groupLabel`), influencing page breaks + a header strip, not
navigation. Unsupported kinds (`location`, `datetime`, `timezone`, `file`,
`material-slots`, `dxf-layer-states`, `actor-ref-list` unless tier 2) are
omitted by the mapping (or shown as a read-only placeholder via a flag).

### 5.4 Layout & navigation (flat + conditional)

Navigation is only **(a) paging** the flat visible list 8/page (buttons 3/4
Prev/Next) and **(b)** entering/exiting a drill-down. The plugin computes the
visible field list by evaluating `visibleWhen` against current values, maps
visible+supported fields to slots in schema order, and tags each with its
section label. Conditional visibility is dynamic: on any applied value change
(device or external) the plugin re-evaluates; if the visible list/order
changed it re-sends `SET_FIELDS`/`SET_ACTOR` (clamp page index), else
`SET_FIELD_VALUE`.

### 5.5 Assignable buttons

3 Page Prev · 4 Page Next · 5 Back (exit drill-down; no-op otherwise) ·
6 Reset focused control to default. In a drill-down all knob pushes mean
"exit"; buttons 3/4 may jump the zoom window to extremes.

---

## 6. Drill-down editors (device-side Lua)

Digit editor (§6.1–6.4): title once; big tall monospace number; four active
digit positions on knobs 5–8 each with a coloured block + link line to its
knob; knob 1 = zoom (pans the 4-wide window); arithmetic add/subtract by place
value `10^p` (sign emergent, carry/borrow propagate through the whole number,
including outside the window); one detent = one step (acceleration filtered);
window defaults to the 4 most-significant positions; clamp to range/precision;
every detent emits SSP `VALUE_CHANGED`; any knob push exits.
Enum/select drill-down (§6.5): scrollable list, same encoder keeps changing
live, push exits, in-place refresh on `SET_FIELD_META`.
Vector drill-down (§6.6): X/Y/Z on three knobs; push a channel → digit editor;
Back → Surface; `color` (tier 2) reuses this.

---

## 7. Simularca Surface Protocol

**Host → device** (inside Run Lua Command): `SET_ACTOR` (flat ordered visible
fields + section labels + page index + page-break hints; JSON, chunked),
`SET_FIELDS` (lighter recomputed slice after a visibility change),
`SET_FIELD_VALUE` (hot, terse), `SET_FIELD_META` (meta/option list change),
`CLEAR`, `STATUS`, `PING`. A `Field`: `slotKind`, `id`, `label`, `value`,
`color`, `sectionLabel?`, `meta` (`min/max/step/precision/unit/dragSpeed`),
`options?` — no `groupPath`.

**Device → host** (custom SysEx `00 21 45` + app tag + type + payload):
`READY` (bundleVersion, firmware), `VALUE_CHANGED`, `NAV` (drill enter/exit,
page index — no group push/pop), `FIELD_FOCUS`, `BUTTON`, `LOG`.

Encoding: cold JSON 7-bit-safe chunked; hot terse ASCII-decimal. Binary
fixed-point is an allowed later optimisation.

---

## 8. The external plugin (this repo)

Single self-contained external package (no two-part split — that is only for
built-in plugins). Build is `tsc` via `scripts/plugin-build.mjs` (mirrors the
existing external React plugins).

- `src/index.ts` — `PluginHandshakeModule`; `createPlugin()` returns a
  `PluginDefinition` with `runtimeComponent` + `inspectorComponent` (the host
  loader preserves them for any id).
- `src/contracts.ts` — self-contained mirror of the host plugin-API slice
  (handshake, **host bridge**, component props, the `ParameterDefinition`
  union with `visibleWhen`). **Keep in sync** with the host
  `src/features/plugins/pluginApi.ts` + `src/core/types.ts`.
- `src/electraOnePlugin.tsx` — `ElectraOneRuntime` (always-on; owns the
  session; tracks `host.selectedActors[0]`), `ElectraOneInspector` (status +
  diagnostics panel), `createElectraOnePlugin()`.
- `src/connectionState.ts` — `ElectraSession`, a React-free controller owning
  the Web MIDI + lifecycle state machine (`unavailable → detecting →
  checking-firmware → provisioning → ready → error`, plus `incompatible`).
- `src/webMidiService.ts` — `requestMIDIAccess({sysex:true})`, Electra port
  match, send/receive, hot-plug.
- `src/electraSysex.ts` — Electra native SysEx framing (device-info now;
  preset/Lua/Run-Lua/Set-Slot in Phase 2).
- `src/inspectorMapping.ts` *(Phase 3)* — selected actor → `SET_ACTOR`
  descriptor: evaluate `visibleWhen`, filter to supported kinds, map to
  `slotKind`, extract meta/options, attach `sectionLabel`, page-break hints,
  colours.
- `src/sspCodec.ts` *(Phase 3)* — SSP encode/decode + JSON chunking.

### 8.1 Selection sync & bidirectional values

The runtime component reads `host.selectedActors` (already includes the
resolved `schema`). On change it builds a descriptor and (Phase 3) sends
`SET_ACTOR`; none → `CLEAR`. Device `VALUE_CHANGED` is applied via
`host.updateActorParams(actorId, { [key]: value }, { history: false })` for
live edits (history on for deliberate commits) — the same kernel path the
inspector UI uses, so on-screen inspector and device stay consistent. After
every applied change, re-evaluate `visibleWhen` and resend if structure
changed.

**Loop prevention.** A device-originated change must not echo `SET_FIELD_VALUE`
back. Guard with a per-field "last value seen from device" compare and a short
suppression window (the Roto `suppressInputUntilRef` 150 ms pattern is the
reference).

### 8.2 Persistence

`localStorage`, keys `simularca:electra-one:*` (mirroring
`simularca:roto-control:*`), SSR/error-guarded, for the chosen preset
`(bank,slot)` and any port preference.

### 8.3 Inspector panel

Status panel (phase, firmware vs `MIN_FIRMWARE`, slot in use, on-device vs
build bundle version, mirrored actor, Re-detect/Re-provision buttons,
diagnostics log).

---

## 9. Edge cases

No selection → `CLEAR`/idle. >8 visible fields → device paging. Zero visible
(all gated by `visibleWhen`) → idle. Visibility flip → recompute + resend +
clamp page. Disconnect → state transition; Web MIDI `statechange` →
re-detect. Slot occupied by non-simularca preset / none free → explicit error,
never overwrite. Long labels → device-side shortening. Firmware <
`MIN_FIRMWARE` → blocked, no upload. Unsupported kinds → omitted.

---

## 10. Open items to confirm during implementation

- Exact USB-MIDI port name(s) of the Electra One Mini (currently matched by
  substring `electra`).
- ~~Exact SysEx framings~~ **RESOLVED** from the Electra docs (electraSysex.ts):
  device-info `02 7F` (resp `01 7F` JSON), Set Preset Slot `09 08 bank slot`
  (0-based — the draft's `14 08` was wrong), upload preset `01 01`, upload Lua
  `01 0C`, request Lua `02 0C`, request preset `02 01`, execute Lua `08 0D`,
  ACK `7E 01` / NACK `7E 00` / Log `7F 00`. Note the protocol reuses the same
  command bytes for upload and the matching response (direction is contextual).
  Still open: per-slot preset-name *listing* (we use switch+request-preset
  instead), exact bank/slot ranges for the Mini, max SysEx payload / chunking
  threshold for large preset uploads.
- Lua Extension API specifics (custom component paint/encoder/touch callbacks,
  page switching from Lua, font sizes, max SysEx payload, `sendSysex`).
- Whether the 4 assignable buttons can be rebound per-context from Lua.
- The pinned `MIN_FIRMWARE`.
- **Single React instance** for the dynamically-loaded bundle (hooks depend on
  it; verify via the host `expectedExternals` mechanism — see README).

---

## 11. Phased plan

- **Phase 1 — Plumbing (done).** Web MIDI detection, connection state machine,
  inspector status/diagnostics panel, always-on runtime watcher tracking the
  selected actor, the two host prerequisites.
- **Phase 2 — Provisioning (done).** Corrected Electra SysEx framings;
  minimal "hello" preset + Lua bundle (stamped `BUNDLE_VERSION`); safe target
  slot (persisted) with a never-overwrite guard (request-preset name check);
  preset + Lua upload with ACK/NACK; activate (visible); read-back +
  version-compare/skip; auto on ready + Re-provision. Still TODO: pin
  `MIN_FIRMWARE`; chunk very large preset uploads if the device needs it.
- **Phase 3 — Baseline surface.** `Surface`, 8 custom slots; SSP
  `SET_ACTOR`/`SET_FIELDS`/`SET_FIELD_VALUE`; toggle/select/read-only
  renderers; `inspectorMapping` with `visibleWhen` + section labels;
  bidirectional sync + loop prevention.
- **Phase 4 — Numbers + digit editor.** Ranged/rangeless renderers; `digits`
  module; digit drill-down (zoom, carry/borrow, link lines). Vitest for digit
  math.
- **Phase 5 — Vectors + enums.** Vector renderer + per-channel digit editing;
  enum/select option-list drill-down with in-place `SET_FIELD_META` refresh.
- **Phase 6 — Polish.** Section-aware page breaks; Back/Prev/Next; knob-touch
  `FIELD_FOCUS` highlight; colour theming; long-label shortening.
- **Phase 7 — Tier 2.** `color`, `actor-ref-list`, reconnection robustness,
  full error-state coverage.

Testing (Vitest): `digits` (place-value math, carry/borrow across the window
boundary, sign flips, zoom clamp, growth), `inspectorMapping` (kind filtering,
`visibleWhen`, section labels, page-break hints, meta extraction), `sspCodec`
(chunk/reassembly round-trips).

---

## 12. Codebase grounding

Simularca repo references behind this design:

- Schema: `src/core/types.ts` — `ParameterSchema { id, title, params:
  ParameterDefinition[] }`; `ParameterDefinitionBase` has
  `groupKey?`/`groupLabel?`/`visibleWhen?`; flat single-level groups.
- Host bridge: `src/features/plugins/pluginApi.ts`
  (`PluginHostBridge`, `PluginHostActorSnapshot`, `host` on
  `PluginRuntime/InspectorComponentProps`),
  `src/features/plugins/usePluginHostBridge.ts`,
  `PluginRuntimeHost.tsx`, `InspectorPane.tsx` mount.
- Loader preserves `runtimeComponent`/`inspectorComponent` for any id:
  `src/features/plugins/pluginLoader.ts` + `pluginApi.ts`
  (`augmentInternalPluginDefinition` only special-cases `plugin.rotoControl`).
- Web MIDI permission: `electron/main.ts` (`midiSysex` handlers).
- Loop-prevention reference: `src/features/rotoControl/useRotoControlBank.ts`
  (`suppressInputUntilRef`, 150 ms).
- External plugin packaging reference: `plugins-external/
  simularca-mylar-explorer-plugin` (React, `tsc`-only,
  `scripts/plugin-build.mjs`).
