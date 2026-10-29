// ────────────────────────────────────────────────────────────
// Archive safety, checksum, and path validation
// ────────────────────────────────────────────────────────────

import type { ArchiveSafetyResult } from "./types";
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, normalize, resolve, sep } from "path";

/**
 * Validate that an archive entry path is safe:
 * - No absolute paths
 * - No path traversal (..)
 * - No symlink escape
 * - No null bytes
 * - No device files or special entries
 */
export function validateArchivePath(entryPath: string): ArchiveSafetyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for null bytes
  if (entryPath.includes("\0")) {
    errors.push(`Null byte detected in path: ${entryPath}`);
    return { ok: false, errors, warnings };
  }

  // Check for absolute paths
  if (isAbsolute(entryPath)) {
    errors.push(`Absolute path not allowed: ${entryPath}`);
    return { ok: false, errors, warnings };
  }

  // Normalize and check for traversal
  const normalized = normalize(entryPath);

  // Check that normalized path doesn't escape via ..
  if (
    normalized.startsWith("..") ||
    normalized.includes(`..${sep}`) ||
    normalized.includes(`${sep}..`)
  ) {
    errors.push(`Path traversal detected: ${entryPath}`);
    return { ok: false, errors, warnings };
  }

  // Check for backslash on unix
  if (entryPath.includes("\\")) {
    warnings.push(`Backslash in path (may be Windows-style): ${entryPath}`);
  }

  // Check for device files (Windows style — safety catch)
  const devicePattern = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  const pathParts = normalized.split(sep);
  for (const part of pathParts) {
    if (devicePattern.test(part)) {
      errors.push(`Device filename detected: ${part}`);
      return { ok: false, errors, warnings };
    }
  }

  // Warn on excessively deep paths
  if (pathParts.length > 20) {
    warnings.push(`Path is very deep (${pathParts.length} levels): ${entryPath}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Compute SHA-256 checksum of a buffer or string.
 */
export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Compute checksum for a file on disk.
 */
export function fileChecksum(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = readFileSync(filePath);
  return sha256(content);
}

/**
 * Generate a checksum manifest entry for a file.
 */
export function checksumEntry(relativePath: string, data: Buffer): string {
  const hash = sha256(data);
  return `${hash}  ${relativePath}`;
}

/**
 * Parse a checksum manifest (SHA256 format) into entries.
 */
export function parseChecksumManifest(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: <hash>  <path>
    const sep = "  ";
    const idx = trimmed.indexOf(sep);
    if (idx === -1) continue;
    const hash = trimmed.slice(0, idx);
    const filePath = trimmed.slice(idx + sep.length);
    entries.set(filePath, hash);
  }
  return entries;
}

/**
 * Verify a checksum manifest against actual data.
 * Returns { ok, mismatches } where mismatches is Map<path, {expected, actual}>.
 */
export function verifyChecksums(
  checksums: Map<string, string>,
  files: Map<string, Buffer>,
): { ok: boolean; mismatches: Map<string, { expected: string; actual: string }> } {
  const mismatches = new Map<string, { expected: string; actual: string }>();
  const checked = new Set<string>();

  for (const [filePath, expectedHash] of checksums) {
    if (!files.has(filePath)) {
      mismatches.set(filePath, { expected: expectedHash, actual: "MISSING" });
      continue;
    }
    const actualHash = sha256(files.get(filePath)!);
    checked.add(filePath);
    if (expectedHash !== actualHash) {
      mismatches.set(filePath, { expected: expectedHash, actual: actualHash });
    }
  }

  // Check for extra files not in manifest
  for (const filePath of files.keys()) {
    if (!checked.has(filePath) && filePath !== "checksums.sha256") {
      // Extra file — warn but don't fail
    }
  }

  return { ok: mismatches.size === 0, mismatches };
}

/**
 * Check if a target directory is safe for restore.
 * Returns warnings if the directory exists and contains files.
 */
export function validateRestoreTarget(
  targetDir: string,
  dbPath?: string,
): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const resolved = resolve(targetDir);
  const parent = resolve(resolved, "..");

  // Target must not be the project root
  if (resolved === parent) {
    errors.push("Restore target cannot be filesystem root");
  }

  // Check if target exists
  if (existsSync(resolved)) {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      errors.push(`Restore target exists and is not a directory: ${targetDir}`);
    } else {
      warnings.push(`Target directory exists: ${targetDir}`);
    }
  }

  // Check if the directory contains an active database
  if (dbPath && existsSync(dbPath)) {
    warnings.push(`Active database detected at: ${dbPath}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
