import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { EmbeddingIdentity, EmbeddingProvider } from "./contracts";
import { EmbeddingIdentitySchema, unitVector } from "./vector-index";

const ResponseSchema = z
  .object({ id: z.number().int(), vectors: z.array(z.array(z.number().finite())).max(64) })
  .strict();

/** A trusted local process, using bounded JSONL on stdio. No shell or network embedding API. */
export class JsonlEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    id: number;
    count: number;
    resolve: (vectors: number[][]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private buffer = "";
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly command: readonly string[],
    identity: EmbeddingIdentity,
    private readonly timeoutMs = 60000,
  ) {
    this.identity = Object.freeze(EmbeddingIdentitySchema.parse(identity));
    if (!command.length || command.some((part) => part.includes("\0")))
      throw new Error("Invalid embedding worker command");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
      throw new Error("Invalid embedding timeout");
  }

  embed(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]> {
    const values = [...texts];
    if (!values.length || values.length > 64 || values.some((text) => text.length > 8000))
      return Promise.reject(new Error("Embedding request exceeds limits"));
    const next = this.queue.then(() => this.request(values, purpose));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.command[0], this.command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: {
        ...process.env,
        TOKENIZERS_PARALLELISM: "false",
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
      },
    });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024 * 1024)
        return this.stop(new Error("Embedding response exceeds limits"));
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        try {
          const response = ResponseSchema.parse(JSON.parse(line));
          const pending = this.pending;
          if (!pending || response.id !== pending.id || response.vectors.length !== pending.count)
            throw new Error("Unexpected embedding response");
          const vectors = response.vectors.map((vector) =>
            unitVector(vector, this.identity.dimensions),
          );
          clearTimeout(pending.timer);
          this.pending = undefined;
          pending.resolve(vectors);
        } catch {
          this.stop(new Error("Invalid embedding worker response"));
          return;
        }
      }
    });
    // Drain diagnostic output without retaining or logging potentially sensitive model inputs.
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (this.child === child) this.stop(new Error("Embedding worker input failed"));
    });
    child.on("error", () => {
      if (this.child === child) this.stop(new Error("Embedding worker unavailable"));
    });
    child.on("exit", () => {
      if (this.child === child) this.stop(new Error("Embedding worker exited"));
    });
    return child;
  }

  private request(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]> {
    if (this.closed) return Promise.reject(new Error("Embedding provider is closed"));
    if (this.idle) clearTimeout(this.idle);
    return new Promise<number[][]>((resolve, reject) => {
      const child = this.start();
      const id = ++this.sequence;
      const timer = setTimeout(
        () => this.stop(new Error("Embedding worker timed out")),
        this.timeoutMs,
      );
      this.pending = { id, count: texts.length, resolve, reject, timer };
      child.stdin.write(`${JSON.stringify({ id, purpose, texts })}\n`, (error) => {
        if (error) this.stop(new Error("Embedding worker input failed"));
      });
    }).finally(() => {
      this.idle = setTimeout(() => this.stop(), 1000);
      this.idle.unref();
    });
  }

  private stop(error?: Error): void {
    const child = this.child;
    this.child = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error ?? new Error("Embedding worker stopped"));
      this.pending = undefined;
    }
    child?.kill("SIGKILL");
    this.buffer = "";
  }
  close(): void {
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    this.stop();
  }
}
