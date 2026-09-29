/**
 * Dependency-aware integration smoke suite.
 *
 * Boots the approved local topology from a clean temporary workspace and
 * exercises each layer in dependency order:
 *
 *   workspace -> migrations -> maildir -> nats -> api -> api-auth ->
 *   cli -> brain-paths -> websocket -> shutdown
 *
 * - A failed stage gates (skips) its dependents with a recorded reason.
 * - NATS is optional: when the binary cannot start, NATS-dependent
 *   assertions skip while the API exercises its JetStream-unavailable
 *   fallbacks instead.
 * - All processes are terminated and the temp workspace removed at the
 *   end (unless --keep is passed for debugging).
 *
 * Usage:
 *   bun run src/regression/smoke-topology.ts [--api-port N] [--nats-port N] [--keep] [--skip-nats]
 *   bun run smoke:topology
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";
import { randomUUID } from "node:crypto";

interface StageResult {
	name: string;
	status: "pass" | "fail" | "skip";
	detail: string;
	ms: number;
}

const results: StageResult[] = [];
let failed = false;

function record(name: string, status: StageResult["status"], detail: string, ms: number): void {
	results.push({ name, status, detail, ms });
	if (status === "fail") failed = true;
	console.log(`[${status.toUpperCase()}] ${name} (${ms}ms): ${detail}`);
}

function skipDependents(name: string, reason: string): void {
	record(name, "skip", reason, 0);
}

async function waitFor(
	description: string,
	probe: () => Promise<boolean>,
	timeoutMs = 30000,
	intervalMs = 500,
): Promise<boolean> {
	const start = Date.now();
	for (;;) {
		try {
			if (await probe()) return true;
		} catch {
			// Keep polling until the timeout.
		}
		if (Date.now() - start > timeoutMs) return false;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

async function tcpOpen(host: string, port: number): Promise<boolean> {
	try {
		const conn = await Bun.connect({ hostname: host, port, socket: { data() {} } });
		conn.end();
		return true;
	} catch {
		return false;
	}
}

async function stopProc(proc: Subprocess | null, label: string): Promise<void> {
	if (!proc) return;
	try {
		proc.kill("SIGTERM");
		const exited = await Promise.race([
			proc.exited.then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
		]);
		if (!exited) {
			proc.kill("SIGKILL");
			await proc.exited.catch(() => undefined);
		}
	} catch {
		console.log(`(shutdown) ${label} already exited`);
	}
}

function parseArgs(): { apiPort: number; natsPort: number; keep: boolean; skipNats: boolean } {
	const args = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const index = args.indexOf(flag);
		return index >= 0 ? args[index + 1] : undefined;
	};
	return {
		apiPort: Number.parseInt(get("--api-port") ?? "18080", 10),
		natsPort: Number.parseInt(get("--nats-port") ?? "14222", 10),
		keep: args.includes("--keep"),
		skipNats: args.includes("--skip-nats"),
	};
}

async function main(): Promise<void> {
	const repoRoot = process.cwd();
	const { apiPort, natsPort, keep, skipNats } = parseArgs();
	const apiKey = `smoke-${randomUUID()}`;
	const apiBase = `http://127.0.0.1:${apiPort}`;
	const headers = { "Content-Type": "application/json", "X-API-Key": apiKey };
	let apiProc: Subprocess | null = null;
	let natsProc: Subprocess | null = null;
	let root = "";
	let natsUp = false;
	let apiUp = false;

	const json = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
		const response = await fetch(`${apiBase}${path}`, init);
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			// Non-JSON bodies are fine for status-only assertions.
		}
		return { status: response.status, body };
	};

	// Stage 1: clean workspace.
	{
		const start = Date.now();
		try {
			root = await mkdtemp(join(tmpdir(), "coleo-smoke-"));
			const coleoDir = join(root, ".coleo");
			await Bun.write(join(root, "probe.txt"), "smoke");
			record("workspace", "pass", `clean temp workspace at ${root}`, Date.now() - start);
			process.env.SMOKE_COLEO_DIR = coleoDir;
			process.env.SMOKE_ROOT = root;
		} catch (error) {
			record("workspace", "fail", String(error), Date.now() - start);
			process.exitCode = 1;
			printSummary();
			return;
		}
	}
	const coleoDir = process.env.SMOKE_COLEO_DIR as string;

	// Stage 2: migrations (gates everything below).
	{
		const start = Date.now();
		try {
			const { initDatabase } = await import("../db/index");
			const { assertDatabaseCompatible } = await import("../db/migration-runner");
			const { getMigrations } = await import("../db/migration-catalog");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(coleoDir, { recursive: true });
			const dbPath = join(coleoDir, "coleo.db");
			const db = await initDatabase(dbPath);
			try {
				const count = db.query("SELECT COUNT(*) AS count FROM _migrations").get() as { count: number };
				if (count.count === 0) throw new Error("no migrations recorded");
				db.transaction(() => assertDatabaseCompatible(db, getMigrations()))();
				// Repeatability: second init must be a no-op success.
				db.close();
				const reopened = await initDatabase(dbPath);
				reopened.close();
			} catch (error) {
				try {
					db.close();
				} catch {
					// Ignore close errors after a failed assertion.
				}
				throw error;
			}
			record("migrations", "pass", "migrated, compatible, repeatable", Date.now() - start);
		} catch (error) {
			record("migrations", "fail", String(error), Date.now() - start);
		}
	}

	// Stage 3: Maildir roundtrip (needs workspace only).
	{
		const start = Date.now();
		try {
			const { initMaildir, Maildir } = await import("../mail/index");
			await initMaildir(join(coleoDir, "mail"));
			const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
			await inbox.init();
			const id = (
				await inbox.write({
					from: "smoke@example.test",
					to: "brain@example.test",
					subject: "smoke",
					date: new Date(),
					body: "hello",
					headers: {},
				})
			).id;
			const listed = await inbox.list("new");
			if (!listed.some((message) => message.id === id)) {
				throw new Error("written message not listed");
			}
			record("maildir", "pass", "write/list roundtrip", Date.now() - start);
		} catch (error) {
			record("maildir", "fail", String(error), Date.now() - start);
		}
	}

	// Stage 4: NATS with JetStream (optional).
	if (!skipNats) {
		const start = Date.now();
		try {
			const binary = resolve(repoRoot, ".coleo/bin/nats-server");
			const storeDir = join(coleoDir, "nats");
			await Bun.$`mkdir -p ${storeDir}`.quiet();
			natsProc = spawn({
				cmd: [binary, "-js", "-sd", storeDir, "-p", String(natsPort)],
				stdout: "ignore",
				stderr: "ignore",
			});
			natsUp = await waitFor("nats", () => tcpOpen("127.0.0.1", natsPort), 20000);
			if (!natsUp) {
				await stopProc(natsProc, "nats-server");
				natsProc = null;
				throw new Error("NATS port never opened");
			}
			record("nats", "pass", `jetstream on :${natsPort}`, Date.now() - start);
		} catch (error) {
			natsProc = null;
			record("nats", "fail", `skipping NATS-dependent assertions: ${error}`, Date.now() - start);
		}
	} else {
		skipDependents("nats", "--skip-nats requested");
	}

	// Stage 5: API serve (gates on workspace+migrations only).
	{
		const start = Date.now();
		const migrationsOk = results.some((r) => r.name === "migrations" && r.status === "pass");
		if (!migrationsOk) {
			skipDependents("api", "migrations stage failed");
		} else {
			try {
				apiProc = spawn({
					cmd: ["bun", "run", "src/cli/index.ts", "serve", "--host", "127.0.0.1", "--port", String(apiPort)],
					cwd: repoRoot,
					env: {
						...process.env,
						COLEO_DIR: coleoDir,
						COLEO_PROJECT_DIR: root,
						COLEO_API_KEY: apiKey,
						COLEO_API_PORT: String(apiPort),
						COLEO_NATS_URL: natsUp ? `nats://127.0.0.1:${natsPort}` : "",
					},
					stdout: "ignore",
					stderr: "ignore",
				});
				apiUp = await waitFor(
					"api health",
					async () => (await json("/api/health")).status === 200,
					45000,
				);
				if (!apiUp) throw new Error("/api/health never returned 200");
				record("api", "pass", `serve healthy on :${apiPort}`, Date.now() - start);
			} catch (error) {
				await stopProc(apiProc, "api");
				apiProc = null;
				record("api", "fail", String(error), Date.now() - start);
			}
		}
	}

	// Stage 6: auth contract.
	{
		const start = Date.now();
		if (!apiUp) {
			skipDependents("api-auth", "api stage failed");
		} else {
			try {
				const anon = await json("/api/tasks?limit=1");
				if (anon.status !== 401) throw new Error(`expected 401 without key, got ${anon.status}`);
				const authed = await json("/api/tasks?limit=1", { headers });
				if (authed.status !== 200) throw new Error(`expected 200 with key, got ${authed.status}`);
				record("api-auth", "pass", "401 without key, 200 with X-API-Key", Date.now() - start);
			} catch (error) {
				record("api-auth", "fail", String(error), Date.now() - start);
			}
		}
	}

	// Stage 7: CLI against the test server.
	{
		const start = Date.now();
		if (!apiUp) {
			skipDependents("cli", "api stage failed");
		} else {
			try {
				const proc = Bun.spawn(
					["bun", "run", "src/cli/index.ts", "status"],
					{
						cwd: repoRoot,
						env: {
							...process.env,
							COLEO_DIR: coleoDir,
							COLEO_PROJECT_DIR: root,
							COLEO_API_URL: apiBase,
							COLEO_API_KEY: apiKey,
							COLEO_API_PORT: String(apiPort),
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [stdout, stderr, code] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				if (code !== 0) throw new Error(`coleo status exited ${code}: ${stderr.slice(0, 300)}`);
				if (!/healthy|running|ok|Coleo/i.test(stdout)) {
					throw new Error(`unexpected status output: ${stdout.slice(0, 200)}`);
				}
				record("cli", "pass", "coleo status against test server", Date.now() - start);
			} catch (error) {
				record("cli", "fail", String(error), Date.now() - start);
			}
		}
	}

	// Stage 8: Brain integration surface (publish + read + queue via API).
	{
		const start = Date.now();
		if (!apiUp) {
			skipDependents("brain-paths", "api stage failed");
		} else {
			try {
				const subject = `coleo.events.brain.smoke-${randomUUID().slice(0, 8)}`;
				const published = await json("/api/events/internal/publish", {
					method: "POST",
					headers,
					body: JSON.stringify({
						subject,
						type: "smoke_check",
						armId: "smoke",
						data: { ok: true },
					}),
				});
				const publishedBody = published.body as { published?: boolean; error?: string };
				const storeUnavailable = published.status === 503;
				if (published.status !== 200 || !publishedBody.published) {
					if (!(natsUp === false && storeUnavailable)) {
						throw new Error(
							`publish returned ${published.status}: ${JSON.stringify(publishedBody).slice(0, 200)}`,
						);
					}
				}
				const recent = await json("/api/events/recent?limit=5", { headers });
				if (recent.status !== 200 && recent.status !== 503) {
					throw new Error(`recent returned ${recent.status}`);
				}
				const queued = await json("/api/brain/internal/messages/queue", {
					method: "POST",
					headers,
					body: JSON.stringify({
						id: `smoke-${randomUUID()}`,
						to: "brain",
						type: "status_update",
						payload: { text: "smoke" },
					}),
				});
				if (queued.status !== 200 && queued.status !== 400) {
					throw new Error(`queue returned ${queued.status}`);
				}
				record(
					"brain-paths",
					"pass",
					natsUp ? "publish/read/queue via API" : "graceful 503 paths without NATS",
					Date.now() - start,
				);
			} catch (error) {
				record("brain-paths", "fail", String(error), Date.now() - start);
			}
		}
	}

	// Stage 9: WebSocket auth + close.
	{
		const start = Date.now();
		if (!apiUp) {
			skipDependents("websocket", "api stage failed");
		} else {
			try {
				const socket = new WebSocket(`ws://127.0.0.1:${apiPort}/ws`);
				const outcome = await new Promise<string>((resolvePromise, rejectPromise) => {
					const timer = setTimeout(() => {
						try {
							socket.close();
						} catch {
							// Ignore close errors during timeout cleanup.
						}
						rejectPromise(new Error("no auth ack within 10s"));
					}, 10000);
					socket.onopen = () => socket.send(JSON.stringify({ type: "auth", apiKey }));
					socket.onmessage = (event) => {
						try {
							const message = JSON.parse(String(event.data));
							if (message.type === "auth") {
								clearTimeout(timer);
								socket.close();
								resolvePromise(message.success === true ? "authed" : `rejected: ${message.error}`);
							}
						} catch {
							// Ignore non-JSON frames.
						}
					};
					socket.onerror = () => {
						clearTimeout(timer);
						rejectPromise(new Error("websocket error"));
					};
				});
				if (outcome !== "authed") throw new Error(outcome);
				record("websocket", "pass", "in-band key auth acknowledged", Date.now() - start);
			} catch (error) {
				record("websocket", "fail", String(error), Date.now() - start);
			}
		}
	}

	// Stage 10: shutdown + cleanup.
	{
		const start = Date.now();
		try {
			await stopProc(apiProc, "api");
			apiProc = null;
			await stopProc(natsProc, "nats-server");
			natsProc = null;
			const apiGone = await waitFor("api shutdown", async () => !(await tcpOpen("127.0.0.1", apiPort)), 15000);
			if (!apiGone) throw new Error("API port still open after SIGTERM/SIGKILL");
			if (keep) {
				record("shutdown", "pass", `processes stopped; workspace kept at ${root}`, Date.now() - start);
			} else {
				await rm(root, { recursive: true, force: true });
				const { existsSync } = await import("node:fs");
				if (existsSync(root)) throw new Error("temp workspace was not removed");
				record("shutdown", "pass", "processes stopped, temp workspace removed", Date.now() - start);
			}
		} catch (error) {
			record("shutdown", "fail", String(error), Date.now() - start);
		}
	}

	printSummary();
	process.exitCode = failed ? 1 : 0;
}

function printSummary(): void {
	const counts = { pass: 0, fail: 0, skip: 0 };
	for (const result of results) counts[result.status] += 1;
	console.log(`\nSmoke topology: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`);
}

await main();
