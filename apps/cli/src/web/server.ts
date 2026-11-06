import { basename, dirname, join, resolve } from "node:path";
import { findLlmConfigPath, runAgent, type AgentInput, type AgentOutput } from "@eigengrid/agent";
import { z } from "zod";
import { createAgentRuntime } from "../agent/create-agent-runtime";
import { PostgresChatStore } from "./postgres-store";
import { WebPermissions } from "./permissions";
import { WebAuth } from "./auth";
import { ChatStore, type ToolActivity, type Conversation, type WebStore } from "./store";
import page from "./index.html";
import { readWebConnection, activateWebConnection } from "./connection";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const messageSchema = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict();

export interface WebOptions {
  port?: number;
  statePath?: string;
  /** Canonical HTTPS origin of the reverse proxy; listener stays on loopback. */
  origin?: string;
  databaseUrl?: string;
  connectionDirectory?: string;
  /** Test seam: production always uses the canonical runtime and its permissions. */
  run?: (
    input: Pick<
      AgentInput,
      | "prompt"
      | "history"
      | "signal"
      | "onTextDelta"
      | "onToolEvent"
      | "takeSteering"
      | "onSteering"
    >,
  ) => Promise<AgentOutput>;
}

let sourceAssets: Promise<Record<string, Response>> | undefined;
async function webRoutes() {
  if (page.files) return { "/": page };
  // Bun 1.3.14's lazy HTML serving derives invalid asset URLs when cwd is outside
  // the source tree. Build with an explicit root; never change the project cwd.
  sourceAssets ??= (async () => {
    const result = await Bun.build({
      entrypoints: [page.index],
      root: dirname(page.index),
      publicPath: "/",
      target: "browser",
      minify: true,
      env: "disable",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    if (!result.success) throw new AggregateError(result.logs, "Could not build the web interface");
    return Object.fromEntries(
      result.outputs.map((output) => [
        output.path.endsWith("/index.html") || output.path === "index.html"
          ? "/"
          : `/${basename(output.path)}`,
        new Response(output, {
          headers: { "Content-Type": output.type, "X-Content-Type-Options": "nosniff" },
        }),
      ]),
    );
  })();
  return sourceAssets;
}

export async function startWebServer(options: WebOptions = {}) {
  const routes = await webRoutes();
  const connectionDirectory = dirname(dirname(findLlmConfigPath(options.connectionDirectory)));
  const remoteOrigin = options.origin ? new URL(options.origin) : undefined;
  if (
    remoteOrigin &&
    (remoteOrigin.protocol !== "https:" ||
      remoteOrigin.origin !== options.origin ||
      remoteOrigin.username ||
      remoteOrigin.password)
  )
    throw new Error("Network access requires an exact HTTPS origin without a path or credentials.");
  const databaseUrl = options.databaseUrl ?? process.env.EIGENGRID_WEB_DATABASE_URL;
  if (remoteOrigin && !databaseUrl)
    throw new Error("Configura EIGENGRID_WEB_DATABASE_URL para el acceso por red.");
  const store: WebStore = databaseUrl
    ? await PostgresChatStore.open(databaseUrl)
    : new ChatStore(
        options.statePath ??
          join(
            process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
            "eigengrid/web",
            createHash("sha256").update(resolve(process.cwd())).digest("hex").slice(0, 24),
            "chats.sqlite",
          ),
      );
  const auth = new WebAuth(store, !!remoteOrigin);
  let active:
    | {
        id: string;
        controller: AbortController;
        task?: Promise<void>;
        chat: Conversation;
        stopping: boolean;
        send?: (event: unknown) => void;
      }
    | undefined;
  const run =
    options.run ??
    (async (input) => {
      const runtime = await createAgentRuntime({ permissions: new WebPermissions() });
      try {
        return await runAgent({
          ...input,
          tools: runtime.registry,
          ctx: runtime.ctx,
          // CLI episodic memory is shared; never let it bridge private browser accounts.
          memory: undefined,
          permissionRules: [
            ...(runtime.permissionRules ?? []),
            ...["submit-job", "parse-job-output", "cancel-job", "write-file", "run-command"].map(
              (resource) => ({ action: "tool:execute", resource, effect: "deny" as const }),
            ),
          ],
          reserveFinalResponse: true,
          maxSteps: 5,
        });
      } finally {
        await runtime.close();
      }
    });
  const json = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  const publicChat = (chat: Conversation) => ({
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt,
    messages: chat.messages,
    pendingPrompt: chat.pendingPrompt,
  });
  let origin = "";
  async function body(request: Request) {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Empty body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new Error("Request too large");
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      development: false,
      hostname: "127.0.0.1",
      port: options.port ?? 4317,
      idleTimeout: 255,
      maxRequestBodySize: 65536,
      routes,
      async fetch(request) {
        const url = new URL(request.url);
        if (
          url.host !== new URL(origin).host ||
          request.headers.get("host") !== new URL(origin).host
        )
          return json({ error: "Invalid host" }, 403);
        if (request.headers.get("origin") && request.headers.get("origin") !== origin)
          return json({ error: "Invalid origin" }, 403);
        if (
          request.method !== "GET" &&
          (request.headers.get("origin") !== origin ||
            !request.headers.get("content-type")?.startsWith("application/json"))
        )
          return json({ error: "Invalid origin or content" }, 403);
        try {
          if (url.pathname === "/api/auth/session" && request.method === "GET")
            return json(await auth.status(request));
          if (
            ["/api/auth/setup", "/api/auth/login", "/api/auth/register"].includes(url.pathname) &&
            request.method === "POST"
          ) {
            const response = await auth.login(
              request,
              await body(request),
              url.pathname.split("/").at(-1) as "setup" | "login" | "register",
            );
            response.headers.set("Cache-Control", "no-store");
            response.headers.set("X-Content-Type-Options", "nosniff");
            return response;
          }
          const user = auth.authenticated(request);
          if (!user) return json({ error: "Sign in to open your workspace." }, 401);
          if (url.pathname === "/api/auth/logout" && request.method === "POST") {
            if (active?.chat.owner === user.id) {
              active.stopping = true;
              delete active.chat.pendingPrompt;
              active.controller.abort();
            }
            return auth.logout(request);
          }
          if (url.pathname === "/api/admin/invitations" && request.method === "POST") {
            if (user.role !== "admin")
              return json({ error: "Only an administrator can invite users." }, 403);
            const invitation = await auth.invitation();
            return json(
              {
                url: `${origin}/#invite=${invitation.token}`,
                expires: new Date(invitation.expires).toISOString(),
              },
              201,
            );
          }
          if (url.pathname === "/api/state" && request.method === "GET")
            return json({
              project: basename(process.cwd()),
              projectPath: process.cwd(),
              settings: readWebConnection(connectionDirectory).state,
              connectionDirectory,
              chats: await store.list(user.id),
              activeId: active?.chat.owner === user.id ? active.id : undefined,
            });
          if (url.pathname === "/api/settings")
            return json(
              {
                error:
                  "Configura el proveedor, la cuenta y el modelo desde el CLI con /connect y /models.",
              },
              405,
            );
          if (url.pathname === "/api/chats" && request.method === "POST")
            return json(publicChat(await store.create(user.id)), 201);
          const match = /^\/api\/chats\/([a-f0-9-]{36})(?:\/(messages|cancel|steer|fork))?$/.exec(
            url.pathname,
          );
          if (!match) return json({ error: "Not found" }, 404);
          const [, id, action] = match;
          const chat = await store.get(id!, user.id);
          if (!chat) return json({ error: "Conversation not found" }, 404);
          if (!action && request.method === "GET") return json(publicChat(chat));
          if (!action && request.method === "PATCH") {
            const { title } = z
              .object({ title: z.string().trim().min(1).max(100) })
              .strict()
              .parse(await body(request));
            if (active?.id === id)
              return json({ error: "Espera a que termine la respuesta para renombrar." }, 409);
            chat.title = title;
            await store.save(chat);
            return json(publicChat(chat));
          }
          if (action === "fork" && request.method === "POST") {
            const { messageIndex } = z
              .object({ messageIndex: z.number().int().min(0) })
              .strict()
              .parse(await body(request));
            if (active?.id === id) return json({ error: "Stop the response before editing." }, 409);
            if (chat.messages[messageIndex]?.role !== "user")
              return json({ error: "Invalid message" }, 400);
            const fork = await store.create(user.id);
            fork.title = `${chat.title.slice(0, 85)} · rama`;
            fork.messages = chat.messages.slice(0, messageIndex);
            // A new branch carries the visible text conversation, never client-supplied tool receipts.
            fork.history = fork.messages
              .filter((m) => !m.error)
              .map((m) => ({ role: m.role, content: m.content }));
            await store.save(fork);
            return json(publicChat(fork), 201);
          }
          if (action === "steer" && request.method === "POST") {
            const { prompt } = messageSchema.parse(await body(request));
            if (!active || active.id !== id || active.stopping)
              return json(
                { error: "The response has already ended. Send the message to continue." },
                409,
              );
            if (active.chat.pendingPrompt)
              return json({ error: "Your change is being applied. Please wait." }, 409);
            if (
              active.chat.messages.length >= 198 ||
              JSON.stringify(active.chat.history).length > 480000
            )
              return json({ error: "Start a new conversation to continue." }, 409);
            active.chat.pendingPrompt = prompt;
            await store.save(active.chat);
            active.send?.({ type: "steering", prompt });
            return json({ ok: true });
          }
          if (!action && request.method === "DELETE") {
            if (active?.id === id)
              return json({ error: "Stop the response before deleting it." }, 409);
            await store.delete(id!, user.id);
            return json({ ok: true });
          }
          if (action === "cancel" && request.method === "POST") {
            if (active?.id === id) {
              active.stopping = true;
              delete active.chat.pendingPrompt;
              await store.save(active.chat);
              active.controller.abort();
            }
            return json({ ok: true });
          }
          if (action !== "messages" || request.method !== "POST")
            return json({ error: "Method not allowed" }, 405);
          if (active)
            return json({ error: "Ya hay una respuesta en curso. Espera o detenla." }, 409);
          if (chat.messages.length >= 200 || JSON.stringify(chat.history).length > 500000)
            return json(
              { error: "This conversation has reached its limit. Create a new one to continue." },
              409,
            );
          const { prompt } = messageSchema.parse(await body(request));
          // Recheck after the asynchronous request read; only one provider configuration may run.
          if (active) return json({ error: "Ya hay una respuesta en curso." }, 409);
          if (!options.run) {
            try {
              activateWebConnection(connectionDirectory);
            } catch (error) {
              return json({ error: (error as Error).message }, 409);
            }
          }
          const current = {
            id: id!,
            chat,
            stopping: false,
            send: undefined as ((event: unknown) => void) | undefined,
            controller: new AbortController(),
            task: undefined as Promise<void> | undefined,
          };
          active = current;
          delete chat.pendingPrompt;
          chat.messages.push({ role: "user", content: prompt });
          if (chat.messages.length === 1) chat.title = prompt.slice(0, 70);
          await store.save(chat);
          const encoder = new TextEncoder();
          let disconnected = false;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (data: unknown) => {
                if (!disconnected) controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
              };
              const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
              current.send = send;
              current.task = (async () => {
                let turnPrompt = prompt;
                try {
                  for (;;) {
                    let content = "";
                    let tools: ToolActivity[] = [];
                    const startedAt = Date.now();
                    let completed = false;
                    try {
                      if (!options.run) activateWebConnection(connectionDirectory);
                      const output = await run({
                        prompt: turnPrompt,
                        history: chat.history,
                        signal: current.controller.signal,
                        takeSteering: () =>
                          current.stopping || !chat.pendingPrompt ? [] : [chat.pendingPrompt],
                        onSteering: async (messages) => {
                          if (content || tools.length)
                            chat.messages.push({
                              role: "assistant",
                              content,
                              tools,
                              status: "complete",
                            });
                          for (const message of messages)
                            chat.messages.push({ role: "user", content: message });
                          delete chat.pendingPrompt;
                          content = "";
                          tools = [];
                          await store.save(chat);
                          send({ type: "turn", chat: publicChat(chat) });
                        },
                        onTextDelta: async (text) => {
                          content += text;
                          send({ type: "text", text });
                        },
                        onToolEvent: (event) => {
                          if (event.type === "tool-call")
                            tools.push({ name: event.name, args: event.args });
                          else {
                            const tool = [...tools]
                              .reverse()
                              .find((t) => t.name === event.name && t.ok === undefined);
                            if (tool) {
                              tool.result = event.result;
                              tool.ok = event.ok;
                            }
                          }
                          send(event);
                        },
                      });
                      const cancelled = current.controller.signal.aborted;
                      completed = output.ok && !cancelled;
                      content = completed
                        ? content || output.response
                        : content || (cancelled ? "Respuesta detenida." : output.response);
                      chat.messages.push({
                        role: "assistant",
                        content,
                        tools,
                        error: !completed,
                        status: cancelled
                          ? chat.pendingPrompt
                            ? "redirected"
                            : "stopped"
                          : completed
                            ? "complete"
                            : "error",
                        durationMs: Date.now() - startedAt,
                      });
                      if (output.messages.length) chat.history = output.messages;
                    } catch {
                      chat.messages.push({
                        role: "assistant",
                        content:
                          content || "Unable to complete the response. Check the CLI connection.",
                        tools,
                        error: true,
                        status: chat.pendingPrompt
                          ? "redirected"
                          : current.controller.signal.aborted
                            ? "stopped"
                            : "error",
                        durationMs: Date.now() - startedAt,
                      });
                    }
                    // Preserve the original request even if shutdown interrupts a pending redirect.
                    // Partial tool output and unfinished answers are never completed model context.
                    if (
                      chat.pendingPrompt &&
                      !completed &&
                      !chat.history.some(
                        (message) => message.role === "user" && message.content === turnPrompt,
                      )
                    )
                      chat.history = [...chat.history, { role: "user", content: turnPrompt }];
                    await store.save(chat);
                    if (!chat.pendingPrompt || current.stopping || disconnected) break;
                    turnPrompt = chat.pendingPrompt;
                    delete chat.pendingPrompt;
                    chat.messages.push({ role: "user", content: turnPrompt });
                    await store.save(chat);
                    current.controller = new AbortController();
                    send({ type: "turn", chat: publicChat(chat) });
                  }
                  send({ type: "done", chat: publicChat(chat) });
                } finally {
                  clearInterval(heartbeat);
                  active = undefined;
                  if (!disconnected) controller.close();
                }
              })();
            },
            cancel() {
              disconnected = true;
              current.stopping = true;
              current.controller.abort();
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "application/x-ndjson",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return json(
            {
              error: "Unable to process the request. Check the values and project permissions.",
            },
            400,
          );
        }
      },
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  origin = remoteOrigin?.origin ?? server.url.origin;
  return {
    server,
    url: (await auth.setupRequired()) ? `${origin}/#setup=${auth.setupCode}` : `${origin}/`,
    async close() {
      if (active) {
        active.stopping = true;
        active.controller.abort();
      }
      await active?.task;
      await server.stop(true);
      await store.close();
    },
  };
}
