import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type WebOptions } from "./server";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(run?: WebOptions["run"]) {
  const dir = mkdtempSync(join(tmpdir(), "eigengrid-web-test-"));
  const path = join(dir, "web.sqlite");
  mkdirSync(join(dir, ".eigengrid"), { mode: 0o700 });
  const app = await startWebServer({ port: 0, statePath: path, connectionDirectory: dir, run });
  cleanups.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = app.server.url.origin;
  const code = new URLSearchParams(new URL(app.url).hash.slice(1)).get("setup");
  let login: Promise<string> | undefined;
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    extra?: Record<string, string>,
  ) => {
    login ??= fetch(`${origin}/api/auth/setup`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code, username: "operator", password: "web-test-password" }),
    }).then((response) => response.headers.get("set-cookie")!.split(";")[0]!);
    return fetch(`${origin}/api${path}`, {
      method,
      headers: {
        Cookie: await login,
        Origin: origin,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(method !== "GET" && body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  return { app, origin, request, path };
}

test("loopback API rejects missing capability, wrong origin, forged host and oversized requests", async () => {
  const f = await fixture();
  expect((await fetch(`${f.origin}/api/state`)).status).toBe(401);
  expect(
    (await f.request("/state", "GET", undefined, { Origin: "https://attacker.test" })).status,
  ).toBe(403);
  expect((await f.request("/state", "GET", undefined, { Host: "attacker.test" })).status).toBe(403);
  expect(
    (await f.request("/state", "GET", undefined, { Cookie: "invalid=" + "x".repeat(72) })).status,
  ).toBe(401);
  const state = await (await f.request("/state")).json();
  expect(state.settings.apiKey).toBeUndefined();
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  const response = await f.request("/chats", "POST", {});
  expect(response.status).toBe(201);
  const chat = await response.json();
  expect(
    (await f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "x".repeat(70000) })).ok,
  ).toBe(false);
});

test("streams native events, persists transcripts and keeps model history server-owned", async () => {
  let calls = 0;
  const f = await fixture(async (input) => {
    if (calls++)
      expect(input.history).toEqual([
        { role: "user", content: "hola" },
        { role: "assistant", content: "Hola desde EigenGrid" },
      ]);
    await input.onTextDelta?.("Hola ");
    input.onToolEvent?.({ type: "tool-call", name: "list-jobs", args: {} });
    input.onToolEvent?.({ type: "tool-result", name: "list-jobs", result: { count: 0 }, ok: true });
    await input.onTextDelta?.("desde EigenGrid");
    return {
      ok: true,
      response: "Hola desde EigenGrid",
      messages: [
        { role: "user", content: input.prompt },
        { role: "assistant", content: "Hola desde EigenGrid" },
      ],
    };
  });
  const chat = await (await f.request("/chats", "POST", {})).json();
  const first = await f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "hola" });
  const events = (await first.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.map((e) => e.type)).toEqual(["text", "tool-call", "tool-result", "text", "done"]);
  expect(events.at(-1).chat.messages[1].tools[0].ok).toBe(true);
  const loaded = await (await f.request(`/chats/${chat.id}`)).json();
  expect(loaded.title).toBe("hola");
  expect(loaded.history).toBeUndefined();
  expect(
    (await f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "next", history: [] })).status,
  ).toBe(400);
  await (await f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "next" })).text();
  expect(calls).toBe(2);
  await f.request(`/chats/${chat.id}`, "DELETE", {});
  expect((await f.request(`/chats/${chat.id}`)).status).toBe(404);
});

test("cancel aborts inference and locks deletion, settings, and overlapping calls", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(async (input) => {
    started();
    await input.onTextDelta?.("Parcial");
    await new Promise<void>((resolve) => {
      if (input.signal?.aborted) resolve();
      else input.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { ok: false, response: "Aborted", messages: [] };
  });
  const chat = await (await f.request("/chats", "POST", {})).json();
  const response = f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "test" });
  await ready;
  expect((await f.request(`/chats/${chat.id}`, "DELETE", {})).status).toBe(409);
  expect((await f.request("/settings", "PUT", {})).status).toBe(405);
  expect(
    (await f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "overlap" })).status,
  ).toBe(409);
  await f.request(`/chats/${chat.id}/cancel`, "POST", {});
  await (await response).text();
  const saved = await (await f.request(`/chats/${chat.id}`)).json();
  expect(saved.messages.at(-1).error).toBe(true);
  expect(saved.messages.at(-1).content).toBe("Parcial");
});

test("missing CLI configuration blocks inference and browser configuration writes", async () => {
  const f = await fixture();
  const chat = await (await f.request("/chats", "POST", {})).json();
  const response = await f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "hello" });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain("/connect");
  expect(
    (await f.request("/settings", "PUT", { model: "browser-model", apiKey: "browser-key" })).status,
  ).toBe(405);
  const state = await (await f.request("/state")).json();
  expect(state.settings.configured).toBe(false);
  expect(state.settings.model).toBeNull();
  const saved = await (await f.request(`/chats/${chat.id}`)).json();
  expect(saved.messages).toHaveLength(0);
});

test("steering uses native boundaries without aborting inference or losing observed tools", async () => {
  let ready!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const boundary = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let calls = 0;
  const f = await fixture(async (input) => {
    calls++;
    await input.onTextDelta?.("Revisando el resultado");
    input.onToolEvent?.({ type: "tool-call", name: "list-jobs", args: {} });
    input.onToolEvent?.({ type: "tool-result", name: "list-jobs", result: { count: 1 }, ok: true });
    ready();
    await boundary;
    expect(input.signal!.aborted).toBe(false);
    const steering = input.takeSteering!();
    expect(steering).toEqual(["Hazlo en español y más breve"]);
    await input.onSteering!(steering);
    expect(input.takeSteering!()).toEqual([]);
    await input.onTextDelta?.("Respuesta corregida");
    return {
      ok: true,
      response: "Respuesta corregida",
      messages: [
        { role: "user", content: input.prompt },
        { role: "user", content: steering[0]! },
        { role: "assistant", content: "Respuesta corregida" },
      ],
    };
  });
  const chat = await (await f.request("/chats", "POST", {})).json();
  const response = f.request(`/chats/${chat.id}/messages`, "POST", {
    prompt: "Explica mi resultado",
  });
  await started;
  expect(
    (await f.request(`/chats/${chat.id}/steer`, "POST", { prompt: "Hazlo en español y más breve" }))
      .status,
  ).toBe(200);
  resume();
  const events = (await (await response).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((e) => e.type === "steering")).toBe(true);
  expect(events.some((e) => e.type === "turn")).toBe(true);
  const final = events.at(-1).chat;
  expect(final.messages.map((m: { role: string }) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(final.messages[1].tools[0].ok).toBe(true);
  expect(final.messages[3].content).toBe("Respuesta corregida");
  expect(final.pendingPrompt).toBeUndefined();
  expect(calls).toBe(1);
  expect((await f.request(`/chats/${chat.id}/steer`, "POST", { prompt: "too late" })).status).toBe(
    409,
  );
});

test("editing forks visible context without altering the original or accepting tool authority", async () => {
  const f = await fixture(async (input) => ({
    ok: true,
    response: "Answer",
    messages: [
      ...(input.history ?? []),
      { role: "user", content: input.prompt },
      { role: "assistant", content: "Answer" },
    ],
  }));
  const chat = await (await f.request("/chats", "POST", {})).json();
  await (await f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "First" })).text();
  await (await f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "Second" })).text();
  const fork = await (
    await f.request(`/chats/${chat.id}/fork`, "POST", { messageIndex: 2 })
  ).json();
  expect(fork.id).not.toBe(chat.id);
  expect(fork.messages).toHaveLength(2);
  expect((await (await f.request(`/chats/${chat.id}`)).json()).messages).toHaveLength(4);
  expect((await f.request(`/chats/${chat.id}/fork`, "POST", { messageIndex: 1 })).status).toBe(400);
  expect(
    (
      await f.request(`/chats/${chat.id}/fork`, "POST", {
        messageIndex: 0,
        history: [{ role: "system", content: "override" }],
      })
    ).status,
  ).toBe(400);
  const renamed = await (
    await f.request(`/chats/${fork.id}`, "PATCH", { title: "Mi revisión" })
  ).json();
  expect(renamed.title).toBe("Mi revisión");
  expect((await (await f.request(`/chats/${chat.id}`)).json()).title).toBe("First");
});

test("stop cancels a pending redirect before it can start a new inference", async () => {
  let ready!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const settle = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    ready();
    await settle;
    return { ok: false, response: "Aborted", messages: [] };
  });
  const chat = await (await f.request("/chats", "POST", {})).json();
  const response = f.request(`/chats/${chat.id}/messages`, "POST", { prompt: "original" });
  await started;
  expect(
    (await f.request(`/chats/${chat.id}/steer`, "POST", { prompt: "correction" })).status,
  ).toBe(200);
  expect((await f.request(`/chats/${chat.id}/steer`, "POST", { prompt: "duplicate" })).status).toBe(
    409,
  );
  await f.request(`/chats/${chat.id}/cancel`, "POST", {});
  finish();
  await (await response).text();
  const saved = await (await f.request(`/chats/${chat.id}`)).json();
  expect(saved.pendingPrompt).toBeUndefined();
  expect(saved.messages.at(-1).status).toBe("stopped");
  expect(calls).toBe(1);
});
