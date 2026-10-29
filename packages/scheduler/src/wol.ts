// ────────────────────────────────────────────────────────────
// Wake-on-LAN Utilities (pure typed abstraction)
// ────────────────────────────────────────────────────────────
// No shell commands. Uses typed Node.js dgram for UDP send.

import { createSocket } from "dgram";

// ── MAC Address Validation ─────────────────────────────────

/**
 * Validates that a string is a well-formed MAC address.
 * Accepts: XX:XX:XX:XX:XX:XX, XX-XX-XX-XX-XX-XX, XXXXXXXXXXXX, XXXX.XXXX.XXXX
 * Does NOT accept mixed separators.
 */
export function isValidMacAddress(mac: string): boolean {
  if (typeof mac !== "string" || mac.length === 0) return false;
  // Colon-separated: XX:XX:XX:XX:XX:XX
  if (/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(mac)) return true;
  // Hyphen-separated: XX-XX-XX-XX-XX-XX
  if (/^([0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}$/.test(mac)) return true;
  // Plain hex: XXXXXXXXXXXX
  if (/^[0-9a-fA-F]{12}$/.test(mac)) return true;
  // Dot-separated (Cisco): XXXX.XXXX.XXXX
  if (/^([0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}$/.test(mac)) return true;
  return false;
}

// ── MAC Parsing ────────────────────────────────────────────

/**
 * Parse a MAC address string into a 6-byte buffer.
 * Supports colon, hyphen, dot, and plain hex formats.
 */
export function parseMacAddress(mac: string): Buffer {
  if (!isValidMacAddress(mac)) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }

  // Normalize: strip separators, keep hex digits
  const hex = mac.replace(/[^0-9a-fA-F]/g, "");
  return Buffer.from(hex, "hex");
}

// ── Magic Packet ───────────────────────────────────────────

/**
 * Create a WoL magic packet buffer (102 bytes).
 * Structure: 6 bytes of 0xFF followed by 16 repetitions of the MAC address.
 */
export function createMagicPacket(macAddress: string): Buffer {
  const macBuffer = parseMacAddress(macAddress);

  // 6 bytes of 0xFF prefix
  const prefix = Buffer.alloc(6, 0xff);

  // 16 repetitions of the MAC address
  const payload = Buffer.alloc(16 * 6);
  for (let i = 0; i < 16; i++) {
    macBuffer.copy(payload, i * 6, 0, 6);
  }

  return Buffer.concat([prefix, payload]);
}

// ── UDP Send ───────────────────────────────────────────────

/**
 * Send a WoL magic packet to a broadcast address via UDP.
 * Uses Node.js dgram (not arbitrary shell commands).
 *
 * @param macAddress  - Target MAC address (any common format)
 * @param broadcastAddress - Broadcast IP (e.g., "192.168.1.255")
 * @param port        - WoL port (default 9)
 */
export function sendWolPacket(
  macAddress: string,
  broadcastAddress: string,
  port: number = 9,
): Promise<void> {
  // Validate before entering promise to ensure type safety
  let packet: Buffer;
  try {
    packet = createMagicPacket(macAddress);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");

    const cleanup = () => {
      try {
        socket.close();
      } catch {
        // Socket already closed — ignore
      }
    };

    socket.on("error", (err) => {
      cleanup();
      reject(err);
    });

    // Some network stacks require the socket to be bound before sending broadcast
    socket.bind(0, () => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcastAddress, (err) => {
        cleanup();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}
