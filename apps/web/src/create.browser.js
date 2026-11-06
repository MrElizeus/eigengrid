import { api, missionPath } from "./api.browser.js";
import { el, field, panel, busy, route, notify, inspect, confirmAction } from "./dom.browser.js";

/** @param {string} projectId @param {HTMLElement} host */
export function renderCreate(projectId, host) {
  const form = el("form", { class: "create-form" });
  const statement = el("textarea", {
    name: "statement",
    rows: 3,
    required: true,
    maxlength: 10000,
    placeholder: "Describe the scientific question this mission should answer.",
  });
  const targets = el("input", {
    name: "targets",
    required: true,
    placeholder: "e.g. relative conformer energies, optimized geometry",
  });
  const structure = el("input", { type: "file", name: "structure", required: true });
  const format = el(
    "select",
    { name: "format" },
    ...["xyz", "sdf", "mol", "pdb", "smiles", "inchi", "engine_input"].map((value) =>
      el("option", { value }, value.toUpperCase()),
    ),
  );
  const confidence = el(
    "select",
    { name: "confidence" },
    ...["exploratory", "screening", "defensible"].map((value) => el("option", { value }, value)),
  );
  const charge = el("input", {
    type: "number",
    step: 1,
    name: "charge",
    placeholder: "Unspecified",
  });
  const multiplicity = el("input", {
    type: "number",
    step: 1,
    min: 1,
    name: "multiplicity",
    placeholder: "Unspecified",
  });
  const engines = el("input", { name: "engines", required: true, placeholder: "e.g. orca" });
  const acceptance = el("textarea", {
    name: "acceptance",
    rows: 3,
    required: true,
    placeholder: "Define measurable conditions that a reviewer can use to accept this result.",
  });
  const environment = el("input", {
    name: "environment",
    placeholder: "e.g. gas phase, or a specified solvent model",
  });
  const offline = el("input", { type: "checkbox", name: "offline" });
  const amounts = {
    externalOperations: el("input", {
      type: "number",
      name: "operations",
      min: 0,
      step: 1,
      required: true,
    }),
    modelTokens: el("input", { type: "number", name: "tokens", min: 0, step: 1, required: true }),
    wallTimeSeconds: el("input", {
      type: "number",
      name: "walltime",
      min: 0,
      step: 1,
      required: true,
    }),
    cost: el("input", { type: "number", name: "cost", min: 0, step: "any", required: true }),
  };
  const submit = el(
    "button",
    { type: "submit", class: "button primary" },
    "Review & create mission",
  );
  const status = el("p", { class: "hint", role: "status" });
  form.append(
    panel(
      "01 / Scientific objective",
      field("Research question", statement),
      field("Target properties", targets, "Separate properties with commas."),
      field("Required confidence", confidence),
      field(
        "Acceptance criteria",
        acceptance,
        "One required criterion per line. Successful process termination alone does not establish scientific validity.",
      ),
    ),
    panel(
      "02 / Molecular system",
      field(
        "Structure file",
        structure,
        "Content is hashed and uploaded to the project's immutable artifact store. Maximum 64 MiB.",
      ),
      el(
        "div",
        { class: "form-grid" },
        field("File format", format),
        field("Total charge (optional)", charge),
        field("Multiplicity (optional)", multiplicity),
      ),
      field("Environmental model (optional)", environment),
    ),
    panel(
      "03 / Execution boundaries",
      field(
        "Allowed engines",
        engines,
        "Comma-separated engine identifiers available at your installation.",
      ),
      el("label", { class: "check" }, offline, "Require offline execution"),
      el(
        "p",
        { class: "hint" },
        "Material scientific changes require approval. This mission is created without launching a calculation.",
      ),
    ),
    panel(
      "04 / Budget limits",
      el(
        "div",
        { class: "form-grid" },
        field("External operations", amounts.externalOperations),
        field("Model tokens", amounts.modelTokens),
        field("Wall time (seconds)", amounts.wallTimeSeconds),
        field("Cost (configured unit)", amounts.cost),
      ),
      el(
        "p",
        { class: "hint" },
        "Enter explicit limits. A zero limit prevents consumption of that resource.",
      ),
    ),
    el(
      "div",
      { class: "actions" },
      el("a", { class: "button secondary", href: route(projectId) }, "Back to missions"),
      submit,
    ),
    status,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    void busy(submit, async () => {
      const file = structure.files?.[0];
      if (!file) throw new Error("Choose the molecular structure file.");
      const split = (/** @type {string} */ value) =>
        value
          .split(/[,\n]/u)
          .map((item) => item.trim())
          .filter(Boolean);
      const targetProperties = split(targets.value);
      const allowedEngines = split(engines.value);
      const criteria = acceptance.value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      if (
        !statement.value.trim() ||
        !targetProperties.length ||
        !allowedEngines.length ||
        !criteria.length
      )
        throw new Error(
          "Complete the scientific objective, target properties, engines and acceptance criteria.",
        );
      const limits = {
        externalOperations: amounts.externalOperations.valueAsNumber,
        modelTokens: amounts.modelTokens.valueAsNumber,
        wallTimeSeconds: amounts.wallTimeSeconds.valueAsNumber,
        cost: amounts.cost.valueAsNumber,
      };
      if (
        !Object.values(limits).every((value) => Number.isFinite(value) && value >= 0) ||
        ![limits.externalOperations, limits.modelTokens, limits.wallTimeSeconds].every(
          Number.isSafeInteger,
        )
      )
        throw new Error(
          "Budget limits must be finite nonnegative numbers; counts and seconds must be integers.",
        );
      if (
        !(await confirmAction(
          "Create this mission?",
          el(
            "div",
            {},
            el("p", {}, statement.value.trim()),
            inspect(
              "Execution boundaries",
              { allowedEngines, limits, acceptanceCriteria: criteria },
              true,
            ),
          ),
          "Upload & create",
        ))
      )
        return;
      status.textContent = "Uploading and verifying structure…";
      const digest = await api.upload(projectId, file);
      const missionId = `mission-${crypto.randomUUID()}`;
      const request = createRequest({
        projectId,
        missionId,
        statement: statement.value.trim(),
        targetProperties,
        allowedEngines,
        criteria,
        limits,
        digest,
        size: file.size,
        format:
          /** @type {import('./contracts').CreateRequest['mission']['objective']['system']['format']} */ (
            format.value
          ),
        confidence: /** @type {'exploratory' | 'screening' | 'defensible'} */ (confidence.value),
        charge: charge.value === "" ? undefined : charge.valueAsNumber,
        multiplicity: multiplicity.value === "" ? undefined : multiplicity.valueAsNumber,
        environment: environment.value.trim() || undefined,
        offline: offline.checked,
      });
      status.textContent = `Creating ${missionId}…`;
      try {
        await api.mutate(missionPath(projectId), projectId, missionId, "create", 0, request);
      } catch (error) {
        location.hash = route(projectId);
        throw error;
      }
      notify("Mission created. Import a candidate or open an agent session to prepare a plan.");
      location.hash = route(projectId, missionId);
    });
  });
  host.replaceChildren(
    el(
      "div",
      { class: "page-heading" },
      el(
        "div",
        {},
        el("p", { class: "eyebrow" }, "Mission workspace"),
        el("h1", {}, "New mission"),
        el("p", { class: "subtitle" }, "Start with a question. Make the boundaries explicit."),
      ),
    ),
    form,
  );
}

/** @param {{ projectId: string; missionId: string; statement: string; targetProperties: string[]; allowedEngines: string[]; criteria: string[]; limits: import('./contracts').CreateRequest['budget']['limits']; digest: string; size: number; format: import('./contracts').CreateRequest['mission']['objective']['system']['format']; confidence: 'exploratory' | 'screening' | 'defensible'; charge?: number; multiplicity?: number; environment?: string; offline: boolean }} input
 * @returns {import('./contracts').CreateRequest} */
export function createRequest(input) {
  const { missionId, digest } = input;
  const createdAt = new Date().toISOString();
  const evidenceId = `${missionId}.structure`;
  const budgetId = `${missionId}.budget`;
  return {
    projectId: input.projectId,
    mission: {
      schemaVersion: "eigengrid.scientific/v1",
      id: missionId,
      revision: 1,
      state: "created",
      objective: {
        schemaVersion: "eigengrid.scientific/v1",
        id: `${missionId}.objective`,
        statement: input.statement,
        system: {
          evidenceId,
          contentDigest: digest,
          format: input.format,
          ...(input.charge === undefined ? {} : { charge: input.charge }),
          ...(input.multiplicity === undefined ? {} : { multiplicity: input.multiplicity }),
        },
        targetProperties: input.targetProperties,
        requiredConfidence: input.confidence,
        ...(input.environment ? { environmentalModel: input.environment } : {}),
      },
      constraints: {
        allowedEngines: input.allowedEngines,
        deniedEngines: [],
        offlineRequired: input.offline,
        materialChangesRequireApproval: true,
        immutableScientificFields: [
          "objective",
          "charge",
          "multiplicity",
          "method",
          "basis",
          "physicalModel",
        ],
      },
      assumptions: [],
      acceptanceCriteria: input.criteria.map((description, index) => ({
        id: `${missionId}.criterion-${index + 1}`,
        kind: "custom",
        description,
        required: true,
      })),
      activePlanId: null,
      budgetId,
      createdAt,
      updatedAt: createdAt,
    },
    budget: {
      id: budgetId,
      missionId,
      revision: 1,
      limits: input.limits,
      consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      reservations: [],
    },
    objectiveEvidence: [
      {
        id: evidenceId,
        missionId,
        kind: "structure",
        uri: `cas://sha256/${digest}`,
        contentDigest: digest,
        sizeBytes: input.size,
        immutable: true,
        createdAt,
      },
    ],
  };
}
