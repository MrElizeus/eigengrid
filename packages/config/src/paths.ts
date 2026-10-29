import { existsSync } from "fs";
import { resolve, join, dirname } from "path";

export const EIGENGRID_DIR_NAME = ".eigengrid";

export function getProjectRoot(cwd?: string): string {
  const start = cwd ?? process.cwd();
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, EIGENGRID_DIR_NAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function getEigenGridDir(cwd?: string): string {
  return join(getProjectRoot(cwd), EIGENGRID_DIR_NAME);
}

export function getConfigPath(cwd?: string): string {
  return join(getEigenGridDir(cwd), "eigengrid.yaml");
}

export function getDbPath(cwd?: string): string {
  return join(getEigenGridDir(cwd), "eigengrid.sqlite");
}

export function getJobsDir(cwd?: string): string {
  return join(getEigenGridDir(cwd), "jobs");
}

export function getLogsDir(cwd?: string): string {
  return join(getEigenGridDir(cwd), "logs");
}

export function getOutputsDir(cwd?: string): string {
  return join(getEigenGridDir(cwd), "outputs");
}

export function getSessionsDir(cwd?: string): string {
  return join(getEigenGridDir(cwd), "sessions");
}
