import { describe, expect, it } from "vitest";
import { pickPort, scoreElectraPortName } from "../src/webMidiService";

describe("scoreElectraPortName", () => {
  it("ignores non-Electra ports", () => {
    expect(scoreElectraPortName("IAC Driver Bus 1")).toBe(0);
    expect(scoreElectraPortName("Launchpad MK2")).toBe(0);
  });

  it("ranks the controller port above the thru ports", () => {
    const ctrl = scoreElectraPortName("Electra Controller");
    const bare = scoreElectraPortName("Electra One");
    const p1 = scoreElectraPortName("Electra Port 1");
    expect(ctrl).toBeGreaterThan(bare);
    expect(bare).toBeGreaterThan(p1);
    expect(p1).toBeGreaterThan(0);
  });
});

describe("pickPort", () => {
  const ports = [
    { id: "a", name: "Electra Port 1" },
    { id: "b", name: "Electra Controller" },
    { id: "c", name: "Electra Port 2" }
  ];

  it("auto-selects the highest-scored port", () => {
    expect(pickPort(ports)?.id).toBe("b");
  });

  it("honours an exact-name override", () => {
    expect(pickPort(ports, "Electra Port 2")?.id).toBe("c");
  });

  it("returns null when the override is missing or nothing matches", () => {
    expect(pickPort(ports, "Nope")).toBeNull();
    expect(pickPort([{ id: "x", name: "Some Synth" }])).toBeNull();
  });
});
