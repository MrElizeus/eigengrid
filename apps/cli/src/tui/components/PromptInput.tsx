import type { ReactNode } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { consoleTheme as t } from "../../presentation/console-theme";

interface PromptInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  secret?: boolean;
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled,
  secret,
}: PromptInputProps): ReactNode {
  if (disabled) return null;
  return (
    <Box
      borderStyle="round"
      borderColor={secret ? t.warn : t.accent}
      paddingX={1}
      marginTop={1}
      flexDirection="column"
    >
      <Text color={secret ? t.warn : t.dim}>
        {secret ? "PRIVATE INPUT · API key · Esc cancels" : "COMMAND / CONVERSATION"}
      </Text>
      <Box>
        <Text color={t.accent}>{secret ? "key › " : "› "}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          mask={
            secret || /^\s*\/(?:key\s+(?!--forget)|models?\s+set\s+apiKey\s+)/i.test(value)
              ? "•"
              : undefined
          }
          placeholder={
            secret ? "Paste your key; input is hidden" : "Ask the operator, or type / for commands"
          }
        />
      </Box>
    </Box>
  );
}
