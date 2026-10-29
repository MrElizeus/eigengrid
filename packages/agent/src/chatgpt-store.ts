import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChatGptProfile {
  id: string;
  clientId: string;
  subject?: string;
  email?: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scopes: string[];
}

interface ChatGptState {
  version: 1;
  hostId: string;
  profiles: ChatGptProfile[];
}

/** Credentials stay outside projects and release directories; profiles survive upgrades. */
export class ChatGptStore {
  readonly directory: string;
  readonly path: string;
  constructor(
    directory = process.env.EIGENGRID_AUTH_DIR ??
      join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "eigengrid/auth"),
  ) {
    this.directory = directory;
    this.path = join(directory, "chatgpt.json");
  }

  private checkDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("ChatGPT credential directory must be private and owned by the current user");
  }

  private read(): ChatGptState | undefined {
    this.checkDirectory();
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("ChatGPT credentials cannot be read safely");
    }
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.size > 512 * 1024 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("Unsafe ChatGPT credential file permissions");
      const state = JSON.parse(readFileSync(fd, "utf8")) as ChatGptState;
      if (
        state.version !== 1 ||
        !/^urn:uuid:[0-9a-f-]{36}$/i.test(state.hostId) ||
        !Array.isArray(state.profiles) ||
        !state.profiles.every(
          (p) =>
            typeof p.id === "string" &&
            typeof p.clientId === "string" &&
            /^[A-Za-z0-9_-]{1,256}$/.test(p.clientId) &&
            p.clientId !== "dynamic_agent_client" &&
            [p.accessToken, p.refreshToken, p.idToken, p.subject, p.email, p.name].every(
              (value) => value === undefined || typeof value === "string",
            ) &&
            (p.expiresAt === undefined ||
              (typeof p.expiresAt === "number" &&
                Number.isFinite(p.expiresAt) &&
                p.expiresAt >= 0)) &&
            Array.isArray(p.scopes) &&
            p.scopes.every((s) => typeof s === "string"),
        )
      )
        throw new Error("Invalid ChatGPT credential record");
      return state;
    } catch {
      throw new Error(
        "Stored ChatGPT credentials are invalid or unsafe; repair them before continuing",
      );
    } finally {
      closeSync(fd);
    }
  }

  private write(state: ChatGptState): void {
    this.checkDirectory();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        const bytes = Buffer.from(JSON.stringify(state) + "\n");
        if (bytes.length > 512 * 1024)
          throw new Error("ChatGPT credential record exceeded the permitted size");
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
      const parent = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Serialize rotating refresh tokens across processes; never steal an uncertain lock. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.checkDirectory();
    const lock = join(this.directory, "chatgpt.lock");
    let acquired = false;
    const deadline = Date.now() + 30_000;
    while (!acquired) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error("ChatGPT credentials are busy; close other sign-in attempts and retry");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await work();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  hostId(): string {
    const existing = this.read();
    if (existing) return existing.hostId;
    const state: ChatGptState = { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [] };
    this.write(state);
    return state.hostId;
  }

  profiles(): ChatGptProfile[] {
    return this.read()?.profiles ?? [];
  }
  profile(id: string): ChatGptProfile {
    const profile = this.profiles().find((p) => p.id === id);
    if (!profile)
      throw new Error("ChatGPT account not found. Use /connect → OpenAI → Continue with ChatGPT.");
    return profile;
  }
  save(profile: ChatGptProfile): void {
    const state = this.read() ?? { version: 1 as const, hostId: this.hostId(), profiles: [] };
    const index = state.profiles.findIndex((p) => p.id === profile.id);
    if (index < 0) state.profiles.push(profile);
    else state.profiles[index] = profile;
    this.write(state);
  }
  clearTokens(id: string): void {
    const profile = this.profile(id);
    this.save({
      id: profile.id,
      clientId: profile.clientId,
      subject: profile.subject,
      email: profile.email,
      name: profile.name,
      scopes: [],
    });
  }
}
