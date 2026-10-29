import type { ReactNode } from "react";
import { Box, Text } from "ink";

// ── Color palette (matches Splash) ──────────────────────────────────────────

import { consoleTheme as palette } from "../../presentation/console-theme";
export { palette };

// ── Inline markdown (bold, inline code) ─────────────────────────────────────

export function renderInlineMd(messageId: string, text: string, lineIndex: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > lastIndex) {
      nodes.push(text.slice(lastIndex, at));
    }
    const token = match[0];
    const k = `${messageId}-inline-${lineIndex}-${tokenIndex++}`;
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <Text key={k} color={palette.value} bold>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <Text key={k} color={palette.warn}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      nodes.push(token);
    }
    lastIndex = at + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length > 0 ? nodes : [text];
}

// ── Table detection helpers ──────────────────────────────────────────────────

export function dedentLines(lines: string[]): string[] {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return lines.slice();

  const indents = nonEmpty.map((line) => (line.match(/^\s*/) ?? [""])[0].length);
  const trimBy = Math.min(...indents);
  return lines.map((line) => line.slice(trimBy).replace(/\s+$/, ""));
}

function isMdTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isMdTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?[-]{3,}:?\s*\|)+\s*:?[-]{3,}:?\s*\|?\s*$/.test(line);
}

function renderMdTable(messageId: string, lines: string[], tableIndex: number): ReactNode {
  const rows = lines
    .filter((l) => isMdTableLine(l) && !isMdTableSeparator(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );

  if (rows.length === 0) return null;
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col]?.length ?? 0)));

  return (
    <Box key={`${messageId}-table-${tableIndex}`} flexDirection="column">
      {rows.map((row, ri) => (
        <Text
          key={`${messageId}-table-${tableIndex}-row-${ri}`}
          color={ri === 0 ? palette.value : palette.text}
          bold={ri === 0}
        >
          {row
            .map((cell, ci) => {
              const pad = widths[ci] - cell.length;
              const content = `${cell}${" ".repeat(Math.max(0, pad))}`;
              return ci === 0 ? content : `  ${content}`;
            })
            .join(" | ")}
        </Text>
      ))}
    </Box>
  );
}

// ── Block markdown renderer ──────────────────────────────────────────────────

/**
 * Render markdown text as Ink ReactNodes.
 * All keys are message-scoped: `${messageId}-<kind>-${index}`.
 *
 * Supported:
 *   - Paragraphs
 *   - Blank lines (spacers)
 *   - Bullet lists (- / *)
 *   - Numbered lists
 *   - Headings (# ## ###)
 *   - Fenced code blocks (``` ```)
 *   - Tables (| col | col |)
 *   - Inline bold (**text**) and inline code (`code`)
 *   - Blockquotes (>)
 *   - Thought/reasoning lines (dim)
 */
export function renderMarkdownLite(messageId: string, text: string): ReactNode[] {
  const rawLines = text.split(/\r?\n/);
  const nodes: ReactNode[] = [];

  let i = 0;
  let tableIndex = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];

    // ── Fenced code block ───────────────────────────────
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < rawLines.length && !rawLines[i].trim().startsWith("```")) {
        codeLines.push(rawLines[i]);
        i++;
      }
      const normalized = dedentLines(codeLines);
      nodes.push(
        <Box
          key={`${messageId}-code-${nodes.length}`}
          flexDirection="column"
          marginY={0}
          paddingX={1}
          borderStyle="single"
          borderColor={palette.dim}
        >
          {lang && (
            <Text key={`${messageId}-codelang-${nodes.length}`} color={palette.dim}>
              {lang}
            </Text>
          )}
          {normalized.map((cl, ci) => (
            <Text key={`${messageId}-codeline-${nodes.length}-${ci}`} color={palette.value}>
              {cl}
            </Text>
          ))}
        </Box>,
      );
      i++; // skip closing ```
      continue;
    }

    // ── Markdown table ──────────────────────────────────
    if (isMdTableLine(line)) {
      const tableLines: string[] = [line];
      let j = i + 1;
      while (
        j < rawLines.length &&
        (isMdTableLine(rawLines[j]) || isMdTableSeparator(rawLines[j]))
      ) {
        tableLines.push(rawLines[j]);
        j++;
      }
      const tbl = renderMdTable(messageId, tableLines, tableIndex++);
      if (tbl) nodes.push(tbl);
      i = j;
      continue;
    }

    // ── Blank line ──────────────────────────────────────
    if (line.trim().length === 0) {
      nodes.push(<Box key={`${messageId}-blank-${nodes.length}`} />);
      i++;
      continue;
    }

    // ── Thought/reasoning lines ─────────────────────────
    const thoughtMatch = line.match(
      /^\s*(Thought|Thoughts|Thinking|Reasoning|Razonamiento|Pensamiento)[:：]?\s*(.*)$/i,
    );
    if (thoughtMatch) {
      const [, label, body] = thoughtMatch;
      nodes.push(
        <Box key={`${messageId}-thought-${nodes.length}`}>
          <Text color={palette.dim} dimColor>
            {label}: {renderInlineMd(messageId, body, nodes.length)}
          </Text>
        </Box>,
      );
      i++;
      continue;
    }

    // ── Heading ─────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const [, hashes, body] = headingMatch;
      const color = hashes.length === 1 ? palette.accent : palette.muted;
      nodes.push(
        <Text key={`${messageId}-heading-${nodes.length}`} color={color} bold>
          {renderInlineMd(messageId, body, nodes.length)}
        </Text>,
      );
      i++;
      continue;
    }

    // ── Bullet list ─────────────────────────────────────
    const bulletMatch = line.match(/^(\s*)([-*])\s+(.*)$/);
    if (bulletMatch) {
      const [, indent, marker, body] = bulletMatch;
      nodes.push(
        <Box key={`${messageId}-bullet-${nodes.length}`}>
          <Text color={palette.dim}>
            {indent}
            {marker}{" "}
          </Text>
          <Text color={palette.text}>{renderInlineMd(messageId, body, nodes.length)}</Text>
        </Box>,
      );
      i++;
      continue;
    }

    // ── Numbered list ────────────────────────────────────
    const numMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numMatch) {
      const [, indent, n, body] = numMatch;
      nodes.push(
        <Box key={`${messageId}-num-${nodes.length}`}>
          <Text color={palette.dim}>
            {indent}
            {n}.{" "}
          </Text>
          <Text color={palette.text}>{renderInlineMd(messageId, body, nodes.length)}</Text>
        </Box>,
      );
      i++;
      continue;
    }

    // ── Blockquote ───────────────────────────────────────
    if (line.startsWith(">")) {
      const body = line.replace(/^>\s?/, "");
      nodes.push(
        <Box key={`${messageId}-quote-${nodes.length}`}>
          <Text color={palette.dim} dimColor>
            │ {renderInlineMd(messageId, body, nodes.length)}
          </Text>
        </Box>,
      );
      i++;
      continue;
    }

    // ── Normal paragraph ─────────────────────────────────
    nodes.push(
      <Text key={`${messageId}-paragraph-${nodes.length}`} color={palette.text}>
        {renderInlineMd(messageId, line, nodes.length)}
      </Text>,
    );
    i++;
  }

  return nodes;
}
