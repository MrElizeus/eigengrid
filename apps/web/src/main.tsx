import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
class WorkspaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="boot">
        <h1>EigenGrid</h1>
        <p>The workspace could not be displayed. Reload to recover your recorded state.</p>
        <button onClick={() => location.reload()}>Reload workspace</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("app")!).render(
  <WorkspaceBoundary>
    <App />
  </WorkspaceBoundary>,
);

document.querySelector(".skip-link")?.addEventListener("click", (event) => {
  event.preventDefault();
  document.getElementById("main")?.focus();
});
