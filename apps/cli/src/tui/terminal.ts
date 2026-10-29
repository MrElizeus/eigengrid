import { stripVTControlCharacters } from "node:util";
import { useEffect, useState } from "react";
import { useStdout } from "ink";

/** External logs/names must not inject terminal commands or extra table rows. */
export function terminalText(value: unknown, multiline = false): string {
  const clean = stripVTControlCharacters(String(value ?? "")).replace(
    // eslint-disable-next-line no-control-regex -- Strip unsafe terminal control bytes.
    /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g,
    "",
  );
  return multiline ? clean.replace(/\t/g, "  ") : clean.replace(/[\n\t]/g, " ");
}

export function useTerminalSize() {
  const { stdout } = useStdout();
  const measure = () => ({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [size, setSize] = useState(measure);
  useEffect(() => {
    const resize = () => setSize(measure());
    stdout.on("resize", resize);
    resize();
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout]);
  return size;
}

export function windowStart(index: number, count: number, capacity: number): number {
  return Math.max(0, Math.min(index - Math.floor(capacity / 2), count - capacity));
}
