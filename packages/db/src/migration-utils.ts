/**
 * Split a migration script into executable statements without treating
 * semicolons inside quoted strings or SQL comments as statement boundaries.
 *
 * Migrations are still executed inside an adapter-owned transaction; this
 * helper only handles the script-to-statement boundary safely for the SQL
 * used by both providers.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (current === quote) {
        // SQL escapes a quote by doubling it ('' / "" / ``).
        if (next === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (current === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      continue;
    }
    if (current === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }

  const trailing = sql.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}
