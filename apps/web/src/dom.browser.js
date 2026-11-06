/** Small DOM primitives. Scientific text is always textContent, never HTML. */
/** @typedef {Node | string | number | null | undefined | false} Child */
/** @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {Record<string, string | number | boolean>} attrs @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]} */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== false)
      node.setAttribute(key === "className" ? "class" : key, value === true ? "" : String(value));
  }
  node.append(
    ...children
      .filter((child) => child !== null && child !== undefined && child !== false)
      .map((child) => (child instanceof Node ? child : String(child))),
  );
  return node;
}
/** @param {string} text @param {() => unknown | Promise<unknown>} action @param {string} [style] */
export function button(text, action, style = "secondary") {
  const node = el("button", { type: "button", class: `button ${style}` }, text);
  node.addEventListener("click", () => void busy(node, action));
  return node;
}
/** @param {HTMLElement} node @param {() => unknown | Promise<unknown>} action */
export async function busy(node, action) {
  if (node.hasAttribute("aria-busy")) return;
  node.setAttribute("aria-busy", "true");
  node.setAttribute("disabled", "");
  try {
    await action();
  } catch (error) {
    notify(error instanceof Error ? error.message : "The action could not be completed.", true);
  } finally {
    node.removeAttribute("aria-busy");
    node.removeAttribute("disabled");
  }
}
/** @param {string} message @param {boolean} [error] */
export function notify(message, error = false) {
  const host = document.getElementById("notifications");
  if (!host) return;
  const note = el(
    "div",
    { class: `notice ${error ? "error" : ""}`, role: error ? "alert" : "status" },
    el("span", {}, message),
  );
  note.append(button("Dismiss", () => note.remove(), "text"));
  host.replaceChildren(note);
}
/** @param {string} value */
export const human = (value) =>
  value.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
/** @param {string} state */
export function badge(state) {
  const tone = /^(completed|approved|confirmed|ready|passed)$/u.test(state)
    ? "good"
    : /failed|rejected|blocked|uncertain|ambiguous/u.test(state)
      ? "bad"
      : /pending|approval|paused|cancel/u.test(state)
        ? "warn"
        : "neutral";
  return el("span", { class: `badge ${tone}` }, human(state));
}
/** @param {string} value */
export function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unknown date"
    : parsed.toLocaleString("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
/** @param {string} title @param {string} description @param {Child} [action] */
export function empty(title, description, action) {
  return el(
    "section",
    { class: "empty" },
    el("div", { class: "empty-mark", "aria-hidden": "true" }, "◇"),
    el("h2", {}, title),
    el("p", {}, description),
    action,
  );
}
/** @param {string} title @param {unknown} value @param {boolean} [open] */
export function inspect(title, value, open = false) {
  return el(
    "details",
    { class: "inspector", open },
    el("summary", {}, title),
    el("pre", { tabindex: "0" }, JSON.stringify(value, null, 2) ?? "No record"),
  );
}
/** @param {string} title @param {...Child} children */
export const panel = (title, ...children) =>
  el("section", { class: "panel" }, el("h2", {}, title), ...children);
/** @param {string} label @param {HTMLElement} input @param {string} [help] */
export function field(label, input, help) {
  if (!input.id) input.id = `field-${crypto.randomUUID()}`;
  const hint = help ? el("small", { id: `${input.id}-help`, class: "hint" }, help) : null;
  if (hint) input.setAttribute("aria-describedby", hint.id);
  return el("div", { class: "field" }, el("label", { for: input.id }, label), input, hint);
}
/** @param {string} label @param {string} value */
export const fact = (label, value) =>
  el("div", { class: "fact" }, el("dt", {}, label), el("dd", {}, value));
/** @param {string[]} headers @param {Child[][]} rows */
export function table(headers, rows) {
  return el(
    "div",
    { class: "table-scroll" },
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ...headers.map((header) => el("th", { scope: "col" }, header)))),
      el("tbody", {}, ...rows.map((row) => el("tr", {}, ...row.map((cell) => el("td", {}, cell))))),
    ),
  );
}
/** @param {string} projectId @param {string} [missionId] @param {string} [tab] */
export function route(projectId, missionId, tab = "overview") {
  return `#/projects/${encodeURIComponent(projectId)}${missionId ? `/missions/${encodeURIComponent(missionId)}/${tab}` : ""}`;
}
/** @param {string} title @param {Child} content @param {string} accept */
export function confirmAction(title, content, accept) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = el(
      "dialog",
      { class: "dialog", "aria-labelledby": "dialog-title" },
      el("h2", { id: "dialog-title" }, title),
      content,
    );
    const finish = (/** @type {boolean} */ value) => {
      dialog.close();
      dialog.remove();
      if (previous instanceof HTMLElement) previous.focus();
      resolve(value);
    };
    dialog.append(
      el(
        "div",
        { class: "actions" },
        button("Go back", () => finish(false)),
        button(accept, () => finish(true), "primary"),
      ),
    );
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
