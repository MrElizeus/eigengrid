import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWebAsset } from "./web-assets";

const asset = (path: string, method = "GET") =>
  serveWebAsset(new Request(`https://eigengrid.test${path}`, { method }));

test("the public asset allowlist is closed, strict and contains every browser import", async () => {
  const index = asset("/")!;
  expect(index.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(index.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  expect(index.headers.get("cache-control")).toBe("no-store");
  expect(index.headers.get("referrer-policy")).toBe("no-referrer");
  expect(index.headers.get("x-frame-options")).toBe("DENY");
  expect(asset("/", "POST")!.status).toBe(405);
  expect(await asset("/", "HEAD")!.text()).toBe("");
  expect(asset("/?unexpected=1")!.status).toBe(404);
  expect(asset("/api/v1/projects")).toBeNull();
  expect(asset("/assets/unknown.js")).toBeNull();
  expect(asset("/assets/../../package.json")).toBeNull();
  const html = await index.text();
  const pending = [...html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/gu)].map(
    (match) => match[1]!,
  );
  const visited = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const result = asset(path);
    expect(result?.status).toBe(200);
    expect(result?.headers.get("x-content-type-options")).toBe("nosniff");
    const source = await result!.text();
    for (const match of source.matchAll(/@import url\("(\/assets\/[^"\n]+\.css)"\)/gu))
      pending.push(match[1]!);
    if (!path.endsWith(".js")) continue;
    expect(result!.headers.get("content-type")).toContain("text/javascript");
    for (const match of source.matchAll(/from "\.\/([^"\n]+\.browser\.js)"/gu))
      pending.push(`/assets/${match[1]}`);
  }
  expect(visited.size).toBe(15);
  const browser = await Bun.build({
    entrypoints: [new URL("../../../../web/src/app.browser.js", import.meta.url).pathname],
    target: "browser",
  });
  expect(browser.success).toBe(true);
});

test("compiled binaries serve the entire web application without a source tree or asset directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eigengrid-web-embed-"));
  try {
    const entry = join(directory, "embed.ts");
    const binary = join(directory, "embed");
    await writeFile(
      entry,
      `import { serveWebAsset } from ${JSON.stringify(new URL("./web-assets.ts", import.meta.url).pathname)};\nfor (const path of ["/", "/assets/styles.css", "/assets/app.browser.js", "/assets/api.browser.js"]) { const r = serveWebAsset(new Request("https://eigengrid.test" + path)); if (!r || r.status !== 200 || (await r.text()).length < 100) process.exit(2); }\nconsole.log("embedded-web-ok");\n`,
    );
    const built = Bun.spawn(["bun", "build", "--compile", `--outfile=${binary}`, entry], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const diagnostics = await new Response(built.stderr).text();
    expect(await built.exited, diagnostics).toBe(0);
    await rm(entry);
    const child = Bun.spawn([binary], {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(child.stdout).text()).toBe("embedded-web-ok\n");
    expect(await child.exited).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
