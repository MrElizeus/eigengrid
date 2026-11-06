import { expect, test } from "bun:test";

test("the release exposes the protected API without a web command", async () => {
  const help = Bun.spawn(["bun", "run", "apps/cli/bin/eigengrid.ts", "serve", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(help.stdout).text();
  expect(await help.exited).toBe(0);
  expect(text).toContain("credential");
  expect(text).toContain("init-schema");
  expect(text).not.toContain("Aliases: web");

  const web = Bun.spawn(["bun", "run", "apps/cli/bin/eigengrid.ts", "web"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const error = await new Response(web.stderr).text();
  expect(await web.exited).not.toBe(0);
  expect(error).toContain("Unknown argument: web");
});
