import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as tar from "tar";
import {
  ARCHIVE_PREFLIGHT_LIMITS,
  ArchiveEntryPolicy,
  canonicalPath,
  preflightArchive,
  withPreflightedArchive,
} from "../../packages/backup/src/archive-preflight";

const tiny = {
  ...ARCHIVE_PREFLIGHT_LIMITS,
  maxCompressedBytes: 100,
  maxRegularFileBytes: 10,
  maxExpandedRegularFileBytes: 20,
  maxEntries: 2,
  maxExpansionRatio: 2,
  maxPathCharacters: 10,
  maxPathLevels: 2,
};
const entry = (path: string, type = "File", size = 1) => ({ path, type, size, meta: false });

describe("archive preflight policy", () => {
  it("rejects unsafe paths and aliases", () => {
    for (const path of [
      "",
      "\0",
      "/x",
      "C:/x",
      "\\\\host\\x",
      "x\\y",
      "x//y",
      "x//",
      "file/",
      "./x",
      "x/../y",
      "x/ ",
      "e\u0301",
      "one/two/three",
      "x".repeat(11),
      "CON",
      "aux.txt",
      "safe/LPT1.log",
    ])
      expect(() => canonicalPath(path, false, tiny)).toThrow();
    expect(() => canonicalPath("x//", true, tiny)).toThrow();
    expect(canonicalPath("One/Two", false, tiny)).toBe("one/two");
  });

  it("enforces types, metadata, collisions, parents, and resources", () => {
    for (const type of [
      "SymbolicLink",
      "Link",
      "CharacterDevice",
      "BlockDevice",
      "FIFO",
      "ContiguousFile",
      "SparseFile",
    ])
      expect(() => new ArchiveEntryPolicy(tiny).check(entry("link", type))).toThrow();
    expect(() =>
      new ArchiveEntryPolicy(tiny).check({ ...entry("x"), linkpath: "target" }),
    ).toThrow();
    expect(() => new ArchiveEntryPolicy(tiny).check(entry("dir", "Directory", 1))).toThrow();
    expect(() => new ArchiveEntryPolicy(tiny).check(entry("bad", "File", -1))).toThrow();
    expect(() => new ArchiveEntryPolicy(tiny).check(entry("bad", "File", 1.5))).toThrow();
    expect(() =>
      new ArchiveEntryPolicy(tiny).check(entry("bad", "File", Number.MAX_SAFE_INTEGER + 1)),
    ).toThrow();
    const valid = new ArchiveEntryPolicy(tiny);
    valid.check(entry("dir/", "Directory", 0));
    valid.check(entry("dir/old", "OldFile", 1));
    const duplicate = new ArchiveEntryPolicy(tiny);
    duplicate.check(entry("One"));
    expect(() => duplicate.check(entry("one"))).toThrow();
    const parent = new ArchiveEntryPolicy(tiny);
    parent.check(entry("file"));
    expect(() => parent.check(entry("file/kid"))).toThrow();
    const descendant = new ArchiveEntryPolicy(tiny);
    descendant.check(entry("dir/kid"));
    expect(() => descendant.check(entry("dir"))).toThrow();
    expect(() => new ArchiveEntryPolicy(tiny).check(entry("large", "File", 11))).toThrow();
    const expanded = new ArchiveEntryPolicy({
      ...tiny,
      maxRegularFileBytes: 30,
      maxExpandedRegularFileBytes: 15,
    });
    expect(() => expanded.check(entry("large", "File", 16))).toThrow();
    const count = new ArchiveEntryPolicy(tiny);
    count.check(entry("a"));
    count.check(entry("b"));
    expect(() => count.check(entry("c"))).toThrow();
    const metadata = new ArchiveEntryPolicy({ ...tiny, maxEntries: 1 });
    metadata.checkMetadata();
    expect(() => metadata.check(entry("a"))).toThrow();
    const ratio = new ArchiveEntryPolicy(tiny);
    ratio.check(entry("a", "File", 3));
    expect(() => ratio.checkRatio(1)).toThrow();
  });
});

describe("archive preflight integration", () => {
  it("rejects old-GNU sparse entries and PAX sparse metadata but permits PAX long paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-"));
    const header = (path: string, type: string, size = 0) => {
      const block = Buffer.alloc(512);
      block.write(path, 0);
      block.write("0000644\0", 100);
      block.write("0000000\0", 108);
      block.write("0000000\0", 116);
      block.write(size.toString(8).padStart(11, "0") + "\0", 124);
      block.write("00000000000\0", 136);
      block.fill(" ", 148, 156);
      block.write(type, 156);
      block.write("ustar\0", 257);
      block.write("00", 263);
      const sum = block.reduce((total, byte) => total + byte, 0);
      block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      return block;
    };
    const pax = (key: string, value: string) => {
      let record = `${key}=${value}\n`;
      while (true) {
        const next = `${Buffer.byteLength(record) + String(Buffer.byteLength(record)).length + 1} ${record}`;
        if (Buffer.byteLength(next) === Number(next.split(" ", 1)[0])) return next;
        record = next.slice(next.indexOf(" ") + 1);
      }
    };
    const archive = (name: string, blocks: Buffer[]) => {
      const file = join(root, name);
      writeFileSync(file, Buffer.concat([...blocks, Buffer.alloc(1024)]));
      return file;
    };
    try {
      await expect(
        preflightArchive(archive("old-sparse.tar", [header("sparse", "S")]), 512),
      ).rejects.toThrow("SparseFile");
      const sparse = pax("GNU.sparse.size", "1");
      await expect(
        preflightArchive(
          archive("pax-sparse.tar", [
            header("pax", "x", Buffer.byteLength(sparse)),
            Buffer.from(sparse),
            Buffer.alloc((512 - (Buffer.byteLength(sparse) % 512)) % 512),
            header("file", "0"),
          ]),
          1024,
        ),
      ).rejects.toThrow("Sparse archive metadata");
      const long = pax("path", "a".repeat(120));
      await expect(
        preflightArchive(
          archive("pax-long.tar", [
            header("pax", "x", Buffer.byteLength(long)),
            Buffer.from(long),
            Buffer.alloc((512 - (Buffer.byteLength(long) % 512)) % 512),
            header("file", "0"),
          ]),
          1024,
        ),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a real link and malformed archive before extraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-"));
    try {
      writeFileSync(join(root, "file"), "x");
      symlinkSync("file", join(root, "link"));
      const linkArchive = join(root, "link.tar.gz");
      await tar.create({ file: linkArchive, cwd: root, gzip: true }, ["link"]);
      writeFileSync(join(root, "after"), "later");
      const followed = join(root, "followed.tar.gz");
      await tar.create({ file: followed, cwd: root, gzip: true }, ["link", "after"]);
      const observed: string[] = [];
      await expect(
        preflightArchive(followed, 1000, ARCHIVE_PREFLIGHT_LIMITS, (path) => observed.push(path)),
      ).rejects.toThrow("link target");
      expect(observed).toEqual(["link"]);
      await expect(preflightArchive(linkArchive, 1000)).rejects.toThrow("link target");
      const bad = join(root, "bad.tar.gz");
      writeFileSync(bad, "truncated");
      await expect(preflightArchive(bad, 9)).rejects.toThrow();
      const long = "x".repeat(200);
      writeFileSync(join(root, long), "x");
      const pax = join(root, "pax.tar.gz");
      await tar.create({ file: pax, cwd: root, gzip: true }, [long]);
      await expect(
        preflightArchive(pax, 1000, { ...ARCHIVE_PREFLIGHT_LIMITS, maxEntries: 1 }),
      ).rejects.toThrow("too many");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a stable private copy and removes it after success and failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-"));
    try {
      const archive = join(root, "archive.tar.gz");
      writeFileSync(join(root, "file"), "one");
      await tar.create({ file: archive, cwd: root, gzip: true }, ["file"]);
      const original = readFileSync(archive);
      let copied = "";
      await withPreflightedArchive(archive, async (stable) => {
        copied = stable;
        writeFileSync(archive, "changed");
        expect(readFileSync(stable)).toEqual(original);
        expect(statSync(stable).mode & 0o777).toBe(0o600);
        expect(statSync(join(stable, "..")).mode & 0o777).toBe(0o700);
      });
      expect(existsSync(copied)).toBe(false);
      await expect(withPreflightedArchive(archive, async () => {})).rejects.toThrow();
      writeFileSync(join(root, "file"), "one");
      await tar.create({ file: archive, cwd: root, gzip: true }, ["file"]);
      await expect(
        withPreflightedArchive(archive, async () => {}, { ...tiny, maxCompressedBytes: 1 }),
      ).rejects.toThrow("compressed-size");
      const sourceLink = join(root, "source-link");
      symlinkSync(archive, sourceLink);
      await expect(withPreflightedArchive(sourceLink, async () => {})).rejects.toThrow(
        "regular file",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
