import { existsSync } from "node:fs";
import type { CommandModule } from "yargs";
import { findLlmConfigPath, loadGlobalLlmConfig, loadLlmConfig } from "@eigengrid/agent";

export const modelConfigCommand: CommandModule = {
  command: "model-config",
  describe: "Inspect the selected private or global model without exposing credentials",
  builder: (y) =>
    y.option("global", {
      type: "boolean",
      default: false,
      describe: "Inspect only administrator-owned defaults",
    }),
  handler(argv) {
    const globalOnly = argv.global === true;
    const config = globalOnly ? loadGlobalLlmConfig() : loadLlmConfig();
    const source = config
      ? !globalOnly && existsSync(findLlmConfigPath())
        ? "private"
        : "global"
      : "unconfigured";
    const endpoint = config?.baseUrl ? new URL(config.baseUrl).origin : null;
    console.log(
      JSON.stringify(
        {
          source,
          provider: config?.providerName ?? null,
          model: config?.model ?? null,
          endpoint,
          authMode: config?.authMode ?? "api-key",
          storedCredentialPresent: Boolean(config?.apiKey),
        },
        null,
        2,
      ),
    );
  },
};
