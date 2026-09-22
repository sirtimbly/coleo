#!/usr/bin/env bun
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ArmOutputProcessor } from "../brain/arm-output-processor";
import { MailProcessor } from "../brain/mail-processor";
import { resolveBrainModelConfig } from "../brain/model-config";
import { BrainTemplateManager } from "../brain/template-manager";
import { loadConfig } from "../config";
import { isRecord } from "../utils/json";
import { armOutputText, buildJevRequest, parseJevResponse } from "./classification-bakeoff/classifiers";
import { CONTEXT, SCENARIOS } from "./classification-bakeoff/fixtures";
import { renderReport } from "./classification-bakeoff/report";
import type { Scenario } from "./classification-bakeoff/fixtures";
import type { Attempt } from "./classification-bakeoff/report";

function positiveInteger(value: string, name: string): number {
	if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
		throw new Error(`${name} must be a positive integer`);
	}
	return Number(value);
}

async function main(): Promise<void> {
	const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
		help: { type: "boolean" }, repeats: { type: "string", default: "2" },
		concurrency: { type: "string", default: "3" }, limit: { type: "string" },
		out: { type: "string" }, "current-model": { type: "string" },
		"jev-model": { type: "string", default: "jev-latest" },
		"timeout-ms": { type: "string", default: "60000" },
	} });
	if (values.help) {
		console.log("Usage: bun run bakeoff:classification [--repeats 2] [--concurrency 3] [--limit cases-per-channel] [--out directory] [--current-model id] [--jev-model id] [--timeout-ms 60000]\nReads JEV_API_KEY and the existing brain configuration. Synthetic inputs only; no Brain runtime, task mutations, or outgoing messages. Results default to ignored test-results/classification-bakeoff/<timestamp>.");
		return;
	}
	const repeats = positiveInteger(values.repeats, "repeats");
	const concurrency = positiveInteger(values.concurrency, "concurrency");
	const timeoutMs = positiveInteger(values["timeout-ms"], "timeout-ms");
	const limit = values.limit ? positiveInteger(values.limit, "limit") : Infinity;
	const config = resolveBrainModelConfig((await loadConfig(process.cwd())).brain);
	if (values["current-model"]) config.model = values["current-model"];
	const jevKey = process.env.JEV_API_KEY;
	if (!jevKey || !config.apiKey) throw new Error("Both JEV_API_KEY and the current brain model key are required; refusing a silently heuristic-only bake-off.");
	const redact = (value: string): string => [jevKey, config.apiKey].reduce((text, key) => text.split(key).join("[REDACTED]"), value);
	const createdAt = new Date().toISOString();
	const out = resolve(values.out || `test-results/classification-bakeoff/${createdAt.replace(/[:.]/g, "-")}`);
	await mkdir(out, { recursive: true });
	const templates = new BrainTemplateManager(process.cwd(), () => {});
	const prompts = {
		arm: await templates.loadArmOutputProcessorSystemPrompt(CONTEXT),
		human: await templates.loadMailProcessorSystemPrompt(CONTEXT),
	};
	if (Object.values(prompts).some((p) => p.startsWith("Template missing:"))) throw new Error("Production classifier template missing");
	const scenarios = ["arm", "human"].flatMap((kind) => SCENARIOS.filter((s) => s.kind === kind).slice(0, limit));
	const requests = scenarios.map((s) => ({ caseId: s.id, request: buildJevRequest(s, prompts[s.kind], values["jev-model"]) }));
	const fingerprint = createHash("sha256").update(JSON.stringify({ scenarios, prompts, requests })).digest("hex");
	const metadata = {
		createdAt, fingerprint, repeats, concurrency, timeoutMs, sdk: "@typesafe-ai/sdk@0.6.0",
		current: { provider: config.provider, model: config.model, endpoint: new URL(config.baseUrl).origin },
		jev: { model: values["jev-model"], endpoint: "https://api.typesafe.ai", retries: 0 },
		corpus: "synthetic-v1", caseCount: scenarios.length,
	};
	// Snapshot labels and queries BEFORE requesting predictions. Exclusive writes prevent overwriting a prior run.
	await writeFile(`${out}/inputs.json`, JSON.stringify({ metadata, scenarios, prompts, requests }, null, 2), { flag: "wx" });
	await writeFile(`${out}/attempts.jsonl`, "", { flag: "wx" });

	const originalFetch = globalThis.fetch;
	const scope = new AsyncLocalStorage<Attempt>();
	const observedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const attempt = scope.getStore();
		if (!attempt) return originalFetch(input, init);
		const deadline = AbortSignal.timeout(timeoutMs);
		const response = await originalFetch(input, { ...init,
			signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
		});
		attempt.status = response.status;
		// Only successful synthetic inference responses are retained; never request headers or error bodies.
		if (response.ok) {
			const payload: unknown = await response.clone().json();
			attempt.response = payload;
			if (isRecord(payload)) {
				attempt.servedModel = typeof payload.model === "string" ? payload.model : undefined;
				attempt.usage = payload.usage;
			}
		}
		return response;
	}, { preconnect: originalFetch.preconnect });
	const jev = new TypeSafeClient({ apiKey: jevKey, baseURL: "https://api.typesafe.ai",
		timeout: timeoutMs, retry: { maxRetries: 0 }, logLevel: "off",
		fetch: (input, init) => observedFetch(input, init),
	});
	const attempts: Attempt[] = [];
	let pendingWrite = Promise.resolve();
	async function evaluate(scenario: Scenario, repeat: number, backend: Attempt["backend"]): Promise<void> {
		const attempt: Attempt = { caseId: scenario.id, kind: scenario.kind, repeat, backend, mode: "model", elapsedMs: 0, logs: [] };
		const started = performance.now();
		await scope.run(attempt, async () => {
			try {
				if (backend === "jev") {
					const request = buildJevRequest(scenario, prompts[scenario.kind], values["jev-model"]);
					const response = await jev.systemOne(request);
					attempt.decision = parseJevResponse(response, request);
				} else {
					const logger = (message: string): void => { attempt.logs.push(redact(message)); };
					if (scenario.kind === "arm") {
						const result = await new ArmOutputProcessor(logger, config).processOutput(CONTEXT.armId,
							CONTEXT.armName, armOutputText(scenario), prompts.arm);
						attempt.decision = { label: result.action,
							...(result.action === "no_action" ? { followup: Boolean(result.armPrompt?.trim()) } : {}),
							...(result.action === "update_task" ? { taskId: result.update?.taskId } : {}),
						};
						if (/^fallback/i.test(result.reasoning)) attempt.mode = "fallback";
					} else {
						const result = await new MailProcessor(logger, prompts.human, config)
							.processMessage(scenario.subject, scenario.text, prompts.human);
						attempt.decision = { label: result.type,
							...(result.type === "approval_response" ? { approved: result.approved } : {}),
						};
						if (/^fallback/i.test(result.reasoning || "")) attempt.mode = "fallback";
					}
					// A swallowed provider failure must never look like a successful LLM decision.
					if (!attempt.status || attempt.status >= 400) attempt.mode = "fallback";
				}
			} catch (error) {
				attempt.mode = "error";
				// SDK errors can contain response bodies; store only error class and HTTP status.
				attempt.error = `${error instanceof Error ? error.name : "Error"}${attempt.status ? ` (HTTP ${attempt.status})` : ""}`;
			}
		});
		attempt.elapsedMs = Math.round(performance.now() - started);
		const completedCount = attempts.push(attempt);
		pendingWrite = pendingWrite.then(() => appendFile(`${out}/attempts.jsonl`, redact(JSON.stringify(attempt)) + "\n"));
		await pendingWrite;
		console.log(`${completedCount}/${scenarios.length * repeats * 2} ${scenario.id} r${repeat} ${backend}: ${attempt.decision?.label || attempt.error} (${attempt.mode}, ${attempt.elapsedMs}ms)`);
	}
	const jobs = Array.from({ length: repeats }, (_, index) => scenarios.map((scenario, caseIndex) =>
		({ scenario, repeat: index + 1, reverse: (index + caseIndex) % 2 === 1 }))).flat();
	let nextJob = 0;
	globalThis.fetch = observedFetch;
	try {
		// At most `concurrency` pairs; each pair issues its two independent requests together.
		const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
			while (nextJob < jobs.length) {
				const job = jobs[nextJob++]!;
				const backends: Attempt["backend"][] = job.reverse ? ["jev", "current"] : ["current", "jev"];
				await Promise.all(backends.map((backend) => evaluate(job.scenario, job.repeat, backend)));
			}
		}));
		for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
	} finally {
		globalThis.fetch = originalFetch;
		await pendingWrite;
		await writeFile(`${out}/results.json`, redact(JSON.stringify({ metadata, attempts }, null, 2)));
		await writeFile(`${out}/report.md`, renderReport(scenarios, attempts));
	}
	console.log(`Report: ${out}/report.md`);
	if (attempts.some((a) => a.mode !== "model")) process.exitCode = 2;
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "Bake-off failed");
		process.exitCode = 1;
	});
}
