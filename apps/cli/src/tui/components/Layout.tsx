import React from "react";
import { Box } from "ink";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <Box flexDirection="column" height="100%">
      {children}
    </Box>
  );
}
