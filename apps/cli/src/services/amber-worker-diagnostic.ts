/** Closed operational labels. Never include error messages, filesystem paths or
 * environment details in worker stdout/stderr. A phase/category is observation,
 * not evidence that an effect did or did not happen or permission to resubmit. */
export class AmberWorkerPhaseError extends Error {
  readonly category: "access_denied" | "other";
  readonly errno?: string;
  constructor(
    readonly phase: "result_preflight" | "stage_out",
    cause: unknown,
  ) {
    super("Amber worker phase failed");
    this.name = "AmberWorkerPhaseError";
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    this.category = code === "EACCES" || code === "EPERM" ? "access_denied" : "other";
    const allowed = new Set([
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
    ]);
    if (typeof code === "string" && allowed.has(code)) this.errno = code;
  }
}

/** Safe stderr payload; never serialize the original exception or stack. */
export function amberWorkerFailureDiagnostic(error: unknown) {
  return error instanceof AmberWorkerPhaseError
    ? {
        event: "amber_worker_failed" as const,
        phase: error.phase,
        category: error.category,
        ...(error.errno ? { errno: error.errno } : {}),
        resubmitAllowed: false as const,
      }
    : { event: "amber_worker_failed" as const, resubmitAllowed: false as const };
}
