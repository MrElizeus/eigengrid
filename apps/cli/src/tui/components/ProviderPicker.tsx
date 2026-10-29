import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";

import { fetchCatalog, type CatalogProvider, type ChatGptAccount } from "@eigengrid/agent";

import { filterProviders, sortProviders, selectableProviders } from "../provider-selection";
import { terminalText, useTerminalSize } from "../terminal";

import { consoleTheme as palette } from "../../presentation/console-theme";
import { ProviderAuthPicker, type ProviderConnection } from "./ProviderAuthPicker";

interface ProviderPickerProps {
  initialProvider?: CatalogProvider;
  onSelect: (provider: CatalogProvider, connection: ProviderConnection) => Promise<void> | void;
  onCancel: () => void;
  onAccountConnected: (account: ChatGptAccount) => Promise<void> | void;
}

export function ProviderPicker({
  onSelect,
  onCancel,
  initialProvider,
  onAccountConnected,
}: ProviderPickerProps): ReactNode {
  const { rows } = useTerminalSize();
  const maxVisible = Math.max(2, Math.min(7, rows - 13));
  const [attempt, setAttempt] = useState(0);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [excludedCount, setExcludedCount] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [authProvider, setAuthProvider] = useState<CatalogProvider | undefined>(initialProvider);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const catalog = await fetchCatalog();
        if (!active) return;
        const all = Object.values(catalog);
        const supported = selectableProviders(all);
        setProviders(sortProviders(supported));
        setExcludedCount(all.length - supported.length);
        setLoading(false);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [attempt]);

  const visibleProviders = useMemo(() => filterProviders(providers, query), [providers, query]);

  useEffect(() => {
    setSelectedIndex((index) => {
      if (visibleProviders.length === 0) return 0;
      return Math.min(index, visibleProviders.length - 1);
    });
  }, [visibleProviders.length]);

  const selectCurrent = async () => {
    const provider = visibleProviders[selectedIndex];
    if (!provider || submitting) return;
    setSubmitting(true);
    try {
      setAuthProvider(provider);
    } finally {
      setSubmitting(false);
    }
  };

  useInput((input, key) => {
    if (authProvider) return;
    if (submitting) return;

    if (key.escape) {
      onCancel();
      return;
    }

    if (error && input === "r") {
      setAttempt((value) => value + 1);
      return;
    }
    if (loading || error || key.ctrl || key.meta) return;

    if (key.return) {
      void selectCurrent();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((index) =>
        visibleProviders.length > 0
          ? (index - 1 + visibleProviders.length) % visibleProviders.length
          : 0,
      );
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((index) =>
        visibleProviders.length > 0 ? (index + 1) % visibleProviders.length : 0,
      );
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    if (input) {
      setQuery((value) => `${value}${terminalText(input)}`);
      setSelectedIndex(0);
    }
  });

  const total = visibleProviders.length;
  const start =
    total <= maxVisible ? 0 : Math.max(0, Math.min(selectedIndex - 2, total - maxVisible));
  const visible = visibleProviders.slice(start, start + maxVisible);

  if (authProvider)
    return (
      <ProviderAuthPicker
        provider={authProvider}
        onBack={() => setAuthProvider(undefined)}
        onAccountConnected={onAccountConnected}
        onConnect={(connection) => onSelect(authProvider, connection)}
      />
    );

  return (
    <Box
      borderStyle="round"
      borderColor={error ? palette.warn : palette.accent}
      paddingX={1}
      paddingY={0}
      flexDirection="column"
      marginTop={1}
    >
      <Text color={palette.accent} bold>
        CONNECT / {submitting ? "SAVING…" : "SELECT PROVIDER"}
      </Text>
      <Text color={palette.muted}>
        Type to filter · ↑↓ to move · Enter to select · Esc to cancel
      </Text>
      <Text color={palette.muted}>
        Source: models.dev · Compatible providers · Access not tested
      </Text>
      <Text color={palette.dim} wrap="truncate-end">
        Filter: {query || "(all providers)"}
      </Text>

      {loading ? (
        <Text color={palette.muted}>Loading providers…</Text>
      ) : error ? (
        <Box flexDirection="column">
          <Text color={palette.warn} wrap="truncate-end">
            ! Catalog unavailable: {terminalText(error)}
          </Text>
          <Text color={palette.muted}>r retry · Esc return to the operator</Text>
        </Box>
      ) : total === 0 ? (
        <Text color={palette.warn}>No providers match “{query}”.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((provider, index) => {
            const absoluteIndex = start + index;
            const selected = absoluteIndex === selectedIndex;
            const modelCount = Object.keys(provider.models).length;
            return (
              <Text
                key={provider.id}
                color={selected ? palette.accent : palette.muted}
                bold={selected}
                wrap="truncate-end"
              >
                {selected ? "▸" : " "} {terminalText(provider.name)} {"<"}
                {terminalText(provider.id)}
                {">"} ({modelCount} compatible models)
              </Text>
            );
          })}
        </Box>
      )}
      {!loading && !error && (
        <Text color={palette.dim}>
          {total ? `${start + 1}–${start + visible.length} of ${total}` : "0 matches"} · Selection
          updates your local provider configuration
        </Text>
      )}
      {!loading && !error && excludedCount > 0 && (
        <Text color={palette.dim}>
          {excludedCount} providers omitted: unsupported integration or missing endpoint
        </Text>
      )}
    </Box>
  );
}
