import { ChatGptAuth, configureLlm, loadLlmConfig, type LlmConfig } from "@eigengrid/agent";

/** Read the CLI-owned connection; the web surface never writes credentials or selects accounts. */
export function readWebConnection(directory: string) {
  let config: Partial<LlmConfig> | null;
  try {
    config = loadLlmConfig(directory);
  } catch {
    return {
      config: null,
      state: {
        configured: false,
        model: null,
        provider: null,
        authMode: null,
        reason: "The CLI configuration cannot be read safely. Check it in the terminal.",
      },
    };
  }
  if (!config)
    return {
      config: null,
      state: {
        configured: false,
        model: null,
        provider: null,
        authMode: null,
        reason: "Conecta un proveedor en el CLI con /connect y elige un modelo con /models.",
      },
    };
  let ready = false;
  try {
    ready =
      config.authMode === "chatgpt"
        ? new ChatGptAuth()
            .accounts()
            .some((a) => a.id === config.chatGptProfileId && a.connected && a.sharing)
        : !!(
            config.apiKey ||
            process.env.LLM_API_KEY ||
            process.env.OPENCODE_API_KEY ||
            process.env.OPENAI_API_KEY ||
            process.env.ANTHROPIC_API_KEY ||
            (config.baseUrl &&
              ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.baseUrl).hostname))
          );
  } catch {
    ready = false;
  }
  return {
    config,
    state: {
      configured: ready,
      model: config.model ?? null,
      provider: config.providerName ?? null,
      authMode: config.authMode ?? "api-key",
      reason: ready
        ? null
        : "The CLI connection requires authentication. Open eigengrid and use /connect.",
    },
  };
}

export function activateWebConnection(directory: string) {
  const { config, state } = readWebConnection(directory);
  if (!state.configured || !config)
    throw new Error(state.reason ?? "Configure the connection in the CLI.");
  // Explicitly clear fields when the CLI removes them; a previous account/key must not survive.
  configureLlm({
    ...config,
    authMode: config.authMode ?? "api-key",
    chatGptProfileId: config.chatGptProfileId,
    apiKey: config.apiKey,
  });
}
