import { consoleTheme } from "../presentation/console-theme";
export const COLORS = {
  primary: consoleTheme.accent,
  success: consoleTheme.success,
  warning: consoleTheme.warn,
  danger: consoleTheme.error,
  dim: consoleTheme.dim,
} as const;
