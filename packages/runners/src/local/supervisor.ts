import type {
  IdentityVerification,
  LocalActiveIdentity,
  LocalActiveIdentityV1,
} from "../local-identity";
import { readActiveIdentity, verifyActiveIdentity, writeActiveIdentity } from "../local-identity";
import type { LocalReceipt, LocalReceiptV1 } from "../local-receipt";
import { readReceipt, writeReceipt } from "../local-receipt";
import { type ProcessSupervisor } from "./contracts";

export class DefaultProcessSupervisor implements ProcessSupervisor {
  writeActiveIdentity(jobDir: string, attemptId: string, identity: LocalActiveIdentityV1): void {
    writeActiveIdentity(jobDir, attemptId, identity);
  }

  writeTerminalReceipt(jobDir: string, attemptId: string, receipt: LocalReceiptV1): void {
    writeReceipt(jobDir, attemptId, receipt);
  }

  readReceipt(
    jobDir: string,
    attemptId: string,
    match?: { jobId?: string; attemptId?: string; cwd?: string },
  ): LocalReceipt | null {
    return readReceipt(jobDir, attemptId, match);
  }

  verifyActiveIdentity(jobDir: string, attemptId: string): IdentityVerification {
    return verifyActiveIdentity(jobDir, attemptId);
  }

  readActiveIdentity(jobDir: string, attemptId: string): LocalActiveIdentity | null {
    return readActiveIdentity(jobDir, attemptId);
  }
}
