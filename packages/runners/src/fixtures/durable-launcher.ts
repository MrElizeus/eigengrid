import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidPath, command, ...args] = process.argv.slice(2);
if (!pidPath || !command) {
  throw new Error("Usage: durable-launcher.ts <pid-path> <command> [args...]");
}

const child = spawn(command, args, {
  detached: true,
  stdio: "ignore",
});
if (!child.pid) {
  throw new Error("Durable supervisor launcher received no PID");
}

writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
child.unref();
setInterval(() => undefined, 1_000);
