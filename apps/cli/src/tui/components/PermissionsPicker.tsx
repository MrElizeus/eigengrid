import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import {
  PERMISSION_PRESETS,
  type PermissionPresetId,
} from "@eigengrid/agent/execution-permissions";
import {
  inspectOperatorSandbox,
  assertOperatorSandboxWorkspace,
  OPERATOR_SANDBOX_LIMITS,
} from "@eigengrid/runners/operator-sandbox";
import {
  loadOperatorPermissions,
  saveOperatorPermissions,
} from "../../services/operator-permission-store";
import { consoleTheme as palette } from "../../presentation/console-theme";
import { terminalText } from "../terminal";

export function PermissionsPicker({
  onCancel,
  onSelect,
}: {
  onCancel: () => void;
  onSelect: (id: PermissionPresetId) => void;
}): ReactNode {
  const [current] = useState(() => {
    try {
      return loadOperatorPermissions().preset;
    } catch {
      return undefined;
    }
  });
  const [index, setIndex] = useState(
    Math.max(
      0,
      PERMISSION_PRESETS.findIndex((preset) => preset.id === current),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sandbox, setSandbox] = useState<{ available: boolean; reason: string }>();
  useEffect(() => {
    let active = true;
    void inspectOperatorSandbox().then((result) => {
      if (active) setSandbox(result);
    });
    return () => {
      active = false;
    };
  }, []);
  const selected = PERMISSION_PRESETS[index];
  useInput((_input, key) => {
    if (saving) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || key.downArrow || key.tab) {
      setIndex(
        (value) =>
          (value + (key.upArrow ? -1 : 1) + PERMISSION_PRESETS.length) % PERMISSION_PRESETS.length,
      );
      setError("");
    } else if (key.return) {
      setSaving(true);
      void (async () => {
        if (selected.id === "sandboxed") {
          assertOperatorSandboxWorkspace(process.cwd());
          const status = await inspectOperatorSandbox();
          if (!status.available) throw new Error(status.reason);
        }
        saveOperatorPermissions(selected.id);
        onSelect(selected.id);
      })().catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not save permissions");
        setSaving(false);
      });
    }
  });
  return (
    <Box
      borderStyle="round"
      borderColor={error ? palette.warn : palette.accent}
      paddingX={1}
      flexDirection="column"
      marginTop={1}
    >
      <Text bold color={palette.accent}>
        PERMISSIONS / EXECUTION AND APPROVAL
      </Text>
      <Text color={palette.muted}>
        Select an execution and approval preset · ↑↓ to move · Enter to select · Esc back
      </Text>
      {PERMISSION_PRESETS.map((preset, row) => (
        <Text
          key={preset.id}
          color={row === index ? palette.accent : palette.muted}
          wrap="truncate-end"
        >
          {row === index ? "▸" : " "} {preset.name}
          {preset.id === current ? " · current" : ""}
        </Text>
      ))}
      <Text>{selected.description}</Text>
      <Text color={palette.dim}>
        Approval: {selected.approvalPolicy} · Execution scope: {selected.executionScope}
      </Text>
      {selected.id === "auto-review" && (
        <Text color={palette.dim}>
          Deterministic host reviewer · bounded scientific input edits · risky actions require human
          approval
        </Text>
      )}
      {selected.id === "sandboxed" && (
        <>
          <Text color={sandbox?.available ? palette.muted : palette.warn}>
            {sandbox?.reason ?? "Checking host isolation…"}
          </Text>
          <Text color={palette.dim}>
            {OPERATOR_SANDBOX_LIMITS.cpuPercent}% CPU · 4 GiB memory · 256 processes · 1 hour per
            job · 64 MiB per file · network denied
          </Text>
          <Text color={palette.dim}>
            Workspace inputs read-only · job directory writable · arbitrary commands and remote
            submissions disabled
          </Text>
        </>
      )}
      {selected.id === "full-access" && (
        <Text color={palette.warn}>
          Tools can modify files and run programs as the current OS user. Execution remains audited.
        </Text>
      )}
      {error && <Text color={palette.warn}>{terminalText(error)}</Text>}
      <Text color={palette.dim}>
        {saving
          ? "Saving permissions…"
          : "Applies to this workspace · saved privately for the current OS user"}
      </Text>
    </Box>
  );
}
