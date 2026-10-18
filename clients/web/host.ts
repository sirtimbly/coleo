import { createWebServer, WEB_DIST_HINT } from "./server";
import { version } from "./package.json";

const HELP = `Usage: coleo-web [--host 127.0.0.1] [--port 3000]
Standalone web client host. Normally launched with coleo-client web.
COLEO_API_URL and COLEO_API_KEY select the upstream API connection.
  --help       Show this help
  --version    Show version`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); return; }
  if (args.includes("--version")) { console.log(version); return; }
  let host = "127.0.0.1";
  let port = 3000;
  while (args.length) {
    const argument = args.shift()!;
    const index = argument.indexOf("=");
    const flag = index < 0 ? argument : argument.slice(0, index);
    if (flag !== "--host" && flag !== "--port") throw new Error(HELP);
    const value = index < 0 ? args.shift() : argument.slice(index + 1);
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
    if (flag === "--host") host = value;
    else {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error("--port must be an integer from 1 to 65535");
      }
      port = Number(value);
    }
  }
  // Bundled host.js lives alongside index.html and assets in the installed artifact.
  if (!await Bun.file(`${import.meta.dir}/index.html`).exists()) throw new Error(WEB_DIST_HINT);
  const server = await createWebServer({
    distPath: import.meta.dir, host, port,
    apiUrl: process.env.COLEO_API_URL || "http://127.0.0.1:8080",
    apiKey: process.env.COLEO_API_KEY,
  });
  console.log(`Coleo web client: ${server.url}`);
  process.once("SIGINT", () => { server.stop(true); process.exit(130); });
  process.once("SIGTERM", () => { server.stop(true); process.exit(143); });
}

main().catch(() => {
  // Runtime errors may include upstream credentials; keep diagnostics credential-free.
  console.error(`Unable to start Coleo web. Check --host, --port and COLEO_API_URL. ${WEB_DIST_HINT}`);
  process.exitCode = 1;
});
