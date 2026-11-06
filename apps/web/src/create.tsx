import { useEffect, useRef, useState } from "react";
import { api, missionPath } from "./api.browser.js";
import { createRequest } from "./create.browser.js";
import type { CreateRequest } from "./contracts";
import { route } from "./navigation";
import { Field, Panel, Inspect, useUi, errorText } from "./ui";
import { Recovery } from "./recovery";
const split = (value: string) =>
  value
    .split(/[,\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
export function CreateMission({
  projectId,
  refresh,
}: {
  projectId: string;
  refresh: () => Promise<void>;
}) {
  const { confirm, notify } = useUi();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Mission setup</p>
          <h1>New mission</h1>
          <p className="muted">Define the objective and boundaries before planning begins.</p>
        </div>
      </div>
      <Recovery projectId={projectId} refresh={refresh} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const data = new FormData(event.currentTarget);
          const text = (name: string) => String(data.get(name) ?? "").trim();
          const generation = api.generation;
          const current = () => {
            if (!alive.current || generation !== api.generation)
              throw new Error("The workspace changed. Review the request again.");
          };
          setBusy(true);
          setStatus("");
          try {
            const file = data.get("structure");
            if (!(file instanceof File) || !file.size)
              throw new Error("Choose a nonempty structure file.");
            const targetProperties = split(text("targets"));
            const allowedEngines = split(text("engines"));
            const criteria = text("criteria")
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean);
            if (
              !text("statement") ||
              !targetProperties.length ||
              !allowedEngines.length ||
              !criteria.length
            )
              throw new Error(
                "Complete the question, properties, engines and acceptance criteria.",
              );
            const limits = {
              externalOperations: Number(text("operations")),
              modelTokens: Number(text("tokens")),
              wallTimeSeconds: Number(text("seconds")),
              cost: Number(text("cost")),
            };
            if (
              !Object.values(limits).every((value) => Number.isFinite(value) && value >= 0) ||
              ![limits.externalOperations, limits.modelTokens, limits.wallTimeSeconds].every(
                Number.isSafeInteger,
              )
            )
              throw new Error(
                "Enter finite, nonnegative budget limits. Counts and seconds must be whole numbers.",
              );
            if (
              !(await confirm(
                "Create this mission?",
                <>
                  <p>{text("statement")}</p>
                  <Inspect
                    label="Execution boundaries"
                    value={{
                      structure: file.name,
                      targetProperties,
                      allowedEngines,
                      limits,
                      acceptanceCriteria: criteria,
                    }}
                    open
                  />
                  <p>
                    Creation saves the objective and evidence. It does not launch a calculation.
                  </p>
                </>,
                "Upload & create",
              ))
            )
              return;
            current();
            setStatus("Uploading and verifying structure…");
            const digest = await api.upload(projectId, file);
            current();
            const missionId = `mission-${crypto.randomUUID()}`;
            const request = createRequest({
              projectId,
              missionId,
              statement: text("statement"),
              targetProperties,
              allowedEngines,
              criteria,
              limits,
              digest,
              size: file.size,
              format: text("format") as CreateRequest["mission"]["objective"]["system"]["format"],
              confidence: text("confidence") as "exploratory" | "screening" | "defensible",
              charge: text("charge") ? Number(text("charge")) : undefined,
              multiplicity: text("multiplicity") ? Number(text("multiplicity")) : undefined,
              environment: text("environment") || undefined,
              offline: data.has("offline"),
            });
            setStatus("Creating mission…");
            await api.mutate(missionPath(projectId), projectId, missionId, "create", 0, request);
            current();
            notify("Mission created. You can now work with the agent or import a candidate.");
            location.hash = route(projectId, missionId);
          } catch (cause) {
            if (alive.current && generation === api.generation) {
              setStatus(errorText(cause));
              await refresh();
            }
          } finally {
            if (alive.current) setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="form-sections">
          <Panel title="Scientific objective">
            <Field label="Research question">
              <textarea
                name="statement"
                rows={3}
                maxLength={10000}
                placeholder="What should this mission answer?"
                required
              />
            </Field>
            <div className="form-grid">
              <Field label="Target properties" hint="Separate properties with commas.">
                <input
                  name="targets"
                  placeholder="Optimized geometry, relative energies"
                  required
                />
              </Field>
              <Field label="Required confidence">
                <select name="confidence">
                  <option value="exploratory">Exploratory</option>
                  <option value="screening">Screening</option>
                  <option value="defensible">Defensible</option>
                </select>
              </Field>
            </div>
            <Field label="Acceptance criteria" hint="One measurable criterion per line.">
              <textarea name="criteria" rows={3} required />
            </Field>
          </Panel>
          <Panel title="Molecular system">
            <Field label="Structure file" hint="Maximum 64 MiB. Stored as immutable evidence.">
              <input type="file" name="structure" required />
            </Field>
            <div className="form-grid">
              <Field label="Format">
                <select name="format">
                  {["xyz", "sdf", "mol", "pdb", "smiles", "inchi", "engine_input"].map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Total charge (optional)">
                <input type="number" name="charge" step={1} placeholder="Unspecified" />
              </Field>
              <Field label="Multiplicity (optional)">
                <input
                  type="number"
                  name="multiplicity"
                  step={1}
                  min={1}
                  placeholder="Unspecified"
                />
              </Field>
            </div>
            <Field label="Environmental model (optional)">
              <input name="environment" placeholder="Gas phase or a specified solvent model" />
            </Field>
          </Panel>
          <Panel title="Execution boundaries">
            <Field
              label="Allowed engines"
              hint="Comma-separated identifiers available at your installation."
            >
              <input name="engines" placeholder="e.g. orca" required />
            </Field>
            <label className="check">
              <input type="checkbox" name="offline" />
              Require offline execution
            </label>
            <p className="muted">Material scientific changes require approval.</p>
          </Panel>
          <Panel title="Budget limits">
            <p className="muted">
              Enter explicit limits. Zero prevents consumption of that resource.
            </p>
            <div className="form-grid">
              {[
                ["operations", "External operations"],
                ["tokens", "Model tokens"],
                ["seconds", "Wall time (seconds)"],
                ["cost", "Cost (configured unit)"],
              ].map(([name, label]) => (
                <Field key={name} label={label}>
                  <input
                    type="number"
                    name={name}
                    min={0}
                    step={name === "cost" ? "any" : 1}
                    required
                  />
                </Field>
              ))}
            </div>
          </Panel>
          <div className="actions">
            <a className="button" href={route(projectId)}>
              Back to missions
            </a>
            <button className="primary" type="submit">
              Review & create mission
            </button>
          </div>
        </fieldset>
        <p role="status" className="muted">
          {status}
        </p>
      </form>
    </div>
  );
}
