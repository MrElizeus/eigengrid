/**
 * Persistent LLM configuration storage.
 * Saves/loads provider, model, endpoint, and API key to .eigengrid/llm.json
 * with 0600 permissions (only current user can read).
 *
 * Key is stored in .eigengrid/llm.json (0600 permissions).
 * .eigengrid/ is in .gitignore so keys never leak to version control.
 * For production/CI, use OPENCODE_API_KEY or LLM_API_KEY environment variables.
 */

import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "path";
import type { LlmConfig } from "./llm-client";
import { isReasoningEffort, type ReasoningEffort } from "@eigengrid/model-gateway";

interface StoredLlmConfig {
  reasoningEffort?: ReasoningEffort;
  authMode?: "api-key" | "chatgpt";
  chatGptProfileId?: string;
  baseUrl: string;
  model: string;
  providerName?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
}

function getConfigPath(cwd?: string): string {
  const dir = findEigenGridDir(cwd ?? process.cwd());
  return join(dir, "llm.json");
}

/**
 * Public alias — returns the full path to .eigengrid/llm.json.
 */
export function findLlmConfigPath(cwd?: string): string {
  return getConfigPath(cwd);
}

function findEigenGridDir(start: string): string {
  let dir = start;
  for (;;) {
    const candidate = join(dir, ".eigengrid");
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`EigenGrid state directory is not a real directory: ${candidate}`);
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) return join(start, ".eigengrid");
    dir = parent;
  }
}

/**
 * Save LLM config (including API key) to .eigengrid/llm.json
 * with 0600 permissions (owner read/write only).
 */
export function saveLlmConfig(config: LlmConfig, apiKey?: string): void {
  const data: StoredLlmConfig = {
    reasoningEffort: config.reasoningEffort,
    authMode: config.authMode,
    chatGptProfileId: config.chatGptProfileId,
    baseUrl: config.baseUrl,
    model: config.model,
    providerName: config.providerName,
    apiKey: apiKey ?? config.apiKey,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    costPerInputToken: config.costPerInputToken,
    costPerOutputToken: config.costPerOutputToken,
  };

  const configPath = getConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirInfo = lstatSync(dir);
  if (
    dirInfo.isSymbolicLink() ||
    !dirInfo.isDirectory() ||
    (dirInfo.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && dirInfo.uid !== process.getuid())
  ) {
    throw new Error("Model configuration directory permissions must prevent writes by other users");
  }
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("LLM config write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, configPath);
    const parent = openSync(dirname(configPath), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/**
 * Load LLM config from .eigengrid/llm.json.
 * Returns full config including API key if saved.
 */
export function loadLlmConfig(): Partial<LlmConfig> | null {
  const configPath = getConfigPath();
  let descriptor: number;
  try {
    // A named pipe must reach fstat validation without waiting for a writer.
    // O_NONBLOCK is ignored for regular files and prevents this pre-validation hang.
    descriptor = openSync(
      configPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Model configuration cannot be read safely");
  }
  let raw: string;
  try {
    const info = fstatSync(descriptor),
      dir = lstatSync(dirname(configPath));
    if (
      !info.isFile() ||
      info.size > 64 * 1024 ||
      (info.mode & 0o077) !== 0 ||
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      (dir.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" &&
        (info.uid !== process.getuid() || dir.uid !== process.getuid()))
    )
      throw new Error("Stored model configuration must have private owner-only permissions");
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  try {
    const stored = JSON.parse(raw) as StoredLlmConfig;
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      typeof stored.baseUrl !== "string" ||
      !stored.baseUrl ||
      typeof stored.model !== "string" ||
      !stored.model ||
      (stored.apiKey !== undefined && typeof stored.apiKey !== "string") ||
      (stored.reasoningEffort !== undefined && !isReasoningEffort(stored.reasoningEffort)) ||
      (stored.authMode !== undefined &&
        stored.authMode !== "api-key" &&
        stored.authMode !== "chatgpt") ||
      (stored.authMode === "chatgpt" &&
        (typeof stored.chatGptProfileId !== "string" || !stored.chatGptProfileId))
    )
      throw new Error("Invalid model configuration");
    return {
      reasoningEffort: stored.reasoningEffort,
      authMode: stored.authMode,
      chatGptProfileId: stored.chatGptProfileId,
      baseUrl: stored.baseUrl,
      model: stored.model,
      providerName: stored.providerName,
      apiKey: stored.apiKey,
      temperature: stored.temperature,
      maxTokens: stored.maxTokens,
      costPerInputToken: stored.costPerInputToken,
      costPerOutputToken: stored.costPerOutputToken,
    };
  } catch {
    throw new Error("Stored model configuration is invalid; repair it before invoking a provider");
  }
}

/** Remove only the saved credential; model and accounting preferences survive. */
export function forgetStoredLlmApiKey(): boolean {
  const stored = loadLlmConfig();
  if (!stored?.apiKey) return false;
  saveLlmConfig({ ...stored, apiKey: undefined } as LlmConfig);
  return true;
}

/**
 * Get the API key hint from stored config (first 8 chars).
 */
export function getStoredApiKeyHint(): string | undefined {
  const stored = loadLlmConfig();
  return stored?.apiKey ? stored.apiKey.slice(0, 8) + "..." : undefined;
}
