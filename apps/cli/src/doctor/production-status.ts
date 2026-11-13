import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";

interface Inspection {
  stat: typeof statSync;
  service: () => { status: number | null; stdout: string; error?: unknown };
}

/** Presence and service state are diagnostics, not execution qualification.
 * Only metadata is inspected; configuration bytes and command output stay private.
 */
export function productionStatus(deps: Partial<Inspection> = {}) {
  const stat = deps.stat ?? statSync;
  const paths = ["mission-client", "md-authority", "md-postprocessing", "dispatch"];
  const configurations = paths.map((name) => {
    const path = `/etc/eigengrid/${name}.json`;
    try {
      return { path, status: stat(path).isFile() ? "present" : "invalid-type" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        path,
        status:
          code === "ENOENT"
            ? "absent"
            : code === "EACCES" || code === "EPERM"
              ? "inaccessible"
              : "unavailable",
      };
    }
  });
  const result = (
    deps.service ??
    (() =>
      spawnSync(
        "systemctl",
        [
          "show",
          "eigengrid-head.service",
          "-p",
          "ActiveState",
          "-p",
          "SubState",
          "-p",
          "ExecStart",
        ],
        { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
      ))
  )();
  const observable = result.status === 0 && !result.error;
  const active = observable && /^ActiveState=active$/mu.test(result.stdout);
  const standby = observable && result.stdout.includes("--dispatch-disabled");
  return {
    serviceObservable: observable,
    serviceActive: active,
    standby,
    configurations,
    readiness:
      standby ||
      (observable && !active) ||
      configurations.some((entry) => ["absent", "invalid-type"].includes(entry.status))
        ? false
        : null,
    readinessReason: standby
      ? "Scientific dispatch is disabled"
      : "Run the protected Head health check as its service identity to verify execution readiness",
    missing: configurations.filter((entry) => entry.status === "absent").map((entry) => entry.path),
    uninspectable: configurations
      .filter((entry) => ["inaccessible", "unavailable", "invalid-type"].includes(entry.status))
      .map((entry) => entry.path),
  };
}
