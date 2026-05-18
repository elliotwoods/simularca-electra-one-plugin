// Self-contained mirror of the Simularca host plugin API. External plugins
// cannot import host modules (`@/...`), so the slice of the host contract this
// plugin relies on is re-declared here. Keep these in sync with the host:
//   - src/features/plugins/pluginApi.ts        (PluginHostBridge, *ComponentProps)
//   - src/features/plugins/contracts.ts         (PluginHandshakeModule)
//   - src/core/types.ts                         (ParameterDefinition union)
// The host's plugin loader spreads the object returned by `createPlugin()`, so
// `inspectorComponent` / `runtimeComponent` declared here survive registration
// for any plugin id (only `plugin.rotoControl` gets special augmentation).

import type { ComponentType, ReactNode } from "react";

/* ------------------------------------------------------------------ values */

export type ParameterValue =
  | number
  | string
  | boolean
  | number[]
  | string[]
  | object
  | null;
export type ParameterValues = Record<string, ParameterValue>;

/* -------------------------------------------------------- parameter schema */

export interface ParameterDefinitionBase {
  key: string;
  label: string;
  description?: string;
  defaultValue?: number | string | boolean | number[] | string[] | object;
  /** Single-level visual section (NOT a nested group tree). */
  groupKey?: string;
  groupLabel?: string;
  /** Conditional visibility against sibling param values. */
  visibleWhen?: Array<{
    key: string;
    equals: string | number | boolean | Array<string | number | boolean>;
  }>;
}

export interface NumberParameterDefinition extends ParameterDefinitionBase {
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  dragSpeed?: number;
}
export interface BooleanParameterDefinition extends ParameterDefinitionBase {
  type: "boolean";
}
export interface StringParameterDefinition extends ParameterDefinitionBase {
  type: "string";
}
export interface ColorParameterDefinition extends ParameterDefinitionBase {
  type: "color";
}
export interface Vector3ParameterDefinition extends ParameterDefinitionBase {
  type: "vector3";
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  dragSpeed?: number;
}
export interface SelectParameterDefinition extends ParameterDefinitionBase {
  type: "select";
  options: string[];
}
export interface ActorRefParameterDefinition extends ParameterDefinitionBase {
  type: "actor-ref";
  allowedActorTypes?: string[];
  allowSelf?: boolean;
}
export interface ActorRefListParameterDefinition extends ParameterDefinitionBase {
  type: "actor-ref-list";
  allowedActorTypes?: string[];
  allowSelf?: boolean;
}
export interface MaterialRefParameterDefinition extends ParameterDefinitionBase {
  type: "material-ref";
}
export interface MeshLodRefParameterDefinition extends ParameterDefinitionBase {
  type: "mesh-lod-ref";
  mode: "viewport" | "render";
  parentAssetIdParam: string;
}
export interface MaterialSlotsParameterDefinition extends ParameterDefinitionBase {
  type: "material-slots";
}
export interface DxfLayerStatesParameterDefinition extends ParameterDefinitionBase {
  type: "dxf-layer-states";
}
export interface LocationParameterDefinition extends ParameterDefinitionBase {
  type: "location";
  showElevation?: boolean;
}
export interface DateTimeParameterDefinition extends ParameterDefinitionBase {
  type: "datetime";
}
export interface TimezoneParameterDefinition extends ParameterDefinitionBase {
  type: "timezone";
}
export interface FileParameterDefinition extends ParameterDefinitionBase {
  type: "file";
  accept: string[];
}

export type ParameterDefinition =
  | NumberParameterDefinition
  | BooleanParameterDefinition
  | StringParameterDefinition
  | ColorParameterDefinition
  | Vector3ParameterDefinition
  | SelectParameterDefinition
  | ActorRefParameterDefinition
  | ActorRefListParameterDefinition
  | MaterialRefParameterDefinition
  | MeshLodRefParameterDefinition
  | MaterialSlotsParameterDefinition
  | DxfLayerStatesParameterDefinition
  | LocationParameterDefinition
  | DateTimeParameterDefinition
  | TimezoneParameterDefinition
  | FileParameterDefinition;

export interface ParameterSchema {
  id: string;
  title: string;
  params: ParameterDefinition[];
}

/* ----------------------------------------------------------- host bridge */

/** Mirror of host `PluginHostActorSnapshot` (src/features/plugins/pluginApi.ts). */
export interface PluginHostActorSnapshot {
  id: string;
  name: string;
  actorType: string;
  pluginType?: string;
  params: ParameterValues;
  schema: ParameterSchema | null;
}

/** Mirror of host `PluginHostBridge`. Recomputed by the host on selection /
 *  param / descriptor changes, so a component reading it re-renders on change. */
export interface PluginHostBridge {
  selectedActors: PluginHostActorSnapshot[];
  updateActorParams(
    actorId: string,
    partial: ParameterValues,
    options?: { history?: boolean }
  ): void;
}

/* ----------------------------------------------------- plugin definition */

export interface PluginManifest {
  handshakeVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  engine: {
    minApiVersion: number;
    maxApiVersion: number;
  };
}

export interface RegisteredPlugin {
  definition: PluginDefinition;
  manifest?: PluginManifest;
  source?: {
    modulePath: string;
    sourceGroup?: "plugins-external" | "plugins" | "manual";
    loadedAtIso: string;
    updatedAtMs?: number;
  };
}

export interface PluginInspectorComponentProps {
  plugin: RegisteredPlugin;
  host: PluginHostBridge;
}

export interface PluginRuntimeComponentProps {
  plugin: RegisteredPlugin;
  host: PluginHostBridge;
}

export interface PluginViewDescriptor {
  viewType: string;
  title: string;
  component?: ComponentType<unknown>;
  render?: (props: unknown) => ReactNode;
}

export interface PluginDefinition {
  id: string;
  name: string;
  actorDescriptors: never[];
  componentDescriptors: never[];
  viewDescriptors: PluginViewDescriptor[];
  inspectorComponent?: ComponentType<PluginInspectorComponentProps>;
  runtimeComponent?: ComponentType<PluginRuntimeComponentProps>;
}

export interface PluginHandshakeModule {
  manifest: PluginManifest;
  createPlugin(): PluginDefinition;
}
