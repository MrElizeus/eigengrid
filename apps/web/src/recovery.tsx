import { useState } from "react";
import { api, ApiError } from "./api.browser.js";
import type { PendingRequest, Recovery as RecoveryResult } from "./contracts";
import { recoveryDestination } from "./recovery.browser.js";
import { Action, Inspect, useUi } from "./ui";

export function Recovery({
  projectId,
  missionId,
  refresh,
}: {
  projectId: string;
  missionId?: string;
  refresh: () => Promise<void>;
}) {
  const entries = api.pending.filter(
    (item) =>
      item.actorId === api.session?.actor.id &&
      item.projectId === projectId &&
      (!missionId || item.missionId === missionId),
  );
  return entries.length ? (
    <section className="recovery" aria-label="Outstanding requests">
      <h2>A request needs a result check</h2>
      <p>Check the recorded outcome before submitting another operation for this mission.</p>
      {entries.map((entry) => (
        <RecoveryItem key={entry.key} entry={entry} refresh={refresh} />
      ))}
    </section>
  ) : null;
}
function RecoveryItem({ entry, refresh }: { entry: PendingRequest; refresh: () => Promise<void> }) {
  const [result, setResult] = useState<RecoveryResult>();
  const [message, setMessage] = useState("");
  const { confirm, notify } = useUi();
  async function finish(value: unknown) {
    const destination = recoveryDestination(entry, value);
    if (destination) location.hash = destination;
    await refresh();
    notify("The recorded result has been recovered.");
  }
  return (
    <div className="recovery-item">
      <strong>
        {entry.operation} · {entry.missionId}
      </strong>
      <Inspect label="Request reference" value={entry} />
      <Action
        run={async () => {
          try {
            const next = await api.recover(entry);
            setResult(next);
            if (next.status !== "pending") await finish(next.result);
          } catch (error) {
            if (error instanceof ApiError && error.code === "NOT_FOUND")
              setMessage(
                "No final record is available. A disconnected request may still be in flight. Keep this reference and check again.",
              );
            else throw error;
          }
        }}
      >
        Check saved result
      </Action>
      {result?.status === "pending" && (
        <Action
          run={async () => {
            if (
              await confirm(
                "Reconcile this request?",
                <p>
                  Read the canonical outcome. An unresolved operation stays blocked for
                  investigation.
                </p>,
                "Reconcile",
              )
            ) {
              const recovered = await api.reconcile(entry, result.operationId);
              await finish(recovered.result);
            }
          }}
        >
          Reconcile with recorded state
        </Action>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
