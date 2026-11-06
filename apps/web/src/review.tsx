import { useEffect, useRef, useState } from "react";
import { api, missionPath } from "./api.browser.js";
import type { MissionView, Review } from "./contracts";
import { Action, Badge, Empty, errorText, Facts, Field, Inspect, Panel, useUi, date } from "./ui";
export function PlanReview({ view }: { view: MissionView }) {
  const plans = view.provenance.plans;
  const [planId, setPlanId] = useState(
    view.provenance.mission.activePlanId ?? plans.at(-1)?.id ?? "",
  );
  const [review, setReview] = useState<Review>();
  const [error, setError] = useState("");
  const selected = plans.some((plan) => plan.id === planId) ? planId : (plans.at(-1)?.id ?? "");
  useEffect(() => {
    const controller = new AbortController();
    setReview(undefined);
    setError("");
    if (selected)
      void api
        .get<Review>(
          `${missionPath(view.projectId, view.missionId)}/plans/${encodeURIComponent(selected)}/review`,
          AbortSignal.any([controller.signal, view.signal]),
        )
        .then((value) => {
          if (!controller.signal.aborted) setReview(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted && !view.signal.aborted) setError(errorText(cause));
        });
    return () => controller.abort();
  }, [selected, view.projectId, view.missionId, view.provenance.mission.revision, view.signal]);
  return (
    <div className="stack">
      <ImportCandidate view={view} />
      {plans.length ? (
        <>
          <Field label="Candidate plan">
            <select value={selected} onChange={(event) => setPlanId(event.target.value)}>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.id} · v{plan.version} / r{plan.revision}
                </option>
              ))}
            </select>
          </Field>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          {review ? (
            <Candidate
              key={`${review.candidateDigest}/${view.provenance.mission.revision}`}
              view={view}
              review={review}
            />
          ) : (
            !error && <p role="status">Loading candidate…</p>
          )}
        </>
      ) : (
        <Empty title="No candidate to review">
          Prepare a plan with the agent or import a candidate from the CLI.
        </Empty>
      )}
    </div>
  );
}
function ImportCandidate({ view }: { view: MissionView }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const artifactsInput = useRef<HTMLInputElement>(null);
  const { confirm, notify } = useUi();
  return (
    <details className="panel">
      <summary>Import a candidate</summary>
      <Field
        label="Candidate JSON"
        hint="Use the candidate object in eigengrid.mission-candidate/v1 format."
      >
        <input ref={fileInput} type="file" accept=".json,application/json" />
      </Field>
      <Field label="Referenced artifact files (optional)">
        <input ref={artifactsInput} type="file" multiple />
      </Field>
      <Action
        run={async () => {
          const file = fileInput.current?.files?.[0];
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
            view.signal.aborted ||
            !(await confirm(
              "Import this candidate?",
              <>
                <p>Importing saves a proposal for review. It does not approve or execute it.</p>
                <Inspect label="Candidate" value={candidate} />
              </>,
              "Import candidate",
            ))
          )
            return;
          for (const file of artifactsInput.current?.files ?? []) {
            if (view.signal.aborted) return;
            const digest = await api.upload(view.projectId, file);
            if (
              !candidate.evidence.some(
                (item: { contentDigest: string }) => item.contentDigest === digest,
              )
            )
              throw new Error(`The uploaded file ${file.name} is not referenced by the candidate.`);
          }
          await view.mutate("import", {
            projectId: view.projectId,
            missionId: view.missionId,
            candidate,
            expectedCandidateDigest: candidate.candidateDigest,
          });
          notify("Candidate imported. Review its exact revision and approvals.");
        }}
      >
        Import candidate
      </Action>
    </details>
  );
}
function Candidate({ view, review }: { view: MissionView; review: Review }) {
  const { confirm, notify } = useUi();
  const plan = review.candidate.plan;
  const exact = {
    projectId: view.projectId,
    missionId: view.missionId,
    planId: plan.id,
    candidateDigest: review.candidateDigest,
  };
  const pending = review.approvals.some(
    (item) =>
      item.state !== "approved" ||
      (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()),
  );
  const approved =
    review.candidate.md ||
    review.approvals.some((item) => item.subjectType === "plan" && item.state === "approved");
  const canCompile =
    Boolean(approved) &&
    !pending &&
    ["awaiting_approval", "planning", "replanning", "ready", "paused", "blocked"].includes(
      review.state,
    );
  async function execute(operation: "compile" | "start") {
    const action = operation === "compile" ? "Compile work units" : "Request execution";
    if (
      !(await confirm(
        action + "?",
        <>
          <p>
            {operation === "compile"
              ? "Compile this exact candidate into work units. Current approvals, policy and evidence are checked again."
              : "Request execution of this candidate. It may consume the mission budget and remains subject to Head admission controls."}
          </p>
          <Inspect label="Exact candidate" value={exact} open />
        </>,
        action,
      ))
    )
      return;
    await view.mutate(operation, exact);
    notify(
      operation === "compile"
        ? "Candidate compiled."
        : "Execution requested. Follow the work units for progress.",
    );
  }
  return (
    <>
      <Panel title={plan.normalizedObjective}>
        <Facts
          items={[
            ["Plan", plan.id],
            ["Version / revision", `${plan.version} / ${plan.revision}`],
            ["Estimated wall time", `${plan.estimatedCost.wallTimeSeconds.toLocaleString("en")} s`],
            ["Estimated CPU", `${plan.estimatedCost.cpuCoreHours} core-hours`],
            ["Estimated cost", String(plan.estimatedCost.cost)],
          ]}
        />
        <code className="digest">{review.candidateDigest}</code>
      </Panel>
      <Panel title="Protocol & scientific parameters">
        <Inspect label="Full protocol" value={plan.protocol} open />
        <Inspect label="Resolved scientific skills" value={plan.skillResolution} />
        <Inspect label="Material decisions" value={review.candidate.decisions} />
        {review.candidate.md && (
          <Inspect label="Biomolecular system & MD protocol" value={review.candidate.md} />
        )}
      </Panel>
      <Panel title="Risks & limitations">
        {plan.risks.map((risk, index) => (
          <div className="record" key={index}>
            <strong>Risk class {risk.riskClass}</strong>
            <p>{risk.description}</p>
            <p className="muted">Mitigation: {risk.mitigation}</p>
          </div>
        ))}
        {plan.limitations.map((item, index) => (
          <p key={index}>{item}</p>
        ))}
        {!plan.risks.length && !plan.limitations.length && (
          <p className="muted">No risks or limitations declared in this candidate.</p>
        )}
        <Inspect
          label="Missing inputs, assumptions & alternatives"
          value={{
            missingInputs: plan.missingInputs,
            assumptions: plan.assumptions,
            alternatives: plan.alternatives,
          }}
        />
      </Panel>
      <Panel title="Human decisions">
        {review.approvals.length ? (
          review.approvals.map((approval) => (
            <Approval key={approval.id} view={view} review={review} approval={approval} />
          ))
        ) : (
          <p className="muted">No approval requests recorded for this candidate.</p>
        )}
      </Panel>
      <div className="action-bar">
        <p className="muted">Approvals apply to the exact content, revision and policy above.</p>
        <div className="actions">
          <Action
            disabled={!canCompile}
            title={
              !canCompile
                ? "Resolve this candidate’s current approvals before compiling."
                : undefined
            }
            run={() => execute("compile")}
          >
            Compile work units
          </Action>
          <Action
            className="primary"
            disabled={
              !canCompile ||
              view.provenance.mission.state !== "ready" ||
              view.provenance.mission.activePlanId !== plan.id
            }
            run={() => execute("start")}
          >
            Request execution
          </Action>
        </div>
      </div>
      <Inspect label="Full candidate record" value={review.candidate} />
    </>
  );
}
function Approval({
  view,
  review,
  approval,
}: {
  view: MissionView;
  review: Review;
  approval: Review["approvals"][number];
}) {
  const [reason, setReason] = useState("");
  const { confirm, notify } = useUi();
  const expired =
    approval.expiresAt !== undefined && new Date(approval.expiresAt).getTime() <= Date.now();
  const permitted = api.session?.roles.includes(approval.requestedFromRole);
  async function decide(decision: "approved" | "rejected") {
    if (!reason.trim()) throw new Error("A review reason is required.");
    if (
      !(await confirm(
        decision === "approved" ? "Approve this exact revision?" : "Reject this exact revision?",
        <>
          <p>
            {approval.subjectId} · version {approval.subjectVersion}, revision{" "}
            {approval.subjectRevision}
          </p>
          <p>{reason.trim()}</p>
        </>,
        "Record decision",
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
      reason: reason.trim(),
    });
    notify("Review decision recorded.");
  }
  return (
    <section className="approval-card">
      <div className="split">
        <h3>
          {approval.subjectType} · {approval.subjectId}
        </h3>
        <Badge value={expired && approval.state === "pending" ? "expired" : approval.state} />
      </div>
      <Facts
        items={[
          ["Required role", approval.requestedFromRole],
          ["Version / revision", `${approval.subjectVersion} / ${approval.subjectRevision}`],
          ["Expires", approval.expiresAt ? date(approval.expiresAt) : "No expiration recorded"],
        ]}
      />
      <Inspect
        label="Exact approval binding"
        value={{
          id: approval.id,
          payloadDigest: approval.payloadDigest,
          policyDigest: approval.policyDigest,
        }}
        open
      />
      {approval.response && <Inspect label="Recorded decision" value={approval.response} open />}
      {approval.state === "pending" &&
        (expired ? (
          <p className="muted">This approval has expired. A current request is required.</p>
        ) : !permitted ? (
          <p className="muted">Your account does not hold the required review role.</p>
        ) : (
          <>
            <Field label="Review reason">
              <textarea
                rows={2}
                maxLength={10000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <div className="actions">
              <Action className="danger" disabled={!reason.trim()} run={() => decide("rejected")}>
                Reject
              </Action>
              <Action className="primary" disabled={!reason.trim()} run={() => decide("approved")}>
                Approve revision
              </Action>
            </div>
          </>
        ))}
    </section>
  );
}
