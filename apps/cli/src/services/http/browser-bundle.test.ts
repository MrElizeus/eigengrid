import { expect, test } from "bun:test";
import { serveWebAsset } from "./web-assets";

for (const authenticated of [false, true]) {
  test(`the shipped browser bundle starts with authenticated=${authenticated}`, async () => {
    const response = serveWebAsset(new Request("https://eigengrid.test/assets/app.browser.js"))!;
    // Happy DOM's VM globals require Node; Bun does not initialize them fully.
    const child = Bun.spawn(
      [
        "node",
        new URL("../../../../web/browser-bundle.fixture.mjs", import.meta.url).pathname,
        String(authenticated),
      ],
      { stdin: Buffer.from(await response.text()), stdout: "pipe", stderr: "pipe" },
    );
    const [code, output, diagnostics] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, diagnostics).toBe(0);
    const result = JSON.parse(output);
    expect(result.errors).toEqual([]);
    expect(result.requests).toContain("/api/v1/auth/session");
    expect(result.text).not.toContain("Connecting to EigenGrid");
    if (authenticated) {
      expect(result.requests).toContain("/api/v1/projects?limit=100");
      expect(result.text).toContain("Sign out");
      expect(result.text).toContain("No accessible projects");
    } else {
      expect(result.passwordInputs).toBe(1);
      expect(result.text).toContain("Sign in to your workspace");
    }
  });
}
