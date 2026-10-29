/** Test-only process barrier. Imports/startup are not the lock algorithm's SLA.
 * Each child writes exactly ready\n then waits for stdin EOF before contending.
 * Always reap owned children before the caller removes their fixture directory.
 */
export async function runContendingProcesses(
  count: number,
  source: string,
  env: Record<string, string | undefined>,
  options: { timeoutMs?: number; onSpawn?: (pid: number) => void } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }[]> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 32 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error("Invalid contention fixture bounds");
  const spawn = () =>
    Bun.spawn({
      cmd: [process.execPath, "-e", source],
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  const children: ReturnType<typeof spawn>[] = [];
  const pending: Promise<unknown>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let index = 0; index < count; index++) {
      const child = spawn();
      children.push(child);
      options.onSpawn?.(child.pid);
    }
    const errors = children.map((child) => new Response(child.stderr).text());
    pending.push(Promise.allSettled(errors));
    const work = async () => {
      await Promise.all(
        children.map(async (child) => {
          const reader = child.stdout.getReader();
          let ready = "";
          try {
            while (!ready.includes("\n")) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error("Contender exited before the startup barrier");
              ready += new TextDecoder().decode(chunk.value);
              if (ready.length > 64) throw new Error("Oversized contender startup message");
            }
            if (ready !== "ready\n") throw new Error("Invalid contender startup message");
          } finally {
            reader.releaseLock();
          }
        }),
      );
      // All processes have imported their real implementation before release.
      for (const child of children) child.stdin.end();
      const readRemainder = async (child: ReturnType<typeof spawn>) => {
        // Response(stream) rejects an already-disturbed stream even after its
        // initial reader releases the lock. Continue through the stream API.
        const reader = child.stdout.getReader();
        let text = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return text;
            text += new TextDecoder().decode(chunk.value);
            if (text.length > 64 * 1024) throw new Error("Oversized contender output");
          }
        } finally {
          reader.releaseLock();
        }
      };
      return Promise.all(
        children.map(async (child, index) => {
          const [stdout, stderr, exitCode] = await Promise.all([
            readRemainder(child),
            errors[index]!,
            child.exited,
          ]);
          return { stdout, stderr, exitCode };
        }),
      );
    };
    const result = work();
    pending.push(result);
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Contender round timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map((child) => child.exited));
    await Promise.allSettled(pending);
  }
}
