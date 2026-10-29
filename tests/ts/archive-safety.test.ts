import { describe, expect, it } from "bun:test";
import {
  validateArchivePath,
  sha256,
  checksumEntry,
  parseChecksumManifest,
  verifyChecksums,
  validateRestoreTarget,
} from "@eigengrid/backup";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("archive safety", () => {
  describe("validateArchivePath", () => {
    it("allows normal relative paths", () => {
      const result = validateArchivePath("manifest.json");
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("allows nested paths", () => {
      const result = validateArchivePath("artifacts/job123/file.txt");
      expect(result.ok).toBe(true);
    });

    it("rejects absolute paths", () => {
      const result = validateArchivePath("/etc/passwd");
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("Absolute path");
    });

    it("rejects path traversal", () => {
      const result = validateArchivePath("../../etc/passwd");
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("Path traversal");
    });

    it("rejects deep path traversal", () => {
      const result = validateArchivePath("artifacts/../../../etc/passwd");
      expect(result.ok).toBe(false);
    });

    it("rejects null bytes", () => {
      const result = validateArchivePath("file\0.txt");
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("Null byte");
    });

    it("rejects Windows device filenames", () => {
      const result = validateArchivePath("CON.txt");
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("Device filename");
    });

    it("warns on backslash paths", () => {
      const result = validateArchivePath("dir\\file.txt");
      expect(result.ok).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("sha256", () => {
    it("computes SHA-256 hash correctly", () => {
      const hash = sha256("hello");
      expect(hash).toHaveLength(64);
      // Known SHA-256 of "hello"
      expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });

    it("produces different hashes for different inputs", () => {
      const hash1 = sha256("foo");
      const hash2 = sha256("bar");
      expect(hash1).not.toBe(hash2);
    });

    it("handles buffer input", () => {
      const hash = sha256(Buffer.from("test"));
      expect(hash).toHaveLength(64);
    });
  });

  describe("checksumEntry", () => {
    it("produces correct format", () => {
      const entry = checksumEntry("manifest.json", Buffer.from("test"));
      expect(entry).toMatch(/^[a-f0-9]{64}  manifest.json$/);
    });
  });

  describe("parseChecksumManifest", () => {
    it("parses SHA256 manifest format", () => {
      const content = ["abc123  file1.txt", "def456  path/to/file2.txt"].join("\n");
      const entries = parseChecksumManifest(content);
      expect(entries.get("file1.txt")).toBe("abc123");
      expect(entries.get("path/to/file2.txt")).toBe("def456");
      expect(entries.size).toBe(2);
    });

    it("handles empty content", () => {
      const entries = parseChecksumManifest("");
      expect(entries.size).toBe(0);
    });

    it("skips empty lines", () => {
      const content = "abc123  file1.txt\n\ndef456  file2.txt\n";
      const entries = parseChecksumManifest(content);
      expect(entries.size).toBe(2);
    });
  });

  describe("verifyChecksums", () => {
    it("passes when all checksums match", () => {
      const content = Buffer.from("test content");
      const hash = sha256(content);
      const checksums = new Map([["file.txt", hash]]);
      const files = new Map([["file.txt", content]]);

      const result = verifyChecksums(checksums, files);
      expect(result.ok).toBe(true);
      expect(result.mismatches.size).toBe(0);
    });

    it("detects checksum mismatch", () => {
      const checksums = new Map([["file.txt", "abc123"]]);
      const files = new Map([["file.txt", Buffer.from("different content")]]);

      const result = verifyChecksums(checksums, files);
      expect(result.ok).toBe(false);
      expect(result.mismatches.size).toBe(1);
      expect(result.mismatches.get("file.txt")?.expected).toBe("abc123");
    });

    it("detects missing files", () => {
      const checksums = new Map([["missing.txt", "abc123"]]);
      const files = new Map<string, Buffer>();

      const result = verifyChecksums(checksums, files);
      expect(result.ok).toBe(false);
      expect(result.mismatches.get("missing.txt")?.actual).toBe("MISSING");
    });
  });

  describe("validateRestoreTarget", () => {
    it("rejects filesystem root", () => {
      const result = validateRestoreTarget("/");
      expect(result.ok).toBe(false);
    });

    it("allows safe directory", () => {
      const dir = mkdtempSync(join(tmpdir(), "restore-test-"));
      const result = validateRestoreTarget(dir);
      expect(result.ok).toBe(true);
    });

    it("warns when target exists", () => {
      const dir = mkdtempSync(join(tmpdir(), "restore-existing-"));
      mkdirSync(dir, { recursive: true });
      const result = validateRestoreTarget(dir);
      expect(result.ok).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("warns when active db exists", () => {
      const dir = mkdtempSync(join(tmpdir(), "restore-db-test-"));
      const dbPath = join(dir, "active.sqlite");
      writeFileSync(dbPath, "fake db content");
      const result = validateRestoreTarget(dir, dbPath);
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => w.includes("Active database"))).toBe(true);
    });
  });
});
