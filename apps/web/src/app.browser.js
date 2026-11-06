import { api, ApiError, missionPath } from "./api.browser.js";
import { el, button, busy, field, badge, date, empty, route, human } from "./dom.browser.js";
import { renderCreate } from "./create.browser.js";
import { renderMission } from "./mission.browser.js";
import { recoveryPanel } from "./recovery.browser.js";
import { announceSessionChange, watchSessionChanges } from "./session.browser.js";

const root = document.getElementById("app");
if (!root) throw new Error("Application root is missing");
/** @type {import('./contracts').ScientificProjectSummary[]} */
let projects = [];
let controller = new AbortController();
let initialized = false;

function brand() {
  return el(
    "a",
    { class: "brand", href: "#/" },
    el("img", { src: "/assets/mark.svg", width: 36, height: 36, alt: "" }),
    el("span", {}, "EigenGrid", el("small", {}, "SCIENTIFIC COMPUTING")),
  );
}

/** @param {string} [message] */
function login(message) {
  initialized = false;
  projects = [];
  controller.abort();
  const credential = el("input", {
    type: "password",
    name: "credential",
    required: true,
    autocomplete: "off",
    spellcheck: "false",
    pattern: "[A-Za-z0-9_-]{43}",
    placeholder: "Your access credential",
  });
  const submit = el(
    "button",
    { type: "submit", class: "button primary" },
    "Connect to workspace →",
  );
  const error = el("p", { class: "error-text", role: "alert" }, message ?? "");
  const form = el(
    "form",
    { class: "login-form" },
    el("p", { class: "eyebrow" }, "Your research, traceable."),
    el("h1", {}, "Mission control."),
    el(
      "p",
      { class: "subtitle" },
      "Plan scientific work, review decisions and follow every result back to its evidence.",
    ),
    field(
      "Access credential",
      credential,
      "Use the credential issued by your EigenGrid administrator.",
    ),
    submit,
    error,
    el(
      "p",
      { class: "hint" },
      "Your session uses a secure, HttpOnly cookie. The access credential is never saved by this console.",
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";
    const secret = credential.value.trim();
    credential.value = "";
    void busy(submit, async () => {
      try {
        await api.login(secret);
        announceSessionChange();
        initialized = true;
        await render();
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : "Unable to sign in.";
        credential.focus();
      }
    });
  });
  const steps = [
    ["01", "Define", "Objectives and boundaries"],
    ["02", "Review", "Explicit, accountable decisions"],
    ["03", "Observe", "Durable work and evidence"],
  ];
  const story = el(
    "div",
    { class: "story-content" },
    el("p", { class: "eyebrow" }, "FROM QUESTION TO EVIDENCE"),
    el("h2", {}, "A clear view of\nyour scientific work."),
    el(
      "div",
      { class: "orbit", "aria-hidden": "true" },
      el("span", {}, "E"),
      el("i", {}),
      el("i", {}),
    ),
    el(
      "ol",
      { class: "story-steps" },
      ...steps.map(([number, title, text]) =>
        el(
          "li",
          {},
          el("span", {}, number),
          el("div", {}, el("strong", {}, title), el("small", {}, text)),
        ),
      ),
    ),
  );
  root?.replaceChildren(
    el(
      "div",
      { class: "login-layout" },
      el("aside", { class: "login-story" }, brand(), story),
      el(
        "main",
        { id: "main", class: "login-main", tabindex: "-1" },
        form,
        el("p", { class: "login-footer" }, "EigenGrid / Human application console"),
      ),
    ),
  );
  credential.focus();
}

/** @param {string} projectId */
function shell(projectId) {
  const projectSelect = el(
    "select",
    { id: "project-selector", "aria-label": "Current project" },
    ...projects.map((project) => el("option", { value: project.id }, project.name)),
  );
  projectSelect.value = projectId;
  projectSelect.addEventListener("change", () => {
    location.hash = route(projectSelect.value);
  });
  const actor = api.session?.actor;
  const main = el("main", { id: "main", class: "main", tabindex: "-1" });
  root?.replaceChildren(
    el(
      "div",
      { class: "workspace" },
      el(
        "aside",
        { class: "sidebar" },
        brand(),
        el(
          "div",
          { class: "project-switch" },
          el("label", { for: "project-selector", class: "eyebrow" }, "Workspace"),
          projectSelect,
        ),
        el(
          "nav",
          { class: "primary-nav", "aria-label": "Workspace navigation" },
          el(
            "a",
            { href: route(projectId), class: "active" },
            el("span", { "aria-hidden": "true" }, "▦"),
            "Missions",
          ),
          el(
            "a",
            { href: `#/projects/${encodeURIComponent(projectId)}/new` },
            el("span", { "aria-hidden": "true" }, "+"),
            "New mission",
          ),
        ),
        el(
          "div",
          { class: "sidebar-note" },
          el("span", { class: "connection-dot", "aria-hidden": "true" }),
          "Authenticated workspace",
          el("p", {}, "Every action is bound to your current project authority."),
        ),
        el(
          "div",
          { class: "account" },
          el(
            "div",
            { class: "avatar", "aria-hidden": "true" },
            (actor?.id ?? "?").slice(0, 2).toUpperCase(),
          ),
          el(
            "div",
            {},
            el("strong", {}, actor?.displayName ?? actor?.id ?? ""),
            el("small", {}, api.session?.roles.join(", ") ?? ""),
          ),
          button(
            "Sign out",
            async () => {
              await api.logout();
              announceSessionChange();
              login();
            },
            "text",
          ),
        ),
      ),
      el(
        "div",
        { class: "workspace-body" },
        el(
          "header",
          { class: "topbar" },
          el(
            "span",
            {},
            "Workspace",
            el("span", { class: "crumb-separator" }, "/"),
            el("strong", {}, projects.find((item) => item.id === projectId)?.name ?? projectId),
          ),
          el("span", { class: "topbar-label" }, "HUMAN CONSOLE"),
        ),
        main,
      ),
    ),
  );
  return main;
}

/** @param {string} projectId @param {HTMLElement} main @param {AbortSignal} signal */
async function dashboard(projectId, main, signal) {
  /** @type {import('./contracts').ScientificMissionSummary[]} */
  const missions = await api.list(missionPath(projectId), signal);
  if (signal.aborted) return;
  const active = missions.filter(
    (item) => !["completed", "failed", "cancelled"].includes(item.state),
  );
  const awaiting = missions.filter((item) => item.state === "awaiting_approval");
  const search = el("input", {
    type: "search",
    placeholder: "Search missions by question or ID…",
    "aria-label": "Search missions",
  });
  const filter = el(
    "select",
    { "aria-label": "Filter missions by state" },
    el("option", { value: "all" }, "All states"),
    ...[...new Set(missions.map((item) => item.state))]
      .sort()
      .map((state) => el("option", { value: state }, human(state))),
  );
  const rows = el("div", { class: "mission-list" });
  const count = el("p", { class: "hint", role: "status" });
  const newLink = () =>
    el(
      "a",
      { class: "button primary", href: `#/projects/${encodeURIComponent(projectId)}/new` },
      "+ New mission",
    );
  const update = () => {
    const query = search.value.toLowerCase().trim();
    const items = missions
      .filter(
        (item) =>
          (filter.value === "all" || item.state === filter.value) &&
          `${item.id} ${item.statement} ${item.targetProperties.join(" ")}`
            .toLowerCase()
            .includes(query),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    count.textContent = `${items.length} of ${missions.length} missions · Owned by your account`;
    rows.replaceChildren(
      ...items.map((item) =>
        el(
          "a",
          { class: "mission-row", href: route(projectId, item.id) },
          el("span", { class: "mission-symbol", "aria-hidden": "true" }, "◇"),
          el(
            "div",
            { class: "mission-title" },
            el("h2", {}, item.statement),
            el(
              "div",
              { class: "row-meta" },
              el("code", {}, item.id),
              el("span", {}, item.targetProperties.join(" · ")),
            ),
          ),
          el(
            "div",
            { class: "mission-state" },
            badge(item.state),
            el("time", { datetime: item.updatedAt }, date(item.updatedAt)),
          ),
          el("span", { class: "row-arrow", "aria-hidden": "true" }, "↗"),
        ),
      ),
    );
    if (!items.length)
      rows.append(
        missions.length
          ? empty(
              "No matching missions",
              "Try another search or choose a different state.",
              button("Clear filters", () => {
                search.value = "";
                filter.value = "all";
                update();
              }),
            )
          : empty(
              "Your next question starts here",
              "Create a mission to define its objective, evidence and execution boundaries.",
              newLink(),
            ),
      );
  };
  search.addEventListener("input", update);
  filter.addEventListener("change", update);
  main.replaceChildren(
    el(
      "div",
      { class: "page-heading" },
      el(
        "div",
        {},
        el("p", { class: "eyebrow" }, "Research operations"),
        el("h1", {}, "Mission control"),
        el("p", { class: "subtitle" }, "From scientific intent to inspectable evidence."),
      ),
      newLink(),
    ),
    recoveryPanel(projectId, render) ?? el("span"),
    el(
      "section",
      { class: "metrics", "aria-label": "Mission counts" },
      ...[
        ["Total missions", missions.length, "In this project"],
        ["Active", active.length, "Work in progress"],
        ["Awaiting review", awaiting.length, "Human decisions needed"],
        [
          "Completed",
          missions.filter((item) => item.state === "completed").length,
          "Execution lifecycle",
        ],
      ].map(([label, number, hint]) =>
        el(
          "div",
          { class: "metric" },
          el("span", {}, label),
          el("strong", {}, number),
          el("small", {}, hint),
        ),
      ),
    ),
    el(
      "section",
      { class: "mission-section" },
      el(
        "div",
        { class: "section-heading" },
        el("h2", {}, "Your missions"),
        button("Refresh", render, "text"),
      ),
      el("div", { class: "filters" }, search, filter),
      count,
      rows,
    ),
    el(
      "p",
      { class: "footer-note" },
      "Scientific assessments are recorded separately from execution status. Review each mission's evidence and acceptance criteria.",
    ),
  );
  update();
}

async function render() {
  controller.abort();
  controller = new AbortController();
  const signal = controller.signal;
  let main = /** @type {HTMLElement | null} */ (null);
  try {
    if (!initialized || !api.session) {
      await api.bootstrap(signal);
      if (signal.aborted) return;
      initialized = true;
    }
    const availableProjects = await api.list("/projects", signal);
    if (signal.aborted) return;
    projects = availableProjects;
    if (!projects.length) {
      main = shell("");
      main.append(
        empty(
          "No accessible projects",
          "Your account has no active projects within its configured HTTP access. Ask your administrator to assign project membership and access.",
        ),
        button("Check again", render),
      );
      return;
    }
    const parts = location.hash.replace(/^#\/?/u, "").split("/").map(decodeURIComponent);
    const projectId = parts[0] === "projects" ? parts[1] : projects[0].id;
    main = shell(projectId);
    if (!projects.some((item) => item.id === projectId)) {
      main.append(
        empty(
          "Project unavailable",
          "This project is not in your current authorized workspace.",
          el(
            "a",
            { class: "button primary", href: route(projects[0].id) },
            "Open an accessible project",
          ),
        ),
      );
      return;
    }
    main.append(el("p", { class: "loading", role: "status" }, "Loading workspace…"));
    if (parts[2] === "new") renderCreate(projectId, main);
    else if (parts[2] === "missions" && parts[3])
      await renderMission(
        projectId,
        parts[3],
        parts[4] ?? "overview",
        parts[5],
        main,
        signal,
        render,
      );
    else await dashboard(projectId, main, signal);
    if (!signal.aborted)
      document.title = `EigenGrid · ${parts[2] === "new" ? "New mission" : parts[2] === "missions" ? "Mission workspace" : "Mission control"}`;
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof ApiError && error.status === 401) {
      login();
      return;
    }
    const message = error instanceof Error ? error.message : "The workspace could not be loaded.";
    if (!main) {
      main = el("main", { id: "main", class: "main" });
      root?.replaceChildren(main);
    }
    main.replaceChildren(empty("Workspace unavailable", message, button("Try again", render)));
  }
}

window.addEventListener("hashchange", () => {
  if (api.session) void render();
});
window.addEventListener("eigengrid:session-expired", () =>
  login("Your session expired or access changed. Sign in to continue."),
);
watchSessionChanges(window, () => {
  api.invalidateSession();
  controller.abort();
  initialized = false;
  projects = [];
  root.replaceChildren(el("p", { class: "loading", role: "status" }, "Checking session…"));
  void render();
});
document.querySelector(".skip-link")?.addEventListener("click", (event) => {
  event.preventDefault();
  document.getElementById("main")?.focus();
});
void render();
