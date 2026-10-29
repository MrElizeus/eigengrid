import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import {
  ChatGptAuth,
  CHATGPT_USAGE_URL,
  type CatalogProvider,
  type ChatGptAccount,
  type ChatGptModel,
  type ReasoningEffort,
} from "@eigengrid/agent";
import { openSystemBrowser } from "@eigengrid/agent/chatgpt-auth";
import { consoleTheme as palette } from "../../presentation/console-theme";
import { terminalText, useTerminalSize } from "../terminal";
import { VariantPicker } from "./VariantPicker";

export type ProviderConnection =
  | { type: "api-key" }
  | {
      type: "chatgpt";
      profileId: string;
      model: ChatGptModel;
      account: string;
      reasoningEffort?: ReasoningEffort;
    };

interface Props {
  provider: CatalogProvider;
  onBack: () => void;
  onConnect: (connection: ProviderConnection) => Promise<void> | void;
  onAccountConnected: (account: ChatGptAccount) => Promise<void> | void;
}

export function ProviderAuthPicker({
  provider,
  onBack,
  onConnect,
  onAccountConnected,
}: Props): ReactNode {
  const { rows } = useTerminalSize();
  const auth = useRef(new ChatGptAuth()).current;
  const [phase, setPhase] = useState<"methods" | "accounts" | "browser" | "models">("methods");
  const [index, setIndex] = useState(0);
  const [accounts, setAccounts] = useState<ChatGptAccount[]>([]);
  const [models, setModels] = useState<ChatGptModel[]>([]);
  const [account, setAccount] = useState<ChatGptAccount>();
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const [pending, setPending] = useState(false);
  const [variantModel, setVariantModel] = useState<ChatGptModel>();
  const [browserUnavailable, setBrowserUnavailable] = useState(false);
  const attempt = useRef<AbortController>();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      attempt.current?.abort();
    },
    [],
  );

  const methods =
    provider.id === "openai" ? ["Continue with ChatGPT", "Use API key"] : ["Use API key"];
  const options =
    phase === "methods"
      ? methods
      : phase === "accounts"
        ? [
            ...accounts.map(
              (a) => a.label + (a.sharing ? " · plan enabled" : " · sign-in required"),
            ),
            "Add a ChatGPT account",
          ]
        : models.map((m) => `${m.name} <${m.id}>`);

  const showAccounts = () => {
    try {
      setAccounts(auth.accounts());
      setError("");
    } catch (cause) {
      setAccounts([]);
      setError(cause instanceof Error ? cause.message : "Could not read ChatGPT accounts");
    }
    setPhase("accounts");
    setIndex(0);
  };

  const chooseAccount = async (existing?: ChatGptAccount, reconnect = false) => {
    const controller = new AbortController();
    attempt.current = controller;
    setPending(true);
    setError("");
    setLink("");
    setBrowserUnavailable(false);
    try {
      let selected = existing;
      if (reconnect || !selected?.connected || !selected.sharing) {
        setPhase("browser");
        selected = await auth.signIn({
          profileId: existing?.id,
          signal: controller.signal,
          onLink: setLink,
          onBrowserUnavailable: () => setBrowserUnavailable(true),
        });
      }
      if (!selected.sharing)
        throw new Error(
          "Signed in, but ChatGPT plan usage was not authorized. Reconnect to grant access or choose API key.",
        );
      controller.signal.throwIfAborted();
      await onAccountConnected(selected);
      const available = await auth.models(selected.id);
      controller.signal.throwIfAborted();
      if (!mounted.current || attempt.current !== controller) return;
      if (!available.length) throw new Error("No models are available for this ChatGPT account.");
      setAccount(selected);
      setModels(available);
      setIndex(0);
      setPhase("models");
    } catch (cause) {
      if (mounted.current && attempt.current === controller && !controller.signal.aborted) {
        showAccounts();
        setError(cause instanceof Error ? cause.message : "ChatGPT connection failed. Try again.");
      }
    } finally {
      if (mounted.current && attempt.current === controller) setPending(false);
    }
  };

  const select = async () => {
    setError("");
    if (phase === "methods") {
      if (methods[index] === "Continue with ChatGPT") {
        showAccounts();
        return;
      }
      setPending(true);
      try {
        await onConnect({ type: "api-key" });
      } finally {
        if (mounted.current) setPending(false);
      }
    } else if (phase === "accounts") {
      await chooseAccount(accounts[index]);
    } else if (phase === "models" && account && models[index]) {
      setVariantModel(models[index]);
    }
  };

  useInput((input, key) => {
    if (variantModel) return;
    if (key.escape) {
      if (phase === "browser" || pending) {
        attempt.current?.abort();
        setPending(false);
        showAccounts();
      } else if (phase === "methods") onBack();
      else {
        setPhase(phase === "models" ? "accounts" : "methods");
        setIndex(0);
        setError("");
      }
      return;
    }
    if (pending) return;
    if (input === "r" && phase === "accounts" && accounts[index]) {
      void chooseAccount(accounts[index], true);
      return;
    }
    if (input === "u" && provider.id === "openai") {
      void openSystemBrowser(CHATGPT_USAGE_URL).catch(() =>
        setError(`Manage usage: ${CHATGPT_USAGE_URL}`),
      );
      return;
    }
    if (input === "d" && phase === "accounts" && accounts[index]) {
      setPending(true);
      void auth
        .signOut(accounts[index].id)
        .then(({ revoked }) => {
          if (!mounted.current) return;
          showAccounts();
          if (!revoked)
            setError(
              "Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT settings.",
            );
        })
        .catch(() => {
          if (mounted.current)
            setError(
              "Could not confirm sign-out. Retry or disconnect the app in ChatGPT settings.",
            );
        })
        .finally(() => {
          if (mounted.current) setPending(false);
        });
      return;
    }
    if (key.upArrow) setIndex((i) => (i - 1 + options.length) % options.length);
    else if (key.downArrow || key.tab) setIndex((i) => (i + 1) % options.length);
    else if (key.return)
      void select().catch((cause) => {
        if (mounted.current) setError(cause instanceof Error ? cause.message : "Connection failed");
      });
  });

  const limit = Math.max(2, Math.min(7, rows - 14));
  if (variantModel && account)
    return (
      <VariantPicker
        model={variantModel}
        onBack={() => setVariantModel(undefined)}
        onSelect={(model, reasoningEffort) =>
          Promise.resolve(
            onConnect({
              type: "chatgpt",
              profileId: account.id,
              model,
              reasoningEffort,
              account: account.label,
            }),
          )
        }
      />
    );
  const start = Math.max(0, Math.min(index - 2, options.length - limit));
  return (
    <Box
      borderStyle="round"
      borderColor={palette.accent}
      paddingX={1}
      flexDirection="column"
      marginTop={1}
    >
      <Text color={palette.accent} bold>
        CONNECT / {terminalText(provider.name)} /{" "}
        {phase === "methods" ? "AUTHENTICATION" : phase.toUpperCase()}
      </Text>
      <Text color={palette.muted}>↑↓ to move · Enter to select · Esc back</Text>
      {phase === "browser" ? (
        <>
          <Text>Continue with ChatGPT in your browser. Waiting for authorization…</Text>
          {browserUnavailable && (
            <Text color={palette.warn}>Browser could not open. Open this link manually:</Text>
          )}
          <Text wrap="wrap">{terminalText(link)}</Text>
        </>
      ) : (
        <>
          {options.slice(start, start + limit).map((label, row) => (
            <Text
              key={`${phase}-${start + row}`}
              color={start + row === index ? palette.accent : palette.muted}
            >
              {start + row === index ? "▸" : " "} {terminalText(label)}
            </Text>
          ))}
          {phase === "models" && (
            <Text>
              Using ChatGPT plan · {terminalText(account?.label ?? "")} · Access verified by a
              completed response
            </Text>
          )}
          {pending && <Text>Connecting…</Text>}
        </>
      )}
      {provider.id === "openai" && (
        <Text color={palette.dim}>
          u manage ChatGPT usage
          {phase === "accounts" ? " · r reconnect · d sign out highlighted account" : ""}
        </Text>
      )}
      {error && (
        <Text color={palette.warn} wrap="wrap">
          {terminalText(error)}
        </Text>
      )}
    </Box>
  );
}
