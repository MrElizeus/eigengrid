import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAmberByteInspection,
  bindAmberTrajectoryInspection,
} from "../src/amber-byte-inspection";

function decode(kind: string, path: string) {
  const p = Bun.spawnSync({
    cmd: ["python", "-m", "eigengrid_chem", "amber-inspect", kind, path, "--json"],
    env: { ...process.env, PYTHONPATH: `${process.cwd()}/python/src` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = new TextDecoder().decode(p.stdout);
  expect(text.trim().startsWith("{")).toBe(true);
  return JSON.parse(text);
}
const root = "tests/fixtures/amber";
describe("engine adapter independent byte decoder with retained real Amber26 files", () => {
  test("ASCII and NetCDF restart formats are detected from bytes rather than extension", () => {
    const d = mkdtempSync(join(tmpdir(), "adapter-amber-bytes-"));
    try {
      const file = join(d, "ascii.rst7");
      writeFileSync(file, readFileSync(`${root}/md.rst7`));
      const actual = assertAmberByteInspection(decode("restart", file));
      expect(actual.format).toBe("amber_netcdf");
      expect(actual.readStatus).toBe("complete");
      expect(actual.time.firstPs).toBe(0.005);
      writeFileSync(file, readFileSync(`${root}/water.inpcrd`));
      const ascii = assertAmberByteInspection(decode("restart", file));
      expect(ascii.format).toBe("amber_ascii_restart");
      expect(ascii.time.status).toBe("missing"); // not a production restart timestamp
      for (const patch of [
        { finiteValues: false },
        { format: "amber_prmtop" },
        { dimensions: { atom: 4, spatial: 3 } },
        {
          hasPeriodicBox: true,
          cell: { status: "partial", frameCount: 1, variableAcrossFrames: null },
        },
      ]) {
        expect(() => assertAmberByteInspection({ ...actual, ...patch })).toThrow();
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("truncating retained NetCDF bytes does not produce complete trajectory evidence", () => {
    const d = mkdtempSync(join(tmpdir(), "adapter-amber-netcdf-"));
    try {
      const bytes = readFileSync(`${root}/md.nc`),
        file = join(d, "damaged.nc");
      for (const size of [16, Math.floor(bytes.length / 2), bytes.length - 12]) {
        writeFileSync(file, bytes.subarray(0, size));
        const observed = decode("trajectory", file);
        expect(
          observed.readStatus === "complete" &&
            observed.finiteValues === true &&
            observed.diagnostics.every(
              (x: { severity: string }) => !["error", "fatal"].includes(x.severity),
            ),
        ).toBe(false);
      }
      const actual = decode("trajectory", `${root}/md.nc`);
      expect(actual.observedContentDigest).toBe(
        "10e8c3e6c0edc193456dff3e7317e8ec09cb042f53a6c679d0df22be9d25e29f",
      );
      expect(actual.frameCount).toBe(5);
      const mismatch = bindAmberTrajectoryInspection(actual, {
        artifactId: "test",
        evidenceRef: "test",
        expectedContentDigest: "f".repeat(64),
        operationReceiptRef: "test",
      });
      expect(mismatch.observedContentDigest).not.toBe(mismatch.expectedContentDigest);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
