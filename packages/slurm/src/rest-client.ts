import type {
  SlurmAccountingRecord,
  SlurmClient,
  SlurmJobStatus,
  SlurmNode,
  SlurmPartition,
  SlurmSubmitOptions,
  SlurmSubmitResult,
} from "./types";

export interface SlurmRestClientConfig {
  baseUrl: string;
  token?: string;
  username?: string;
  timeoutMs?: number;
}

export class SlurmRestClient implements SlurmClient {
  readonly config: SlurmRestClientConfig;

  constructor(config: SlurmRestClientConfig) {
    if (!config.baseUrl) throw new Error("SlurmRestClient requires baseUrl");
    this.config = { timeoutMs: 10_000, ...config };
  }

  async submitJob(_scriptPath: string, _opts?: SlurmSubmitOptions): Promise<SlurmSubmitResult> {
    return notImplemented("submitJob");
  }

  async getJobStatus(_slurmJobId: string): Promise<SlurmJobStatus> {
    return notImplemented("getJobStatus");
  }

  async cancelJob(_slurmJobId: string): Promise<{ success: boolean; error?: string }> {
    return notImplemented("cancelJob");
  }

  async getNodes(): Promise<SlurmNode[]> {
    return notImplemented("getNodes");
  }

  async getPartitions(): Promise<SlurmPartition[]> {
    return notImplemented("getPartitions");
  }

  async getAccounting(_slurmJobId: string): Promise<SlurmAccountingRecord | null> {
    return notImplemented("getAccounting");
  }
}

function notImplemented(method: string): never {
  throw new Error(
    `SlurmRestClient.${method} is not implemented yet. Use SlurmCliClient for production execution until slurmrestd support is added.`,
  );
}
