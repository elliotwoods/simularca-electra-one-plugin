import { describe, expect, it } from "vitest";
import {
  buildDeviceInfoRequest,
  buildSwitchPresetSlot,
  bytesToHex,
  electraPayload,
  frameElectraSysex,
  hexToBytes,
  isElectraSysex,
  isMiniCompatible,
  parseDeviceInfoResponse
} from "../src/electraSysex";

function jsonSysex(obj: unknown, leadBytes: number[] = []): number[] {
  const text = JSON.stringify(obj);
  const body = [...leadBytes, ...Array.from(text, (c) => c.charCodeAt(0))];
  return frameElectraSysex(body);
}

describe("framing", () => {
  it("wraps payload with F0 00 21 45 … F7", () => {
    expect(frameElectraSysex([0x01, 0x02])).toEqual([0xf0, 0x00, 0x21, 0x45, 0x01, 0x02, 0xf7]);
  });

  it("isElectraSysex recognises only Electra frames", () => {
    expect(isElectraSysex(frameElectraSysex([0x02]))).toBe(true);
    expect(isElectraSysex([0xf0, 0x7e, 0x00, 0x06, 0x01, 0xf7])).toBe(false); // generic IDR
    expect(isElectraSysex([0x90, 0x40, 0x7f])).toBe(false); // note-on
    expect(isElectraSysex([0xf0, 0x00, 0x21, 0x45])).toBe(false); // unterminated
  });

  it("electraPayload returns the inner bytes", () => {
    expect(electraPayload(frameElectraSysex([0x14, 0x08, 0x01]))).toEqual([0x14, 0x08, 0x01]);
    expect(electraPayload([0x90, 0x40])).toEqual([]);
  });
});

describe("command builders", () => {
  it("device-info request bytes", () => {
    expect(buildDeviceInfoRequest()).toEqual([0xf0, 0x00, 0x21, 0x45, 0x02, 0x7f, 0xf7]);
  });

  it("set-preset-slot bytes, masked to 7-bit", () => {
    expect(buildSwitchPresetSlot(2, 3)).toEqual([0xf0, 0x00, 0x21, 0x45, 0x14, 0x08, 0x02, 0x03, 0xf7]);
    expect(buildSwitchPresetSlot(0x80, 0xff)).toEqual([
      0xf0, 0x00, 0x21, 0x45, 0x14, 0x08, 0x00, 0x7f, 0xf7
    ]);
  });
});

describe("device-info parsing", () => {
  it("parses model/firmware/serial from a JSON reply", () => {
    const msg = jsonSysex({ hwId: "electra-one-mini", versionText: "4.1.2", serial: "EOM123" });
    expect(parseDeviceInfoResponse(msg)).toEqual({
      manufacturerId: "00 21 45",
      model: "electra-one-mini",
      firmware: "4.1.2",
      serial: "EOM123"
    });
  });

  it("tolerates command bytes before the JSON object", () => {
    const msg = jsonSysex({ model: "Electra One", firmware: "3.5" }, [0x7f, 0x01]);
    const info = parseDeviceInfoResponse(msg);
    expect(info?.model).toBe("Electra One");
    expect(info?.firmware).toBe("3.5");
  });

  it("returns null for non-Electra / no JSON / bad JSON", () => {
    expect(parseDeviceInfoResponse([0x90, 0x40, 0x7f])).toBeNull();
    expect(parseDeviceInfoResponse(frameElectraSysex([0x02, 0x7f]))).toBeNull();
    expect(parseDeviceInfoResponse(frameElectraSysex(Array.from("{nope", (c) => c.charCodeAt(0))))).toBeNull();
  });
});

describe("model gate + hex helpers", () => {
  it("isMiniCompatible", () => {
    expect(isMiniCompatible({ manufacturerId: "", model: "Electra One Mini", firmware: "" })).toBe(true);
    expect(isMiniCompatible({ manufacturerId: "", model: "unknown", firmware: "" })).toBe(true);
    expect(isMiniCompatible({ manufacturerId: "", model: "Launchpad", firmware: "" })).toBe(false);
  });

  it("bytesToHex / hexToBytes round-trip and validation", () => {
    expect(bytesToHex([0xf0, 0x00, 0x7f])).toBe("f0 00 7f");
    expect(hexToBytes("F0 00 21,45 0x7F")).toEqual([0xf0, 0x00, 0x21, 0x45, 0x7f]);
    expect(hexToBytes(bytesToHex([1, 2, 3, 250]))).toEqual([1, 2, 3, 250]);
    expect(() => hexToBytes("F0 ZZ")).toThrow(/Invalid hex/);
  });
});
