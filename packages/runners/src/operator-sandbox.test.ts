import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectOperatorSandbox,
  assertOperatorSandboxWorkspace,
  operatorSandboxCommand,
  OPERATOR_SANDBOX_LIMITS,
} from "./operator-sandbox";
import { runCommand } from "./process-utils";

const status = await inspectOperatorSandbox();
test.skipIf(!status.available)(
  "sandbox enforces actual filesystem, environment, network and file-size restrictions",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-sandbox-proof-"));
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      const control = join(workspace, ".eigengrid");
      mkdirSync(control);
      const job = join(control, "jobs", "job-one");
      mkdirSync(job, { recursive: true });
      writeFileSync(join(root, "outside-secret"), "private");
      writeFileSync(join(workspace, ".env"), "FIXTURE_SECRET=private");
      writeFileSync(join(control, "llm.json"), "private");
      writeFileSync(join(workspace, "input.in"), "input");
      const invocation = operatorSandboxCommand(
        "/bin/sh",
        [
          "-c",
          `test -z "$FIXTURE_SECRET" && test ! -e '${root}/outside-secret' && test ! -e '${control}/llm.json' && test ! -s '${workspace}/.env' && test -r '${workspace}/input.in' && ! touch '${workspace}/forbidden' 2>/dev/null && printf result > result.out && test "$(wc -l < /proc/net/route)" -le 1 && test "$(ulimit -f)" -le 131072 && printf sandbox-enforced`,
        ],
        workspace,
        job,
      );
      expect(invocation.args).toContain(
        `--property=MemoryMax=${OPERATOR_SANDBOX_LIMITS.memoryBytes}`,
      );
      const result = await runCommand(invocation.command, invocation.args, {
        timeout: 10000,
        env: { FIXTURE_SECRET: "must-not-leak" },
      });
      expect({ exit: result.exitCode, out: result.stdout, err: result.stderr }).toEqual({
        exit: 0,
        out: "sandbox-enforced",
        err: "",
      });
      expect(readFileSync(join(job, "result.out"), "utf8")).toBe("result");
      expect(() => operatorSandboxCommand("/bin/true", [], workspace, workspace)).toThrow(
        "strictly inside",
      );
      expect(() => operatorSandboxCommand("/bin/true", [], workspace, root)).toThrow(
        "strictly inside",
      );
      expect(() => assertOperatorSandboxWorkspace(homedir())).toThrow("project directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);

test.skipIf(!status.available || !existsSync("/usr/bin/python3"))(
  "a live isolated process has separate namespaces, no capabilities and actual cgroup v2 limits",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-live-sandbox-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const job = join(workspace, "job");
    mkdirSync(job);
    const code = `import os,json,time
fields={}
for line in open('/proc/self/status'):
 key,_,value=line.partition(':')
 if key in ('CapEff','NoNewPrivs','Seccomp'): fields[key]=value.strip()
metadata={'namespaces':{name:os.readlink('/proc/self/ns/'+name) for name in ('mnt','net','pid','user')},'status':fields}
with open('evidence.tmp','w') as f: json.dump(metadata,f)
os.rename('evidence.tmp','evidence.json')
for i in range(100):
 if os.path.exists('finish'): break
 time.sleep(0.1)
`;
    const invocation = operatorSandboxCommand("/usr/bin/python3", ["-c", code], workspace, job);
    const child = Bun.spawn([invocation.command, ...invocation.args], {
      cwd: workspace,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text(),
      stderr = new Response(child.stderr).text();
    try {
      const evidence = join(job, "evidence.json");
      for (let count = 0; count < 100 && !existsSync(evidence); count++) await Bun.sleep(50);
      expect(existsSync(evidence)).toBe(true);
      const metadata = JSON.parse(readFileSync(evidence, "utf8"));
      for (const name of ["mnt", "net", "pid", "user"])
        expect(metadata.namespaces[name]).not.toBe(readlinkSync(`/proc/self/ns/${name}`));
      expect(BigInt(`0x${metadata.status.CapEff}`)).toBe(0n);
      expect(metadata.status.NoNewPrivs).toBe("1");
      const membership = readFileSync(`/proc/${child.pid}/cgroup`, "utf8")
        .split("\n")
        .find((line) => line.startsWith("0::"));
      expect(membership).toBeDefined();
      const cgroup = `/sys/fs/cgroup${membership!.slice(3)}`;
      expect(Number(readFileSync(join(cgroup, "memory.max"), "utf8").trim())).toBe(
        OPERATOR_SANDBOX_LIMITS.memoryBytes,
      );
      expect(Number(readFileSync(join(cgroup, "pids.max"), "utf8").trim())).toBe(
        OPERATOR_SANDBOX_LIMITS.processes,
      );
      const [quota, period] = readFileSync(join(cgroup, "cpu.max"), "utf8")
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(quota / period).toBe(OPERATOR_SANDBOX_LIMITS.cpuPercent / 100);
      writeFileSync(join(job, "finish"), "done");
      expect(await child.exited).toBe(0);
      expect(await stdout).toBe("");
      expect(await stderr).toBe("");
    } finally {
      writeFileSync(join(job, "finish"), "done");
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
