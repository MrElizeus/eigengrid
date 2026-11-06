import { useCallback, useEffect, useRef, useState } from "react";
import { api, missionPath } from "./api.browser.js";
import type { MissionProvenance, MissionView } from "./contracts";
import { route, tabs, type Address } from "./navigation";
import { Action, Badge, Empty, errorText, Field, useUi } from "./ui";
import { Overview, WorkUnits, Evidence, Activity } from "./records";
import { PlanReview } from "./review";
import { Recovery } from "./recovery";
import { AgentPanel } from "./agent";

export function MissionWorkspace({
  address,
  agentOpen,
  closeAgent,
}: {
  address: Address;
  agentOpen: boolean;
  closeAgent: () => void;
}) {
  const { projectId, missionId, tab, sessionId } = address;
  const [provenance, setProvenance] = useState<MissionProvenance>();
  const [error, setError] = useState("");
  const [updates, setUpdates] = useState("");
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lifetime = useRef(new AbortController());
  const serial = useRef(0);
  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("eigengrid.agent-width"));
      return [320, 360, 400, 440, 480, 520, 560, 600, 640].includes(saved) ? saved : 400;
    } catch {
      return 400;
    }
  });
  const drag = useRef<{ x: number; width: number }>();
  const { confirm, notify } = useUi();
  const refresh = useCallback(async () => {
    const sequence = ++serial.current;
    setRefreshing(true);
    try {
      const value = await api.get<MissionProvenance>(
        missionPath(projectId, missionId),
        lifetime.current.signal,
      );
      if (!lifetime.current.signal.aborted && sequence === serial.current) {
        setProvenance(value);
        setError("");
        setUpdates("");
      }
    } catch (cause) {
      if (!lifetime.current.signal.aborted && sequence === serial.current)
        setError(errorText(cause));
    } finally {
      if (!lifetime.current.signal.aborted && sequence === serial.current) setRefreshing(false);
    }
  }, [projectId, missionId]);
  useEffect(() => {
    void refresh();
    return () => lifetime.current.abort();
  }, [refresh]);
  useEffect(() => {
    try {
      localStorage.setItem("eigengrid.agent-width", String(size));
    } catch {
      /* Layout remains usable without storage. */
    }
  }, [size]);
  useEffect(() => {
    if (!provenance) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime.current.signal, controller.signal]);
    let baseline = "";
    let changed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (signal.aborted) return;
      if (!document.hidden)
        try {
          const next = await api.get<{ revision: number }>(
            `${missionPath(projectId, missionId)}/status`,
            signal,
          );
          if (signal.aborted) return;
          const value = JSON.stringify(next);
          changed ||=
            Boolean(baseline && baseline !== value) ||
            next.revision !== provenance!.mission.revision;
          setUpdates(changed ? "New recorded state is available. Refresh to review it." : "");
          baseline = value;
        } catch {
          if (!signal.aborted)
            setUpdates("Live checks are unavailable. Refresh before making a decision.");
        }
      if (!signal.aborted) timer = setTimeout(() => void poll(), 15000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, missionId, provenance]);
  function resize(value: number) {
    setSize(Math.max(320, Math.min(640, Math.round(value / 40) * 40)));
  }
  if (!provenance)
    return (
      <main id="main">
        {error ? (
          <Empty title="Mission unavailable">
            <p>{error}</p>
            <Action run={refresh}>Try again</Action>
          </Empty>
        ) : (
          <p className="boot" role="status">
            Loading mission…
          </p>
        )}
      </main>
    );
  const mission = provenance.mission;
  const view: MissionView = {
    projectId,
    missionId: missionId!,
    provenance,
    signal: lifetime.current.signal,
    refresh,
    async mutate(
      operation,
      request,
      expectedRevision = mission.revision,
      suffix = `/${operation}`,
    ) {
      if (lifetime.current.signal.aborted) throw new Error("This mission is no longer open.");
      setWorking(true);
      try {
        return await api.mutate(
          `${missionPath(projectId, missionId)}${suffix}`,
          projectId,
          missionId!,
          operation,
          expectedRevision,
          request,
        );
      } finally {
        if (!lifetime.current.signal.aborted) {
          setWorking(false);
          await refresh();
        }
      }
    },
  };
  const disabled = working || refreshing || api.outstanding(projectId, missionId!).length > 0;
  const content =
    tab === "review" ? (
      <PlanReview view={view} />
    ) : tab === "work" ? (
      <WorkUnits view={view} />
    ) : tab === "evidence" ? (
      <Evidence view={view} />
    ) : tab === "activity" ? (
      <Activity view={view} />
    ) : (
      <Overview view={view} />
    );
  return (
    <div
      className={`workspace-grid mission-workspace ${agentOpen ? "with-agent" : ""} agent-width-${size}`}
    >
      <main id="main" tabIndex={-1}>
        <div className="page">
          <a className="back-link" href={route(projectId)}>
            ← All missions
          </a>
          <div className="page-heading">
            <div>
              <h1>{mission.objective.statement}</h1>
              <div className="heading-meta">
                <Badge value={mission.state} />
                <span>Revision {mission.revision}</span>
                <code>{mission.id}</code>
              </div>
            </div>
            <Action disabled={working} run={refresh}>
              Refresh
            </Action>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <Recovery projectId={projectId} missionId={missionId} refresh={refresh} />
          <nav className="tabs" aria-label="Mission views">
            {tabs.map(([id, label]) => (
              <a
                key={id}
                aria-current={tab === id ? "page" : undefined}
                href={route(projectId, missionId, id, sessionId)}
              >
                {label}
              </a>
            ))}
          </nav>
          {updates && (
            <div className="updates" role="status">
              <span>{updates}</span>
              <Action disabled={working} run={refresh}>
                Refresh view
              </Action>
            </div>
          )}
          <fieldset className="view-content" disabled={disabled} aria-busy={working || refreshing}>
            {content}
          </fieldset>
          {!["completed", "failed", "cancelled", "cancelling", "cancel_requested"].includes(
            mission.state,
          ) && (
            <details className="mission-management">
              <summary>Mission controls</summary>
              <CancelMission
                disabled={disabled}
                submit={async (reason) => {
                  if (
                    await confirm(
                      "Request mission cancellation?",
                      <p>
                        The coordinator records this request and reconciles admitted work.
                        Cancellation may take time.
                      </p>,
                      "Request cancellation",
                    )
                  ) {
                    await view.mutate("cancel", {
                      projectId,
                      missionId,
                      schemaVersion: "eigengrid.mission-cancel/v1",
                      expectedRevision: mission.revision,
                      reason,
                    });
                    notify("Mission cancellation requested.");
                  }
                }}
              />
            </details>
          )}
        </div>
      </main>
      {agentOpen && (
        <div
          className="resize-handle"
          role="separator"
          tabIndex={0}
          aria-label="Agent panel width"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={640}
          aria-valuenow={size}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              resize(
                event.key === "Home"
                  ? 320
                  : event.key === "End"
                    ? 640
                    : size + (event.key === "ArrowLeft" ? 40 : -40),
              );
            }
          }}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, width: size };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (drag.current) resize(drag.current.width + drag.current.x - event.clientX);
          }}
          onPointerUp={(event) => {
            drag.current = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = undefined;
          }}
        />
      )}
      <div className="agent-slot" hidden={!agentOpen}>
        <AgentPanel view={view} sessionId={sessionId} close={closeAgent} />
      </div>
    </div>
  );
}
function CancelMission({
  disabled,
  submit,
}: {
  disabled: boolean;
  submit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="stack">
      <Field label="Cancellation reason">
        <textarea
          rows={2}
          maxLength={2048}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={disabled}
        />
      </Field>
      <Action
        className="danger"
        disabled={disabled || !reason.trim()}
        run={() => submit(reason.trim())}
      >
        Cancel mission
      </Action>
    </div>
  );
}
