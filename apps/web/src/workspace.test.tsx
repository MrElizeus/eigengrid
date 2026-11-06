import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { App } from "./app";
import { api } from "./api.browser.js";
import { createRequest } from "./create.browser.js";
import { parseAddress, route } from "./navigation";

let window: Window;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();
let calls: { path: string; method: string; body?: Record<string, unknown> }[];
const sessionId = "61f368eb-7ce0-4b78-b165-0e97f1839c77";
const session = {
  actor: { id: "scientist-a", kind: "human" },
  roles: ["scientific_reviewer"],
  csrfToken: "private-csrf",
};
const created = createRequest({
  projectId: "project-a",
  missionId: "mission-a",
  statement: "Optimize the water structure",
  targetProperties: ["geometry"],
  allowedEngines: ["fixture"],
  criteria: ["Converged geometry"],
  limits: { externalOperations: 0, modelTokens: 1000, wallTimeSeconds: 300, cost: 1 },
  digest: "a".repeat(64),
  size: 20,
  format: "xyz",
  confidence: "exploratory",
  offline: true,
});
const provenance = {
  mission: {
    ...created.mission,
    requestedBy: { id: session.actor.id, kind: "human" },
    policyProfile: "fixture",
  },
  budget: created.budget,
  plans: [],
  evidence: created.objectiveEvidence,
  workUnits: [],
  operations: [],
  assessments: [],
  validations: [],
  observations: [],
  transitions: [],
  decisions: [],
  receipts: [],
  checkpoints: [],
  missingReferences: [],
  complete: true,
};
const agent = {
  sessionId,
  phase: "ready",
  prompt: "Inspect the geometry",
  limits: { maximumSteps: 5 },
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  observations: [],
  cursor: { sequence: 1, digest: "b".repeat(64) },
};
let agentState: typeof agent & { text?: string };
let transportOverride:
  | ((path: string, options?: RequestInit) => Promise<Response> | undefined)
  | undefined;
const missionBase = "/api/v1/projects/project-a/missions/mission-a";

beforeEach(async () => {
  window = new Window({ url: "https://eigengrid.test/" });
  for (const name of [
    "window",
    "document",
    "navigator",
    "location",
    "localStorage",
    "sessionStorage",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "Node",
    "Element",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "StorageEvent",
  ]) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }
  for (const [name, value] of [
    ["dispatchEvent", window.dispatchEvent.bind(window)],
    ["IS_REACT_ACT_ENVIRONMENT", true],
  ] as const) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  window.location.hash = route("project-a", "mission-a");
  window.document.body.innerHTML = '<div id="app"></div>';
  calls = [];
  agentState = { ...agent };
  transportOverride = undefined;
  api.invalidateSession();
  api.pending = [];
  api.storage = window.sessionStorage as unknown as Storage;
  api.transport = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    const method = options?.method ?? "GET";
    calls.push({
      path,
      method,
      body:
        options?.body && typeof options.body === "string" ? JSON.parse(options.body) : undefined,
    });
    const override = transportOverride?.(path, options);
    if (override) return override;
    if (path.endsWith("/auth/session")) return Response.json(session);
    if (path.endsWith("/auth/logout")) return Response.json({ ok: true });
    if (path.startsWith("/api/v1/projects?"))
      return Response.json({
        result: { items: [{ id: "project-a", name: "Research workspace" }], nextCursor: null },
      });
    if (path === missionBase) return Response.json({ result: provenance });
    if (path === `${missionBase}/status`) return Response.json({ result: { revision: 1 } });
    if (path.startsWith(`${missionBase}/agent-sessions?`))
      return Response.json({
        result: { items: [{ ...agentState, createdAt: "2026-11-06T12:00:00Z" }], nextCursor: null },
      });
    if (path === `${missionBase}/agent-sessions/${sessionId}`)
      return Response.json({ result: agentState });
    if (path === `${missionBase}/agent-sessions` && method === "POST")
      return Response.json({ operationId: "open-op", result: agentState }, { status: 201 });
    if (path === `${missionBase}/agent-sessions/${sessionId}/resume` && method === "POST") {
      agentState = {
        ...agentState,
        phase: "completed",
        text: "The geometry is ready for review.",
        cursor: { sequence: 2, digest: "c".repeat(64) },
      };
      return Response.json({ operationId: "resume-op", result: agentState });
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(window.document.getElementById("app")! as unknown as HTMLElement);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  await window.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
  api.invalidateSession();
  api.pending = [];
  api.storage = null;
  api.transport = fetch.bind(globalThis);
});
async function render() {
  await act(async () => {
    root.render(<App />);
  });
}
function button(text: string) {
  const found = [...window.document.querySelectorAll("button")]
    .filter((item) => item.textContent === text)
    .at(-1);
  expect(found).toBeDefined();
  return found!;
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new window.Event("hashchange"));
  });
}

test("React preserves the right agent panel across mission tabs and supports collapse and keyboard resize", async () => {
  await render();
  expect(window.document.querySelector(".wordmark")?.textContent).toBe("EigenGrid");
  expect(window.document.querySelector("h1")?.textContent).toBe("Optimize the water structure");
  const panel = window.document.getElementById("agent-panel");
  expect(panel).not.toBeNull();
  await navigate(route("project-a", "mission-a", "evidence"));
  expect(window.document.getElementById("agent-panel")).toBe(panel);
  expect(window.document.querySelector("a[download]")?.getAttribute("href")).toBe(
    `${missionBase}/artifacts/${"a".repeat(64)}`,
  );
  const splitter = window.document.querySelector('[role="separator"]')!;
  await act(async () => {
    splitter.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
  });
  expect(splitter.getAttribute("aria-valuenow")).toBe("440");
  await click("Hide agent");
  expect(window.document.querySelector(".agent-slot")?.hasAttribute("hidden")).toBe(true);
  await click("Show agent");
  expect(window.document.getElementById("agent-panel")).toBe(panel);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("opening a recorded task never resumes it and its response renders safe Markdown", async () => {
  agentState = {
    ...agentState,
    phase: "completed",
    text: "**Analysis**\n\n<script>unsafe()</script>\n\n![remote](https://untrusted.test/pixel.png)",
  };
  await navigate(route("project-a", "mission-a", "overview", sessionId));
  await render();
  expect(window.document.querySelector(".markdown strong")?.textContent).toBe("Analysis");
  expect(window.document.querySelector(".markdown script")).toBeNull();
  expect(window.document.querySelector(".markdown img")).toBeNull();
  expect(calls.some((call) => call.method === "POST")).toBe(false);
  await navigate(route("project-a", "mission-a", "activity", sessionId));
  expect(window.document.querySelector(".message.user")?.textContent).toContain(
    "Inspect the geometry",
  );
});

test("starting a task uses the API once for open and once for resume, with CSRF and recorded cursors", async () => {
  await render();
  const textarea = window.document.getElementById("agent-prompt")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Inspect the geometry",
    );
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(button("Start task").disabled).toBe(false);
  await click("Start task");
  expect(window.document.querySelector("dialog[open]")).not.toBeNull();
  await click("Start task");
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts.map((call) => call.path)).toEqual([
    `${missionBase}/agent-sessions`,
    `${missionBase}/agent-sessions/${sessionId}/resume`,
  ]);
  expect(posts[0]!.body).toEqual({
    expectedRevision: 0,
    request: { prompt: "Inspect the geometry" },
  });
  expect(posts[1]!.body).toEqual({ expectedRevision: 1, request: {} });
  expect(parseAddress(window.location.hash).sessionId).toBe(sessionId);
  expect(api.pending).toHaveLength(0);
});

test("lost mutation replies retain recovery controls and disable further agent actions", async () => {
  await navigate(route("project-a", "mission-a", "overview", sessionId));
  transportOverride = (path, options) =>
    options?.method === "POST" && path.endsWith("/resume")
      ? Promise.reject(new TypeError("Connection lost after admission"))
      : undefined;
  await render();
  await click("Resume task");
  await click("Resume task");
  expect(api.pending).toHaveLength(1);
  expect(window.document.querySelector('[aria-label="Outstanding requests"]')).not.toBeNull();
  expect(button("Resume task").closest("fieldset")?.hasAttribute("disabled")).toBe(true);
  expect(window.sessionStorage.getItem("eigengrid.web.pending.v1")).not.toContain(
    "Inspect the geometry",
  );
});

test("signing out clears mission and agent data without deleting unresolved request references", async () => {
  await navigate(route("project-a", "mission-a", "overview", sessionId));
  await render();
  api.pending = [
    {
      actorId: session.actor.id,
      projectId: "project-a",
      missionId: "mission-a",
      operation: "agent.resume",
      key: "unknown-effect",
      createdAt: new Date().toISOString(),
    },
  ];
  api.persist();
  await click("Sign out");
  expect(window.document.querySelector("h1")?.textContent).toBe("Sign in to your workspace");
  expect(window.document.getElementById("agent-panel")).toBeNull();
  expect(window.document.body.textContent).not.toContain("Inspect the geometry");
  expect(api.pending).toHaveLength(1);
});

test("cross-tab authentication changes hide previous mission data before revalidation completes", async () => {
  await navigate(route("project-a", "mission-a", "overview", sessionId));
  await render();
  let finish!: (value: Response) => void;
  transportOverride = (path) =>
    path.endsWith("/auth/session")
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined;
  await act(async () => {
    window.dispatchEvent(
      new window.StorageEvent("storage", {
        key: "eigengrid.missions.session-event",
        newValue: "new-session",
      }),
    );
  });
  expect(window.document.getElementById("agent-panel")).toBeNull();
  expect(window.document.body.textContent).not.toContain("Inspect the geometry");
  await act(async () => {
    finish(Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }));
  });
  expect(window.document.querySelector("h1")?.textContent).toBe("Sign in to your workspace");
});
