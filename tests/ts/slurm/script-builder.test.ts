import { describe, expect, test } from "bun:test";
import {
  buildSlurmScript,
  buildSlurmCommandScript,
  buildSlurmRunnerScript,
  shellQuoteWord,
  validateSubmitOptions,
} from "@eigengrid/slurm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildSlurmScript", () => {
  test("builds a default script", () => {
    const script = buildSlurmScript("echo hello", {});

    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("#SBATCH --job-name=eigengrid-job");
    expect(script).toContain("#SBATCH --no-requeue");
    expect(script).toContain("#SBATCH --cpus-per-task=1");
    expect(script).toContain("#SBATCH --time=01:00:00");
    expect(script).toContain("#SBATCH --nodes=1");
    expect(script).toContain("#SBATCH --ntasks=1");
    expect(script).toContain("#SBATCH --output=%x-%j.out");
    expect(script).toContain("#SBATCH --error=%x-%j.err");
    expect(script).toContain('cd -- "$SLURM_SUBMIT_DIR"');
    expect(script).toContain('export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-1}"');
    expect(script).toContain("echo hello");
    expect(script).toContain("engine.exit.json");
  });

  test("builds a script with all options", () => {
    const script = buildSlurmScript("run-task", {
      jobName: "custom-job",
      partition: "debug",
      account: "research",
      qos: "high",
      time: "1-00:00:00",
      cpusPerTask: 8,
      mem: "16G",
      nodes: 2,
      ntasks: 4,
      output: "job.out",
      error: "job.err",
      chdir: "/work/dir",
    });

    expect(script).toContain("#SBATCH --job-name=custom-job");
    expect(script).toContain("#SBATCH --partition=debug");
    expect(script).toContain("#SBATCH --account=research");
    expect(script).toContain("#SBATCH --qos=high");
    expect(script).toContain("#SBATCH --cpus-per-task=8");
    expect(script).toContain("#SBATCH --mem=16G");
    expect(script).toContain("#SBATCH --time=1-00:00:00");
    expect(script).toContain("#SBATCH --nodes=2");
    expect(script).toContain("#SBATCH --ntasks=4");
    expect(script).toContain("#SBATCH --output=job.out");
    expect(script).toContain("#SBATCH --error=job.err");
    expect(script).toContain("#SBATCH --chdir=/work/dir");
  });

  test("uses chdir instead of SLURM_SUBMIT_DIR", () => {
    const script = buildSlurmScript("run-task", { chdir: "/tmp/work" });

    expect(script).toContain("#SBATCH --chdir=/tmp/work");
    expect(script).not.toContain('cd -- "$SLURM_SUBMIT_DIR"');
    expect(script).toContain("cd -- '/tmp/work'");
  });

  test("includes extra env vars", () => {
    const script = buildSlurmScript("run-task", {
      envVars: {
        FOO: "bar",
        BAZ: "two words",
      },
    });

    expect(script).toContain('export FOO="bar"');
    expect(script).toContain('export BAZ="two words"');
  });

  test("falls back to SLURM_SUBMIT_DIR when no chdir is provided", () => {
    const script = buildSlurmScript("run-task", {});

    expect(script).toContain('cd -- "$SLURM_SUBMIT_DIR"');
  });

  test("rejects directive and command control-character injection", () => {
    expect(() => buildSlurmScript("echo safe\n touch /tmp/pwned", {})).toThrow(
      "must not contain NUL, CR, or LF",
    );
    expect(() =>
      buildSlurmScript("echo safe", { account: "chem\n#SBATCH --partition=admin" }),
    ).toThrow("account must not contain control characters");
  });

  test("escapes shell metacharacters in environment values and rejects unsafe names", () => {
    const script = buildSlurmScript("echo safe", {
      envVars: { SAFE: "$(touch /tmp/pwned) `id` $HOME\\value" },
    });
    expect(script).toContain('export SAFE="\\$(touch /tmp/pwned) \\`id\\` \\$HOME\\\\value"');
    expect(() => buildSlurmScript("echo safe", { envVars: { "BAD;NAME": "value" } })).toThrow(
      "env var name is invalid",
    );
  });
});

describe("registered runner script (workspace owned by runner)", () => {
  test("round-trips argv and preserves runner exit without claims in batch launch cwd", () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-runner-script-"));
    const words = ["a'b", "", "two words", "$(touch INJECTED)", "`touch INJECTED`", "$HOME", "á🙂"];
    try {
      const script = buildSlurmRunnerScript(
        {
          executable: "/usr/bin/python3",
          argv: [
            "-c",
            "import json,sys; print(json.dumps(sys.argv[1:])); raise SystemExit(42)",
            ...words,
          ],
        },
        { chdir: directory },
      );
      const result = Bun.spawnSync(["bash", "-c", script]);
      expect(result.exitCode).toBe(42);
      expect(JSON.parse(result.stdout.toString())).toEqual(words);
      for (const name of ["INJECTED", "engine.started.json", "engine.exit.json", "exit.status"])
        expect(existsSync(join(directory, name))).toBe(false);
      expect(script).toContain("#SBATCH --no-requeue");
      expect(script).not.toContain("EIGENGRID_ENGINE_V1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("requires a fixed absolute runner and retains command/directive injection guards", () => {
    expect(() => buildSlurmRunnerScript({ executable: "runner", argv: [] }, {})).toThrow(
      "absolute site path",
    );
    expect(() =>
      buildSlurmRunnerScript({ executable: "/bin/true", argv: ["value\ninjected"] }, {}),
    ).toThrow("NUL, CR, or LF");
    expect(() =>
      buildSlurmRunnerScript(
        { executable: "/bin/true", argv: [] },
        { partition: "chem\n#SBATCH --node=other" },
      ),
    ).toThrow("control");
    expect(() =>
      buildSlurmRunnerScript(
        { executable: "/bin/true", argv: [] },
        { envVars: { LD_PRELOAD: "evil" } },
      ),
    ).toThrow("reserved");
  });
});

describe("generated script execution (real Bash/Python, not Slurm qualification)", () => {
  test("an interrupted claim without a receipt blocks replay without overwriting evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-slurm-claim-"));
    try {
      writeFileSync(join(directory, "engine.started.json"), "{partial claim");
      const script = buildSlurmCommandScript(
        { executable: "/usr/bin/touch", argv: ["RERUN"] },
        { chdir: directory },
      );
      expect(Bun.spawnSync(["bash", "-c", script]).exitCode).toBe(73);
      expect(existsSync(join(directory, "RERUN"))).toBe(false);
      expect(readFileSync(join(directory, "engine.started.json"), "utf8")).toBe("{partial claim");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("concurrent supervisors launch one engine and bind the receipt to its durable claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-slurm-claim-race-"));
    try {
      const script = buildSlurmCommandScript(
        {
          executable: "/usr/bin/python3",
          argv: [
            "-c",
            "import pathlib, time; pathlib.Path('ENGINE_COUNT').open('a').write('launch\\n'); time.sleep(0.1)",
          ],
        },
        { chdir: directory },
      );
      const first = Bun.spawn(["bash", "-c", script]);
      const second = Bun.spawn(["bash", "-c", script]);
      expect((await Promise.all([first.exited, second.exited])).sort((a, b) => a - b)).toEqual([
        0, 73,
      ]);
      expect(readFileSync(join(directory, "ENGINE_COUNT"), "utf8")).toBe("launch\n");
      const claim = readFileSync(join(directory, "engine.started.json"));
      const receipt = JSON.parse(readFileSync(join(directory, "engine.exit.json"), "utf8"));
      expect(receipt.claimDigest).toBe(new Bun.CryptoHasher("sha256").update(claim).digest("hex"));
      expect(receipt.commandDigest).toBe(JSON.parse(claim.toString()).commandDigest);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const exitCode of [0, 1, 42, 137, 255]) {
    test(`preserves engine exit ${exitCode} after publishing its receipt`, () => {
      const directory = mkdtempSync(join(tmpdir(), "eigengrid-slurm-exit-"));
      try {
        const script = buildSlurmCommandScript(
          { executable: "/usr/bin/python3", argv: ["-c", `raise SystemExit(${exitCode})`] },
          { chdir: directory },
        );
        const result = Bun.spawnSync(["bash", "-c", script]);
        expect(result.exitCode).toBe(exitCode);
        expect(readFileSync(join(directory, "exit.status"), "utf8").trim()).toBe(String(exitCode));
        expect(JSON.parse(readFileSync(join(directory, "engine.exit.json"), "utf8"))).toMatchObject(
          {
            schema: "eigengrid.engine-exit/v1",
            exitCode,
            signal: null,
            executionError: null,
          },
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("records SIGKILL independently from an ordinary exit 137", () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-slurm-signal-"));
    try {
      const script = buildSlurmCommandScript(
        {
          executable: "/usr/bin/python3",
          argv: ["-c", "import os, signal; os.kill(os.getpid(), signal.SIGKILL)"],
        },
        { chdir: directory },
      );
      const result = Bun.spawnSync(["bash", "-c", script]);
      expect(result.exitCode).toBe(137);
      expect(JSON.parse(readFileSync(join(directory, "engine.exit.json"), "utf8"))).toMatchObject({
        exitCode: null,
        signal: 9,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("round-trips adversarial argv without executing shell syntax", () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-slurm-quote-"));
    const words = [
      "a'b",
      "",
      "two words",
      "'\"\\",
      "$(touch INJECTED)",
      "`touch INJECTED`",
      "$HOME",
      "; touch INJECTED;",
      "--option=value",
      "á🙂",
    ];
    try {
      const script = buildSlurmCommandScript(
        {
          executable: "/usr/bin/python3",
          argv: ["-c", "import json, sys; print(json.dumps(sys.argv[1:]))", ...words],
        },
        { chdir: directory },
      );
      const result = Bun.spawnSync(["bash", "-c", script]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual(words);
      expect(existsSync(join(directory, "INJECTED"))).toBe(false);
      for (const word of words) {
        const roundTrip = Bun.spawnSync(["/bin/sh", "-c", `printf '%s' ${shellQuoteWord(word)}`]);
        expect(roundTrip.exitCode).toBe(0);
        expect(roundTrip.stdout.toString()).toBe(word);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not rerun an engine or overwrite a prior receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-slurm-receipt-"));
    try {
      writeFileSync(join(directory, "engine.exit.json"), "prior receipt");
      const script = buildSlurmCommandScript(
        { executable: "/usr/bin/touch", argv: ["RERUN"] },
        { chdir: directory },
      );
      expect(Bun.spawnSync(["bash", "-c", script]).exitCode).toBe(73);
      expect(existsSync(join(directory, "RERUN"))).toBe(false);
      expect(readFileSync(join(directory, "engine.exit.json"), "utf8")).toBe("prior receipt");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("legacy trusted-shell failure also remains a batch failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-slurm-legacy-"));
    try {
      expect(
        Bun.spawnSync(["bash", "-c", buildSlurmScript("false", { chdir: directory })]).exitCode,
      ).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("validateSubmitOptions", () => {
  test("accepts valid options", () => {
    expect(
      validateSubmitOptions({
        mem: "8G",
        time: "01:00:00",
        cpusPerTask: 2,
        nodes: 1,
        ntasks: 1,
      }),
    ).toBeNull();
  });

  test("rejects invalid memory format", () => {
    expect(validateSubmitOptions({ mem: "8GB" })).toBe("Invalid mem format");
  });

  test("rejects invalid time format", () => {
    expect(validateSubmitOptions({ time: "1:00" })).toBe("Invalid time format");
  });

  test("rejects non-positive cpusPerTask", () => {
    expect(validateSubmitOptions({ cpusPerTask: 0 })).toBe("cpusPerTask must be greater than 0");
  });

  test("rejects fractional/nonfinite resources, directive options and interpreter injection", () => {
    for (const value of [1.5, NaN, Infinity]) {
      expect(validateSubmitOptions({ cpusPerTask: value })).toBe("cpusPerTask must be an integer");
    }
    expect(validateSubmitOptions({ account: "chem --uid=0" })).toBe(
      "account must be a single scheduler identifier",
    );
    for (const key of ["BASH_ENV", "ENV", "PATH", "PYTHONPATH", "LD_PRELOAD", "SLURM_JOB_ID"]) {
      expect(validateSubmitOptions({ envVars: { [key]: "attack" } })).toBe(
        `env var ${key} is reserved`,
      );
    }
  });
});
