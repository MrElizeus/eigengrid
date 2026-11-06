import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { Window } from "happy-dom";

const authenticated = process.argv[2] === "true";
const window = new Window({ url: "https://eigengrid.test/" });
const requests = [];
const errors = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.fetch = async (input) => {
  const path = String(input);
  requests.push(path);
  if (path === "/api/v1/auth/session")
    return window.Response.json(
      authenticated
        ? {
            actor: { id: "scientist-a", kind: "human" },
            roles: ["scientific_reviewer"],
            csrfToken: "test-csrf",
          }
        : { error: { code: "UNAUTHENTICATED" } },
      { status: authenticated ? 200 : 401 },
    );
  if (path === "/api/v1/projects?limit=100")
    return window.Response.json({ result: { items: [], nextCursor: null } });
  throw new Error(`Unexpected request: ${path}`);
};
try {
  window.document.body.innerHTML = '<div id="app">Connecting to EigenGrid…</div>';
  // Execute only the repository's emitted bundle, with all network calls stubbed.
  window.eval(readFileSync(0, "utf8"));
  const expected = authenticated ? "No accessible projects" : "Sign in to your workspace";
  for (let attempt = 0; attempt < 200; attempt++) {
    if (window.document.body.textContent.includes(expected)) break;
    await setTimeout(10);
  }
  console.log(
    JSON.stringify({
      requests,
      errors,
      text: window.document.body.textContent,
      passwordInputs: window.document.querySelectorAll('input[type="password"]').length,
    }),
  );
} finally {
  await window.happyDOM.close();
}
