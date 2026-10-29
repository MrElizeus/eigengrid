import { canonicalJson } from "@eigengrid/scientific-schema";

/** Stable machine output shared by CLI and programmatic callers. */
export function serializeScientificSkillOutput(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}
