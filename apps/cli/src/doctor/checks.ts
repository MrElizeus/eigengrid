import type { EigenGridRole } from "@eigengrid/core";

export type CheckStatus = "ok" | "warn" | "error" | "optional" | "missing";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
  role?: EigenGridRole | "all";
}

export type CheckFunction = () => Promise<DoctorCheck> | DoctorCheck;

export interface DoctorRegistry {
  /** Register a check with an optional role filter. Default role is "all". */
  register(name: string, check: CheckFunction, role?: EigenGridRole | "all"): void;
  /** Run all registered checks. If a role is given, filters by that role. */
  runAll(role?: EigenGridRole): Promise<DoctorCheck[]>;
  /** Run only checks matching the given role (including "all" checks). */
  runForRole(role: EigenGridRole): Promise<DoctorCheck[]>;
}

/**
 * Create a new doctor check registry.
 *
 * Checks are stored in registration order. Each check's optional `role` field
 * determines which role(s) it applies to:
 *   - `"all"` (default): included for every role
 *   - `"standalone"`, `"head"`, `"worker"`: included only when running for that role
 */
export function createDoctorRegistry(): DoctorRegistry {
  const checks: Array<{
    name: string;
    check: CheckFunction;
    role: EigenGridRole | "all";
  }> = [];

  return {
    register(name, check, role = "all") {
      checks.push({ name, check, role });
    },

    async runAll(role?: EigenGridRole) {
      if (role) {
        return this.runForRole(role);
      }

      const results: DoctorCheck[] = [];
      for (const entry of checks) {
        try {
          const result = await entry.check();
          results.push(result);
        } catch (err) {
          results.push({
            name: entry.name,
            status: "error",
            detail: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
      return results;
    },

    async runForRole(role: EigenGridRole) {
      const results: DoctorCheck[] = [];
      for (const entry of checks) {
        if (entry.role !== "all" && entry.role !== role) continue;
        try {
          const result = await entry.check();
          results.push(result);
        } catch (err) {
          results.push({
            name: entry.name,
            status: "error",
            detail: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
      return results;
    },
  };
}
