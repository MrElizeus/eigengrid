import { expect, test } from "bun:test";

test("startup diagnostic names the rejected stage without echoing caller data", async () => {
  for (const [args, stage] of [
    [[], "arguments"],
    [
      ["--service-config", "/tmp/SECRET-REQUEST-DO-NOT-LOG", "--launch-fd", "3", "--check-only"],
      "root-config",
    ],
  ] as const) {
    const child = Bun.spawn(
      [process.execPath, "apps/cli/bin/eigengrid-submit-backend.ts", ...args],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(74);
    expect(stdout).toBe("");
    expect(stderr).toBe(`eigengrid protected backend rejected: ${stage}\n`);
  }
});
