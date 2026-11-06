const sessionEventKey = "eigengrid.missions.session-event";

/** Only an opaque notification is shared; session credentials remain in HttpOnly cookies.
 * @param {Storage} [storage]
 */
export function announceSessionChange(storage = localStorage) {
  try {
    storage.setItem(sessionEventKey, crypto.randomUUID());
  } catch {
    // Focus revalidation still works if browser storage is disabled.
  }
}

/** @param {EventTarget} target @param {() => void} changed */
export function watchSessionChanges(target, changed) {
  /** @param {Event} event */
  const listener = (event) => {
    if (event.type === "focus" || /** @type {StorageEvent} */ (event).key === sessionEventKey)
      changed();
  };
  target.addEventListener("storage", listener);
  target.addEventListener("focus", listener);
  return () => {
    target.removeEventListener("storage", listener);
    target.removeEventListener("focus", listener);
  };
}
