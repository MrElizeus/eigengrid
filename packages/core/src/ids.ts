let counter = 0;

export function generateId(prefix: string): string {
  counter += 1;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${ts}_${rand}_${counter}`;
}
