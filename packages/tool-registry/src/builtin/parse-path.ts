import { realpathSync, statSync } from "fs";
import { resolve, sep } from "path";

export type ParsePathResult = { ok: true; path: string } | { ok: false; message: string };

function isInsideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * Restrict parser input to an existing regular file under one of the local
 * artifact roots. Both the file and roots are canonicalized so symlink escapes
 * cannot cross the boundary.
 */
export function resolveParsePath(
  candidate: string,
  roots: Array<string | undefined>,
): ParsePathResult {
  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.includes("\r") ||
    candidate.includes("\n")
  ) {
    return { ok: false, message: "Output path is empty or contains an invalid control character" };
  }

  if (candidate.split(/[\\/]+/).includes("..")) {
    return { ok: false, message: "Output path must not contain traversal segments" };
  }

  try {
    const canonicalCandidate = realpathSync(resolve(candidate));
    if (!statSync(canonicalCandidate).isFile()) {
      return { ok: false, message: "Output path must be a regular file" };
    }

    const canonicalRoots = roots.flatMap((root) => {
      if (typeof root !== "string" || root.length === 0) return [];
      try {
        return [realpathSync(resolve(root))];
      } catch {
        return [];
      }
    });
    if (!canonicalRoots.some((root) => isInsideRoot(canonicalCandidate, root))) {
      return { ok: false, message: "Output path is outside configured artifact roots" };
    }

    return { ok: true, path: canonicalCandidate };
  } catch {
    return { ok: false, message: "Output path does not exist or cannot be resolved" };
  }
}
