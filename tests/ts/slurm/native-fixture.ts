/** Synthetic native response for unit-test scheduler doubles only.
 * Real producer fixtures are checked independently by native-accounting.test.ts.
 */
export function nativeFixtureForText(text: string): string {
  const rows = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));
  const pair = (text: string) => {
    const [code, signal] = text.split(":").map(Number);
    const set = text !== "";
    return {
      status: [signal ? "SIGNALED" : code ? "ERROR" : "SUCCESS"],
      return_code: { set, infinite: false, number: code },
      signal: { id: { set: set && signal > 0, infinite: false, number: signal || 0 } },
    };
  };
  return JSON.stringify({
    meta: {
      plugin: {
        data_parser: "data_parser/v0.0.40",
        accounting_storage: "accounting_storage/slurmdbd",
      },
      slurm: { release: "23.11.4" },
    },
    errors: [],
    warnings: [],
    jobs: rows
      .filter((row) => !row[0].includes("."))
      .map((row) => ({
        job_id: Number(row[0]),
        cluster: row[11],
        time: { submission: Date.parse(row[10].replace(/Z?$/u, "Z")) / 1000 },
        state: { current: [row[1].replace(/ by \d+$/u, "")] },
        exit_code: pair(row[2]),
        derived_exit_code: pair(row[8]),
        steps: rows
          .filter((step) => step[0].startsWith(row[0] + "."))
          .map((step) => ({
            step: { id: step[0] },
            state: [step[1].replace(/ by \d+$/u, "")],
            exit_code: pair(step[2]),
          })),
      })),
  });
}
