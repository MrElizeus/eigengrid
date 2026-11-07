import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInput } from "@eigengrid/agent";
import { verifyPlanArtifact } from "@eigengrid/mission-runtime";
import { ScientificPlanningSession } from "./scientific-planning";
import {
  planningModel,
  planningRuntime,
  planSteps,
  proposal,
  protocolRef,
  questions,
} from "./fixtures/planning";

const directories: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "eigengrid-planning-"));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("interactive scientific planning", () => {
  test("assembles a long plan in bounded model responses and saves only its complete revision", async () => {
    const session = new ScientificPlanningSession(directory());
    const { stages, decisions, ...overview } = proposal;
    const expanded = Array.from({ length: 10 }, (_, n) => ({
      ...stages[0],
      id: `stage-${n}`,
      dependsOn: n ? [`stage-${n - 1}`] : [],
      description: "Document the input checks, measured diagnostics and recovery conditions. "
        .repeat(35)
        .trim(),
    }));
    const fixture = planningModel([
      ...planSteps().slice(0, 2),
      { name: "update-campaign-plan", input: { overview } },
      ...expanded.map((stage) => ({ name: "update-campaign-plan", input: { stage } })),
      { name: "update-campaign-plan", input: { decision: decisions[0] } },
      { name: "update-campaign-plan", input: { save: true } },
      "The complete staged proposal was saved.",
    ]);
    let draftObservations = 0;
    for await (const event of session.run("Plan a detailed campaign", planningRuntime(), {
      model: fixture.model,
      ask: async () => undefined,
    })) {
      if (event.type === "error") throw new Error(event.message);
      if (
        event.type === "tool-result" &&
        JSON.stringify(event.result).includes('"working-draft"')
      ) {
        draftObservations++;
        expect(await session.store.list()).toHaveLength(0);
      }
    }
    expect(draftObservations).toBe(12);
    expect(session.artifact?.workGraph.proposal).toMatchObject({ stages: expanded });
    expect(JSON.stringify(session.artifact?.workGraph.proposal).length).toBeGreaterThan(25000);
    expect(await session.store.list()).toHaveLength(1);
    expect(
      fixture.requests.every(
        (request) => (request as { maxOutputTokens: number }).maxOutputTokens === 2048,
      ),
    ).toBe(true);
  });
  test("researches, waits for an answer, acquires an asset and saves a visible revision with provenance", async () => {
    const runtime = planningRuntime(true);
    const session = new ScientificPlanningSession(directory(), {
      sourceLoader: async (url) => ({
        url,
        bytes: Buffer.from("ATOM      1  CA  ALA A   1      1.000   2.000   3.000\n"),
        contentType: "text/plain",
      }),
    });
    const fixture = planningModel([
      ...planSteps().slice(0, 2),
      {
        name: "inspect-protocol",
        input: {
          id: protocolRef.id,
          cursor: { fragment: 1, character: 0 },
          corpusDigest: "fixture-corpus",
        },
      },
      { name: "ask-planning-questions", input: questions },
      {
        name: "acquire-planning-asset",
        input: { url: "https://files.rcsb.org/download/TEST.pdb" },
      },
      ...planSteps().slice(2),
    ]);
    let asked = false;
    let history: AgentInput["history"] = [];
    let text = "";
    for await (const event of session.run(
      "Plan the campaign with the ligand already discussed.",
      runtime,
      {
        model: fixture.model,
        history: [
          {
            role: "user",
            content:
              "The target protein and ligand have been specified; use the reference experiment.",
          },
        ],
        ask: async (request) => {
          expect(request).toEqual(questions);
          expect(fixture.requests).toHaveLength(4);
          asked = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(fixture.requests).toHaveLength(4); // inference waits, no default auto-submission
          return { temperature: "300 K" };
        },
      },
    )) {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") history = event.messages;
      if (event.type === "text") text += event.text;
    }
    expect(asked).toBe(true);
    expect(fixture.requests).toHaveLength(7);
    expect(JSON.stringify(fixture.requests[0])).toContain("target protein and ligand");
    expect(JSON.stringify(fixture.requests[4])).toContain("300 K");
    expect(JSON.stringify(history)).toContain("ask-planning-questions");
    expect(text).toContain("Campaign stages");
    expect(text).toContain("300 K");
    expect(session.artifact?.humanInputs).toHaveLength(1);
    expect(verifyPlanArtifact(session.artifact).ok).toBe(true);
    const asset = session.sources.assets[0];
    expect(session.artifact?.evidence).toContainEqual(
      expect.objectContaining({ sha256: asset.sha256, kind: "acquired-asset" }),
    );
    expect(JSON.parse(readFileSync(asset.path + ".json", "utf8")).sourceUrl).toContain(
      "files.rcsb.org",
    );
    const revised = structuredClone(proposal);
    revised.decisions[0].choice = "310 K";
    revised.stages[0].parameters.temperature = "310 K; user changed the target";
    const next = planningModel([
      { name: "save-campaign-plan", input: revised },
      "Updated the requested temperature.",
    ]);
    for await (const event of session.run("Change temperature to 310 K", runtime, {
      model: next.model,
      history,
      ask: async () => {
        throw new Error("Do not re-ask the stated temperature");
      },
    }))
      if (event.type === "error") throw new Error(event.message);
    expect(session.artifact?.revision).toBe(2);
    expect(session.artifact?.priorRevision).toBe(1);
    expect(await session.store.list(session.planId)).toHaveLength(2);
    expect(runtime.effects()).toBe(0);
  });

  test("Full Access cannot expose or dispatch execution tools during planning", async () => {
    const runtime = planningRuntime();
    const session = new ScientificPlanningSession(directory());
    const tools = session.createTools(runtime, { ask: async () => undefined });
    for (const name of ["run-command", "write-file", "submit-job", "cancel-job"]) {
      expect(tools.materialize().definitions.some((t) => t.name === name)).toBe(false);
      expect((await tools.settleAuthorized({ id: name, name, input: {} }, runtime.ctx)).ok).toBe(
        false,
      );
    }
    expect(runtime.effects()).toBe(0);
  });

  test("uninspected and partially inspected protocols cannot be cited as complete", async () => {
    const runtime = planningRuntime(true);
    const session = new ScientificPlanningSession(directory());
    const tools = session.createTools(runtime, { ask: async () => undefined });
    await tools.settleAuthorized({ id: "list", name: "list-protocols", input: {} }, runtime.ctx);
    for (const partiallyInspected of [false, true]) {
      if (partiallyInspected)
        await tools.settleAuthorized(
          { id: "inspect", name: "inspect-protocol", input: { id: protocolRef.id } },
          runtime.ctx,
        );
      const result = await tools.settleAuthorized(
        { id: "save", name: "save-campaign-plan", input: proposal },
        runtime.ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Complete inspection");
    }
    expect(session.artifact).toBeUndefined();
  });

  test("cancelling a question does not fabricate an answer or save a placeholder", async () => {
    const session = new ScientificPlanningSession(directory());
    const controller = new AbortController();
    const fixture = planningModel([{ name: "ask-planning-questions", input: questions }]);
    for await (const _event of session.run("Plan", planningRuntime(), {
      signal: controller.signal,
      model: fixture.model,
      ask: async () => {
        controller.abort();
        return undefined;
      },
    })) {
      /* consume cancellation */
    }
    expect(fixture.requests).toHaveLength(1);
    expect(session.artifact).toBeUndefined();
    expect(await session.store.list()).toHaveLength(0);
  });
});
