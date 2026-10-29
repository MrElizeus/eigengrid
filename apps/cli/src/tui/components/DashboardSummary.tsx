import { Box, Text } from "ink";
import type { DashboardView } from "../dashboard/dashboard-controller";
import { consoleTheme as t } from "../../presentation/console-theme";

export function DashboardSummary({ view }: { view: DashboardView }) {
  const jobs = view.snapshot?.jobs;
  const items = [
    {
      label: "RUNNING",
      count: jobs?.filter((j) => j.status === "running").length,
      color: t.accent,
    },
    {
      label: "WAITING",
      count: jobs?.filter((j) => ["created", "queued", "staged"].includes(j.status)).length,
      color: t.warn,
    },
    {
      label: "FINISHED",
      count: jobs?.filter((j) => ["completed", "parsed"].includes(j.status)).length,
      color: t.success,
    },
    { label: "FAILED", count: jobs?.filter((j) => j.status === "failed").length, color: t.error },
  ];
  return (
    <Box height={4} flexShrink={0}>
      {items.map((item) => (
        <Box
          key={item.label}
          width="25%"
          borderStyle="round"
          borderColor={t.border}
          paddingX={1}
          flexDirection="column"
        >
          <Text color={t.dim}>{item.label}</Text>
          <Text color={item.color} bold>
            {item.count ?? "—"}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
