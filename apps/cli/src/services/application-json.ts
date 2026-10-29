import { canonicalAgentJson } from "@eigengrid/agent-runtime";

/** Application output may have absent optional TypeScript properties. Drop those
 * object fields before transport, while retaining strict rejection of accessors,
 * cycles, non-plain values and undefined array entries. Never use this for input,
 * physical digests or approval payloads. */
export function applicationJson(value: unknown): unknown {
  const parents = new WeakSet<object>();
  function copy(item: unknown, depth: number): unknown {
    if (depth > 48) throw new Error("Application JSON nesting limit");
    if (!item || typeof item !== "object") return item;
    if (parents.has(item)) throw new Error("Application JSON cycle");
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new Error("Application JSON non-plain value");
    parents.add(item);
    try {
      const output: Record<string, unknown> | unknown[] = Array.isArray(item)
        ? []
        : Object.create(null);
      if (Array.isArray(output)) output.length = (item as unknown[]).length;
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor)) throw new Error("Application JSON accessor");
        if (descriptor.value === undefined && !Array.isArray(item)) continue;
        Object.defineProperty(output, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    } finally {
      parents.delete(item);
    }
  }
  return JSON.parse(canonicalAgentJson(copy(value, 0)));
}
