import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { STATIC_SYSTEMD_SECURITY_EXPECTATIONS } from "./profiles";
import {
  evaluateRepositoryStaticSecurity,
  evaluateSystemdSecurity,
  parseSystemdUnit,
} from "./static-gate";

const repositoryRoot = resolve(import.meta.dir, "../../..");

function hardenedHeadUnit(): string {
  return `[Unit]
Description=EigenGrid hardened Head qualification fixture

[Service]
Type=exec
User=eigengrid
Group=eigengrid
SupplementaryGroups=eigengrid-db
ExecStart=/usr/local/lib/eigengrid/eigengrid-head
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateDevices=yes
DevicePolicy=closed
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictRealtime=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
ProcSubset=pid
ProtectProc=invisible
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
KillMode=control-group
TasksMax=256
MemoryMax=4G
CPUQuota=200%
AppArmorProfile=eigengrid-head
ReadWritePaths=/var/lib/eigengrid/head
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any
`;
}

describe("static systemd security enforcement gate", () => {
  test("accepts a complete static fixture but never promotes it to production evidence", () => {
    const report = evaluateSystemdSecurity(
      hardenedHeadUnit(),
      STATIC_SYSTEMD_SECURITY_EXPECTATIONS.head,
    );
    expect(report.verdict).toBe("STATIC_PASS");
    expect(report.productionEligible).toBe(false);
    expect(report.checks).toBeGreaterThan(30);
    expect(report.findings).toEqual([]);
    expect(report.externalBlockers).toContain("ubuntu-24.04-apparmor-enforce-and-denial-evidence");
  });

  test("detects independent identity, shell, AppArmor, capability, cgroup, egress, and secret gaps", () => {
    const mutations = [
      ["identity.user", ["User=eigengrid", "User=root"]],
      [
        "process.no-shell",
        [
          "ExecStart=/usr/local/lib/eigengrid/eigengrid-head",
          "ExecStart=/bin/sh -c /usr/local/lib/eigengrid/eigengrid-head",
        ],
      ],
      [
        "apparmor.enforced-profile",
        ["AppArmorProfile=eigengrid-head", "AppArmorProfile=-eigengrid-head"],
      ],
      [
        "process.capability-bounding",
        ["CapabilityBoundingSet=\n", "CapabilityBoundingSet=CAP_SYS_ADMIN\n"],
      ],
      ["resources.memory-max", ["MemoryMax=4G", "MemoryMax=infinity"]],
      ["resources.cpu-quota", ["CPUQuota=200%", "CPUQuota=infinity"]],
      ["network.default-deny", ["IPAddressDeny=any", "IPAddressDeny=none"]],
      [
        "secrets.postgres-peer-boundary",
        ["SupplementaryGroups=eigengrid-db", "SupplementaryGroups=wrong-group"],
      ],
    ] as const;
    for (const [findingId, [from, to]] of mutations) {
      const report = evaluateSystemdSecurity(
        hardenedHeadUnit().replace(from, to),
        STATIC_SYSTEMD_SECURITY_EXPECTATIONS.head,
      );
      expect(report.verdict).toBe("BLOCKED_IMPLEMENTATION");
      expect(report.findings.map(({ id }) => id)).toContain(findingId);
    }
  });

  test("systemd-credential profiles still require the exact credential and peer profiles reject added authority", () => {
    const credentialProfile = {
      ...STATIC_SYSTEMD_SECURITY_EXPECTATIONS.head,
      postgresPeerSocketGroup: undefined,
      credentialNames: ["database-url"],
    };
    const correct =
      hardenedHeadUnit() + "LoadCredential=database-url:/run/eigengrid/database-url\n";
    expect(evaluateSystemdSecurity(correct, credentialProfile).verdict).toBe("STATIC_PASS");
    expect(
      evaluateSystemdSecurity(
        correct.replace("LoadCredential=database-url:", "LoadCredential=wrong:"),
        credentialProfile,
      ).findings.map(({ id }) => id),
    ).toContain("secrets.systemd-credentials");
    expect(
      evaluateSystemdSecurity(correct, STATIC_SYSTEMD_SECURITY_EXPECTATIONS.head).findings.map(
        ({ id }) => id,
      ),
    ).toContain("secrets.postgres-peer-boundary");
    expect(
      evaluateSystemdSecurity(
        hardenedHeadUnit().replace(
          "RestrictAddressFamilies=AF_UNIX",
          "RestrictAddressFamilies=AF_UNIX AF_INET",
        ),
        STATIC_SYSTEMD_SECURITY_EXPECTATIONS.head,
      ).verdict,
    ).toBe("BLOCKED_IMPLEMENTATION");
  });

  test("treats a final empty list assignment as a reset and handles continuations/comments", () => {
    const source = hardenedHeadUnit()
      .replace(
        "CapabilityBoundingSet=\n",
        "CapabilityBoundingSet=CAP_NET_RAW\\\n  CAP_SYS_ADMIN\nCapabilityBoundingSet=\n",
      )
      .replace("PrivateTmp=yes", "# comment\nPrivateTmp=yes");
    const parsed = parseSystemdUnit(source);
    expect(parsed.sections.Service?.CapabilityBoundingSet).toEqual([
      "CAP_NET_RAW CAP_SYS_ADMIN",
      "",
    ]);
    expect(evaluateSystemdSecurity(source, STATIC_SYSTEMD_SECURITY_EXPECTATIONS.head).verdict).toBe(
      "STATIC_PASS",
    );
  });

  test("rejects malformed unit syntax instead of ignoring unparsed policy", () => {
    expect(() => parseSystemdUnit("User=eigengrid\n")).toThrow("Invalid systemd unit syntax");
    expect(() => parseSystemdUnit("[Service]\nthis is not an assignment\n")).toThrow(
      "Invalid systemd unit syntax",
    );
    expect(() => parseSystemdUnit("[Service]\nExecStart=/bin/true\\\n")).toThrow(
      "unterminated continuation",
    );
  });

  test("reports current repository units as statically hardened while retaining lab gates", async () => {
    const report = await evaluateRepositoryStaticSecurity(repositoryRoot);
    expect(report.verdict).toBe("STATIC_PASS");
    expect(report.productionEligible).toBe(false);
    expect(report.reports.map(({ expectationId }) => expectationId).sort()).toEqual([
      "head",
      "worker",
    ]);
    for (const unit of report.reports) {
      expect(unit.findings.map(({ id }) => id)).toContain("secrets.environment-file-unclassified");
      expect(unit.externalBlockers.length).toBeGreaterThan(0);
    }
  });

  test("CLI report-only is machine-readable while the enforcing mode exits nonzero", async () => {
    const script = resolve(import.meta.dir, "../scripts/check-static-security.ts");
    const reportOnly = Bun.spawn(
      [process.execPath, script, "--root", repositoryRoot, "--report-only"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reportOnlyOutput = await new Response(reportOnly.stdout).text();
    expect(await reportOnly.exited).toBe(0);
    expect(JSON.parse(reportOnlyOutput)).toMatchObject({ verdict: "STATIC_PASS" });

    const enforcing = Bun.spawn([process.execPath, script, "--root", repositoryRoot], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(enforcing.stdout).text();
    expect(await enforcing.exited).toBe(0);
  });
});
