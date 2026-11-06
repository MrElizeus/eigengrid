import type { MissionView } from "./contracts";
import { missionPath } from "./api.browser.js";
import { Badge, date, Empty, Facts, human, Inspect, Panel } from "./ui";
export function Overview({ view }: { view: MissionView }) {
  const p = view.provenance;
  const m = p.mission;
  return (
    <div className="record-grid">
      <div className="stack">
        <Panel title="Scientific objective">
          <p className="lead">{m.objective.statement}</p>
          <div className="tags">
            {m.objective.targetProperties.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <Facts
            items={[
              ["Confidence", human(m.objective.requiredConfidence)],
              ["Environment", m.objective.environmentalModel ?? "Unspecified"],
              ["Allowed engines", m.constraints.allowedEngines.join(", ")],
              ["Policy profile", m.policyProfile],
            ]}
          />
        </Panel>
        <Panel title="Acceptance criteria">
          {m.acceptanceCriteria.map((item) => (
            <div className="record" key={item.id}>
              <strong>
                {item.required ? "Required" : "Optional"} · {human(item.kind)}
              </strong>
              <p>{item.description}</p>
              {item.threshold !== undefined && (
                <small>
                  Threshold: {item.threshold} {item.unit}
                </small>
              )}
            </div>
          ))}
        </Panel>
        <Panel title="Scientific assessment">
          {p.assessments.length ? (
            p.assessments.map((item, index) => (
              <Inspect
                key={index}
                label={`Assessment ${index + 1}`}
                value={item}
                open={index === p.assessments.length - 1}
              />
            ))
          ) : (
            <p className="muted">
              No scientific assessment is recorded. Completed execution alone does not establish an
              accepted scientific result.
            </p>
          )}
        </Panel>
        {!!p.missingReferences.length && (
          <Panel title="Incomplete provenance">
            <Inspect label="Missing references" value={p.missingReferences} open />
          </Panel>
        )}
      </div>
      <div className="stack">
        <Panel title="Mission record">
          <Facts
            items={[
              ["Revision", m.revision],
              ["Requested by", m.requestedBy.id],
              ["Created", date(m.createdAt)],
              ["Last changed", date(m.updatedAt)],
              ["Active plan", m.activePlanId ?? "None"],
              ["Provenance", p.complete ? "Complete" : "Incomplete"],
            ]}
          />
        </Panel>
        <Panel title="Budget">
          {Object.entries(p.budget.limits).map(([name, limit]) => {
            const used = p.budget.consumed[name as keyof typeof p.budget.limits];
            return (
              <div className="budget-row" key={name}>
                <div>
                  <span>
                    {
                      {
                        externalOperations: "External operations",
                        modelTokens: "Model tokens",
                        wallTimeSeconds: "Wall time (s)",
                        cost: "Cost",
                      }[name]
                    }
                  </span>
                  <strong>
                    {used.toLocaleString("en")} / {limit.toLocaleString("en")}
                  </strong>
                </div>
                <progress value={used} max={Math.max(1, limit)} aria-label={name} />
                {used > limit && (
                  <small className="error-text">Recorded consumption exceeds the limit.</small>
                )}
              </div>
            );
          })}
          <Inspect label="Reservations" value={p.budget.reservations} />
        </Panel>
        <Inspect
          label="System & constraints"
          value={{
            system: m.objective.system,
            constraints: m.constraints,
            assumptions: m.assumptions,
          }}
        />
      </div>
    </div>
  );
}
export function WorkUnits({ view }: { view: MissionView }) {
  const p = view.provenance;
  if (!p.workUnits.length)
    return (
      <Empty title="No work units yet">
        Review and compile an approved candidate to create its execution graph.
      </Empty>
    );
  return (
    <div className="stack">
      <Panel title="Work units">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Work unit</th>
                <th>Kind</th>
                <th>State</th>
                <th>Job</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {p.workUnits.map((unit) => (
                <tr key={unit.id}>
                  <td>
                    <code>{unit.id}</code>
                  </td>
                  <td>{unit.kind}</td>
                  <td>
                    <Badge value={unit.state} />
                  </td>
                  <td>{unit.jobId ?? "—"}</td>
                  <td>
                    <Inspect label="Inspect" value={unit} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="External operations">
        {p.operations.length ? (
          p.operations.map((op) => (
            <Inspect key={op.id} label={`${op.id} · ${human(op.state)}`} value={op} />
          ))
        ) : (
          <p className="muted">No external operations recorded.</p>
        )}
      </Panel>
      <Panel title="Validation & observations">
        {p.validations.map((value, index) => (
          <Inspect key={`v${index}`} label={`Validation ${index + 1}`} value={value} />
        ))}
        {p.observations.map((value, index) => (
          <Inspect key={`o${index}`} label={`Observation ${index + 1}`} value={value} />
        ))}
      </Panel>
    </div>
  );
}
export function Evidence({ view }: { view: MissionView }) {
  const items = view.provenance.evidence;
  return (
    <div className="stack">
      <p className="muted">
        Recorded artifacts and their content digests. Downloads require current mission access.
      </p>
      {items.length ? (
        items.map((item) => (
          <Panel key={item.id} title={item.id}>
            <div className="evidence-row">
              <div>
                <Badge value={item.kind} />
                <p className="muted">
                  {item.sizeBytes === undefined
                    ? "Unknown size"
                    : `${(item.sizeBytes / 1024).toLocaleString("en", { maximumFractionDigits: 1 })} KiB`}
                </p>
              </div>
              {item.immutable && item.uri === `cas://sha256/${item.contentDigest}` ? (
                <a
                  className="button"
                  href={`/api/v1${missionPath(view.projectId, view.missionId)}/artifacts/${encodeURIComponent(item.contentDigest)}`}
                  download={`${item.id}.bin`}
                >
                  Download
                </a>
              ) : (
                <span className="muted">External reference</span>
              )}
            </div>
            <code className="digest">{item.contentDigest}</code>
            <Inspect label="Metadata" value={item} />
          </Panel>
        ))
      ) : (
        <Empty title="No evidence recorded">
          Uploaded and generated artifacts will appear here.
        </Empty>
      )}
    </div>
  );
}
export function Activity({ view }: { view: MissionView }) {
  const p = view.provenance;
  return (
    <div className="stack">
      <Panel title="Mission activity">
        {p.transitions.length ? (
          p.transitions.map((item) => (
            <Inspect
              key={item.sequence}
              label={`${human(item.toState)} · ${date(item.occurredAt)}`}
              value={item}
            />
          ))
        ) : (
          <p className="muted">No transitions recorded yet.</p>
        )}
      </Panel>
      <Panel title="Decision records">
        {p.decisions.map((item) => (
          <Inspect key={item.id} label={item.id} value={item} />
        ))}
      </Panel>
      <Panel title="Receipts & checkpoints">
        {p.receipts.map((item) => (
          <Inspect key={item.id} label={item.id} value={item} />
        ))}
        {p.checkpoints.map((item) => (
          <Inspect key={item.id} label={item.id} value={item} />
        ))}
      </Panel>
      <Inspect label="Complete provenance" value={p} />
    </div>
  );
}
