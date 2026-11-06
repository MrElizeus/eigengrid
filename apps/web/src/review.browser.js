import { api, missionPath } from "./api.browser.js";
import {
  el,
  panel,
  field,
  button,
  busy,
  inspect,
  badge,
  fact,
  date,
  empty,
  confirmAction,
  notify,
} from "./dom.browser.js";

/** @param {import('./contracts').MissionView} view @param {HTMLElement} host */
export async function renderReview(view, host) {
  const plans = view.provenance.plans;
  const selector = el(
    "select",
    { "aria-label": "Candidate plan" },
    ...plans.map((plan) =>
      el("option", { value: plan.id }, `${plan.id} · v${plan.version} / r${plan.revision}`),
    ),
  );
  selector.value = view.provenance.mission.activePlanId ?? plans.at(-1)?.id ?? "";
  const content = el("div", { class: "stack" });
  let generation = 0;
  const load = async () => {
    const current = ++generation;
    content.replaceChildren(el("p", { role: "status" }, "Loading candidate…"));
    /** @type {import('./contracts').Review} */
    const review = await api.get(
      `${missionPath(view.projectId, view.missionId)}/plans/${encodeURIComponent(selector.value)}/review`,
      view.signal,
    );
    if (current !== generation || view.signal.aborted) return;
    content.replaceChildren(candidateView(view, review));
  };
  selector.addEventListener("change", () => void busy(selector, load));
  host.replaceChildren(
    el(
      "div",
      { class: "stack" },
      importPanel(view),
      plans.length
        ? panel("Candidate", field("Plan revision", selector), content)
        : empty(
            "No candidate to review",
            "Import a candidate from the CLI or prepare one through a mission agent session.",
          ),
    ),
  );
  if (plans.length) await load();
}

/** @param {import('./contracts').MissionView} view */
function importPanel(view) {
  const candidateFile = el("input", {
    type: "file",
    accept: ".json,application/json",
    required: true,
  });
  const artifacts = el("input", { type: "file", multiple: true });
  const form = el("form", {});
  const submit = el("button", { type: "submit", class: "button secondary" }, "Import candidate");
  form.append(
    field(
      "Candidate JSON",
      candidateFile,
      "Use the eigengrid.mission-candidate/v1 format produced by the CLI or planning tools.",
    ),
    field(
      "Referenced artifact files (optional)",
      artifacts,
      "Upload new evidence files referenced by this candidate. Their digests must match the candidate exactly.",
    ),
    submit,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void busy(submit, async () => {
      const file = candidateFile.files?.[0];
      if (!file || file.size > 3 * 1024 * 1024)
        throw new Error("Choose a candidate JSON file smaller than 3 MiB.");
      const candidate = JSON.parse(await file.text());
      if (
        candidate?.schemaVersion !== "eigengrid.mission-candidate/v1" ||
        candidate?.plan?.missionId !== view.missionId ||
        !/^[a-f0-9]{64}$/u.test(candidate?.candidateDigest ?? "") ||
        !Array.isArray(candidate.evidence)
      )
        throw new Error(
          "The candidate must use the supported schema, belong to this mission and include its content digest.",
        );
      if (
        !(await confirmAction(
          "Import this candidate?",
          el(
            "div",
            {},
            el(
              "p",
              {},
              "The server will validate the complete candidate, its evidence and current policy. Importing does not approve or execute the plan.",
            ),
            inspect("Candidate to import", candidate),
          ),
          "Import candidate",
        ))
      )
        return;
      for (const artifact of artifacts.files ?? []) {
        const digest = await api.upload(view.projectId, artifact);
        if (
          !candidate.evidence.some(
            (/** @type {{ contentDigest: string }} */ item) => item.contentDigest === digest,
          )
        )
          throw new Error(
            `The uploaded file ${artifact.name} is not referenced by this candidate.`,
          );
      }
      await view.mutate("import", {
        projectId: view.projectId,
        missionId: view.missionId,
        candidate,
        expectedCandidateDigest: candidate.candidateDigest,
      });
      notify("Candidate imported. Review the exact plan and its approval requirements.");
    });
  });
  return el("details", { class: "panel" }, el("summary", {}, "Import a candidate"), form);
}

/** @param {import('./contracts').MissionView} view @param {import('./contracts').Review} review */
function candidateView(view, review) {
  const { plan } = review.candidate;
  const exact = {
    projectId: view.projectId,
    missionId: view.missionId,
    planId: plan.id,
    candidateDigest: review.candidateDigest,
  };
  const execute = (/** @type {'compile' | 'start'} */ operation) => async () => {
    if (
      !(await confirmAction(
        operation === "compile" ? "Compile this candidate?" : "Start this mission?",
        el(
          "div",
          {},
          el(
            "p",
            {},
            operation === "compile"
              ? "Compile the reviewed candidate into work units. The server rechecks approvals, policy and evidence."
              : "This requests execution of the exact reviewed candidate and may consume the mission budget. The server rechecks all admission requirements.",
          ),
          inspect("Exact candidate", exact, true),
        ),
        operation === "compile" ? "Compile work units" : "Request execution",
      ))
    )
      return;
    await view.mutate(operation, exact);
    notify(
      operation === "compile"
        ? "Candidate compiled."
        : "Execution requested. Follow the recorded work units for progress.",
    );
  };
  const compile = button("Compile work units", execute("compile"));
  const start = button("Request execution", execute("start"), "primary");
  const decisionsPending = review.approvals.some(
    (item) =>
      item.state !== "approved" ||
      (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()),
  );
  const exactPlanApproved =
    review.candidate.md ||
    review.approvals.some((item) => item.subjectType === "plan" && item.state === "approved");
  const canCompile =
    Boolean(exactPlanApproved) &&
    !decisionsPending &&
    ["awaiting_approval", "planning", "replanning", "ready", "paused", "blocked"].includes(
      review.state,
    );
  compile.disabled = !canCompile;
  start.disabled =
    !canCompile ||
    view.provenance.mission.state !== "ready" ||
    view.provenance.mission.activePlanId !== plan.id;
  if (compile.disabled)
    compile.title = "Resolve this candidate's current approvals before compiling.";
  if (start.disabled)
    start.title =
      "Compile the approved candidate and refresh its ready state before requesting execution.";
  return el(
    "div",
    { class: "stack" },
    el(
      "div",
      { class: "split" },
      el("h2", {}, plan.normalizedObjective),
      badge(view.provenance.plans.find((item) => item.id === plan.id)?.status ?? plan.status),
    ),
    el(
      "dl",
      { class: "facts" },
      fact("Plan", plan.id),
      fact("Version / revision", `${plan.version} / ${plan.revision}`),
      fact("Estimated wall time", `${plan.estimatedCost.wallTimeSeconds.toLocaleString("en")} s`),
      fact("Estimated CPU", `${plan.estimatedCost.cpuCoreHours} core-hours`),
      fact("Estimated cost", String(plan.estimatedCost.cost)),
    ),
    inspect("Candidate content digest", review.candidateDigest, true),
    panel(
      "Protocol & scientific parameters",
      inspect("Full protocol", plan.protocol, true),
      inspect("Resolved scientific skills", plan.skillResolution),
      inspect("Material decisions", review.candidate.decisions),
      review.candidate.md
        ? inspect("Biomolecular system & MD protocol", review.candidate.md)
        : null,
    ),
    panel(
      "Risks & limitations",
      ...plan.risks.map((risk) =>
        el(
          "div",
          { class: "record" },
          el("strong", {}, `Risk class ${risk.riskClass}`),
          el("p", {}, risk.description),
          el("p", { class: "hint" }, `Mitigation: ${risk.mitigation}`),
        ),
      ),
      ...plan.limitations.map((item) => el("p", {}, item)),
      plan.risks.length + plan.limitations.length === 0
        ? el("p", { class: "hint" }, "No risks or limitations declared in this candidate.")
        : null,
      inspect("Missing inputs, assumptions & alternatives", {
        missingInputs: plan.missingInputs,
        assumptions: plan.assumptions,
        alternatives: plan.alternatives,
      }),
    ),
    panel(
      "Human decisions",
      review.approvals.length
        ? el(
            "div",
            { class: "stack" },
            ...review.approvals.map((approval) => approvalCard(view, review, approval)),
          )
        : el("p", { class: "hint" }, "This candidate has no recorded approval requests."),
    ),
    el(
      "div",
      { class: "action-bar" },
      el(
        "p",
        { class: "hint" },
        "Approval applies to the exact content, revision and policy shown above.",
      ),
      el("div", { class: "actions" }, compile, start),
    ),
    inspect("Full candidate record", review.candidate),
  );
}

/** @param {import('./contracts').MissionView} view @param {import('./contracts').Review} review @param {import('./contracts').Review['approvals'][number]} approval */
function approvalCard(view, review, approval) {
  const expired =
    approval.expiresAt !== undefined && new Date(approval.expiresAt).getTime() <= Date.now();
  const permitted = api.session?.roles.includes(approval.requestedFromRole);
  const card = el(
    "section",
    { class: "approval-card" },
    el(
      "div",
      { class: "split" },
      el("h3", {}, `${approval.subjectType} · ${approval.subjectId}`),
      badge(expired && approval.state === "pending" ? "expired" : approval.state),
    ),
    el(
      "dl",
      { class: "facts" },
      fact("Required role", approval.requestedFromRole),
      fact("Version / revision", `${approval.subjectVersion} / ${approval.subjectRevision}`),
      fact("Expires", approval.expiresAt ? date(approval.expiresAt) : "No expiration recorded"),
    ),
    inspect(
      "Exact approval binding",
      {
        id: approval.id,
        payloadDigest: approval.payloadDigest,
        policyDigest: approval.policyDigest,
      },
      true,
    ),
  );
  if (approval.response) card.append(inspect("Recorded decision", approval.response, true));
  if (approval.state === "pending" && !expired && permitted) {
    const reason = el("textarea", {
      rows: 2,
      maxlength: 10000,
      placeholder: "Explain the basis for your decision.",
    });
    const decide = (/** @type {'approved' | 'rejected'} */ decision) => async () => {
      if (!reason.value.trim()) {
        reason.focus();
        throw new Error("A review reason is required.");
      }
      if (
        !(await confirmAction(
          decision === "approved" ? "Approve this exact revision?" : "Reject this exact revision?",
          el(
            "p",
            {},
            `${approval.subjectId} · version ${approval.subjectVersion}, revision ${approval.subjectRevision}. ${reason.value.trim()}`,
          ),
          decision === "approved" ? "Record approval" : "Record rejection",
        ))
      )
        return;
      await view.mutate("approve", {
        projectId: view.projectId,
        missionId: view.missionId,
        planId: review.planId,
        candidateDigest: review.candidateDigest,
        approvalRequestId: approval.id,
        subjectVersion: approval.subjectVersion,
        subjectRevision: approval.subjectRevision,
        payloadDigest: approval.payloadDigest,
        policyDigest: approval.policyDigest,
        decision,
        reason: reason.value.trim(),
      });
      notify("Review decision recorded.");
    };
    card.append(
      field("Review reason", reason),
      el(
        "div",
        { class: "actions" },
        button("Reject", decide("rejected"), "danger"),
        button("Approve revision", decide("approved"), "primary"),
      ),
    );
  } else if (approval.state === "pending")
    card.append(
      el(
        "p",
        { class: "hint" },
        expired
          ? "This approval has expired. A current approval request is required."
          : "Your session does not hold the required review role.",
      ),
    );
  return card;
}
