import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const human = (value: string) =>
  value.replaceAll("_", " ").replace(/^./u, (c) => c.toUpperCase());
export const date = (value: string) =>
  new Date(value).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The request could not be completed.";
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <div className="muted">{children}</div>
    </div>
  );
}
export function Inspect({
  label,
  value,
  open = false,
}: {
  label: string;
  value: unknown;
  open?: boolean;
}) {
  return (
    <details className="inspect" open={open}>
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export function Badge({ value }: { value: string }) {
  const tone = /^(completed|approved|confirmed|ready|passed)$/u.test(value)
    ? "good"
    : /failed|rejected|blocked|uncertain/u.test(value)
      ? "bad"
      : /pending|approval|paused|cancel/u.test(value)
        ? "warn"
        : "";
  return <span className={`badge ${tone}`}>{human(value)}</span>;
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
interface Confirmation {
  title: string;
  content: ReactNode;
  action: string;
  resolve: (ok: boolean) => void;
}
const Ui = createContext({
  notify: (_message: string, _error?: boolean) => {},
  confirm: async (_title: string, _content: ReactNode, _action: string) => false,
});
export const useUi = () => useContext(Ui);
export function UiProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pending = useRef<Confirmation | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (confirmation) dialog.current?.showModal();
  }, [confirmation]);
  useEffect(
    () => () => {
      pending.current?.resolve(false);
    },
    [],
  );
  function finish(ok: boolean) {
    pending.current?.resolve(ok);
    pending.current = null;
    setConfirmation(null);
  }
  return (
    <Ui.Provider
      value={{
        notify: (message, error = false) => setNotice({ message, error }),
        confirm: (title, content, action) =>
          new Promise((resolve) => {
            pending.current?.resolve(false);
            const value = { title, content, action, resolve };
            pending.current = value;
            setConfirmation(value);
          }),
      }}
    >
      {children}
      {notice && (
        <div
          className={`notice ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notification">
            Dismiss
          </button>
        </div>
      )}
      {confirmation && (
        <dialog
          ref={dialog}
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            finish(false);
          }}
        >
          <h2 id={titleId}>{confirmation.title}</h2>
          <div className="dialog-content">{confirmation.content}</div>
          <div className="actions">
            <button autoFocus onClick={() => finish(false)}>
              Back
            </button>
            <button className="primary" onClick={() => finish(true)}>
              {confirmation.action}
            </button>
          </div>
        </dialog>
      )}
    </Ui.Provider>
  );
}
export function Action({
  children,
  run,
  disabled = false,
  className = "",
  title,
}: {
  children: ReactNode;
  run: () => unknown | Promise<unknown>;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  const { notify } = useUi();
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  return (
    <button
      type="button"
      className={className}
      title={title}
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={async () => {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
          await run();
        } catch (error) {
          if (alive.current) notify(errorText(error), true);
        } finally {
          lock.current = false;
          if (alive.current) setBusy(false);
        }
      }}
    >
      {busy ? "Working…" : children}
    </button>
  );
}
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
