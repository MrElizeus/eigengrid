import { expect, test } from "bun:test";
import { amberWorkerFailureDiagnostic, AmberWorkerPhaseError } from "./amber-worker-diagnostic";

test("worker diagnostics expose only closed phase/category and allowlisted errno", () => {
  for (const code of [
    "EAGAIN",
    "EWOULDBLOCK",
    "ESTALE",
    "EINTR",
    "EIO",
    "EACCES",
    "EPERM",
    "EROFS",
    "ENOENT",
    "ENOSPC",
    "EDQUOT",
    "EXDEV",
  ]) {
    const error = new AmberWorkerPhaseError(
      "stage_out",
      Object.assign(new Error("secret/path"), { code }),
    );
    expect(error.errno).toBe(code);
    expect(error.message).toBe("Amber worker phase failed");
  }
  const unknown = new AmberWorkerPhaseError(
    "stage_out",
    Object.assign(new Error("secret/path"), { code: "secret-code" }),
  );
  expect(unknown.errno).toBeUndefined();
  expect(JSON.stringify(unknown)).not.toContain("secret");
  expect(amberWorkerFailureDiagnostic(unknown)).toEqual({
    event: "amber_worker_failed",
    phase: "stage_out",
    category: "other",
    resubmitAllowed: false,
  });
  expect(JSON.stringify(amberWorkerFailureDiagnostic(unknown))).not.toContain("secret");
  expect(amberWorkerFailureDiagnostic(new Error("/secret/path"))).toEqual({
    event: "amber_worker_failed",
    resubmitAllowed: false,
  });
});
