import { describe, expect, it } from "vitest";
import { decodeFieldValue, mapInspectorToSurface } from "../src/inspectorMapping";
import type { ParameterDefinition, PluginHostActorSnapshot } from "../src/contracts";

function snap(
  params: Record<string, unknown>,
  defs: ParameterDefinition[]
): PluginHostActorSnapshot {
  return {
    id: "a1",
    name: "Cube",
    actorType: "mesh",
    params: params as PluginHostActorSnapshot["params"],
    schema: { id: "s", title: "Cube", params: defs }
  };
}

describe("mapInspectorToSurface", () => {
  it("returns null with no selection / no schema / no mappable fields", () => {
    expect(mapInspectorToSurface(null)).toBeNull();
    expect(
      mapInspectorToSurface({
        id: "x",
        name: "x",
        actorType: "t",
        params: {},
        schema: null
      })
    ).toBeNull();
    expect(
      mapInspectorToSurface(snap({}, [{ key: "f", label: "F", type: "file", accept: [] }]))
    ).toBeNull();
  });

  it("maps the supported kinds with terse values", () => {
    const desc = mapInspectorToSurface(
      snap({ on: true, size: 2.5, mode: "b", note: "hi" }, [
        { key: "on", label: "On", type: "boolean" },
        { key: "size", label: "Size", type: "number", min: 0, max: 10, step: 0.5, precision: 2 },
        { key: "mode", label: "Mode", type: "select", options: ["a", "b", "c"] },
        { key: "note", label: "Note", type: "string" }
      ])
    );
    expect(desc?.actorName).toBe("Cube");
    expect(desc?.fields.map((f) => [f.idx, f.kind, f.value])).toEqual([
      [0, "toggle", "1"],
      [1, "number", "2.50"],
      [2, "list", "1"],
      [3, "readonly", "hi"]
    ]);
    expect(desc?.fields[1]).toMatchObject({ min: 0, max: 10, step: 0.5 });
    expect(desc?.fields[2].options).toEqual(["a", "b", "c"]);
  });

  it("honours visibleWhen (scalar + array) and section labels", () => {
    const defs: ParameterDefinition[] = [
      { key: "kind", label: "Kind", type: "select", options: ["x", "y"] },
      {
        key: "adv",
        label: "Adv",
        type: "boolean",
        groupKey: "g1",
        groupLabel: "Advanced",
        visibleWhen: [{ key: "kind", equals: "y" }]
      },
      {
        key: "either",
        label: "Either",
        type: "boolean",
        visibleWhen: [{ key: "kind", equals: ["x", "y"] }]
      }
    ];
    const hidden = mapInspectorToSurface(snap({ kind: "x" }, defs));
    expect(hidden?.fields.map((f) => f.key)).toEqual(["kind", "either"]);
    const shown = mapInspectorToSurface(snap({ kind: "y" }, defs));
    expect(shown?.fields.map((f) => f.key)).toEqual(["kind", "adv", "either"]);
    expect(shown?.fields.find((f) => f.key === "adv")?.sectionLabel).toBe("Advanced");
  });

  it("sends all visible fields (device pages them); cap guards runaway", () => {
    const defs = Array.from({ length: 12 }, (_, i) => ({
      key: `n${i}`,
      label: `N${i}`,
      type: "boolean" as const
    }));
    // Default cap is large (MAX_FIELDS=64) — all 12 are sent, not truncated to 8.
    expect(mapInspectorToSurface(snap({}, defs))?.fields).toHaveLength(12);
    expect(mapInspectorToSurface(snap({}, defs), 3)?.fields).toHaveLength(3);
  });

  it("prepends transform/enabled/visibility (@-keyed) before params", () => {
    const withTransform: PluginHostActorSnapshot = {
      ...snap({ amp: 2 }, [{ key: "amp", label: "Amp", type: "number" }]),
      transform: {
        position: [1, 2, 3],
        rotation: [Math.PI, 0, 0],
        scale: [1, 1, 1]
      },
      enabled: true,
      visibilityMode: "hidden"
    };
    const desc = mapInspectorToSurface(withTransform);
    const keys = desc?.fields.map((f) => f.key);
    expect(keys?.slice(0, 11)).toEqual([
      "@enabled",
      "@visibility",
      "@pos.0",
      "@pos.1",
      "@pos.2",
      "@rot.0",
      "@rot.1",
      "@rot.2",
      "@scl.0",
      "@scl.1",
      "@scl.2"
    ]);
    expect(keys?.[11]).toBe("amp");
    const enabled = desc?.fields[0];
    expect(enabled).toMatchObject({ kind: "toggle", value: "1" });
    const vis = desc?.fields[1];
    expect(vis).toMatchObject({ kind: "list", value: "1" }); // "hidden" index
    expect(desc?.fields[5]).toMatchObject({ key: "@rot.0", value: "180.0" }); // rad->deg
    // v37 pagination keeps grouped vectors on a single 4-slot page: each of
    // pos/rot/scl is a contiguous 3-axis group, so a group that doesn't fit
    // in the current page wraps to the next page (the previous page is
    // padded with a gap = a skipped idx). Layout:
    //   page 0: @enabled(0), @visibility(1)                — 2 free slots
    //   page 1: @pos.0(4), @pos.1(5), @pos.2(6)            — 1 free slot
    //   page 2: @rot.0(8), @rot.1(9), @rot.2(10)           — 1 free slot
    //   page 3: @scl.0(12), @scl.1(13), @scl.2(14), amp(15)
    expect(desc?.fields.map((f) => f.idx)).toEqual([0, 1, 4, 5, 6, 8, 9, 10, 12, 13, 14, 15]);
    // Transform rows carry units: pos=m, rot=deg (ASCII, not "°"), scl=x.
    // Enabled / Visibility don't get a unit.
    expect(desc?.fields[0].unit).toBeUndefined();
    expect(desc?.fields[1].unit).toBeUndefined();
    expect(desc?.fields[2].unit).toBe("m"); // @pos.0
    expect(desc?.fields[5].unit).toBe("deg"); // @rot.0
    expect(desc?.fields[8].unit).toBe("x"); // @scl.0
  });

  it("propagates def.unit from number params through to the surface field", () => {
    const desc = mapInspectorToSurface(
      snap({ size: 1.5, speed: 0 }, [
        { key: "size", label: "Size", type: "number", precision: 2, unit: "m" },
        { key: "speed", label: "Speed", type: "number", precision: 1, unit: "m/s" },
        { key: "ratio", label: "Ratio", type: "number" } // no unit
      ])
    );
    expect(desc?.fields.find((f) => f.key === "size")?.unit).toBe("m");
    expect(desc?.fields.find((f) => f.key === "speed")?.unit).toBe("m/s");
    expect(desc?.fields.find((f) => f.key === "ratio")?.unit).toBeUndefined();
  });
});

describe("decodeFieldValue", () => {
  it("decodes editable kinds and rejects others", () => {
    expect(decodeFieldValue({ kind: "toggle" }, "1")).toBe(true);
    expect(decodeFieldValue({ kind: "toggle" }, "0")).toBe(false);
    expect(decodeFieldValue({ kind: "number" }, "3.5")).toBe(3.5);
    expect(decodeFieldValue({ kind: "number" }, "x")).toBeUndefined();
    expect(decodeFieldValue({ kind: "list", options: ["a", "b", "c"] }, "2")).toBe("c");
    expect(decodeFieldValue({ kind: "list", options: ["a"] }, "9")).toBeUndefined();
    expect(decodeFieldValue({ kind: "readonly" }, "anything")).toBeUndefined();
  });
});
