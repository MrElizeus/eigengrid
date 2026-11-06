import { missionPath } from "./api.browser.js";
import { el, badge, date, empty, inspect, panel, fact, table, human } from "./dom.browser.js";

/** @param {import('./contracts').MissionView} view */
export function overview(view) {
  const p = view.provenance;
  const m = p.mission;
  return el(
    "div",
    { class: "detail-grid" },
    el(
      "div",
      { class: "stack" },
      panel(
        "Scientific objective",
        el("p", { class: "lead" }, m.objective.statement),
        el(
          "div",
          { class: "tags" },
          ...m.objective.targetProperties.map((item) => el("span", { class: "tag" }, item)),
        ),
        el(
          "dl",
          { class: "facts" },
          fact("Confidence", human(m.objective.requiredConfidence)),
          fact("Environment", m.objective.environmentalModel ?? "Unspecified"),
          fact("Allowed engines", m.constraints.allowedEngines.join(", ")),
          fact("Policy profile", m.policyProfile),
        ),
      ),
      panel(
        "Acceptance criteria",
        ...m.acceptanceCriteria.map((item) =>
          el(
            "div",
            { class: "record" },
            el(
              "p",
              {},
              el("strong", {}, item.required ? "Required" : "Optional"),
              " · ",
              human(item.kind),
            ),
            el("p", {}, item.description),
            item.threshold !== undefined
              ? el("small", {}, `Threshold: ${item.threshold} ${item.unit ?? ""}`)
              : null,
          ),
        ),
      ),
      panel(
        "Scientific assessment",
        p.assessments.length
          ? el(
              "div",
              {},
              ...p.assessments.map((item, index) =>
                inspect(`Assessment ${index + 1}`, item, index === p.assessments.length - 1),
              ),
            )
          : el(
              "p",
              { class: "hint" },
              "No scientific assessment has been recorded. Execution status alone does not establish a scientifically accepted result.",
            ),
      ),
      p.missingReferences.length
        ? panel(
            "Incomplete provenance",
            el("p", {}, "Some references are missing from the available records."),
            inspect("Missing references", p.missingReferences, true),
          )
        : null,
    ),
    el(
      "aside",
      { class: "stack" },
      panel(
        "Mission record",
        el(
          "dl",
          { class: "facts vertical" },
          fact("Revision", String(m.revision)),
          fact("Requested by", m.requestedBy.id),
          fact("Created", date(m.createdAt)),
          fact("Last changed", date(m.updatedAt)),
          fact("Active plan", m.activePlanId ?? "None"),
          fact("Provenance", p.complete ? "Complete" : "Incomplete"),
        ),
      ),
      panel(
        "Budget",
        ...Object.entries(p.budget.limits).map(([name, limit]) => {
          const key = /** @type {keyof typeof p.budget.limits} */ (name);
          const used = p.budget.consumed[key];
          return el(
            "div",
            { class: "budget-row" },
            el(
              "div",
              { class: "split" },
              el(
                "span",
                {},
                {
                  externalOperations: "External operations",
                  modelTokens: "Model tokens",
                  wallTimeSeconds: "Wall time (s)",
                  cost: "Cost",
                }[key],
              ),
              el("strong", {}, `${used.toLocaleString("en")} / ${limit.toLocaleString("en")}`),
            ),
            el("progress", { value: used, max: Math.max(limit, 1), "aria-label": name }),
            used > limit
              ? el("small", { class: "error-text" }, "Recorded consumption exceeds this limit")
              : null,
          );
        }),
        inspect("Reservations", p.budget.reservations),
      ),
      inspect("System & constraints", {
        system: m.objective.system,
        constraints: m.constraints,
        assumptions: m.assumptions,
      }),
    ),
  );
}
/** @param {import('./contracts').MissionView} view */
export function workUnits(view) {
  const p = view.provenance;
  if (!p.workUnits.length)
    return empty(
      "No work units yet",
      "Review and compile an approved candidate to create the execution graph.",
    );
  return el(
    "div",
    { class: "stack" },
    panel(
      "Work units",
      table(
        ["Work unit", "Kind", "State", "Job", "Details"],
        p.workUnits.map((unit) => [
          el("code", {}, unit.id),
          unit.kind,
          badge(unit.state),
          unit.jobId ?? "—",
          inspect("Inspect", unit),
        ]),
      ),
    ),
    panel(
      "External operations",
      p.operations.length
        ? table(
            ["Operation", "Work unit", "State", "Details"],
            p.operations.map((op) => [
              el("code", {}, op.id),
              el("code", {}, op.workUnitId),
              badge(op.state),
              inspect("Inspect", op),
            ]),
          )
        : el("p", { class: "hint" }, "No external operations recorded."),
    ),
    panel(
      "Validation & observations",
      ...p.validations.map((item, index) => inspect(`Validation ${index + 1}`, item)),
      ...p.observations.map((item, index) => inspect(`Observation ${index + 1}`, item)),
    ),
  );
}
/** @param {import('./contracts').MissionView} view */
export function evidence(view) {
  const items = view.provenance.evidence;
  return el(
    "div",
    { class: "stack" },
    el(
      "p",
      { class: "subtitle" },
      "Immutable artifacts attached to this mission. Each download is authorized and verified against its content digest.",
    ),
    items.length
      ? panel(
          "Evidence library",
          table(
            ["Evidence", "Kind", "Size", "Content digest", "Artifact"],
            items.map((item) => [
              el("div", {}, el("strong", {}, item.id), inspect("Metadata", item)),
              human(item.kind),
              item.sizeBytes === undefined
                ? "Unknown"
                : `${(item.sizeBytes / 1024).toLocaleString("en", { maximumFractionDigits: 1 })} KiB`,
              el("code", { class: "digest" }, item.contentDigest),
              item.immutable && item.uri === `cas://sha256/${item.contentDigest}`
                ? el(
                    "a",
                    {
                      class: "button secondary small",
                      href: `/api/v1${missionPath(view.projectId, view.missionId)}/artifacts/${encodeURIComponent(item.contentDigest)}`,
                      download: `${item.id}.bin`,
                    },
                    "Download",
                  )
                : el("span", { class: "hint" }, "External reference"),
            ]),
          ),
        )
      : empty("No evidence recorded", "Uploaded and generated artifacts will appear here."),
  );
}
/** @param {import('./contracts').MissionView} view */
export function activity(view) {
  const p = view.provenance;
  return el(
    "div",
    { class: "stack" },
    panel(
      "Mission transitions",
      p.transitions.length
        ? el(
            "div",
            { class: "timeline" },
            ...p.transitions.map((item) =>
              inspect(`${item.sequence} · ${human(item.toState)} · ${date(item.occurredAt)}`, item),
            ),
          )
        : el("p", { class: "hint" }, "No transitions recorded yet."),
    ),
    panel("Decision records", ...p.decisions.map((item) => inspect(item.id, item))),
    panel(
      "Receipts & checkpoints",
      ...p.receipts.map((item) => inspect(item.id, item)),
      ...p.checkpoints.map((item) => inspect(item.id, item)),
    ),
    inspect("Complete provenance record", p),
  );
}
