// ────────────────────────────────────────────────────────────
// runWithContext — reusable command composition helper
// ────────────────────────────────────────────────────────────
// Prevents duplicated context creation/close logic across all
// CLI commands that need an ApplicationContext.
//
// Usage (production):
//   await runWithContext(async (ctx) => { ... });
//
// Usage (test injection):
//   await runWithContext(async (ctx) => { ... }, deps.createContext);
// ────────────────────────────────────────────────────────────

import { createApplicationContext, ApplicationContext } from "./context";
import type { ContextOverrides } from "./types";

/**
 * Factory function signature that commands accept as a seam for
 * test injection or production use.
 */
export type CreateContextFn = (overrides?: ContextOverrides) => Promise<ApplicationContext>;

/**
 * Wrap command execution with ApplicationContext lifecycle.
 *
 * Creates a context (via production factory or injected seam),
 * runs `fn` with it, and **always** closes the context when
 * `fn` settles — whether it resolves or throws.
 *
 * Errors from context creation itself are **not** caught here;
 * the caller should handle them (e.g. "Database not initialized").
 */
export async function runWithContext<T>(
  fn: (ctx: ApplicationContext) => Promise<T>,
  createContext?: CreateContextFn,
): Promise<T> {
  const createFn: CreateContextFn = createContext ?? (createApplicationContext as CreateContextFn);
  const ctx = await createFn();
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}
