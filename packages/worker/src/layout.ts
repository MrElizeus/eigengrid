import { chmodSync, lstatSync, mkdirSync } from "fs";
import { join } from "path";

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Worker layout path is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(jobId)) {
    throw new Error(`Unsafe worker job identifier: ${jobId}`);
  }
}

// ────────────────────────────────────────────────────────────
// Worker Scratch Directory Layout
// ────────────────────────────────────────────────────────────
//
// <remoteScratchDir>/
//   inbox/      – head stages job bundles here
//   running/    – daemon moves claimed bundles here
//   done/       – completed bundles
//   failed/     – failed bundles
//   cancelled/  – cancelled bundles
//   locks/      – lock files for atomic operations
//   daemon/     – daemon metadata (pid, logs)

export function ensureWorkerLayout(scratchDir: string): void {
  ensurePrivateDirectory(scratchDir);
  for (const dir of [
    "inbox",
    "running",
    "done",
    "failed",
    "cancelled",
    "orphaned",
    "locks",
    "daemon",
  ]) {
    const p = join(scratchDir, dir);
    ensurePrivateDirectory(p);
  }
}

export function getInboxDir(scratchDir: string): string {
  return join(scratchDir, "inbox");
}

export function getRunningDir(scratchDir: string): string {
  return join(scratchDir, "running");
}

export function getDoneDir(scratchDir: string): string {
  return join(scratchDir, "done");
}

export function getFailedDir(scratchDir: string): string {
  return join(scratchDir, "failed");
}

export function getCancelledDir(scratchDir: string): string {
  return join(scratchDir, "cancelled");
}

export function getLocksDir(scratchDir: string): string {
  return join(scratchDir, "locks");
}

export function getDaemonDir(scratchDir: string): string {
  return join(scratchDir, "daemon");
}

export function getOrphanedDir(scratchDir: string): string {
  return join(scratchDir, "orphaned");
}

// ────────────────────────────────────────────────────────────
// Bundle Path Helpers
// ────────────────────────────────────────────────────────────

export function getInboxBundlePath(scratchDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  return join(getInboxDir(scratchDir), jobId);
}

export function getRunningBundlePath(scratchDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  return join(getRunningDir(scratchDir), jobId);
}

export function getDoneBundlePath(scratchDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  return join(getDoneDir(scratchDir), jobId);
}

export function getFailedBundlePath(scratchDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  return join(getFailedDir(scratchDir), jobId);
}

export function getCancelledBundlePath(scratchDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  return join(getCancelledDir(scratchDir), jobId);
}

export interface WorkerLayoutCheck {
  ok: boolean;
  missing: string[];
}

export function checkWorkerLayout(scratchDir: string): WorkerLayoutCheck {
  const required = [
    "inbox",
    "running",
    "done",
    "failed",
    "cancelled",
    "orphaned",
    "locks",
    "daemon",
  ];
  const missing: string[] = [];

  for (const dir of required) {
    try {
      const info = lstatSync(join(scratchDir, dir));
      if (!info.isDirectory() || info.isSymbolicLink()) missing.push(dir);
    } catch {
      missing.push(dir);
    }
  }

  return { ok: missing.length === 0, missing };
}
