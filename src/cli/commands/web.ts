import { Command } from "commander";
import { serve } from "bun";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  startService,
  stopService,
  restartService,
  getServiceStatus,
  getServiceLogs,
  formatUptime,
} from "../../daemon";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Start the web UI server (foreground mode)
 */
async function startWebServer(options: { port: number; host: string }): Promise<void> {
  // Find the web dist directory - check multiple locations
  const possiblePaths = [
    join(process.cwd(), "src/web/dist"),
    join(process.cwd(), "dist/web"),
    join(dirname(__dirname), "../../web/dist"),
    join(dirname(__dirname), "../../../web/dist"),
  ];

  let distPath: string | null = null;
  for (const path of possiblePaths) {
    try {
      const { existsSync } = await import("fs");
      if (existsSync(path)) {
        distPath = path;
        break;
      }
    } catch {
      // Continue to next path
    }
  }

  if (!distPath) {
    console.error("Error: Web UI build not found.");
    console.error("Please run: bun run web:build");
    process.exit(1);
  }

  console.log(`Starting web UI server on http://${options.host}:${options.port}`);
  console.log(`Serving files from: ${distPath}`);
  console.log(`API server expected at: http://localhost:8080`);
  console.log("Press Ctrl+C to stop\n");

  const server = serve({
    port: options.port,
    hostname: options.host,
    fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;

      // Handle API proxy - redirect to the actual API server
      if (pathname.startsWith("/api") || pathname.startsWith("/ws")) {
        const targetUrl = new URL(pathname, "http://localhost:8080");
        targetUrl.search = url.search;
        return fetch(targetUrl.toString(), {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
      }

      // Serve static files
      if (pathname === "/") {
        pathname = "/index.html";
      }

      const filePath = join(distPath!, pathname);
      const file = Bun.file(filePath);

      // If file exists, serve it
      if (file.size > 0) {
        return new Response(file);
      }

      // For SPA routing: return index.html for non-file paths
      const indexPath = join(distPath!, "index.html");
      return new Response(Bun.file(indexPath));
    },
  });

  // Keep the process running
  await new Promise(() => {
    // Process will exit on SIGINT/SIGTERM
  });
}

export function registerWebCommand(program: Command): void {
  const webCmd = program
    .command("web")
    .description("Manage the Octopai Web UI (serves the React dashboard)");

  // Default action: run in foreground
  webCmd
    .option("-p, --port <port>", "Port to listen on", "5173")
    .option("-h, --host <host>", "Host to bind to", "0.0.0.0")
    .action(async (options) => {
      await startWebServer({
        port: parseInt(options.port, 10),
        host: options.host,
      });
    });

  // Start in background
  webCmd
    .command("start")
    .description("Start the web UI server in the background")
    .option("-p, --port <port>", "Port to listen on", "5173")
    .option("-h, --host <host>", "Host to bind to", "0.0.0.0")
    .action(async (options) => {
      try {
        // Set environment variables for the background process
        process.env.WEB_UI_PORT = options.port;
        process.env.WEB_UI_HOST = options.host;

        const status = await startService("web");
        if (status.running) {
          console.log(`Web UI server started (PID: ${status.pid})`);
          console.log(`Access at: http://${options.host}:${options.port}`);
        }
      } catch (err) {
        console.error(`Failed to start web UI server: ${err}`);
        process.exit(1);
      }
    });

  // Stop
  webCmd
    .command("stop")
    .description("Stop the web UI server")
    .option("-f, --force", "Force kill if graceful shutdown fails")
    .option("-t, --timeout <ms>", "Timeout for graceful shutdown", "5000")
    .action(async (options) => {
      try {
        const status = await stopService("web", {
          force: options.force,
          timeout: parseInt(options.timeout, 10),
        });
        if (!status.running) {
          console.log("Web UI server stopped");
        } else {
          console.log(`Web UI server still running (PID: ${status.pid})`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to stop web UI server: ${err}`);
        process.exit(1);
      }
    });

  // Restart
  webCmd
    .command("restart")
    .description("Restart the web UI server")
    .option("-f, --force", "Force kill if graceful shutdown fails")
    .option("-t, --timeout <ms>", "Timeout for graceful shutdown", "5000")
    .action(async (options) => {
      try {
        const status = await restartService("web", {
          force: options.force,
          timeout: parseInt(options.timeout, 10),
        });
        if (status.running) {
          console.log(`Web UI server restarted (PID: ${status.pid})`);
        } else {
          console.error("Failed to restart web UI server");
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to restart web UI server: ${err}`);
        process.exit(1);
      }
    });

  // Status
  webCmd
    .command("status")
    .description("Show web UI server status")
    .action(async () => {
      const status = await getServiceStatus("web");
      if (status.running) {
        console.log(`Web UI server: running`);
        console.log(`  PID: ${status.pid}`);
        console.log(`  Started: ${status.startedAt}`);
        console.log(`  Uptime: ${formatUptime(status.uptime || 0)}`);
      } else {
        console.log("Web UI server: not running");
      }
    });

  // Logs
  webCmd
    .command("logs")
    .description("Show web UI server logs")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .action(async (options) => {
      const lines = await getServiceLogs("web", parseInt(options.lines, 10));
      if (lines.length === 0) {
        console.log("No logs found");
      } else {
        console.log(lines.join("\n"));
      }
    });

  // Build command
  webCmd
    .command("build")
    .description("Build the web UI for production")
    .action(async () => {
      console.log("Building web UI...");
      const { execSync } = await import("node:child_process");
      try {
        execSync("bun run web:build", {
          stdio: "inherit",
          cwd: process.cwd(),
        });
        console.log("\nWeb UI built successfully!");
        console.log('Run "coleo web" to start the server');
      } catch (err) {
        console.error("Build failed:", err);
        process.exit(1);
      }
    });
}
