import {
  commandRequestDigest,
  validateCommandSpec,
  type AmberExecutable,
  type CommandSpec,
} from "./contracts";
import {
  assertAmberEnvironmentManifest,
  type AmberEnvironmentManifest,
  type ProbeObservation,
} from "./environment";

/** Explicit support statement: command materialization and operation-ledger wiring are not claimed. */
export const AMBER_HOST_EXECUTION_SUPPORT = Object.freeze({
  supported: false,
  e4_7_runner: "pending" as const,
  e4_11_operationLedger: "pending" as const,
  reason:
    "A host path resolver, process supervisor, cancellation/reconciliation, and operation ledger must be supplied by the mission runtime.",
});

export interface AmberExecutionBinding {
  executable: AmberExecutable;
  binarySha256: string;
  version: string;
  build?: string;
  environmentDigest: string;
}

export interface AmberHostExecutionRequest {
  command: CommandSpec;
  requestDigest: string;
  binding: AmberExecutionBinding;
}

export interface AmberHostExecutionReceipt {
  requestDigest: string;
  exitCode: number | null;
  signal: string | null;
  outputDigests: Record<string, string>;
}

/** Implemented by the durable operation owner, never by a model-facing tool. */
export interface AmberHostExecutionGateway {
  execute(request: AmberHostExecutionRequest): Promise<AmberHostExecutionReceipt>;
}

export class AmberHostExecutionUnavailableError extends Error {
  constructor() {
    super(AMBER_HOST_EXECUTION_SUPPORT.reason);
    this.name = "AmberHostExecutionUnavailableError";
  }
}

/** Default boundary deliberately performs no resolution, spawning, or file IO. */
export class FailClosedAmberHostExecutionGateway implements AmberHostExecutionGateway {
  async execute(_request: AmberHostExecutionRequest): Promise<AmberHostExecutionReceipt> {
    throw new AmberHostExecutionUnavailableError();
  }
}

function observedExecutable(
  environmentValue: AmberEnvironmentManifest,
  executable: AmberExecutable,
): ProbeObservation {
  const environment = assertAmberEnvironmentManifest(environmentValue);
  const observed = environment.observations.find((item) => item.executable === executable);
  if (
    observed === undefined ||
    !observed.available ||
    observed.version === undefined ||
    observed.binarySha256 === undefined
  ) {
    throw new Error(`Executable ${executable} is not bound to an available binary identity`);
  }
  if (executable === "pmemd.cuda" && observed.gpu !== true) {
    throw new Error("pmemd.cuda cannot be bound without an observed usable GPU");
  }
  return observed;
}

export function createAmberHostExecutionRequest(
  commandValue: unknown,
  environment: AmberEnvironmentManifest,
): AmberHostExecutionRequest {
  const command = validateCommandSpec(commandValue);
  const observed = observedExecutable(environment, command.executable);
  return {
    command,
    requestDigest: commandRequestDigest(command),
    binding: {
      executable: command.executable,
      binarySha256: observed.binarySha256!,
      version: observed.version!,
      ...(observed.build === undefined ? {} : { build: observed.build }),
      environmentDigest: environment.environmentDigest,
    },
  };
}
