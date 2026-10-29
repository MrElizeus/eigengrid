import type { LoadedScientificSkill } from "./types";

export interface DeterministicHelper<I, O> {
  id: string;
  run(input: Readonly<I>): O;
}

/**
 * Application-owned pure helper registry. It never imports or executes code from a skill directory;
 * a manifest may only attribute an already-registered, digest-checked helper.
 */
export class DeterministicSkillHelperRegistry {
  private readonly helpers = new Map<string, DeterministicHelper<unknown, unknown>>();

  register<I, O>(helper: DeterministicHelper<I, O>): void {
    if (this.helpers.has(helper.id)) throw new Error(`Duplicate deterministic helper ${helper.id}`);
    this.helpers.set(helper.id, helper as DeterministicHelper<unknown, unknown>);
  }

  invoke<I, O>(skill: LoadedScientificSkill, helperId: string, input: Readonly<I>): O {
    const declaration = skill.manifest.helpers.find((helper) => helper.id === helperId);
    if (!declaration)
      throw new Error(`Skill ${skill.manifest.id} does not declare helper ${helperId}`);
    const helper = this.helpers.get(helperId);
    if (!helper) throw new Error(`Deterministic helper ${helperId} is not application-allowlisted`);
    return helper.run(input) as O;
  }
}
