import html from "../../../../web/index.page.html" with { type: "text" };
import css from "../../../../web/styles.css" with { type: "text" };
import baseCss from "../../../../web/styles/base.css" with { type: "text" };
import layoutCss from "../../../../web/styles/layout.css" with { type: "text" };
import componentsCss from "../../../../web/styles/components.css" with { type: "text" };
import agentCss from "../../../../web/styles/agent.css" with { type: "text" };
import responsiveCss from "../../../../web/styles/responsive.css" with { type: "text" };
import { browser } from "../../../../web/embedded-browser";

const assets = new Map<string, { source: string; type: string }>([
  ["/", { source: html, type: "text/html; charset=utf-8" }],
  ["/assets/styles.css", { source: css, type: "text/css; charset=utf-8" }],
  ["/assets/base.css", { source: baseCss, type: "text/css; charset=utf-8" }],
  ["/assets/layout.css", { source: layoutCss, type: "text/css; charset=utf-8" }],
  ["/assets/components.css", { source: componentsCss, type: "text/css; charset=utf-8" }],
  ["/assets/agent.css", { source: agentCss, type: "text/css; charset=utf-8" }],
  ["/assets/responsive.css", { source: responsiveCss, type: "text/css; charset=utf-8" }],
  ["/assets/app.browser.js", { source: browser, type: "text/javascript; charset=utf-8" }],
]);

/** Only a fixed allowlist is public; API paths never fall through to the SPA. */
export function serveWebAsset(request: Request): Response | null {
  const url = new URL(request.url);
  const asset = assets.get(url.pathname);
  if (!asset) return null;
  const headers = new Headers({
    "Content-Type": asset.type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  });
  if (!["GET", "HEAD"].includes(request.method)) {
    headers.set("Allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  if (url.search) return new Response(null, { status: 404, headers });
  return new Response(request.method === "HEAD" ? null : asset.source, { headers });
}
