import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import type { Settings } from "./client";
export function SettingsDialog({
  settings,
  directory,
  close,
  saved,
}: {
  settings: Settings;
  directory: string;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close}>
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">CLI CONNECTION</span>
          <h2>One connection</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Close settings" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <p>
        The workspace uses the provider, account and model selected in EigenGrid CLI. You do not
        need to enter credentials here.
      </p>
      <dl className="connection-details">
        <dt>Model</dt>
        <dd>{settings.model ?? "Not configured"}</dd>
        <dt>Access</dt>
        <dd>
          {settings.authMode === "chatgpt"
            ? "ChatGPT account"
            : settings.authMode === "api-key"
              ? "CLI API connection"
              : "Not configured"}
        </dd>
        <dt>Connection directory</dt>
        <dd>
          <code>{directory}</code>
        </dd>
      </dl>
      <p>
        To change it, open <code>eigengrid</code> from that directory and use <code>/connect</code>{" "}
        and <code>/models</code>.
      </p>
      <p className="hint">
        Changes are read before each message. The CLI continues to manage credentials and session
        renewal.
      </p>
      {settings.reason && <p className="error">{settings.reason}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" onClick={() => void saved().catch((e) => setError(e.message))}>
        Refresh CLI status
      </button>
    </dialog>
  );
}
export function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} aria-label={title}>
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          title="Close · Esc"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
