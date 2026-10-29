import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import {
  discoverConfiguredModels,
  getLlmConfig,
  ModelConnectionRequiredError,
  type DiscoveredModels,
  type ChatGptModel,
  type ReasoningEffort,
} from "@eigengrid/agent";
import { consoleTheme as palette } from "../../presentation/console-theme";
import { terminalText, useTerminalSize } from "../terminal";
import { VariantPicker } from "./VariantPicker";

interface Props {
  onSelect: (model: ChatGptModel, effort?: ReasoningEffort) => Promise<void>;
  onConnect: () => void;
  onCancel: () => void;
}

export function ModelPicker({ onSelect, onConnect, onCancel }: Props): ReactNode {
  const { rows } = useTerminalSize();
  const [catalog, setCatalog] = useState<DiscoveredModels>();
  const [error, setError] = useState("");
  const [needsConnection, setNeedsConnection] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [variantModel, setVariantModel] = useState<ChatGptModel>();
  const [attempt, setAttempt] = useState(0);
  const config = getLlmConfig();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setNeedsConnection(false);
    setCatalog(undefined);
    void discoverConfiguredModels(undefined, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setCatalog(data);
        setIndex(
          Math.max(
            0,
            data.models.findIndex((model) => model.id === getLlmConfig().model),
          ),
        );
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setNeedsConnection(cause instanceof ModelConnectionRequiredError);
        setError(cause instanceof Error ? cause.message : "Could not load provider models");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  const models = useMemo(
    () =>
      catalog?.models.filter((model) =>
        `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()),
      ) ?? [],
    [catalog, query],
  );
  useEffect(() => {
    setIndex((value) => Math.min(value, Math.max(0, models.length - 1)));
  }, [models.length]);
  useInput((input, key) => {
    if (variantModel) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (error) {
      if ((needsConnection && key.return) || input === "c") onConnect();
      else if (input === "r") setAttempt((value) => value + 1);
      return;
    }
    if (loading) return;
    if (key.upArrow)
      setIndex((value) => (models.length ? (value - 1 + models.length) % models.length : 0));
    else if (key.downArrow || key.tab)
      setIndex((value) => (models.length ? (value + 1) % models.length : 0));
    else if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      setIndex(0);
    } else if (key.return && models[index]) {
      setVariantModel(models[index]);
    } else if (input && !key.ctrl && !key.meta) {
      setQuery((value) => value + terminalText(input));
      setIndex(0);
    }
  });
  const limit = Math.max(2, Math.min(7, rows - 15));
  const start = Math.max(0, Math.min(index - 2, models.length - limit));
  const mode = config.authMode === "chatgpt" ? "CHATGPT ACCOUNT" : "API KEY";
  if (variantModel)
    return (
      <VariantPicker
        model={variantModel}
        onBack={() => setVariantModel(undefined)}
        onSelect={onSelect}
      />
    );
  return (
    <Box
      borderStyle="round"
      borderColor={error ? palette.warn : palette.accent}
      paddingX={1}
      flexDirection="column"
      marginTop={1}
    >
      <Text color={palette.accent} bold>
        MODELS / {terminalText(catalog?.provider ?? config.providerName ?? "Choose provider")} /{" "}
        {mode}
      </Text>
      <Text color={palette.muted}>Type to filter · ↑↓ to move · Enter variants · Esc back</Text>
      {catalog && (
        <Text color={palette.muted}>
          Source: {terminalText(catalog.source)}
          {catalog.account ? ` · ${terminalText(catalog.account)}` : ""}
        </Text>
      )}
      {loading ? (
        <Text>Loading models from the selected provider…</Text>
      ) : error ? (
        <>
          <Text color={palette.warn} wrap="wrap">
            {terminalText(error)}
          </Text>
          <Text>
            {needsConnection ? "Enter choose account or API key" : "r retry"} · c change connection
            · Esc back
          </Text>
        </>
      ) : (
        <>
          <Text color={palette.dim}>Filter: {query || "(all available models)"}</Text>
          {models.slice(start, start + limit).map((model, row) => (
            <Text
              key={model.id}
              color={start + row === index ? palette.accent : palette.muted}
              wrap="truncate-end"
            >
              {start + row === index ? "▸" : " "} {terminalText(model.name)} {"<"}
              {terminalText(model.id)}
              {">"}
              {model.id === config.model
                ? ` · current · ${config.reasoningEffort ?? "default"}`
                : ""}
            </Text>
          ))}
          {!models.length && <Text>No active conversational models match this selection.</Text>}
          <Text color={palette.dim}>
            {models.length} available
            {catalog?.excluded
              ? ` · ${catalog.excluded} retired or incompatible entries omitted`
              : ""}
          </Text>
          <Text color={palette.dim}>
            Provider-reported availability · A completed response confirms access
          </Text>
        </>
      )}
    </Box>
  );
}
