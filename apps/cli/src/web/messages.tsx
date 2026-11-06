import { useRef, useState } from "react";
import type { ToolActivity } from "./store";
import { Icon } from "./icons";
export function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy"
      aria-label="Copy response"
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          })
          .catch(() => setCopied(false))
      }
    >
      <Icon name={copied ? "check" : "copy"} size={15} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
export function CodeBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>CODE</span>
        <button
          className="text-button"
          onClick={() =>
            void navigator.clipboard.writeText(ref.current?.innerText ?? "").then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            })
          }
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
export function Tools({ tools }: { tools: ToolActivity[] }) {
  return (
    <div className="tools">
      {tools.map((t, i) => (
        <details key={i}>
          <summary>
            <Icon name="terminal" size={15} />
            <span>{t.name}</span>
            <span className={t.ok === false ? "tool-error" : "tool-state"}>
              {t.ok === undefined ? "In progress" : t.ok ? "Completed" : "Not completed"}
            </span>
          </summary>
          <pre>{JSON.stringify(t.result ?? t.args, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
