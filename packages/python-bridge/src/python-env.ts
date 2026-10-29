import { SubprocessPythonBridge } from "./tasks";

export function createPythonBridge(pythonCmd?: string) {
  return new SubprocessPythonBridge(pythonCmd);
}
