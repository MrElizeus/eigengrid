import React from "react";
import { Text } from "ink";

export function StatusBadge({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "green"
      : status === "running"
        ? "yellow"
        : status === "failed"
          ? "red"
          : "white";
  return <Text color={color}>{status}</Text>;
}
