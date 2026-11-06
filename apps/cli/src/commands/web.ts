import type { CommandModule } from "yargs";
import { spawn } from "node:child_process";

export const webCommand: CommandModule = {
  command: "web",
  describe: "Open the authenticated web workspace in your browser",
  builder: (y) =>
    y
      .option("connection-dir", {
        type: "string",
        describe:
          "Directory whose CLI connection to reuse (for example ~); credentials remain CLI-owned",
      })
      .option("origin", {
        type: "string",
        describe:
          "Canonical HTTPS origin behind a reverse proxy; requires EIGENGRID_WEB_DATABASE_URL",
      })
      .option("port", {
        type: "number",
        default: 4317,
        describe: "Loopback port (0 selects a free port)",
      })
      .option("open", {
        type: "boolean",
        default: true,
        describe: "Open the browser automatically; use --no-open to disable",
      })
      .check((args) => {
        if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)
          throw new Error("Invalid port");
        return true;
      }),
  async handler(args) {
    const { startWebServer } = await import("../web/server");
    const app = await startWebServer({
      port: args.port as number,
      origin: args.origin as string | undefined,
      connectionDirectory: args["connection-dir"] as string | undefined,
    });
    console.log(
      `\n  EigenGrid · Web workspace\n\n  ${app.url}\n\n  Keep the initial setup link private. Ctrl+C to stop.\n`,
    );
    if (args.open) {
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      const browser = spawn(command, [app.url], { stdio: "ignore" });
      browser.on("error", () => console.log("Open the address above in your browser."));
      browser.unref();
    }
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void app.close().then(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  },
};
