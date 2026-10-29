/**
 * Static ASCII splash — fallback when Ink TUI is not available.
 * Queries real system data: jobs, commands, environment.
 */

import { EIGENGRID_VERSION } from "./version";

const palette = {
  text: "\x1b[38;2;184;214;176m",
  muted: "\x1b[38;2;124;156;118m",
  accent: "\x1b[38;2;156;207;140m",
  value: "\x1b[38;2;216;240;208m",
  dim: "\x1b[38;2;95;124;90m",
  warn: "\x1b[38;2;207;180;100m",
  reset: "\x1b[0m",
};

function gradient(from: string, to: string, steps: number): string[] {
  const r1 = Number.parseInt(from.slice(1, 3), 16);
  const g1 = Number.parseInt(from.slice(3, 5), 16);
  const b1 = Number.parseInt(from.slice(5, 7), 16);
  const r2 = Number.parseInt(to.slice(1, 3), 16);
  const g2 = Number.parseInt(to.slice(3, 5), 16);
  const b2 = Number.parseInt(to.slice(5, 7), 16);
  return Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return `\x1b[38;2;${r};${g};${b}m`;
  });
}

const logoLines = [
  "  ███████╗██╗ ██████╗ ███████╗███╗   ██╗ ██████╗ ██████╗ ██╗██████╗ ",
  "  ██╔════╝██║██╔════╝ ██╔════╝████╗  ██║██╔════╝ ██╔══██╗██║██╔══██╗",
  "  █████╗  ██║██║  ███╗█████╗  ██╔██╗ ██║██║  ███╗██████╔╝██║██║  ██║",
  "  ██╔══╝  ██║██║   ██║██╔══╝  ██║╚██╗██║██║   ██║██╔══██╗██║██║  ██║",
  "  ███████╗██║╚██████╔╝███████╗██║ ╚████║╚██████╔╝██║  ██║██║██████╔╝",
  "  ╚══════╝╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝ ",
];

const colors = gradient("#1e3a1a", "#6db35a", logoLines.length);

interface SplashData {
  dbReady: boolean;
  jobs: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  nodes: number;
  commands: Array<{ name: string; description: string }>;
  environment: {
    bun: string;
    node: string;
    python: string;
    os: string;
    arch: string;
  };
  runners: string[];
  parsers: string[];
}

async function collectSplashData(): Promise<SplashData> {
  const data: SplashData = {
    dbReady: false,
    jobs: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 },
    nodes: 0,
    commands: [],
    environment: { bun: "", node: "", python: "", os: "", arch: "" },
    runners: ["local", "ssh", "slurm", "pbs"],
    parsers: ["gaussian", "orca", "xtb", "cp2k"],
  };

  // Environment info
  const bunGlobal = (globalThis as Record<string, unknown>).Bun as { version: string } | undefined;
  data.environment.bun = bunGlobal?.version ?? process.versions.bun ?? "?";
  data.environment.node = process.version;
  data.environment.os = process.platform;
  data.environment.arch = process.arch;
  try {
    const { runCommand } = await import("@eigengrid/runners");
    const pyResult = await runCommand("python3", ["--version"], {
      timeout: 3000,
      maxOutputBytes: 512,
    }).catch(() => runCommand("python", ["--version"], { timeout: 3000, maxOutputBytes: 512 }));
    if (pyResult.exitCode === 0) {
      data.environment.python = pyResult.stdout.trim() || pyResult.stderr.trim();
    }
  } catch {
    data.environment.python = "not found";
  }

  // Commands
  data.commands = [
    { name: "init", description: "Initialize an EigenGrid project" },
    { name: "doctor", description: "Run environment diagnostics" },
    { name: "submit", description: "Submit a computational chemistry job" },
    { name: "status", description: "Show job and node status" },
    { name: "parse", description: "Parse a computational chemistry output file" },
    { name: "logs", description: "Show job logs" },
    { name: "node", description: "Manage compute nodes" },
    { name: "agent", description: "Run EigenGrid agent" },
    { name: "dashboard", description: "Launch interactive TUI dashboard" },
  ];

  // Database
  try {
    const { createApplicationContext } = await import("./composition");
    const ctx = await createApplicationContext();
    try {
      const jobs = await ctx.db.listJobs();
      data.dbReady = true;
      data.jobs.total = jobs.length;
      for (const j of jobs) {
        const status = String(j.status ?? "");
        if (["created", "queued", "staged"].includes(status)) data.jobs.pending++;
        else if (status === "running") data.jobs.running++;
        else if (status === "completed") data.jobs.completed++;
        else if (["failed", "cancelled"].includes(status)) data.jobs.failed++;
      }
    } finally {
      await ctx.close();
    }
  } catch {
    // DB not initialized — that's ok
  }

  return data;
}

export async function printSplash(): Promise<void> {
  const data = await collectSplashData();
  const out = console.log;
  const sep = `${palette.dim}${"=".repeat(80)}${palette.reset}`;

  out(sep);

  // Logo
  for (let i = 0; i < logoLines.length; i++) {
    out(`${colors[i]}${logoLines[i]}${palette.reset}`);
  }

  out(
    `${palette.dim}v${EIGENGRID_VERSION} | bun ${data.environment.bun} | ${data.environment.os} ${data.environment.arch}${palette.reset}`,
  );
  out(sep);

  // Job status section
  out(`${palette.accent}Jobs${palette.reset}`);
  if (!data.dbReady) {
    out(`  ${palette.warn}Database not initialized. Run 'eigengrid init' first.${palette.reset}`);
  } else if (data.jobs.total === 0) {
    out(
      `  ${palette.muted}No jobs yet. Run 'eigengrid submit <software> <input>' to start.${palette.reset}`,
    );
  } else {
    out(
      `  ${palette.muted}Total:${palette.dim} ${palette.value}${data.jobs.total}${palette.reset}`,
    );
    out(
      `  ${palette.muted}Pending:${palette.dim} ${palette.value}${data.jobs.pending}${palette.reset}`,
    );
    out(
      `  ${palette.muted}Running:${palette.dim} ${palette.value}${data.jobs.running}${palette.reset}`,
    );
    out(
      `  ${palette.muted}Completed:${palette.dim} ${palette.value}${data.jobs.completed}${palette.reset}`,
    );
    out(
      `  ${palette.muted}Failed:${palette.dim} ${palette.value}${data.jobs.failed}${palette.reset}`,
    );
  }
  out("");

  // Runners section
  out(`${palette.accent}Runners${palette.reset}`);
  out(
    `  ${palette.muted}Available:${palette.dim} ${palette.value}${data.runners.join(", ")}${palette.reset}`,
  );
  out(
    `  ${palette.muted}Usage:${palette.dim} ${palette.value}eigengrid submit <software> <input> --runner <name>${palette.reset}`,
  );
  out("");

  // Parsers section
  out(`${palette.accent}Parsers${palette.reset}`);
  out(
    `  ${palette.muted}Available:${palette.dim} ${palette.value}${data.parsers.join(", ")}${palette.reset}`,
  );
  out(
    `  ${palette.muted}Usage:${palette.dim} ${palette.value}eigengrid parse <software> <output-file>${palette.reset}`,
  );
  out("");

  // Commands section
  out(`${palette.accent}Commands${palette.reset}`);
  const cmdPad = 12;
  for (const cmd of data.commands) {
    const name = cmd.name.padEnd(cmdPad);
    out(
      `  ${palette.value}${name}${palette.reset} ${palette.muted}${cmd.description}${palette.reset}`,
    );
  }
  out("");

  // Environment section
  out(`${palette.accent}Environment${palette.reset}`);
  out(
    `  ${palette.muted}Bun:${palette.dim} ${palette.value}${data.environment.bun}${palette.reset}`,
  );
  out(
    `  ${palette.muted}Node:${palette.dim} ${palette.value}${data.environment.node}${palette.reset}`,
  );
  out(
    `  ${palette.muted}Python:${palette.dim} ${palette.value}${data.environment.python}${palette.reset}`,
  );
  out(
    `  ${palette.muted}OS:${palette.dim} ${palette.value}${data.environment.os} ${data.environment.arch}${palette.reset}`,
  );
  out("");

  out(sep);
  out(
    `${palette.text}eigengrid${palette.reset} ${palette.muted}-- computational chemistry workbench${palette.reset}`,
  );
  out(`${palette.muted}Run 'eigengrid <command> --help' for detailed usage.${palette.reset}`);
  out("");
}
