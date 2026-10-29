import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRegularRunnerFile,
  atomicCopyRunnerFile,
  atomicPromoteRunnerFile,
  atomicWriteRunnerFile,
  ensurePrivateRunnerDirectory,
} from "../../../packages/runners/src/safe-path";

describe("runner filesystem publication boundary", () => {
  test("publishes an atomic private file and refuses symlink targets", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-runner-path-"));
    const directory = join(root, "job");
    ensurePrivateRunnerDirectory(directory);
    const target = join(directory, "intent.json");
    atomicWriteRunnerFile(target, '{"ok":true}\n');
    expect(readFileSync(target, "utf8")).toBe('{"ok":true}\n');

    const outside = join(root, "outside");
    atomicWriteRunnerFile(outside, "outside\n");
    const link = join(directory, "link");
    symlinkSync(outside, link);
    expect(() => assertRegularRunnerFile(link, "test target")).toThrow(/regular file/);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("refuses a symlinked runner directory", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-runner-path-link-"));
    const outside = join(root, "outside");
    ensurePrivateRunnerDirectory(outside);
    const link = join(root, "job");
    symlinkSync(outside, link);
    expect(() => ensurePrivateRunnerDirectory(link)).toThrow(/symlink|real directory/);
  });

  test("refuses a symlinked parent before recursive creation", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-runner-parent-link-"));
    const outside = join(root, "outside");
    ensurePrivateRunnerDirectory(outside);
    const parent = join(root, "parent");
    symlinkSync(outside, parent);

    expect(() => ensurePrivateRunnerDirectory(join(parent, "job"))).toThrow(/contains a symlink/);
  });

  test("copies and promotes through regular-file boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-runner-copy-"));
    const directory = join(root, "job");
    ensurePrivateRunnerDirectory(directory);
    const source = join(root, "source.dat");
    const copied = join(directory, "copied.dat");
    const promoted = join(directory, "promoted.dat");
    writeFileSync(source, "scientific bytes\n");
    atomicCopyRunnerFile(source, copied);
    expect(readFileSync(copied, "utf8")).toBe("scientific bytes\n");
    const temporary = join(directory, "temporary.dat");
    writeFileSync(temporary, "downloaded bytes\n");
    atomicPromoteRunnerFile(temporary, promoted);
    expect(readFileSync(promoted, "utf8")).toBe("downloaded bytes\n");
  });
});
