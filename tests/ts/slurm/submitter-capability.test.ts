import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { resolve } from "node:path";
import {
  signSubmitterCapability,
  signSubmitterAccountingCapability,
  SUBMITTER_ACCOUNTING_SIGNATURE_DOMAIN,
  SubmitterCapabilitySchema,
  AnySubmitterCapabilitySchema,
  SUBMITTER_SIGNATURE_DOMAIN,
  SUBMITTER_MAX_BODY_BYTES,
  assertProtectedSubmitterSocket,
} from "@eigengrid/slurm";

const now = 1_789_885_000_000;
const key = generateKeyPairSync("ed25519");
const privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyHex = (key.publicKey.export({ type: "spki", format: "der" }) as Buffer)
  .subarray(12)
  .toString("hex");
const input = {
  action: "submit" as const,
  requestId: "rpc-1",
  subject: "human-1",
  projectId: "project-1",
  uid: 2101,
  gid: 2101,
  recoveryEpoch: "site-epoch-1",
  membershipGeneration: 3,
  siteProfileDigest: "a".repeat(64),
  operationId: "operation-1",
  requestDigest: "b".repeat(64),
  admissionDigest: "c".repeat(64),
  bindingDigest: "d".repeat(64),
  fencingGeneration: 17,
  notBeforeMs: now - 1000,
  expiresAtMs: now + 30_000,
};
const body = Buffer.from('{"kind":"test-only-counted-effect"}');

describe("Head-signed per-UID submitter capability", () => {
  test("V2 accounting preserves claim identity across Python and rejects domain/action downgrade", async () => {
    const signed = signSubmitterAccountingCapability(
      { ...input, action: "accounting" },
      body,
      privateKey,
    );
    expect(signed.capability.version).toBe("eigengrid.submitter-capability/v2");
    expect(() => SubmitterCapabilitySchema.parse(signed.capability)).toThrow();
    for (const changed of [
      { version: "eigengrid.submitter-capability/v1" },
      { action: "submit" },
      { action: "observe" },
      { action: "cancel" },
    ])
      expect(() =>
        AnySubmitterCapabilitySchema.parse({ ...signed.capability, ...changed }),
      ).toThrow();
    const envelope = JSON.parse(Buffer.from(signed.wire).toString());
    const payload = Buffer.from(envelope.payload, "base64");
    const signature = Buffer.from(envelope.signature, "base64");
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from(SUBMITTER_ACCOUNTING_SIGNATURE_DOMAIN), payload]),
        key.publicKey,
        signature,
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from(SUBMITTER_SIGNATURE_DOMAIN), payload]),
        key.publicKey,
        signature,
      ),
    ).toBe(false);
    const v1 = signSubmitterCapability(input, body, privateKey);
    const script = [
      "import sys,json,base64",
      `sys.path.insert(0, ${JSON.stringify(resolve("python/src"))})`,
      "from eigengrid_submitter.authority import SubmitterPolicy,authenticate_request",
      `policy=SubmitterPolicy(uid=2101,gid=2101,head_uid=997,recovery_epoch='site-epoch-1',site_profile_digest='a'*64,public_key_hex='${publicKeyHex}',memberships={('human-1','project-1'):3})`,
      `requests=[authenticate_request(base64.b64decode(v),policy,${now}) for v in json.load(sys.stdin)]`,
      "assert requests[0].identity==requests[1].identity",
      "print(requests[1].capability['action'])",
    ].join("\n");
    const child = Bun.spawn(["python3", "-I", "-c", script], {
      stdin: Buffer.from(
        JSON.stringify(
          [v1.wire, signed.wire].map((value) => Buffer.from(value).toString("base64")),
        ),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stdout, stderr, code }).toEqual({ stdout: "accounting\n", stderr: "", code: 0 });
  });
  test("Ed25519 signature binds domain and exact body bytes in canonical field order", () => {
    const first = signSubmitterCapability(input, body, privateKey);
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as typeof input;
    expect(signSubmitterCapability(reordered, body, privateKey)).toEqual(first);
    const envelope = JSON.parse(Buffer.from(first.wire).toString());
    const payload = Buffer.from(envelope.payload, "base64");
    expect(JSON.parse(payload.toString())).toEqual(first.capability);
    expect(first.capability.bodyDigest).toBe(createHash("sha256").update(body).digest("hex"));
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from(SUBMITTER_SIGNATURE_DOMAIN), payload]),
        key.publicKey,
        Buffer.from(envelope.signature, "base64"),
      ),
    ).toBe(true);
    expect(verify(null, payload, key.publicKey, Buffer.from(envelope.signature, "base64"))).toBe(
      false,
    );
    expect(Buffer.from(envelope.body, "base64")).toEqual(body);
  });

  test("Python/OpenSSL receiver verifies an actual TypeScript-signed wire request", async () => {
    const { wire } = signSubmitterCapability(input, body, privateKey);
    const script = [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(resolve("python/src"))})`,
      "from eigengrid_submitter.authority import SubmitterPolicy, authenticate_request, compact_json",
      `policy=SubmitterPolicy(uid=2101,gid=2101,head_uid=997,recovery_epoch='site-epoch-1',site_profile_digest='a'*64,public_key_hex='${publicKeyHex}',memberships={('human-1','project-1'):3})`,
      `request=authenticate_request(sys.stdin.buffer.read(),policy,${now})`,
      "sys.stdout.buffer.write(compact_json(request.identity))",
    ].join("\n");
    const process = Bun.spawn(["python3", "-I", "-c", script], {
      stdin: wire,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      operationId: "operation-1",
      uid: 2101,
      fencingGeneration: 17,
    });
  });

  test("rejects widened authority, unsupported actions, shell-like IDs and long lifetimes", () => {
    for (const changed of [
      { uid: 0 },
      { uid: 4_294_967_295 },
      { gid: 0 },
      { uid: 2.5 },
      { uid: "2101" },
      { action: "shell" },
      { action: "cancel" },
      { projectId: "../other" },
      { operationId: "x\ny" },
      { requestId: "é" },
      { admissionDigest: "z".repeat(64) },
      { siteProfileDigest: "A".repeat(64) },
      { expiresAtMs: now + 60_000 },
      { expiresAtMs: input.notBeforeMs },
      { notBeforeMs: NaN },
      { fencingGeneration: 0 },
      { membershipGeneration: 0 },
      { command: "id" },
    ])
      expect(() =>
        signSubmitterCapability({ ...input, ...changed } as typeof input, body, privateKey),
      ).toThrow();
    for (const bytes of [new Uint8Array(), new Uint8Array(SUBMITTER_MAX_BODY_BYTES + 1)])
      expect(() => signSubmitterCapability(input, bytes, privateKey)).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    expect(() => signSubmitterCapability(input, body, rsa)).toThrow("Ed25519");
  });

  test("client rejects caller-owned, relative, normalized or substituted socket paths", () => {
    for (const path of [
      "./submitter.sock",
      "/tmp/../run/submitter.sock",
      "/tmp/x\n",
      "/etc/passwd",
      "/dev/null",
    ])
      expect(() => assertProtectedSubmitterSocket(path)).toThrow();
  });
});
