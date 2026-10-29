import type { ParseResult, GenerateResult, ConformerResult, PythonResult } from "@eigengrid/core";
export interface PythonBridge {
  parse(software: string, outputPath: string): Promise<ParseResult>;
  generate(recipe: string, params: Record<string, unknown>): Promise<GenerateResult>;
  conformers(smiles: string, n: number): Promise<ConformerResult>;
  run(cmd: string, args: string[]): Promise<PythonResult>;
}
