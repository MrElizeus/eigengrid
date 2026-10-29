#!/usr/bin/env bun
import { resolve } from "node:path";
import { evaluateRepositoryStaticSecurity } from "../src/static-gate";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repositoryRoot = resolve(argumentValue("--root") ?? resolve(import.meta.dir, "../../.."));
const reportOnly = process.argv.includes("--report-only");
const report = await evaluateRepositoryStaticSecurity(repositoryRoot);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!reportOnly && report.verdict !== "STATIC_PASS") process.exitCode = 2;
