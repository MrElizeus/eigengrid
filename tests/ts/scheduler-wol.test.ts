import { describe, expect, test } from "bun:test";
import { isValidMacAddress, createMagicPacket, sendWolPacket } from "@eigengrid/scheduler/wol";

describe("WoL — MAC address validation", () => {
  test("accepts colon-separated MAC", () => {
    expect(isValidMacAddress("00:1A:2B:3C:4D:5E")).toBe(true);
  });

  test("accepts hyphen-separated MAC", () => {
    expect(isValidMacAddress("00-1A-2B-3C-4D-5E")).toBe(true);
  });

  test("accepts plain hex MAC without separators", () => {
    expect(isValidMacAddress("001A2B3C4D5E")).toBe(true);
  });

  test("accepts dot-separated MAC (Cisco style)", () => {
    expect(isValidMacAddress("001A.2B3C.4D5E")).toBe(true);
  });

  test("rejects invalid MAC — too short", () => {
    expect(isValidMacAddress("00:1A:2B:3C:4D")).toBe(false);
  });

  test("rejects invalid MAC — non-hex characters", () => {
    expect(isValidMacAddress("00:1A:2B:3C:4D:ZZ")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidMacAddress("")).toBe(false);
  });

  test("rejects null or undefined", () => {
    expect(isValidMacAddress(null as unknown as string)).toBe(false);
    expect(isValidMacAddress(undefined as unknown as string)).toBe(false);
  });

  test("rejects MAC with invalid separators", () => {
    expect(isValidMacAddress("00:1A-2B:3C-4D:5E")).toBe(false);
  });
});

describe("WoL — magic packet format", () => {
  test("creates 102-byte magic packet for valid MAC", () => {
    const mac = "00:1A:2B:3C:4D:5E";
    const packet = createMagicPacket(mac);
    expect(packet).toBeInstanceOf(Buffer);
    expect(packet.length).toBe(102);
  });

  test("magic packet starts with 6 bytes of 0xFF", () => {
    const mac = "AA:BB:CC:DD:EE:FF";
    const packet = createMagicPacket(mac);
    // First 6 bytes should all be 0xFF
    for (let i = 0; i < 6; i++) {
      expect(packet[i]).toBe(0xff);
    }
  });

  test("magic packet contains 16 copies of the MAC address", () => {
    const macBytes = [0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e];
    const packet = createMagicPacket("00:1A:2B:3C:4D:5E");

    // After the first 6 bytes (0xFF prefix), there should be 16 copies of MAC
    for (let copy = 0; copy < 16; copy++) {
      const offset = 6 + copy * 6;
      for (let byte = 0; byte < 6; byte++) {
        expect(packet[offset + byte]).toBe(macBytes[byte]);
      }
    }
  });

  test("accepts hyphen-separated MAC for magic packet", () => {
    const mac = "AA-BB-CC-DD-EE-FF";
    const packet = createMagicPacket(mac);
    expect(packet.length).toBe(102);
    // Verify AA is first MAC byte
    expect(packet[6]).toBe(0xaa);
  });

  test("throws on invalid MAC in createMagicPacket", () => {
    expect(() => createMagicPacket("")).toThrow("Invalid MAC address");
    expect(() => createMagicPacket("not-a-mac")).toThrow("Invalid MAC address");
  });
});

describe("WoL — sendWolPacket error handling (no actual network)", () => {
  test("sendWolPacket rejects for invalid MAC", async () => {
    await expect(sendWolPacket("", "192.168.1.255")).rejects.toThrow("Invalid MAC address");
  });

  test("sendWolPacket rejects for null MAC", async () => {
    await expect(sendWolPacket(null as unknown as string, "192.168.1.255")).rejects.toThrow(
      "Invalid MAC address",
    );
  });
});
