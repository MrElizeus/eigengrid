import { expect, test } from "bun:test";

test("web and serve expose one protected workspace and reject prototype server options", async () => {
  for (const command of ["serve", "web"]) {
    const help = Bun.spawn(["bun", "run", "apps/cli/bin/eigengrid.ts", command, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(help.stdout).text();
    expect(await help.exited).toBe(0);
    expect(text).toContain("credential");
    expect(text).toContain("init-schema");
    expect(text).not.toContain("connection-dir");
  }
  const old = Bun.spawn(
    ["bun", "run", "apps/cli/bin/eigengrid.ts", "web", "--no-open", "--port", "4317"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const error = await new Response(old.stderr).text();
  expect(await old.exited).not.toBe(0);
  expect(error).toContain("Unknown arguments");
});
