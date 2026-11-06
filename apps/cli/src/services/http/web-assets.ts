/** Text imports are embedded by Bun in every native target. No cwd or runtime asset directory. */
import html from "../../../../web/index.page.html" with { type: "text" };
import css from "../../../../web/styles.css" with { type: "text" };
import baseCss from "../../../../web/styles/base.css" with { type: "text" };
import layoutCss from "../../../../web/styles/layout.css" with { type: "text" };
import componentsCss from "../../../../web/styles/components.css" with { type: "text" };
import responsiveCss from "../../../../web/styles/responsive.css" with { type: "text" };
import mark from "../../../../web/mark.svg" with { type: "text" };
import app from "../../../../web/src/app.browser.js" with { type: "text" };
import api from "../../../../web/src/api.browser.js" with { type: "text" };
import dom from "../../../../web/src/dom.browser.js" with { type: "text" };
import create from "../../../../web/src/create.browser.js" with { type: "text" };
import mission from "../../../../web/src/mission.browser.js" with { type: "text" };
import records from "../../../../web/src/records.browser.js" with { type: "text" };
import review from "../../../../web/src/review.browser.js" with { type: "text" };
import agent from "../../../../web/src/agent.browser.js" with { type: "text" };
import recovery from "../../../../web/src/recovery.browser.js" with { type: "text" };

const assets = new Map<string, { source: string; type: string }>([
  ["/", { source: html, type: "text/html; charset=utf-8" }],
  ["/assets/styles.css", { source: css, type: "text/css; charset=utf-8" }],
  ...Object.entries({
    base: baseCss,
    layout: layoutCss,
    components: componentsCss,
    responsive: responsiveCss,
  }).map(([name, source]): [string, { source: string; type: string }] => [
    `/assets/${name}.css`,
    { source, type: "text/css; charset=utf-8" },
  ]),
  ["/assets/mark.svg", { source: mark, type: "image/svg+xml" }],
  ...Object.entries({ app, api, dom, create, mission, records, review, agent, recovery }).map(
    ([name, source]): [string, { source: string; type: string }] => [
      `/assets/${name}.browser.js`,
      { source, type: "text/javascript; charset=utf-8" },
    ],
  ),
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
