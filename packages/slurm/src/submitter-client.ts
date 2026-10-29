import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createConnection } from "node:net";
import { SUBMITTER_MAX_WIRE_BYTES } from "./submitter-capability";
import { hasControlCharacter } from "./script-builder";

/** A root-provisioned systemd socket is the server identity. Root owns every
 * parent; neither the Head nor a scientific UID may replace/symlink the endpoint.
 * The Python server additionally checks the client's Linux SO_PEERCRED.
 */
export function assertProtectedSubmitterSocket(path: string): void {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    hasControlCharacter(path) ||
    path.includes(" ")
  )
    throw new Error("Submitter endpoint must be a canonical absolute path");
  let current = path;
  for (;;) {
    const info = lstatSync(current);
    if (info.uid !== 0 || info.isSymbolicLink())
      throw new Error("Submitter endpoint and parents must be root-owned without symlinks");
    if (current === path) {
      if (!info.isSocket() || (info.mode & 0o777) !== 0o660)
        throw new Error("Submitter endpoint must be a protected mode-0660 Unix socket");
    } else if (!info.isDirectory() || (info.mode & 0o022) !== 0) {
      throw new Error("Submitter endpoint parents must not be group/other writable");
    }
    if (current === "/") break;
    current = dirname(current);
  }
}

/** No retries. An error after connection may mean a consumed external effect;
 * callers must observe/reconcile with the same operation, never mint a replacement.
 */
export function callSubmitter(socketPath: string, wireValue: Uint8Array): Promise<unknown> {
  assertProtectedSubmitterSocket(socketPath);
  const wire = Buffer.from(wireValue);
  if (wire.length === 0 || wire.length > SUBMITTER_MAX_WIRE_BYTES)
    throw new Error("Submitter request exceeds its bound");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(wire.length);
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let buffer = Buffer.alloc(0);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolveRequest(value);
    };
    const timer = setTimeout(
      () => finish(new Error("Submitter RPC indeterminate: deadline exceeded")),
      45_000,
    );
    socket.on("connect", () => socket.write(Buffer.concat([header, wire])));
    socket.on("error", () =>
      finish(new Error("Submitter RPC indeterminate: transport unavailable")),
    );
    socket.on("end", () => finish(new Error("Submitter RPC indeterminate: incomplete response")));
    socket.on("data", (chunk: Buffer) => {
      if (buffer.length + chunk.length > 64 * 1024 + 4)
        return finish(new Error("Submitter RPC indeterminate: oversized response"));
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE();
      if (length === 0 || length > 64 * 1024 || buffer.length > length + 4)
        return finish(new Error("Submitter RPC indeterminate: invalid response frame"));
      if (buffer.length === length + 4) {
        try {
          const text = buffer.subarray(4).toString("utf8");
          if (!Buffer.from(text).equals(buffer.subarray(4))) throw new Error("Invalid UTF-8");
          const value: unknown = JSON.parse(text);
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            (value as Record<string, unknown>).resubmitAllowed !== false
          )
            throw new Error("Invalid response contract");
          finish(undefined, value);
        } catch {
          finish(new Error("Submitter RPC indeterminate: invalid response"));
        }
      }
    });
  });
}
