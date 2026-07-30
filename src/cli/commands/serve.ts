import { Command } from "commander";
import { startServer } from "../../api";
import { ensureLocalNatsForServe } from "../local-nats";
import {
	startService,
	stopService,
	restartService,
	getServiceStatus,
	getServiceLogs,
	formatUptime,
	isSelfModifyAllowed,
} from "../../daemon";

export function registerServeCommand(program: Command): void {
	const serveCmd = program
		.command("serve")
		.alias("server")
		.description("Start the API server (required for harness-based arms)");

	// Default action: run in foreground (existing behavior)
	serveCmd
		.option("-p, --port <port>", "Port to listen on (defaults to COLEO_API_PORT)")
		.option("-h, --host <host>", "Host to bind to (defaults to COLEO_API_HOST)")
		.action(async (options) => {
			await ensureLocalNatsForServe();
			await startServer({
				port: options.port ? parseInt(options.port, 10) : undefined,
				host: options.host,
			});
		});

	// Start in background
	serveCmd
		.command("start")
		.description("Start the API server in the background")
		.option(
			"--self-modify",
			"Require COLEO_SELF_MODIFY env var (for arm access)",
		)
		.action(async (options) => {
			try {
				const status = await startService("server", {
					requireSelfModify: options.selfModify,
				});
				if (status.running) {
					console.log(`Server started (PID: ${status.pid})`);
				}
			} catch (err) {
				console.error(`Failed to start server: ${err}`);
				process.exit(1);
			}
		});

	// Stop
	serveCmd
		.command("stop")
		.description("Stop the API server")
		.option("-f, --force", "Force kill if graceful shutdown fails")
		.option("-t, --timeout <ms>", "Timeout for graceful shutdown", "5000")
		.option(
			"--self-modify",
			"Require COLEO_SELF_MODIFY env var (for arm access)",
		)
		.action(async (options) => {
			try {
				const status = await stopService("server", {
					requireSelfModify: options.selfModify,
					force: options.force,
					timeout: parseInt(options.timeout, 10),
				});
				if (!status.running) {
					console.log("Server stopped");
				} else {
					console.log(`Server still running (PID: ${status.pid})`);
					process.exit(1);
				}
			} catch (err) {
				console.error(`Failed to stop server: ${err}`);
				process.exit(1);
			}
		});

	// Restart
	serveCmd
		.command("restart")
		.description("Restart the API server")
		.option("-f, --force", "Force kill if graceful shutdown fails")
		.option("-t, --timeout <ms>", "Timeout for graceful shutdown", "5000")
		.option(
			"--self-modify",
			"Require COLEO_SELF_MODIFY env var (for arm access)",
		)
		.action(async (options) => {
			try {
				const status = await restartService("server", {
					requireSelfModify: options.selfModify,
					force: options.force,
					timeout: parseInt(options.timeout, 10),
				});
				if (status.running) {
					console.log(`Server restarted (PID: ${status.pid})`);
				} else {
					console.error("Failed to restart server");
					process.exit(1);
				}
			} catch (err) {
				console.error(`Failed to restart server: ${err}`);
				process.exit(1);
			}
		});

	// Status
	serveCmd
		.command("status")
		.description("Show API server status")
		.action(async () => {
			const status = await getServiceStatus("server");
			if (status.running) {
				console.log(`Server: running`);
				console.log(`  PID: ${status.pid}`);
				console.log(`  Started: ${status.startedAt}`);
				console.log(`  Uptime: ${formatUptime(status.uptime || 0)}`);
			} else {
				console.log("Server: not running");
			}
		});

	// Logs
	serveCmd
		.command("logs")
		.description("Show API server logs")
		.option("-n, --lines <n>", "Number of lines to show", "50")
		.option("-f, --follow", "Follow log output (not implemented yet)")
		.action(async (options) => {
			const lines = await getServiceLogs("server", parseInt(options.lines, 10));
			if (lines.length === 0) {
				console.log("No logs found");
			} else {
				console.log(lines.join("\n"));
			}
		});
}
