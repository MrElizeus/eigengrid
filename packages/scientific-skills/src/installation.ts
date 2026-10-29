import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve shipped data independently of the operator's working directory. */
export function installedScientificSkillRoot(
  options: {
    override?: string;
    executable?: string;
    sourceUrl?: string;
  } = {},
): string {
  const override = options.override ?? process.env.EIGENGRID_SCIENTIFIC_SKILLS_ROOT;
  if (override !== undefined) {
    if (!override.trim()) throw new Error("Scientific skill root must not be empty");
    return resolve(override);
  }
  const executable = options.executable ?? process.execPath;
  const installed = resolve(dirname(executable), "../share/eigengrid/scientific-skills");
  if (existsSync(installed)) return installed;
  return fileURLToPath(new URL("../../../scientific-skills", options.sourceUrl ?? import.meta.url));
}
