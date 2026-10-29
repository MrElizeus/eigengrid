import type { PythonBridge } from "./bridge";
import type { ParseResult, GenerateResult, ConformerResult, PythonResult } from "@eigengrid/core";
import {
  PythonParseResponseSchema,
  PythonGenerateResponseSchema,
  PythonConformerResponseSchema,
} from "@eigengrid/protocol";
import { PythonBridgeError } from "@eigengrid/core";
import { runCommand, ProcessError } from "@eigengrid/runners";

// ------------------------------------------------------------
// Configuration Constants
// ------------------------------------------------------------

/** Default timeout for parse operations: 5 minutes. */
const PARSE_TIMEOUT_MS = 5 * 60 * 1_000;

/** Default timeout for generate operations: 2 minutes. */
const GENERATE_TIMEOUT_MS = 2 * 60 * 1_000;

/** Default timeout for conformer generation: 3 minutes. */
const CONFORMER_TIMEOUT_MS = 3 * 60 * 1_000;

/** Max JSON output from Python: 10 MB. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// ------------------------------------------------------------
// SubprocessPythonBridge
// ------------------------------------------------------------

export class SubprocessPythonBridge implements PythonBridge {
  constructor(private pythonCmd: string = "python") {}

  /**
   * Execute the Python CLI subprocess, capture JSON output,
   * and validate against the expected Zod schema.
   */
  private async callPython(args: string[], options?: { timeout?: number }): Promise<string> {
    const result = await runCommand(this.pythonCmd, ["-m", "eigengrid_chem", ...args], {
      timeout: options?.timeout ?? PARSE_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxErrorBytes: MAX_OUTPUT_BYTES,
    });

    if (result.exitCode !== 0) {
      throw new PythonBridgeError(
        `Python exited with code ${result.exitCode}: ${result.stderr.slice(0, 1000).trim()}`,
      );
    }

    return result.stdout;
  }

  async parse(software: string, outputPath: string): Promise<ParseResult> {
    try {
      const raw = await this.callPython(["parse", software, outputPath, "--json"], {
        timeout: PARSE_TIMEOUT_MS,
      });
      const parsed = JSON.parse(raw);
      const zodResult = PythonParseResponseSchema.safeParse(parsed);

      if (!zodResult.success) {
        return {
          ok: false,
          parser: software,
          status: "unknown",
          error: {
            code: "SCHEMA_MISMATCH",
            message: `Python response failed Zod validation: ${zodResult.error.message}`,
            hint: "Check that the Python protocol.py matches the TypeScript parse-result.schema.ts",
          },
        };
      }

      const result = zodResult.data;
      if (result.ok) {
        return { ok: true, parser: result.parser, status: result.status, data: result.data };
      }
      return { ok: false, parser: result.parser, status: result.status, error: result.error };
    } catch (err) {
      if (err instanceof PythonBridgeError) {
        return {
          ok: false,
          parser: software,
          status: "unknown",
          error: { code: "BRIDGE_ERROR", message: err.message, hint: err.hint },
        };
      }
      if (err instanceof ProcessError) {
        return {
          ok: false,
          parser: software,
          status: "unknown",
          error: {
            code: "PROCESS_ERROR",
            message: err.message,
            hint: `Exit code: ${err.exitCode}`,
          },
        };
      }
      return {
        ok: false,
        parser: software,
        status: "unknown",
        error: {
          code: "BRIDGE_ERROR",
          message: String(err),
          hint: "Check Python bridge connectivity",
        },
      };
    }
  }

  async generate(recipe: string, params: Record<string, unknown>): Promise<GenerateResult> {
    try {
      const paramsJson = JSON.stringify(params);
      const raw = await this.callPython(["generate", recipe, "--params", paramsJson, "--json"], {
        timeout: GENERATE_TIMEOUT_MS,
      });
      const parsed = JSON.parse(raw);
      const zodResult = PythonGenerateResponseSchema.safeParse(parsed);

      if (!zodResult.success) {
        return { ok: false, message: `Schema mismatch: ${zodResult.error.message}` };
      }

      return zodResult.data.ok
        ? { ok: true, data: zodResult.data.data }
        : { ok: false, message: zodResult.data.error?.message };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }

  async conformers(smiles: string, n: number): Promise<ConformerResult> {
    try {
      const raw = await this.callPython(["conformers", smiles, String(n), "--json"], {
        timeout: CONFORMER_TIMEOUT_MS,
      });
      const parsed = JSON.parse(raw);
      const zodResult = PythonConformerResponseSchema.safeParse(parsed);

      if (!zodResult.success) {
        return { ok: false, data: { message: `Schema mismatch: ${zodResult.error.message}` } };
      }

      return zodResult.data.ok
        ? { ok: true, conformers: zodResult.data.conformers, data: zodResult.data.data }
        : { ok: false, data: { message: zodResult.data.error?.message } };
    } catch (err) {
      return { ok: false, data: { message: String(err) } };
    }
  }

  async run(cmd: string, args: string[]): Promise<PythonResult> {
    try {
      const out = await this.callPython([cmd, ...args]);
      return { ok: true, data: { output: out } };
    } catch (err) {
      return { ok: false, error: { code: "RUN_ERROR", message: String(err) } };
    }
  }
}
