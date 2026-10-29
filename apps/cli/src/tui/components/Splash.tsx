/**
 * Splash.tsx — EigenGrid TUI Root
 *
 * Architecture:
 *   Splash (root)
 *     ├── <Static> MessageList   (committed history, scrolls into past)
 *     ├── StatusBar              (spinner / active tool / draft preview)
 *     └── PromptInput            (fixed at bottom, hidden while processing)
 *
 * State is managed by a pure reducer (tuiReducer). Module-level globals
 * are limited to the agent infrastructure singleton (lazily initialized once).
 *
 * Stream lifecycle (Ticket 4):
 *   USER_SUBMIT   → append user msg, clear draft, processing=true
 *   TEXT_DELTA    → append to assistantDraft only
 *   TOOL_CALL_START → flush draft → append tool-call msg(running)
 *   TOOL_CALL_UPDATE → update existing tool-call msg
 *   STREAM_FINISH → commit draft as one assistant msg, processing=false
 *   STREAM_ERROR  → commit draft + error system msg, processing=false
 *
 * Key rules (Ticket 3, 6):
 *   All React keys are message-scoped: `${message.id}-<kind>-${i}`
 *   No key based only on local line index.
 *
 * Tool calls (Ticket 5):
 *   Rendered as compact ToolCallCard — raw JSON hidden by default.
 *   Summarizer extracts operational signal (counts, IDs, status).
 *
 * No submitGaussianTool is imported or registered (Ticket 2).
 * No module-level global conversationHistory/toolRegistry in TUI (Ticket 9).
 * Agent infrastructure initialized via createAgentRuntime() (Ticket 1).
 */

import { useState, useEffect, useReducer, useRef, type ReactNode } from "react";
import { Box, Text, useApp, useInput } from "ink";

import { MessageList } from "./MessageList";
import { StatusBar } from "./StatusBar";
import { PromptInput } from "./PromptInput";
import { ProviderPicker } from "./ProviderPicker";
import { ModelPicker } from "./ModelPicker";
import { VariantPicker } from "./VariantPicker";
import { PermissionsPicker } from "./PermissionsPicker";
import { OperationApproval } from "./OperationApproval";
import {
  OperatorPermissions,
  type OperatorApprovalRequest,
} from "../../services/operator-permissions";
import { loadOperatorPermissions } from "../../services/operator-permission-store";
import { permissionPreset } from "@eigengrid/agent/execution-permissions";
import { tuiReducer, initialTuiState } from "../state/tui-reducer";
import { getHelpText, getCompletions, getSuggestions } from "../slash-commands";
import { selectProvider, selectableProviders, selectChatGptAccount } from "../provider-selection";
import { OperatorWelcome } from "./OperatorWelcome";
import { consoleTheme as palette } from "../../presentation/console-theme";
import { terminalText, useTerminalSize } from "../terminal";
import { redactCommand } from "../secret-input";
import { join } from "path";

// ── Agent infrastructure singleton ────────────────────────────────────────────
// Module-level references are intentionally limited to the runtime singleton.
// conversationHistory lives outside the module-level singleton; it is scoped
// to the Splash component via useRef to avoid global mutation.

let _runtime: import("../../agent/create-agent-runtime").AgentRuntime | null = null;
let _runtimePromise: Promise<import("../../agent/create-agent-runtime").AgentRuntime> | null = null;

async function getRuntime(
  permissions: OperatorPermissions,
): Promise<import("../../agent/create-agent-runtime").AgentRuntime> {
  if (_runtime) return _runtime;
  if (_runtimePromise) return _runtimePromise;
  _runtimePromise = import("../../agent/create-agent-runtime")
    .then((m) => m.createAgentRuntime({ allowActions: false, permissions }))
    .then((rt) => {
      _runtime = rt;
      return rt;
    });
  return _runtimePromise;
}

// ── Splash data (header stats) ────────────────────────────────────────────────

interface SplashStats {
  dbReady: boolean;
  error?: string;
  jobs: { total: number; pending: number; running: number };
}

async function loadStats(): Promise<SplashStats> {
  try {
    const { runWithContext } = await import("../../composition");
    return await runWithContext(async (ctx) => {
      const { jobs } = await ctx.dashboard.fetch();
      return {
        dbReady: true,
        jobs: {
          total: jobs.length,
          pending: jobs.filter((j) => ["created", "queued", "staged"].includes(j.status)).length,
          running: jobs.filter((j) => j.status === "running").length,
        },
      };
    });
  } catch (error) {
    return {
      dbReady: false,
      error: error instanceof Error ? error.message : String(error),
      jobs: { total: 0, pending: 0, running: 0 },
    };
  }
}

// ── Fallback response (no LLM configured) ────────────────────────────────────

function fallbackResponse(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("hola") || lower.includes("hello") || lower.includes("hi")) {
    return "EigenGrid Operator is ready. API key authentication is selected, but no key is configured. Use /connect to sign in with ChatGPT or configure an API key.";
  }
  return "API key authentication is selected, but no key is configured. Use /connect to sign in with ChatGPT or /key to configure an API key.";
}

// ── Tab completion helper ─────────────────────────────────────────────────────

function getCommonPrefix(words: string[]): string {
  if (!words.length) return "";
  let prefix = words[0];
  for (let i = 1; i < words.length; i++) {
    while (!words[i].startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) return "";
  }
  return prefix;
}

function handleTabCompletion(query: string): string | null {
  if (!query.startsWith("/")) return null;
  const parts = query.split(" ");
  if (parts.length !== 1) return null;
  const partial = parts[0].slice(1).toLowerCase();
  const matches = getCompletions(`/${partial}`).map((c) => c.slice(1));
  if (matches.length === 1) return `/${matches[0]} `;
  if (matches.length > 1) {
    const prefix = getCommonPrefix(matches);
    if (prefix.length > partial.length) return `/${prefix}`;
  }
  return null;
}

// ── Slash command runner ──────────────────────────────────────────────────────

type StreamChunk =
  | { type: "variants"; modelId?: string }
  | { type: "models" }
  | { type: "connect"; provider: import("@eigengrid/agent").CatalogProvider }
  | { type: "text"; text: string }
  | { type: "error"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; result: unknown; ok: boolean }
  | { type: "clear" }
  | { type: "exit" };

async function* runSlashCommand(
  input: string,
  conversationHistory: import("@eigengrid/agent").AgentInput["history"] | undefined,
  onHistoryUpdate: (h: import("@eigengrid/agent").AgentInput["history"]) => void,
  permissions: OperatorPermissions,
): AsyncGenerator<StreamChunk, void, unknown> {
  const parts = input.trim().slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const execute = () =>
    executeSlashCommand(input, conversationHistory, onHistoryUpdate, permissions);
  if (
    !input.trim().startsWith("/") ||
    [
      "agent",
      "help",
      "clear",
      "q",
      "exit",
      "quit",
      "connect",
      "providers",
      "models",
      "model",
      "variants",
      "key",
      "configure",
      "endpoint",
    ].includes(cmd)
  ) {
    yield* execute();
    return;
  }
  const chunks = await permissions.run(
    { id: crypto.randomUUID(), name: `/${cmd}`, input: { args: parts.slice(1) } },
    async () => {
      const result: StreamChunk[] = [];
      for await (const chunk of execute()) result.push(chunk);
      return result;
    },
  );
  yield* chunks;
}

async function* executeSlashCommand(
  input: string,
  conversationHistory: import("@eigengrid/agent").AgentInput["history"] | undefined,
  onHistoryUpdate: (h: import("@eigengrid/agent").AgentInput["history"]) => void,
  permissions: OperatorPermissions,
): AsyncGenerator<StreamChunk, void, unknown> {
  const trimmed = input.trim();
  if (!trimmed) return;

  // ── AI mode ──────────────────────────────────────────
  if (!trimmed.startsWith("/")) {
    yield* runAgentTurn(trimmed, conversationHistory, onHistoryUpdate, permissions);
    return;
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === "agent") {
    yield* runAgentTurn(args.join(" "), conversationHistory, onHistoryUpdate, permissions);
    return;
  }

  // ── Built-in slash commands ───────────────────────────
  if (cmd === "mission" || cmd === "session") {
    const { runDurableInterfaceCommand } = await import("../durable-commands");
    const result = await runDurableInterfaceCommand(cmd, args);
    yield { type: "text", text: JSON.stringify(result, null, 2) };
    return;
  }
  if (cmd === "help") {
    yield { type: "text", text: getHelpText() };
    return;
  }

  if (cmd === "clear") {
    yield { type: "clear" };
    return;
  }

  if (cmd === "plan") {
    if (args.length === 0) {
      yield {
        type: "text",
        text: "Usage: /plan <scientific objective>\nPlan Mode is hard zero-effect and never executes jobs.",
      };
      return;
    }
    const { runPlan } = await import("../../commands/plan");
    const artifact = await runPlan({ objective: args.join(" "), json: true });
    yield {
      type: "text",
      text: [
        `Plan ${artifact.planId} revision ${artifact.revision} created`,
        `Digest: ${artifact.materialDigest}`,
        "Plan Mode: zero-effect (no job, SSH, Slurm, worker, install, or shell capability)",
      ].join("\n"),
    };
    return;
  }

  if (cmd === "q" || cmd === "exit" || cmd === "quit") {
    yield { type: "exit" };
    return;
  }

  if (cmd === "connect" || cmd === "providers") {
    const { fetchCatalog, formatProviderSummary } = await import("@eigengrid/agent");
    if (args[0] === "usage") {
      const { openSystemBrowser, CHATGPT_USAGE_URL } =
        await import("@eigengrid/agent/chatgpt-auth");
      await openSystemBrowser(CHATGPT_USAGE_URL).catch(() => undefined);
      yield { type: "text", text: `Manage ChatGPT plan usage: ${CHATGPT_USAGE_URL}` };
      return;
    }
    if (args[0] === "logout") {
      const { ChatGptAuth, getLlmConfig } = await import("@eigengrid/agent");
      const profileId = getLlmConfig().chatGptProfileId;
      if (!profileId) {
        yield { type: "text", text: "No ChatGPT account is selected." };
        return;
      }
      const { revoked } = await new ChatGptAuth().signOut(profileId);
      yield {
        type: "text",
        text: revoked
          ? "Signed out of ChatGPT. The saved registration can be reconnected through /connect."
          : "Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT settings.",
      };
      return;
    }
    if (args.length === 0) {
      const catalog = await fetchCatalog();
      yield {
        type: "text",
        text: formatProviderSummary(
          Object.fromEntries(selectableProviders(Object.values(catalog)).map((p) => [p.id, p])),
        ),
      };
      return;
    }
    if (args[0].toLowerCase() === "search" && args[1]) {
      const query = args[1].toLowerCase();
      const catalog = await fetchCatalog();
      const matches = selectableProviders(Object.values(catalog)).filter(
        (p) => p.id.includes(query) || p.name.toLowerCase().includes(query),
      );
      const obj = Object.fromEntries(matches.map((m) => [m.id, m]));
      yield {
        type: "text",
        text: matches.length
          ? formatProviderSummary(obj)
          : `No providers found matching '${query}'`,
      };
      return;
    }
    const id = args[0].toLowerCase();
    const catalog = await fetchCatalog();
    const provider = catalog[id];
    if (!provider) {
      yield {
        type: "text",
        text: `Provider '${id}' not found. Use /connect to list available providers.`,
      };
      return;
    }
    yield { type: "connect", provider };
    return;
  }

  if (cmd === "variants") {
    if (!args.length) {
      yield { type: "variants" };
      return;
    }
    const { selectConfiguredVariant } = await import("@eigengrid/agent");
    await selectConfiguredVariant(args[0]);
    yield { type: "text", text: `Reasoning variant selected: ${args[0]}` };
    return;
  }

  if (cmd === "model" || cmd === "models" || cmd === "key" || cmd === "endpoint") {
    const { configureLlm, getLlmConfig, saveLlmConfig } = await import("@eigengrid/agent");

    if (cmd === "key") {
      if (args[0] === "--forget") {
        const { forgetStoredLlmApiKey } = await import("@eigengrid/agent");
        if (forgetStoredLlmApiKey()) {
          configureLlm({ apiKey: undefined });
          yield { type: "text", text: "API key removed." };
        } else yield { type: "text", text: "No stored API key found." };
        return;
      }
      const key = args.join(" ");
      if (!key) {
        yield { type: "text", text: "Paste your API key in the private input below. Esc cancels." };
        yield { type: "tool-call", id: "configure-key-mode", name: "__configure_key__", args: {} };
        return;
      }
      configureLlm({ apiKey: key, authMode: "api-key", chatGptProfileId: undefined });
      saveLlmConfig(getLlmConfig());
      yield { type: "text", text: "API key saved. Input was hidden from the transcript." };
      return;
    }

    if (cmd === "endpoint") {
      const url = args.join(" ");
      if (!url) {
        yield { type: "text", text: `Current endpoint: ${getLlmConfig().baseUrl}` };
        return;
      }
      configureLlm({ baseUrl: url });
      saveLlmConfig(getLlmConfig());
      yield { type: "text", text: `Endpoint set to: ${url}` };
      return;
    }

    if (!args.length) {
      yield { type: "models" };
      return;
    }

    if (args[0] !== "set" && args.length === 1) {
      yield { type: "variants", modelId: args[0] };
      return;
    }

    if (args[0] === "set" && args.length >= 3) {
      const k = args[1]!;
      const v = args.slice(2).join(" ");
      if (k === "model") {
        yield { type: "variants", modelId: v };
        return;
      }
      const { parseOperatorModelSetting } = await import("../provider-selection");
      configureLlm(parseOperatorModelSetting(k, v));
      saveLlmConfig(getLlmConfig());
      yield { type: "text", text: `${k} = ${k === "apiKey" ? "[hidden]" : v}` };
      return;
    }

    yield { type: "text", text: "Usage: /models, /models <name>, /models set <key> <value>" };
    return;
  }

  // Private key entry is independent of the provider catalog/network.
  if (cmd === "configure") {
    yield {
      type: "text",
      text: "Paste your API key in the private input below. Esc cancels. Use /connect first if you need a different provider.",
    };
    yield { type: "tool-call", id: "configure-key-mode", name: "__configure_key__", args: {} };
    return;
  }

  // ── Delegate to CLI binary (Ticket 12: no shell quotes around binPath) ─────
  const { runCommand } = await import("@eigengrid/runners");
  const cwd = process.cwd();
  const raw = process.argv[1] ?? "apps/cli/bin/eigengrid.ts";
  const binPath = raw.startsWith("/") ? raw : join(cwd, raw);
  const native = !/\.[cm]?[jt]sx?$/.test(binPath);
  const result = await runCommand(
    native ? process.execPath : "bun",
    native ? [cmd, ...args] : ["run", binPath, cmd, ...args],
    {
      timeout: 30_000,
      maxOutputBytes: 50 * 1024,
    },
  );
  const output = (result.stdout + result.stderr).trim();
  yield {
    type: result.exitCode === 0 ? "text" : "error",
    text: output || `(no output, exit ${result.exitCode})`,
  };
}

// ── Agent streaming turn ──────────────────────────────────────────────────────

let _pendingToolCallId = 0;

async function* runAgentTurn(
  message: string,
  conversationHistory: import("@eigengrid/agent").AgentInput["history"] | undefined,
  onHistoryUpdate: (h: import("@eigengrid/agent").AgentInput["history"]) => void,
  permissions: OperatorPermissions,
): AsyncGenerator<StreamChunk, void, unknown> {
  try {
    const { getLlmConfig } = await import("@eigengrid/agent");
    const cfg = getLlmConfig();
    const hasKey = !!(
      cfg.authMode === "chatgpt" ||
      cfg.apiKey ||
      process.env.LLM_API_KEY ||
      process.env.OPENCODE_API_KEY ||
      process.env.OPENAI_API_KEY
    );

    if (!hasKey) {
      yield { type: "text", text: fallbackResponse(message) };
      return;
    }

    const runtime = await getRuntime(permissions);
    const { runAgentStream, DEFAULT_OPERATOR_MAXIMUM_STEPS } = await import("@eigengrid/agent");

    const stream = runAgentStream({
      prompt: message,
      tools: runtime.registry,
      ctx: runtime.ctx,
      memory: runtime.memory,
      history: conversationHistory,
      maxSteps: DEFAULT_OPERATOR_MAXIMUM_STEPS,
      reserveFinalResponse: true,
      permissionRules: runtime.permissionRules,
      approvalAuthority: runtime.approvalAuthority,
      signal: AbortSignal.timeout(300_000),
    });

    // Track tool call IDs for matching
    const pendingCalls: Array<{ id: string; name: string }> = [];

    for await (const event of stream) {
      switch (event.type) {
        case "text":
          yield { type: "text", text: event.text };
          break;

        case "tool-call": {
          _pendingToolCallId += 1;
          const callId = `tc-${Date.now()}-${_pendingToolCallId}`;
          pendingCalls.push({ id: callId, name: event.name });
          yield { type: "tool-call", id: callId, name: event.name, args: event.args };
          break;
        }

        case "tool-result": {
          // Match by tool name (order-based fallback)
          const pending = pendingCalls.find((p) => p.name === event.name) ?? pendingCalls.shift();
          const id = pending?.id ?? `tc-${Date.now()}`;
          if (pending) pendingCalls.splice(pendingCalls.indexOf(pending), 1);
          yield { type: "tool-result", id, name: event.name, result: event.result, ok: event.ok };
          break;
        }

        case "error": {
          const apiKeyHint = event.message.toLowerCase().includes("api key")
            ? " Set your API key with /key <api-key>."
            : "";
          yield { type: "error", text: `${event.message}${apiKeyHint}` };
          break;
        }

        case "done": {
          // Update conversation history for multi-turn
          const updated = [
            ...(conversationHistory ?? []),
            { role: "user" as const, content: message },
            { role: "assistant" as const, content: event.fullText },
          ];
          onHistoryUpdate(updated.slice(-20));
          break;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: "error", text: `Agent error: ${msg.slice(0, 200)}` };
  }
}

// ── Spinner frames ────────────────────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── Splash Component ──────────────────────────────────────────────────────────

export function Splash(): ReactNode {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [transcriptKey, setTranscriptKey] = useState(0);

  // State via reducer (Ticket 3+4)
  const [tui, dispatch] = useReducer(tuiReducer, initialTuiState);

  // Local UI state
  const [query, setQuery] = useState("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [stats, setStats] = useState<SplashStats | null>(null);
  const [bootDone, setBootDone] = useState(false);
  const [activeTool, setActiveTool] = useState<string | undefined>();
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [variantPicker, setVariantPicker] = useState<{ modelId?: string }>();
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionName, setPermissionName] = useState(() => {
    try {
      return permissionPreset(loadOperatorPermissions().preset).name;
    } catch {
      return "Unavailable · /permissions";
    }
  });
  const [approval, setApproval] = useState<OperatorApprovalRequest>();
  const approvalResolver = useRef<(approved: boolean) => void>();
  const [permissions] = useState(
    () =>
      new OperatorPermissions(
        process.cwd(),
        (request) =>
          new Promise<boolean>((resolve) => {
            approvalResolver.current = resolve;
            setApproval(request);
          }),
      ),
  );
  const answerApproval = (approved: boolean) => {
    const resolve = approvalResolver.current;
    approvalResolver.current = undefined;
    setApproval(undefined);
    resolve?.(approved);
  };
  useEffect(
    () => () => {
      approvalResolver.current?.(false);
    },
    [],
  );
  const [initialProvider, setInitialProvider] =
    useState<import("@eigengrid/agent").CatalogProvider>();
  const submittingRef = useRef(false);
  const lastCmdRef = useRef("");
  const [waitingForKey, setWaitingForKey] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<string>("");

  const syncApiKeyHint = async () => {
    const { getLlmConfig } = await import("@eigengrid/agent");
    const cfg = getLlmConfig();
    if (cfg.authMode === "chatgpt") {
      const { ChatGptAuth } = await import("@eigengrid/agent");
      const account = new ChatGptAuth().accounts().find((a) => a.id === cfg.chatGptProfileId);
      setApiKeyStatus(
        account?.sharing
          ? `Using ChatGPT plan · ${terminalText(account.label)} · /connect usage`
          : "ChatGPT sign-in required · /connect",
      );
      return;
    }
    setApiKeyStatus(
      cfg.apiKey
        ? "API key configured · /key to replace · /key --forget to remove"
        : "No saved API key · Provider environment checked when sending · /key to configure",
    );
  };

  // Conversation history is scoped to this component (not module-level global)
  const conversationHistoryRef = useRef<import("@eigengrid/agent").AgentInput["history"]>([]);

  // ── Load stats + LLM config on boot ─────────────────
  useEffect(() => {
    let active = true;
    loadStats().then((result) => {
      if (active) setStats(result);
    });
    (async () => {
      const { loadLlmConfig, configureLlm, getLlmConfig } = await import("@eigengrid/agent");
      const saved = loadLlmConfig();
      if (saved) configureLlm(saved);
      const cfg = getLlmConfig();
      if (cfg.authMode === "chatgpt") {
        if (active) await syncApiKeyHint();
        return;
      }
      if (active)
        setApiKeyStatus(
          cfg.apiKey
            ? "API key configured · /key to replace · /key --forget to remove"
            : "No saved API key · Provider environment checked when sending · /key to configure",
        );
    })().catch((error) => {
      if (active)
        dispatch({
          type: "SYSTEM_MESSAGE",
          level: "error",
          text: `Provider configuration unavailable: ${error instanceof Error ? error.message : String(error)}. Use /connect to retry.`,
        });
    });
    return () => {
      active = false;
    };
  }, []);

  // ── Print boot banner once stats are loaded ──────────
  useEffect(() => {
    if (stats && !bootDone) {
      const statusStr = stats.dbReady
        ? `jobs: ${stats.jobs.pending} queued | running: ${stats.jobs.running} | total: ${stats.jobs.total}`
        : `Data source unavailable: ${terminalText(stats.error)}. Run /doctor to diagnose or /init for a new workspace.`;

      dispatch({
        type: "SYSTEM_MESSAGE",
        level: stats.dbReady ? "info" : "warn",
        text: stats.dbReady
          ? `Workspace snapshot · ${statusStr}\nUse eigengrid dashboard for live operations.`
          : statusStr,
      });
      setBootDone(true);
    }
  }, [stats, bootDone]);

  // ── Spinner animation ─────────────────────────────────
  useEffect(() => {
    if (!tui.processing) return;
    const t = setInterval(() => setSpinnerFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [tui.processing]);

  // ── Run a slash command ────────────────────────────────────────
  const runCommand = async (cmd: string) => {
    if (/^\/permissions\s*$/i.test(cmd.trim())) {
      setPermissionsOpen(true);
      setVariantPicker(undefined);
      setModelPickerOpen(false);
      setProviderPickerOpen(false);
      setQuery("");
      setSuggestionIndex(0);
      submittingRef.current = false;
      return;
    }
    if (/^\/variants\s*$/i.test(cmd.trim())) {
      setVariantPicker({});
      setModelPickerOpen(false);
      setProviderPickerOpen(false);
      setQuery("");
      setSuggestionIndex(0);
      submittingRef.current = false;
      return;
    }
    setVariantPicker(undefined);
    if (/^\/models?\s*$/i.test(cmd.trim())) {
      setModelPickerOpen(true);
      setProviderPickerOpen(false);
      setQuery("");
      setSuggestionIndex(0);
      submittingRef.current = false;
      return;
    }
    setModelPickerOpen(false);
    // Route both typed commands and resolved suggestions through the picker.
    if (/^\/(?:connect|providers)\s*$/i.test(cmd.trim())) {
      setInitialProvider(undefined);
      setProviderPickerOpen(true);
      setQuery("");
      setSuggestionIndex(0);
      submittingRef.current = false;
      return;
    }

    submittingRef.current = true;
    dispatch({ type: "USER_SUBMIT", text: redactCommand(cmd) });
    lastCmdRef.current = cmd;
    setQuery("");
    setActiveTool(undefined);
    setProviderPickerOpen(false);

    try {
      const gen = runSlashCommand(
        cmd,
        conversationHistoryRef.current,
        (updated) => {
          conversationHistoryRef.current = updated;
        },
        permissions,
      );

      for await (const chunk of gen) {
        switch (chunk.type) {
          case "variants":
            setVariantPicker({ modelId: chunk.modelId });
            break;
          case "models":
            setModelPickerOpen(true);
            break;
          case "connect":
            setInitialProvider(chunk.provider);
            setProviderPickerOpen(true);
            break;
          case "clear":
            dispatch({ type: "CLEAR" });
            setTranscriptKey((key) => key + 1);
            lastCmdRef.current = "";
            setActiveTool(undefined);
            submittingRef.current = false;
            return;

          case "exit":
            submittingRef.current = false;
            exit();
            return;

          case "text":
            dispatch({ type: "TEXT_DELTA", text: chunk.text });
            break;

          case "error":
            dispatch({ type: "STREAM_ERROR", error: chunk.text });
            break;

          case "tool-call":
            if (chunk.name === "__configure_key__") {
              setWaitingForKey(true);
              continue;
            }
            setActiveTool(chunk.name);
            dispatch({
              type: "TOOL_CALL_START",
              toolCallId: chunk.id,
              toolName: chunk.name,
              args: chunk.args,
            });
            break;

          case "tool-result":
            setActiveTool(undefined);
            dispatch({
              type: "TOOL_CALL_UPDATE",
              toolCallId: chunk.id,
              status: chunk.ok ? "ok" : "error",
              result: chunk.result,
              error: chunk.ok ? undefined : String(chunk.result),
            });
            break;
        }
      }

      dispatch({ type: "STREAM_FINISH" });
    } catch (err) {
      const brief = err instanceof Error ? err.message : String(err);
      dispatch({ type: "STREAM_ERROR", error: `Error: ${brief}` });
    }

    // Re-check key status after any agent turn (covers /key command and env changes)
    try {
      await syncApiKeyHint();
    } catch {
      dispatch({
        type: "SYSTEM_MESSAGE",
        level: "warn",
        text: "Could not refresh provider configuration. Use /connect to review it.",
      });
    } finally {
      setActiveTool(undefined);
      submittingRef.current = false;
      lastCmdRef.current = "";
    }
  };

  // ── Submit handler ────────────────────────────────────
  const handleSubmit = async (value: string) => {
    if (submittingRef.current || tui.processing) return;

    // Private input never enters the conversation history or command transcript.
    if (waitingForKey) {
      const key = value.trim();
      if (!key) return;
      submittingRef.current = true;
      try {
        const { configureLlm, saveLlmConfig, getLlmConfig } = await import("@eigengrid/agent");
        configureLlm({ apiKey: key, authMode: "api-key", chatGptProfileId: undefined });
        saveLlmConfig(getLlmConfig());
        setQuery("");
        setWaitingForKey(false);
        dispatch({
          type: "SYSTEM_MESSAGE",
          level: "info",
          text: "API key saved. Input was hidden from the transcript.",
        });
        await syncApiKeyHint();
      } catch {
        dispatch({
          type: "SYSTEM_MESSAGE",
          level: "error",
          text: "Could not save the API key. Check configuration file permissions and try again.",
        });
      } finally {
        setQuery("");
        submittingRef.current = false;
      }
      return;
    }

    const suggestions = getSuggestions(value);
    if (suggestions.length > 0 && suggestionIndex >= 0 && suggestionIndex < suggestions.length) {
      const fullCmd = suggestions[suggestionIndex].name;
      setSuggestionIndex(0);
      if (fullCmd) return runCommand(fullCmd);
    }

    submittingRef.current = true;
    const text = value.trim();

    if (!text) {
      submittingRef.current = false;
      return;
    }

    // Deduplicate: same command just submitted (prevents double-firing)
    if (text === lastCmdRef.current) {
      submittingRef.current = false;
      return;
    }

    // Handle exit immediately
    const lower = text.toLowerCase();
    if (lower === "/q" || lower === "/exit" || lower === "/quit") {
      submittingRef.current = false;
      exit();
      return;
    }

    return runCommand(text);
  };

  // ── Keyboard shortcuts ────────────────────────────────
  useInput((_input, key) => {
    if (providerPickerOpen || modelPickerOpen || variantPicker || permissionsOpen || approval)
      return;
    if (waitingForKey) {
      if (key.escape) {
        setQuery("");
        setWaitingForKey(false);
      }
      return;
    }

    const suggestions = getSuggestions(query);
    if (suggestions.length > 0 && !tui.processing) {
      if (key.upArrow) {
        setSuggestionIndex((i) => (i > 0 ? i - 1 : suggestions.length - 1));
        return;
      }
      if (key.downArrow) {
        setSuggestionIndex((i) => (i < suggestions.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.tab) {
        setSuggestionIndex((i) => (i < suggestions.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.escape) {
        setSuggestionIndex(0);
        setQuery("");
        return;
      }
    }

    // Tab completion (no suggestions visible)
    if (key.tab && !tui.processing) {
      const completion = handleTabCompletion(query);
      if (completion !== null) setQuery(completion);
      return;
    }

    // Quit on escape when idle and input is empty
    if (!query && !tui.processing && key.escape) {
      exit();
    }
  });

  // ── Render ────────────────────────────────────────────
  return (
    <>
      {/* Committed message history (logo + info + user/assistant) */}
      <MessageList messages={tui.messages} intro={<OperatorWelcome />} resetKey={transcriptKey} />

      {/* Status bar + prompt — stable container */}
      <Box flexDirection="column" paddingX={1} width={columns}>
        <Text color={palette.dim}>Permissions: {permissionName} · /permissions</Text>
        <StatusBar
          processing={tui.processing}
          spinnerFrame={spinnerFrame}
          activeTool={activeTool}
          assistantDraft={tui.assistantDraft}
        />

        {/* Prompt input — hidden while processing */}
        <PromptInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setSuggestionIndex(0);
          }}
          onSubmit={handleSubmit}
          disabled={
            tui.processing ||
            providerPickerOpen ||
            modelPickerOpen ||
            !!variantPicker ||
            permissionsOpen ||
            !!approval
          }
          secret={waitingForKey}
        />

        {permissionsOpen && (
          <PermissionsPicker
            onCancel={() => setPermissionsOpen(false)}
            onSelect={(id) => {
              const preset = permissionPreset(id);
              setPermissionName(preset.name);
              setPermissionsOpen(false);
              dispatch({
                type: "SYSTEM_MESSAGE",
                level: "info",
                text: `Permissions: ${preset.name} · Approval: ${preset.approvalPolicy} · Execution scope: ${preset.executionScope}`,
              });
            }}
          />
        )}
        {approval && <OperationApproval request={approval} onAnswer={answerApproval} />}

        {variantPicker && (
          <VariantPicker
            modelId={variantPicker.modelId}
            onBack={() => setVariantPicker(undefined)}
            onSelect={async (model, effort) => {
              const { selectConfiguredModel } = await import("@eigengrid/agent");
              await selectConfiguredModel(model.id, effort);
              dispatch({
                type: "SYSTEM_MESSAGE",
                level: "info",
                text: `Model: ${model.name} · Variant: ${effort ?? "provider default"}`,
              });
              setVariantPicker(undefined);
            }}
          />
        )}
        {modelPickerOpen && (
          <ModelPicker
            onCancel={() => setModelPickerOpen(false)}
            onConnect={() => {
              void import("@eigengrid/agent").then(({ getLlmConfig }) => {
                const id = getLlmConfig().providerName;
                return runCommand(id && id !== "eigengrid-llm" ? `/connect ${id}` : "/connect");
              });
            }}
            onSelect={async (model, effort) => {
              const { selectConfiguredModel, getLlmConfig } = await import("@eigengrid/agent");
              await selectConfiguredModel(model.id, effort);
              dispatch({
                type: "SYSTEM_MESSAGE",
                level: "info",
                text: `Model selected: ${model.name} <${model.id}> · Variant: ${effort ?? "provider default"} · ${getLlmConfig().authMode === "chatgpt" ? "ChatGPT account" : "API key"}`,
              });
              setModelPickerOpen(false);
              await syncApiKeyHint();
            }}
          />
        )}

        {providerPickerOpen ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={palette.muted}>{apiKeyStatus}</Text>
            <ProviderPicker
              initialProvider={initialProvider}
              onAccountConnected={async (account) => {
                await selectChatGptAccount(account.id);
                await syncApiKeyHint();
              }}
              onCancel={() => setProviderPickerOpen(false)}
              onSelect={async (provider, connection) => {
                try {
                  if (connection.type === "chatgpt") {
                    await selectChatGptAccount(
                      connection.profileId,
                      connection.model.id,
                      connection.reasoningEffort,
                    );
                    dispatch({
                      type: "SYSTEM_MESSAGE",
                      level: "info",
                      text: `Using ChatGPT plan · ${terminalText(connection.account)}\nModel: ${terminalText(connection.model.name)} · Variant: ${connection.reasoningEffort ?? "provider default"}\nManage usage: /connect usage`,
                    });
                  } else {
                    const text = await selectProvider(provider);
                    dispatch({ type: "SYSTEM_MESSAGE", level: "info", text });
                    setQuery("");
                    setWaitingForKey(true);
                  }
                  await syncApiKeyHint();
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  dispatch({
                    type: "SYSTEM_MESSAGE",
                    level: "error",
                    text: `Provider selection failed: ${message}`,
                  });
                } finally {
                  setProviderPickerOpen(false);
                }
              }}
            />
          </Box>
        ) : null}

        {!providerPickerOpen &&
          !modelPickerOpen &&
          !variantPicker &&
          !permissionsOpen &&
          !approval &&
          !waitingForKey &&
          !tui.processing &&
          (() => {
            const suggestions = getSuggestions(query);
            const limit = Math.max(2, Math.min(6, rows - 12));
            const total = suggestions.length;
            const start =
              total <= limit ? 0 : Math.max(0, Math.min(suggestionIndex - 2, total - limit));
            const visible = suggestions.slice(start, start + limit);
            return total > 0 ? (
              <Box
                borderStyle="round"
                borderColor={palette.border}
                paddingX={1}
                flexDirection="column"
              >
                {visible.map((s, i) => {
                  const globalIdx = start + i;
                  return (
                    <Text key={s.name} wrap="truncate-end">
                      <Text color={palette.accent} bold={globalIdx === suggestionIndex}>
                        {globalIdx === suggestionIndex ? "▸" : " "} {s.name.padEnd(12)}
                      </Text>
                      <Text color={palette.muted}>{s.description}</Text>
                    </Text>
                  );
                })}
              </Box>
            ) : null;
          })()}
        {!tui.processing &&
          !providerPickerOpen &&
          !modelPickerOpen &&
          !variantPicker &&
          !permissionsOpen &&
          !approval && (
            <Text color={palette.dim} wrap="truncate-end">
              {waitingForKey
                ? "Enter saves locally · Esc cancels private entry"
                : "Enter send · Tab / ↑↓ suggestions · /help commands · Esc exit when empty"}
            </Text>
          )}
      </Box>
    </>
  );
}
