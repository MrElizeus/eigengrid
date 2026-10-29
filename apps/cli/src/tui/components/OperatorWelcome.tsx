import { Box, Text } from "ink";
import { Header } from "./Header";
import { consoleTheme as t } from "../../presentation/console-theme";
import { useTerminalSize } from "../terminal";

export function OperatorWelcome() {
  const { columns } = useTerminalSize();
  return (
    <Box flexDirection="column" width={columns}>
      <Header mode="OPERATOR" compact={columns < 100} />
      <Box borderStyle="round" borderColor={t.border} paddingX={2} flexDirection="column">
        <Text color={t.text} bold>
          Your scientific workspace.
        </Text>
        <Text color={t.muted}>
          Inspect calculations, explore evidence and prepare your next workflow.
        </Text>
        <Text> </Text>
        <Text color={t.accent}>
          {"/help       "}
          <Text color={t.muted}>Explore commands</Text>
        </Text>
        <Text color={t.accent}>
          {"/connect    "}
          <Text color={t.muted}>Choose an AI provider</Text>
        </Text>
        <Text color={t.accent}>
          {"/configure  "}
          <Text color={t.muted}>Set up your API key privately</Text>
        </Text>
        <Text> </Text>
        <Text color={t.secondary}>Live operations → eigengrid dashboard</Text>
        <Text color={t.dim}>
          Run it in another terminal to follow jobs while using the operator.
        </Text>
      </Box>
    </Box>
  );
}
