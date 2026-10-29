import React from "react";
import { Box, Text } from "ink";

export function Sidebar() {
  return (
    <Box borderStyle="single" flexDirection="column" width={20} paddingX={1}>
      <Text bold>Nodes</Text>
      <Text dimColor> localhost</Text>
    </Box>
  );
}
