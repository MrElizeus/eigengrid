import { randomBytes } from "node:crypto";
import type { CommandModule } from "yargs";
import {
  initializeApplicationHttpSchema,
  startApplicationHttpServer,
} from "../services/http/composition";
import { httpSecretDigest } from "../services/http/auth";

export const serveCommand: CommandModule = {
  command: "serve",
  describe: "Run the authenticated application HTTP listener using protected Head configuration",
  builder(y) {
    return y
      .command(
        "init-schema",
        "Explicitly install application HTTP tables in the protected database",
        (child) => child.strict(),
        async () => {
          await initializeApplicationHttpSchema();
          console.log("Application HTTP schema installed");
        },
      )
      .command(
        "credential",
        "Generate a private 256-bit login credential and its provisioning digest",
        (child) => child.strict(),
        () => {
          const credential = randomBytes(32).toString("base64url");
          console.log(
            JSON.stringify(
              { credential, httpCredentialDigest: httpSecretDigest(credential) },
              null,
              2,
            ),
          );
        },
      )
      .strict();
  },
  async handler() {
    try {
      const app = await startApplicationHttpServer();
      console.log(`EigenGrid HTTP listening on 127.0.0.1:${app.server.port}`);
      const stop = () => {
        void app.close().then(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    } catch {
      console.error(
        "HTTP startup failed: verify protected configuration, database migrations and application HTTP schema.",
      );
      process.exitCode = 1;
    }
  },
};
