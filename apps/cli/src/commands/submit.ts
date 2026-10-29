import type { CommandModule } from "yargs";
import type { SshRunnerConfig, StartedProcess } from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import { parse } from "path";
import { readFileSync } from "fs";
import {
  SshRunner,
  SshDaemonStager,
  SlurmRunner,
  type CommandExecutor,
  type Runner,
} from "@eigengrid/runners";
import { SlurmCliClient, buildSlurmScript, type SlurmClient } from "@eigengrid/slurm";
import { parseManifest } from "@eigengrid/worker";
import { validateRecipe, type Recipe, type RecipeRunnerKind } from "@eigengrid/recipes";
import {
  submitJob,
  buildLocalExecutionPlan,
  validateSubmissionInput,
  type SubmitJobInput,
  type RunnerFactory,
  type LocalExecutionPlan,
} from "../services/submit-service";
import { createApplicationContext, runWithContext, type ApplicationContext } from "../composition";
import type { LocalExecutionRequest } from "../services/execution-coordinator";
import { WorkerDaemonBackend } from "../services/worker-daemon-backend";

type SubmitArgs = {
  software: string;
  input?: string[];
  runner: "local" | "ssh" | "slurm";
  mode?: string;
  recipe?: string;
  node?: string;
  project?: string;
  "ssh-host"?: string;
  "ssh-user"?: string;
  "ssh-port"?: number;
  "ssh-key"?: string;
  "ssh-known-hosts"?: string;
  "ssh-remote-dir"?: string;
  "slurm-partition"?: string;
  "slurm-account"?: string;
  "slurm-qos"?: string;
  "slurm-time"?: string;
  "slurm-cpus"?: number;
  "slurm-mem"?: string;
  "slurm-nodes"?: number;
  "slurm-ntasks"?: number;
};

type SubmitDependencies = {
  createContext?: typeof createApplicationContext;
  runnerFactory?: RunnerFactory;
  executor?: CommandExecutor;
  createSlurmClient?: () => Pick<SlurmCliClient, "submitJob">;
  buildSlurmScript?: typeof buildSlurmScript;
};

async function resolveProjectId(db: DatabaseLike, projectRef: string): Promise<string | undefined> {
  const projectById = await db.getProject(projectRef);
  if (projectById) {
    return typeof projectById.id === "string" ? projectById.id : projectRef;
  }

  const projectByName = await db.getProjectByName(projectRef);
  if (projectByName) {
    return typeof projectByName.id === "string" ? projectByName.id : projectRef;
  }

  try {
    const resolvedId = await db.resolveProjectId(projectRef);
    const resolvedProject = await db.getProject(resolvedId);
    if (resolvedProject) {
      return typeof resolvedProject.id === "string" ? resolvedProject.id : resolvedId;
    }
  } catch {
    // Not found; caller will handle the missing project case.
  }

  return undefined;
}

function buildSshRunnerConfig(args: SubmitArgs): SshRunnerConfig {
  const host = args["ssh-host"];
  const user = args["ssh-user"] ?? process.env.USER ?? "root";
  const port = args["ssh-port"] ?? 22;
  const remoteDir = args["ssh-remote-dir"] ?? "/scratch/eigengrid";
  const knownHostsPath = args["ssh-known-hosts"] ?? process.env.EIGENGRID_KNOWN_HOSTS;

  if (!host) {
    throw new Error("--ssh-host is required when using --runner ssh");
  }
  if (!knownHostsPath) {
    throw new Error(
      "SSH host identity is not configured; pass --ssh-known-hosts or set EIGENGRID_KNOWN_HOSTS",
    );
  }

  return {
    host,
    port,
    username: user,
    privateKeyPath: args["ssh-key"],
    knownHostsPath,
    remoteScratchDir: remoteDir,
  };
}

export function extractOrcaNprocs(inputText: string): number | undefined {
  const palBlocks = inputText.match(/%pal\b([\s\S]*?)\bend\b/gi);
  if (!palBlocks) return undefined;

  for (const block of palBlocks) {
    const nprocsMatch = block.match(/\bnprocs\b\s+(\d+)\b/i);
    if (nprocsMatch) {
      return Number(nprocsMatch[1]);
    }

    if (/\bnprocs\b/i.test(block)) {
      return undefined;
    }
  }

  return undefined;
}

async function sshRunnerFactory(
  plan: LocalExecutionPlan,
  db: DatabaseLike,
  args: SubmitArgs,
): Promise<StartedProcess> {
  const config = buildSshRunnerConfig(args);
  const runner = new SshRunner(config, db as any, {
    engines: {
      [plan.job.software]: {
        command: plan.program,
        args: plan.args,
        displayCommand: plan.displayCommand,
      },
    },
  });
  await runner.stage(plan.job);
  return runner.start(plan.job);
}

function createSshRunner(plan: LocalExecutionPlan, db: DatabaseLike, args: SubmitArgs): SshRunner {
  const config = buildSshRunnerConfig(args);
  return new SshRunner(config, db as any, {
    engines: {
      [plan.job.software]: {
        command: plan.program,
        args: plan.args,
        displayCommand: plan.displayCommand,
      },
    },
  });
}

function createSlurmRunner(
  plan: LocalExecutionPlan,
  db: DatabaseLike,
  args: SubmitArgs,
  deps: Pick<SubmitDependencies, "createSlurmClient" | "buildSlurmScript"> = {},
): SlurmRunner {
  const slurmClient = deps.createSlurmClient?.() ?? new SlurmCliClient();
  const inputText = readFileSync(plan.job.inputPath, "utf8");
  const orcaNprocs =
    plan.job.software.toLowerCase() === "orca" ? extractOrcaNprocs(inputText) : undefined;
  const requestedSlurmCpus = args["slurm-cpus"];
  let cpusPerTask = requestedSlurmCpus ?? 1;

  if (orcaNprocs !== undefined) {
    if (requestedSlurmCpus === undefined) {
      cpusPerTask = orcaNprocs;
      console.log(`Using ORCA %pal nprocs ${orcaNprocs} as Slurm CPUs per task.`);
    } else if (requestedSlurmCpus !== orcaNprocs) {
      console.log(
        `Warning: ORCA input requests %pal nprocs ${orcaNprocs}, but --slurm-cpus is ${requestedSlurmCpus}. Slurm and ORCA CPU counts should match.`,
      );
    }
  }

  return new SlurmRunner(
    {
      partition: args["slurm-partition"],
      account: args["slurm-account"],
      qos: args["slurm-qos"],
      time: args["slurm-time"] ?? "01:00:00",
      cpusPerTask,
      commandProgram: plan.program,
      commandArgs: plan.args,
      mem: args["slurm-mem"],
      nodes: args["slurm-nodes"] ?? 1,
      ntasks: args["slurm-ntasks"] ?? 1,
      command: plan.command,
      scriptBuilder: deps.buildSlurmScript,
    },
    db,
    slurmClient as SlurmClient,
  );
}

async function slurmRunnerFactory(
  plan: LocalExecutionPlan,
  db: DatabaseLike,
  args: SubmitArgs,
  deps: Pick<SubmitDependencies, "createSlurmClient" | "buildSlurmScript"> = {},
): Promise<StartedProcess> {
  const runner = createSlurmRunner(plan, db, args, deps);

  const staged = await runner.stage(plan.job);
  if (!staged.ok) return { ok: false, message: staged.message };
  return runner.start(plan.job);
}

/** Current SSH staging uses shell command strings, so paths must remain shell-free. */
export function validateRemotePath(filePath: string, label: string): string | null {
  if (
    !filePath ||
    // eslint-disable-next-line no-control-regex — null byte check is intentional
    /[\x00\r\n\s'"`$;&|<>*?[\]()\\]/.test(filePath) ||
    filePath.split(/[\\/]/).includes("..")
  ) {
    return `  ${label} path contains characters unsafe for remote execution: ${filePath}`;
  }
  return null;
}

export const submitCommand: CommandModule = {
  command: "submit <software> [input...]",
  describe: "Submit a computational chemistry job",
  builder: (y) =>
    y
      .positional("software", { describe: "Software to use", type: "string", demandOption: true })
      .positional("input", { describe: "Input files", type: "string", array: true })
      .option("runner", {
        describe: "Runner to use (local | ssh | slurm)",
        type: "string",
        default: "local",
      })
      .option("mode", {
        describe: "Execution mode",
        type: "string",
        choices: ["direct", "daemon"] as const,
        default: "direct",
      })
      .option("recipe", { describe: "Recipe ID to use (auto-selects if omitted)", type: "string" })
      .option("node", { describe: "Node name or ID (for SSH runner)", type: "string" })
      .option("project", {
        describe: "Project name or ID to associate the job with",
        type: "string",
      })
      .option("ssh-host", { describe: "SSH target hostname", type: "string" })
      .option("ssh-user", { describe: "SSH username", type: "string" })
      .option("ssh-port", { describe: "SSH port", type: "number", default: 22 })
      .option("ssh-key", { describe: "SSH private key path", type: "string" })
      .option("ssh-known-hosts", {
        describe: "SSH known-hosts file (required for production SSH identity verification)",
        type: "string",
      })
      .option("ssh-remote-dir", {
        describe: "Remote scratch directory",
        type: "string",
        default: "/scratch/eigengrid",
      })
      .option("slurm-partition", { describe: "Slurm partition", type: "string" })
      .option("slurm-account", { describe: "Slurm account", type: "string" })
      .option("slurm-qos", { describe: "Slurm QoS", type: "string" })
      .option("slurm-time", { describe: "Slurm time limit (e.g. 01:00:00)", type: "string" })
      .option("slurm-cpus", { describe: "Slurm CPUs per task", type: "number" })
      .option("slurm-mem", { describe: "Slurm memory (e.g. 8G, 16000M)", type: "string" })
      .option("slurm-nodes", { describe: "Slurm node count", type: "number" })
      .option("slurm-ntasks", { describe: "Slurm task count", type: "number" }),
  async handler(args) {
    await runSubmit(args as unknown as SubmitArgs);
  },
};

export async function runSubmit(args: SubmitArgs, deps: SubmitDependencies = {}): Promise<void> {
  const { software, input, runner } = args;
  if (!input || input.length === 0) {
    console.log("  No input files specified. Usage: eigengrid submit <software> <input...>\n");
    return;
  }

  try {
    await runWithContext(async (ctx: ApplicationContext) => {
      const allRecipes = [...ctx.recipes.recipes];
      let selectedRecipe: Recipe | undefined;

      if (args.recipe) {
        selectedRecipe = ctx.recipes.findRunnable(
          software,
          runner as RecipeRunnerKind,
          "",
          args.recipe,
        );
        if (!selectedRecipe) {
          const found = allRecipes.find((r) => r.id === args.recipe);
          if (!found) {
            console.log(`  Recipe "${args.recipe}" not found.\n`);
          } else {
            console.log(`  Recipe "${args.recipe}" is for ${found.software}, not ${software}\n`);
          }
          return;
        }
        console.log(`  Selected recipe: ${selectedRecipe.id}\n`);
      } else {
        selectedRecipe = ctx.recipes.findRunnable(software, runner as RecipeRunnerKind, "");
      }

      // For SSH, if no recipe is found, try using local recipes
      if (runner === "ssh" && !selectedRecipe) {
        selectedRecipe = ctx.recipes.findRunnable(software, "local", "");
      }

      if (!selectedRecipe) {
        console.log(`  No recipe found for ${software}.\n`);
        return;
      }

      // Validate the selected recipe
      const validation = validateRecipe(selectedRecipe);
      if (!validation.valid) {
        console.log(
          `  Recipe validation failed for "${selectedRecipe.id}": ${validation.errors.join("; ")}\n`,
        );
        return;
      }
      if (!args.recipe) {
        console.log(`  Selected recipe: ${selectedRecipe.id}\n`);
      }

      const { config, db } = ctx;

      let resolvedProjectId: string | undefined;
      if (args.project) {
        resolvedProjectId = await resolveProjectId(db, args.project);
        if (!resolvedProjectId) {
          console.log(`  Project not found: ${args.project}\n`);
          return;
        }
      }

      // If --node is specified and runner is ssh, try to resolve node details
      if (runner === "ssh" && args.node) {
        try {
          const resolvedNodeId = await db.resolveNodeId(args.node);
          const node = await db.getNode(resolvedNodeId);
          if (node) {
            if (!args["ssh-host"]) args["ssh-host"] = node.host as string;
            if (!args["ssh-user"]) args["ssh-user"] = node.user as string;
            if (args["ssh-port"] === 22 && node.port) args["ssh-port"] = node.port as number;
            if (!args["ssh-key"] && node.privateKeyPath) args["ssh-key"] = node.privateKeyPath;
            if (args["ssh-remote-dir"] === "/scratch/eigengrid" && node.remoteScratchDir) {
              args["ssh-remote-dir"] = node.remoteScratchDir;
            }
            console.log(`  Using node: ${node.name} (${resolvedNodeId})\n`);
          }
        } catch {
          console.log(`  Node not found: ${args.node}\n`);
          return;
        }
      }

      // Daemon mode uses a separate flow
      const isDaemonMode = args.mode === "daemon" && runner === "ssh";

      if (runner === "ssh") {
        // Validate host identity before creating any durable job/attempt rows;
        // an untrusted SSH configuration must fail closed without a partial
        // submission.
        try {
          buildSshRunnerConfig(args);
        } catch (error) {
          console.log(`  ${error instanceof Error ? error.message : String(error)}\n`);
          return;
        }
      }

      // Pick the runner factory: SSH needs a different factory
      const effectiveRunnerFactory: RunnerFactory =
        runner === "ssh" && !isDaemonMode
          ? (plan, db_, _executor) => sshRunnerFactory(plan, db_, args)
          : runner === "slurm"
            ? (plan, db_, _executor) => slurmRunnerFactory(plan, db_, args, deps)
            : deps.runnerFactory!;

      // Production remote submissions use the same coordinator boundary as
      // cancellation and collection. The legacy factory remains available as
      // an explicit test/compatibility seam, but is not selected here.
      const remoteRunnerFactory =
        runner === "ssh" && !isDaemonMode
          ? (plan: LocalExecutionPlan, db_: DatabaseLike): Runner =>
              createSshRunner(plan, db_, args)
          : runner === "slurm"
            ? (plan: LocalExecutionPlan, db_: DatabaseLike): Runner =>
                createSlurmRunner(plan, db_, args, deps)
            : undefined;

      if (runner === "ssh") {
        const remoteDirErr = validateRemotePath(
          args["ssh-remote-dir"] ?? "/scratch/eigengrid",
          "Remote scratch dir",
        );
        if (remoteDirErr) {
          console.log(remoteDirErr + "\n");
          return;
        }
      }

      for (const inp of input) {
        const inputValidation = validateSubmissionInput(inp);
        if (!inputValidation.ok) {
          console.log(`  ${inputValidation.message}: ${inp}\n`);
          continue;
        }
        const canonicalInputPath = inputValidation.canonicalPath;

        // Validate input extension against recipe
        const ext = parse(canonicalInputPath).ext.toLowerCase();
        const validExts = selectedRecipe.inputExtensions.map((e) => e.toLowerCase());
        if (!validExts.includes(ext)) {
          console.log(
            `  Input file extension "${ext}" not supported for ${software}. Expected: ${validExts.join(", ")}\n`,
          );
          continue;
        }

        if (runner === "ssh") {
          const inputErr = validateRemotePath(canonicalInputPath, "Input");
          if (inputErr) {
            console.log(inputErr + "\n");
            continue;
          }
        }

        if (isDaemonMode) {
          // ── Daemon Mode: stage via SshDaemonStager; worker claims later ──
          const jobId = generateId("job");

          const { plan: executionPlan, recipePlan } = buildLocalExecutionPlan(
            selectedRecipe,
            canonicalInputPath,
            jobId,
            config.jobsDir,
            "local",
          );
          const attemptId = generateId("attempt");
          const nodeName = args.node ?? args["ssh-host"] ?? "unknown";

          const manifest = parseManifest({
            schemaVersion: 2,
            jobId,
            attemptId,
            nodeName,
            software: executionPlan.job.software,
            recipeId: recipePlan.recipeId,
            runner: "worker-daemon",
            inputName: recipePlan.inputName,
            outputName: recipePlan.outputName,
            resources: recipePlan.resources,
            createdAt: Date.now(),
          });
          if (!manifest.ok) {
            console.log(`  Failed to submit ${inp}: invalid daemon manifest\n`);
            continue;
          }

          await db.createJob({
            id: jobId,
            name: canonicalInputPath,
            software,
            inputPath: canonicalInputPath,
            outputPath: recipePlan.outputName,
            workdir: config.jobsDir,
            projectId: resolvedProjectId,
          });

          await db.appendEvent({
            id: generateId("evt"),
            type: "job.created",
            at: Date.now(),
            source: "cli",
            jobId,
            payload: { software, inputPath: canonicalInputPath, runner: "ssh", mode: "daemon" },
          });

          const daemonConfig = buildSshRunnerConfig(args);
          const daemonBackend = new WorkerDaemonBackend({
            db,
            stager: new SshDaemonStager(daemonConfig),
            manifest: manifest.manifest,
            command: recipePlan.command.display,
            remoteScratchDir: daemonConfig.remoteScratchDir,
            nodeName,
          });
          const startResult = await ctx.execution.dispatchRemote?.(jobId, daemonBackend);

          if (startResult?.ok) {
            console.log(
              `  Job ${jobId} staged for worker daemon on ${args["ssh-host"] ?? args.node ?? "?"}\n`,
            );
            console.log(
              `  Created job ${jobId} for ${inp} (${software}, daemon via ${args["ssh-host"] ?? "?"}) -- staged for worker\n`,
            );
          } else {
            console.log(
              `  Failed to submit ${inp}: ${startResult?.message ?? "worker-daemon coordinator is unavailable"}\n`,
            );
          }
        } else if (runner === "local") {
          // ── Local runner: route through canonical coordinator ──
          const localRequest: LocalExecutionRequest = {
            software,
            inputPath: canonicalInputPath,
            name: inp, // Use the original input filename
            recipeId: args.recipe,
            projectId: resolvedProjectId,
          };

          const result = await ctx.execution.executeLocal(localRequest);

          if (result.ok) {
            console.log(
              `  Created job ${result.jobId} for ${inp} (${software}, local) -- started\n`,
            );
          } else {
            console.log(`  Failed to submit ${inp}: ${result.message ?? "unknown error"}\n`);
          }
        } else {
          const submitInput: SubmitJobInput = {
            software,
            inputPath: canonicalInputPath,
            runner: runner as "local" | "ssh" | "slurm",
            recipe: args.recipe,
            projectId: resolvedProjectId,
          };

          const result = await submitJob(submitInput, {
            db,
            config,
            recipes: allRecipes,
            runnerFactory: effectiveRunnerFactory,
            executor: deps.executor,
            execution: ctx.execution,
            remoteRunnerFactory,
          });

          if (result.ok) {
            const runnerLabel =
              runner === "ssh"
                ? `ssh (${args["ssh-host"] ?? "?"})`
                : runner === "slurm"
                  ? "slurm"
                  : "local";
            const statusText = result.message ? `started (${result.message})` : "started";
            console.log(
              `  Created job ${result.jobId} for ${inp} (${software}, ${runnerLabel}) -- ${statusText}\n`,
            );
          } else {
            console.log(`  Failed to submit ${inp}: ${result.message ?? "unknown error"}\n`);
          }
        }
      }
    }, deps.createContext);
  } catch (err) {
    console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
