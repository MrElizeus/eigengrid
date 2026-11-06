import { Dialog } from "./dialogs";

export function HelpDialog({ close }: { close: () => void }) {
  return (
    <Dialog title="Commands and shortcuts" close={close}>
      <p>
        Type <kbd>/</kbd> or press <kbd>Ctrl / ⌘ K</kbd> to open the menu. Queries prepare a
        message; you decide when to send it.
      </p>
      <div className="help-shortcuts">
        {[
          ["Enter", "Send or redirect"],
          ["Shift + Enter", "New line"],
          ["Esc", "Close menu or stop response"],
          ["Ctrl / ⌘ B", "Toggle history"],
          ["Ctrl / ⌘ Shift O", "New conversation"],
          ["Ctrl / ⌘ Shift F", "Search history"],
        ].map(([key, label]) => (
          <div key={key}>
            <span>{label}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
      <p>
        You can type a correction during a response. Sending it interrupts generation and resumes
        your original request with the new instruction. Editing or retrying creates a branch and
        preserves the original conversation.
      </p>
      <p>
        Configure your account, model and variants in the CLI. Web chat supports inspection and
        analysis; continue actions that make changes in the CLI.
      </p>
    </Dialog>
  );
}
