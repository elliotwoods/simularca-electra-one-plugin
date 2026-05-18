import { describe, expect, it } from "vitest";
import {
  asciiBytes,
  buildDeviceInfoRequest,
  buildExecuteLua,
  buildRequestLua,
  buildRequestPreset,
  buildSwitchPresetSlot,
  buildUploadLua,
  buildUploadPreset,
  bytesToHex,
  electraMessageKind,
  electraPayload,
  frameElectraSysex,
  hexToBytes,
  isElectraSysex,
  isMiniCompatible,
  parseAck,
  parseBundleVersion,
  parseDeviceInfoResponse,
  parseLog,
  parseLuaResponse,
  parsePresetResponse
} from "../src/electraSysex";

function jsonSysex(cmd: number[], obj: unknown): number[] {
  return frameElectraSysex([...cmd, ...asciiBytes(JSON.stringify(obj))]);
}

describe("framing + encoding", () => {
  it("wraps payload with F0 00 21 45 … F7", () => {
    expect(frameElectraSysex([0x01, 0x02])).toEqual([0xf0, 0x00, 0x21, 0x45, 0x01, 0x02, 0xf7]);
  });

  it("isElectraSysex recognises only Electra frames", () => {
    expect(isElectraSysex(frameElectraSysex([0x02]))).toBe(true);
    expect(isElectraSysex([0xf0, 0x7e, 0x00, 0x06, 0xf7])).toBe(false);
    expect(isElectraSysex([0xf0, 0x00, 0x21, 0x45])).toBe(false);
  });

  it("asciiBytes rejects non-7-bit input", () => {
    expect(asciiBytes("AZ09{}")).toEqual([65, 90, 48, 57, 123, 125]);
    expect(() => asciiBytes("café")).toThrow(/7-bit/);
  });

  it("electraMessageKind classifies by command bytes", () => {
    expect(electraMessageKind(buildDeviceInfoRequest())).toBe("REQUEST_DEVICE_INFO");
    expect(electraMessageKind(frameElectraSysex([0x7e, 0x01, 0, 0]))).toBe("ACK");
    expect(electraMessageKind(frameElectraSysex([0x7e, 0x00, 0, 0]))).toBe("NACK");
    expect(electraMessageKind([0x90, 0x40])).toBe("unknown");
  });
});

describe("command builders", () => {
  it("device-info request", () => {
    expect(buildDeviceInfoRequest()).toEqual([0xf0, 0x00, 0x21, 0x45, 0x02, 0x7f, 0xf7]);
  });

  it("set-preset-slot is 09 08, 7-bit masked, 0-based", () => {
    expect(buildSwitchPresetSlot(2, 3)).toEqual([0xf0, 0x00, 0x21, 0x45, 0x09, 0x08, 0x02, 0x03, 0xf7]);
    expect(buildSwitchPresetSlot(0x80, 0xff)).toEqual([
      0xf0, 0x00, 0x21, 0x45, 0x09, 0x08, 0x00, 0x7f, 0xf7
    ]);
  });

  it("upload/request command prefixes", () => {
    expect(buildUploadPreset("{}").slice(4, 6)).toEqual([0x01, 0x01]);
    expect(buildUploadLua("x=1").slice(4, 6)).toEqual([0x01, 0x0c]);
    expect(buildRequestPreset()).toEqual([0xf0, 0x00, 0x21, 0x45, 0x02, 0x01, 0xf7]);
    expect(buildRequestLua()).toEqual([0xf0, 0x00, 0x21, 0x45, 0x02, 0x0c, 0xf7]);
    expect(buildExecuteLua("ssp(1)").slice(4, 6)).toEqual([0x08, 0x0d]);
  });
});

describe("response parsers", () => {
  it("device info", () => {
    const msg = jsonSysex([0x01, 0x7f], {
      model: "Electra One mini",
      versionText: "v4.1.4",
      serial: "EOM1"
    });
    expect(parseDeviceInfoResponse(msg)).toEqual({
      manufacturerId: "00 21 45",
      model: "Electra One mini",
      firmware: "v4.1.4",
      serial: "EOM1"
    });
    expect(parseDeviceInfoResponse([0x90, 0x40])).toBeNull();
  });

  it("lua + preset + ack + log", () => {
    const lua = "local BUNDLE_VERSION = 7\nfunction f() end";
    expect(parseLuaResponse(frameElectraSysex([0x01, 0x0c, ...asciiBytes(lua)]))).toBe(lua);
    expect(parseLuaResponse(frameElectraSysex([0x02, 0x0c]))).toBeNull();

    const preset = jsonSysex([0x01, 0x01], { name: "Simularca Surface" });
    expect(parsePresetResponse(preset)).toMatchObject({ name: "Simularca Surface" });
    expect(parsePresetResponse(frameElectraSysex([0x01, 0x01]))).toBeNull(); // empty slot

    expect(parseAck(frameElectraSysex([0x7e, 0x01, 0, 0]))).toEqual({ ok: true });
    expect(parseAck(frameElectraSysex([0x7e, 0x00, 0, 0]))).toEqual({ ok: false });
    expect(parseAck(buildRequestLua())).toBeNull();

    expect(parseLog(frameElectraSysex([0x7f, 0x00, ...asciiBytes("simularca:ready")]))).toBe(
      "simularca:ready"
    );
  });

  it("parseBundleVersion", () => {
    expect(parseBundleVersion("local BUNDLE_VERSION = 12\n")).toBe(12);
    expect(parseBundleVersion("no version here")).toBeNull();
  });
});

describe("misc helpers", () => {
  it("isMiniCompatible", () => {
    expect(isMiniCompatible({ manufacturerId: "", model: "Electra One mini", firmware: "" })).toBe(true);
    expect(isMiniCompatible({ manufacturerId: "", model: "unknown", firmware: "" })).toBe(true);
    expect(isMiniCompatible({ manufacturerId: "", model: "Launchpad", firmware: "" })).toBe(false);
  });

  it("hex round-trip + validation", () => {
    expect(bytesToHex([0xf0, 0x00, 0x7f])).toBe("f0 00 7f");
    expect(hexToBytes("F0 00 21,45 0x7F")).toEqual([0xf0, 0x00, 0x21, 0x45, 0x7f]);
    expect(() => hexToBytes("F0 ZZ")).toThrow(/Invalid hex/);
  });

  it("electraPayload", () => {
    expect(electraPayload(frameElectraSysex([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(electraPayload([0x90])).toEqual([]);
  });
});
