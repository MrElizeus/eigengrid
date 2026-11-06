import { browserBundle } from "./browser-bundle" with { type: "macro" };

// Isolate macro expansion from the HTTP module graph for source and native builds.
export const browser = browserBundle();
