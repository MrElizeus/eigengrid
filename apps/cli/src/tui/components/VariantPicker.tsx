import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import {
  configuredModelVariants,
  getLlmConfig,
  modelVariants,
  type ChatGptModel,
  type ModelVariant,
  type ReasoningEffort,
} from "@eigengrid/agent";
import { consoleTheme as palette } from "../../presentation/console-theme";
import { terminalText, useTerminalSize } from "../terminal";

interface Props {
  model?: ChatGptModel;
  modelId?: string;
  onBack: () => void;
  onSelect: (model: ChatGptModel, effort?: ReasoningEffort) => Promise<void>;
}

export function VariantPicker({
  model: suppliedModel,
  modelId,
  onBack,
  onSelect,
}: Props): ReactNode {
  const { rows } = useTerminalSize();
  const [model, setModel] = useState(suppliedModel);
  const [variants, setVariants] = useState<ModelVariant[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const config = getLlmConfig();
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const resolve = suppliedModel
      ? Promise.resolve({
          model: suppliedModel,
          variants: modelVariants(suppliedModel, getLlmConfig()),
        })
      : configuredModelVariants(modelId);
    void resolve
      .then((data) => {
        if (!active) return;
        setModel(data.model);
        setVariants(data.variants);
        const current = getLlmConfig();
        setIndex(
          Math.max(
            0,
            data.variants.findIndex(
              (variant) =>
                current.model === data.model.id &&
                current.reasoningEffort === variant.reasoningEffort,
            ),
          ),
        );
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load variants");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [suppliedModel, modelId, attempt]);
  useInput((input, key) => {
    if (saving) return;
    if (key.escape) {
      onBack();
      return;
    }
    if (error) {
      if (input === "r") setAttempt((value) => value + 1);
      return;
    }
    if (loading) return;
    if (key.upArrow) setIndex((value) => (value - 1 + variants.length) % variants.length);
    else if (key.downArrow || key.tab) setIndex((value) => (value + 1) % variants.length);
    else if (key.return && model && variants[index]) {
      setSaving(true);
      void onSelect(model, variants[index].reasoningEffort).catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not save variant");
        setSaving(false);
      });
    }
  });
  const limit = Math.max(2, Math.min(8, rows - 14));
  const start = Math.max(0, Math.min(index - 2, variants.length - limit));
  return (
    <Box
      borderStyle="round"
      borderColor={error ? palette.warn : palette.accent}
      paddingX={1}
      flexDirection="column"
      marginTop={1}
    >
      <Text color={palette.accent} bold>
        VARIANTS / {terminalText(model?.name ?? modelId ?? config.model)} /{" "}
        {config.authMode === "chatgpt" ? "CHATGPT ACCOUNT" : "API KEY"}
      </Text>
      <Text color={palette.muted}>↑↓ to move · Enter to select · Esc back</Text>
      {loading ? (
        <Text>Loading reasoning variants for this model…</Text>
      ) : error ? (
        <>
          <Text color={palette.warn}>{terminalText(error)}</Text>
          <Text>r retry · Esc back</Text>
        </>
      ) : (
        <>
          {variants.slice(start, start + limit).map((variant, row) => (
            <Text
              key={variant.id}
              color={start + row === index ? palette.accent : palette.muted}
              wrap="truncate-end"
            >
              {start + row === index ? "▸" : " "} {terminalText(variant.name)}
              {config.model === model?.id && config.reasoningEffort === variant.reasoningEffort
                ? " · current"
                : ""}
            </Text>
          ))}
          <Text color={palette.muted} wrap="wrap">
            {terminalText(variants[index]?.description ?? "")}
          </Text>
          {variants.length === 1 && (
            <Text color={palette.dim}>
              This model exposes no additional reasoning variants for this access method.
            </Text>
          )}
          <Text color={palette.dim}>
            {saving
              ? "Saving model and variant…"
              : "Reasoning effort · Higher levels can use more time and tokens"}
          </Text>
        </>
      )}
    </Box>
  );
}
