import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  STATIC_SYSTEMD_SECURITY_EXPECTATIONS,
  type StaticSystemdSecurityExpectation,
} from "./profiles";

export interface ParsedSystemdUnit {
  sections: Record<string, Record<string, string[]>>;
}

export type StaticSecurityFindingSeverity = "error" | "warning";

export interface StaticSecurityFinding {
  id: string;
  severity: StaticSecurityFindingSeverity;
  message: string;
}

export interface StaticSystemdSecurityReport {
  schema: "eigengrid.static-systemd-security-report.v1";
  expectationId: StaticSystemdSecurityExpectation["id"];
  unitPath: string;
  verdict: "STATIC_PASS" | "BLOCKED_IMPLEMENTATION";
  productionEligible: false;
  checks: number;
  findings: StaticSecurityFinding[];
  externalBlockers: string[];
}

export interface RepositoryStaticSecurityReport {
  schema: "eigengrid.repository-static-security-report.v1";
  verdict: "STATIC_PASS" | "BLOCKED_IMPLEMENTATION";
  productionEligible: false;
  reports: StaticSystemdSecurityReport[];
  externalBlockers: string[];
}

export const EG031_EXTERNAL_SECURITY_BLOCKERS = Object.freeze([
  "ubuntu-24.04-apparmor-enforce-and-denial-evidence",
  "cgroup-v2-exhaustion-and-process-tree-evidence",
  "network-namespace-firewall-egress-escape-evidence",
  "real-secret-store-credential-rotation-and-revocation",
  "rootless-container-namespace-and-device-escape-evidence",
  "protected-slurm-site-cgroup-gres-and-egress-attestation",
] as const);

function logicalLines(source: string): string[] {
  const result: string[] = [];
  let pending = "";
  const rawLines = source.replace(/\r\n?/gu, "\n").split("\n");
  for (const [lineIndex, raw] of rawLines.entries()) {
    if (pending && lineIndex === rawLines.length - 1 && raw === "") {
      throw new TypeError("Systemd unit has an unterminated continuation");
    }
    const line = pending ? `${pending}${raw.trimStart()}` : raw;
    let trailing = 0;
    for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) {
      trailing += 1;
    }
    if (trailing % 2 === 1) {
      pending = `${line.slice(0, -1)} `;
      continue;
    }
    result.push(line);
    pending = "";
  }
  if (pending) throw new TypeError("Systemd unit has an unterminated continuation");
  return result;
}

/** Strict-enough parser for security-relevant systemd unit assignments. */
export function parseSystemdUnit(source: string): ParsedSystemdUnit {
  const sections: ParsedSystemdUnit["sections"] = {};
  let section: string | undefined;
  for (const [index, raw] of logicalLines(source).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9]*)\]$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      sections[section] ??= {};
      continue;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/u.exec(line);
    if (!section || !assignment) {
      throw new TypeError(`Invalid systemd unit syntax at line ${index + 1}`);
    }
    const [, key, value] = assignment;
    sections[section]![key!] ??= [];
    sections[section]![key!]!.push(value!.trim());
  }
  if (!sections.Service) throw new TypeError("Systemd unit has no [Service] section");
  return { sections };
}

function values(unit: ParsedSystemdUnit, key: string): string[] {
  return unit.sections.Service?.[key] ?? [];
}

function last(unit: ParsedSystemdUnit, key: string): string | undefined {
  return values(unit, key).at(-1);
}

function words(value: string): string[] {
  return (
    value
      .match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/gu)
      ?.map((word) => word.replace(/^['"]|['"]$/gu, "")) ?? []
  );
}

function credentialName(value: string): string {
  return value.split(":", 1)[0] ?? "";
}

function finiteLimit(value: string | undefined): boolean {
  return !!value && !/^(?:infinity|max)$/iu.test(value) && /^[1-9][0-9]*(?:[KMGTP]?)$/u.test(value);
}

function addCheck(
  findings: StaticSecurityFinding[],
  condition: boolean,
  id: string,
  message: string,
  severity: StaticSecurityFindingSeverity = "error",
): void {
  if (!condition) findings.push({ id, severity, message });
}

export function evaluateSystemdSecurity(
  source: string,
  expectation: StaticSystemdSecurityExpectation,
): StaticSystemdSecurityReport {
  const unit = parseSystemdUnit(source);
  const findings: StaticSecurityFinding[] = [];
  let checks = 0;
  const check = (
    condition: boolean,
    id: string,
    message: string,
    severity: StaticSecurityFindingSeverity = "error",
  ) => {
    checks += 1;
    addCheck(findings, condition, id, message, severity);
  };

  check(
    last(unit, "User") === expectation.user,
    "identity.user",
    "Dedicated service user is absent or wrong",
  );
  check(
    last(unit, "Group") === expectation.group,
    "identity.group",
    "Dedicated service group is absent or wrong",
  );
  const execStart = last(unit, "ExecStart") ?? "";
  const executable = words(execStart)[0] ?? "";
  check(
    executable.startsWith("/"),
    "process.exec-absolute",
    "ExecStart must use an absolute executable",
  );
  check(
    !/(?:^|\/)(?:ba|da|z|k|c|t|fi)?sh$/u.test(executable) && !words(execStart).includes("-c"),
    "process.no-shell",
    "ExecStart cannot invoke a shell expression",
  );
  for (const [key, expected, id] of [
    ["NoNewPrivileges", "yes", "process.no-new-privileges"],
    ["PrivateTmp", "yes", "filesystem.private-tmp"],
    ["ProtectSystem", "strict", "filesystem.protect-system"],
    ["PrivateDevices", "yes", "devices.private"],
    ["RestrictSUIDSGID", "yes", "process.restrict-suid-sgid"],
    ["LockPersonality", "yes", "process.lock-personality"],
    ["MemoryDenyWriteExecute", "yes", "process.memory-wx"],
    ["ProtectKernelTunables", "yes", "kernel.tunables"],
    ["ProtectKernelModules", "yes", "kernel.modules"],
    ["ProtectKernelLogs", "yes", "kernel.logs"],
    ["ProtectControlGroups", "yes", "kernel.control-groups"],
    ["ProtectClock", "yes", "kernel.clock"],
    ["ProtectHostname", "yes", "kernel.hostname"],
    ["RestrictRealtime", "yes", "process.realtime"],
    ["SystemCallArchitectures", "native", "process.syscall-architecture"],
    ["ProcSubset", "pid", "process.proc-subset"],
    ["ProtectProc", "invisible", "process.protect-proc"],
    ["UMask", "0077", "filesystem.umask"],
    ["KillMode", "control-group", "process.kill-tree"],
    ["DevicePolicy", "closed", "devices.policy"],
    ["IPAddressDeny", "any", "network.default-deny"],
  ] as const) {
    check(last(unit, key)?.toLowerCase() === expected, id, `${key}=${expected} is required`);
  }
  check(
    ["yes", "read-only", "tmpfs"].includes(last(unit, "ProtectHome")?.toLowerCase() ?? ""),
    "filesystem.protect-home",
    "ProtectHome must be enabled",
  );
  check(
    last(unit, "CapabilityBoundingSet") === "",
    "process.capability-bounding",
    "CapabilityBoundingSet must be empty",
  );
  check(
    last(unit, "AmbientCapabilities") === "",
    "process.ambient-capabilities",
    "AmbientCapabilities must be empty",
  );
  check(
    words(last(unit, "SystemCallFilter") ?? "").includes("@system-service") &&
      !(last(unit, "SystemCallFilter") ?? "").trimStart().startsWith("~"),
    "process.syscall-filter",
    "A positive @system-service SystemCallFilter is required",
  );
  check(
    finiteLimit(last(unit, "TasksMax")),
    "resources.tasks-max",
    "A finite positive TasksMax is required",
  );
  check(
    finiteLimit(last(unit, "MemoryMax")),
    "resources.memory-max",
    "A finite positive MemoryMax is required",
  );
  check(
    /^[1-9][0-9]*%$/u.test(last(unit, "CPUQuota") ?? ""),
    "resources.cpu-quota",
    "A finite positive CPUQuota percentage is required",
  );
  check(
    last(unit, "AppArmorProfile") === expectation.appArmorProfile,
    "apparmor.enforced-profile",
    "The exact non-optional AppArmorProfile is required",
  );

  const readWritePaths = values(unit, "ReadWritePaths")
    .flatMap(words)
    .map((path) => path.replace(/^[-+]/u, ""));
  check(
    expectation.readWritePaths.every((path) => readWritePaths.includes(path)) &&
      !readWritePaths.some((path) => ["/", "/etc", "/usr", "/var", "/home"].includes(path)),
    "filesystem.write-roots",
    "ReadWritePaths must include only the scoped writable roots",
  );
  const families = words(last(unit, "RestrictAddressFamilies") ?? "");
  check(
    expectation.addressFamilies.every((family) => families.includes(family)) &&
      families.every((family) => expectation.addressFamilies.includes(family as never)),
    "network.address-families",
    "RestrictAddressFamilies differs from the profile",
  );
  const credentials = values(unit, "LoadCredential").map(credentialName);
  if (expectation.postgresPeerSocketGroup) {
    check(
      words(last(unit, "SupplementaryGroups") ?? "").includes(
        expectation.postgresPeerSocketGroup,
      ) &&
        families.length === 1 &&
        families[0] === "AF_UNIX" &&
        credentials.length === 0,
      "secrets.postgres-peer-boundary",
      "Peer authentication requires the dedicated socket group, Unix-only transport and no additional loaded credentials",
    );
  }
  check(
    expectation.credentialNames.every((name) => credentials.includes(name)),
    "secrets.systemd-credentials",
    "Required systemd credentials are not loaded by reference",
  );
  const environmentText = values(unit, "Environment").join(" ");
  check(
    !/(?:API_KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_KEY|DATABASE_URL)\s*=/iu.test(
      environmentText,
    ),
    "secrets.no-inline-environment",
    "Environment contains a secret-shaped assignment",
  );
  if (values(unit, "EnvironmentFile").length > 0) {
    findings.push({
      id: "secrets.environment-file-unclassified",
      severity: "warning",
      message: "EnvironmentFile requires an independent proof that it contains no secret values",
    });
  }

  const blocking = findings.some(({ severity }) => severity === "error");
  return {
    schema: "eigengrid.static-systemd-security-report.v1",
    expectationId: expectation.id,
    unitPath: expectation.unitPath,
    verdict: blocking ? "BLOCKED_IMPLEMENTATION" : "STATIC_PASS",
    productionEligible: false,
    checks,
    findings,
    externalBlockers: [...EG031_EXTERNAL_SECURITY_BLOCKERS],
  };
}

export async function evaluateRepositoryStaticSecurity(
  repositoryRoot: string,
): Promise<RepositoryStaticSecurityReport> {
  const reports = await Promise.all(
    Object.values(STATIC_SYSTEMD_SECURITY_EXPECTATIONS).map(async (expectation) => {
      const source = await readFile(resolve(repositoryRoot, expectation.unitPath), "utf8");
      return evaluateSystemdSecurity(source, expectation);
    }),
  );
  return {
    schema: "eigengrid.repository-static-security-report.v1",
    verdict: reports.every(({ verdict }) => verdict === "STATIC_PASS")
      ? "STATIC_PASS"
      : "BLOCKED_IMPLEMENTATION",
    productionEligible: false,
    reports,
    externalBlockers: [...EG031_EXTERNAL_SECURITY_BLOCKERS],
  };
}
