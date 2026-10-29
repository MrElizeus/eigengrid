/** Internal, bounded copy of data-only protocol records. No getters or class instances. */
export function snapshotProtocolData<T>(value: T): T {
  const ancestors = new Set<object>();
  let nodes = 0;
  let textUnits = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 10_000_000 || depth > 64) throw new TypeError("Protocol data exceeds limits");
    if (item === null || item === undefined || typeof item === "boolean") return item;
    if (typeof item === "string") {
      textUnits += item.length;
      if (textUnits > 64 * 1024 * 1024) throw new TypeError("Protocol text exceeds limits");
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Protocol numbers must be finite");
      return item;
    }
    if (typeof item !== "object") throw new TypeError("Protocol must contain data, not code");
    if (ancestors.has(item)) throw new TypeError("Cyclic protocol data");
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      throw new TypeError("Protocol records must be plain objects");
    }
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError("Symbol protocol fields");
    ancestors.add(item);
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && item.length > 1_000_000) throw new TypeError("Protocol array exceeds limits");
    for (const key of Object.keys(descriptors)) {
      if (array && key === "length") continue;
      const d = descriptors[key]!;
      if (!("value" in d) || !d.enumerable) throw new TypeError("Protocol accessors are forbidden");
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new TypeError("Unsafe protocol record key");
      }
      if (array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) {
        throw new TypeError("Non-index array field");
      }
      if (array && d.value === undefined) throw new TypeError("Undefined protocol array value");
      Object.defineProperty(result, key, {
        value: visit(d.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (array && Object.keys(result).length !== item.length) throw new TypeError("Sparse array");
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0) as T;
}

/** Total, locale-independent ordering for content-addressed metadata. */
export function compareProtocolText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Defense in depth for legacy free-form QC parameters; this grants no execution authority. */
export function assertNoEffectParameters(value: unknown): void {
  const forbidden = new Set([
    "argv",
    "shell",
    "command",
    "executable",
    "script",
    "sql",
    "ssh",
    "sbatch",
    "cwd",
    "env",
  ]);
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object") return;
    for (const [key, v] of Object.entries(item)) {
      if (forbidden.has(key.toLowerCase()))
        throw new TypeError("Effect parameters are not protocol controls");
      visit(v);
    }
  };
  visit(value);
}
