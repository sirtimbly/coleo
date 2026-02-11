#!/usr/bin/env bun

import { readFile } from "fs/promises";

import { ArmOutputProcessor } from "../brain/arm-output-processor";
import { BrainTemplateManager } from "../brain/template-manager";

interface CliOptions {
	armId: string;
	armName: string;
	armDomain: string;
	coleoDir: string;
	pendingTasks: number;
	taskSnapshot: string;
	taskSnapshotFile?: string;
	systemPromptFile?: string;
	timestampIso?: string;
	passthroughInput: boolean;
	showSystemPrompt: boolean;
	showOutputText: boolean;
	json: boolean;
}

function printUsage(): void {
	console.log(`Usage:
  cat scenario.txt | bun run src/scripts/simulate-arm-output-processor.ts [options]
  echo "create a task for follow-up" | bun run simulate:arm-output

Options:
  --arm-id <id>                Arm ID passed to processor (default: arm-sim)
  --arm-name <name>            Arm name passed to processor (default: arm-sim)
  --arm-domain <domain>        Domain for template render (default: general)
  --coleo-dir <path>           Repo/coleo dir for template manager (default: cwd)
  --pending-tasks <n>          Pending tasks count for template (default: 0)
  --task-snapshot <text>       Task snapshot text for template (default: none)
  --task-snapshot-file <path>  Load task snapshot text from file
  --system-prompt-file <path>  Use explicit system prompt instead of template render
  --timestamp-iso <iso>        Timestamp used in wrapped assistant message
  --passthrough-input          Send stdin verbatim (skip assistant-message wrapper)
  --show-system-prompt         Print rendered/loaded system prompt
  --show-output-text           Print exact outputText passed to processor
  --json                       Print JSON output only
  --help                       Show this help

Environment:
  OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL`);
}

function parseOptions(argv: string[]): CliOptions {
	const options: CliOptions = {
		armId: "arm-sim",
		armName: "arm-sim",
		armDomain: "general",
		coleoDir: process.cwd(),
		pendingTasks: 0,
		taskSnapshot: "none",
		passthroughInput: false,
		showSystemPrompt: false,
		showOutputText: false,
		json: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];

		if (!arg) continue;
		switch (arg) {
			case "--help":
			case "-h":
				printUsage();
				process.exit(0);
			case "--arm-id":
				if (!next) throw new Error("--arm-id requires a value");
				options.armId = next;
				i++;
				break;
			case "--arm-name":
				if (!next) throw new Error("--arm-name requires a value");
				options.armName = next;
				i++;
				break;
			case "--arm-domain":
				if (!next) throw new Error("--arm-domain requires a value");
				options.armDomain = next;
				i++;
				break;
			case "--coleo-dir":
				if (!next) throw new Error("--coleo-dir requires a value");
				options.coleoDir = next;
				i++;
				break;
			case "--pending-tasks":
				if (!next) throw new Error("--pending-tasks requires a value");
				options.pendingTasks = Number.parseInt(next, 10);
				if (!Number.isFinite(options.pendingTasks) || options.pendingTasks < 0) {
					throw new Error("--pending-tasks must be a non-negative integer");
				}
				i++;
				break;
			case "--task-snapshot":
				if (!next) throw new Error("--task-snapshot requires a value");
				options.taskSnapshot = next;
				i++;
				break;
			case "--task-snapshot-file":
				if (!next) throw new Error("--task-snapshot-file requires a value");
				options.taskSnapshotFile = next;
				i++;
				break;
			case "--system-prompt-file":
				if (!next) throw new Error("--system-prompt-file requires a value");
				options.systemPromptFile = next;
				i++;
				break;
			case "--timestamp-iso":
				if (!next) throw new Error("--timestamp-iso requires a value");
				options.timestampIso = next;
				i++;
				break;
			case "--passthrough-input":
				options.passthroughInput = true;
				break;
			case "--show-system-prompt":
				options.showSystemPrompt = true;
				break;
			case "--show-output-text":
				options.showOutputText = true;
				break;
			case "--json":
				options.json = true;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}

	return options;
}

async function loadTaskSnapshot(options: CliOptions): Promise<string> {
	if (!options.taskSnapshotFile) {
		return options.taskSnapshot || "none";
	}
	const content = await readFile(options.taskSnapshotFile, "utf-8");
	const value = content.trim();
	return value || "none";
}

async function loadSystemPrompt(
	options: CliOptions,
	taskSnapshot: string,
	logs: string[],
): Promise<{ source: string; systemPrompt: string }> {
	if (options.systemPromptFile) {
		const systemPrompt = await readFile(options.systemPromptFile, "utf-8");
		return { source: options.systemPromptFile, systemPrompt };
	}

	const templates = new BrainTemplateManager(options.coleoDir, (msg) =>
		logs.push(msg),
	);
	const systemPrompt = await templates.loadArmOutputProcessorSystemPrompt({
		armName: options.armName,
		armDomain: options.armDomain,
		pendingTasks: options.pendingTasks,
		taskSnapshot: taskSnapshot || "none",
	});
	return {
		source: "template:arm-output-processor-system-prompt.jinja",
		systemPrompt,
	};
}

async function main(): Promise<void> {
	let options: CliOptions;
	try {
		options = parseOptions(Bun.argv.slice(2));
	} catch (err) {
		console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
		printUsage();
		process.exit(1);
	}

	const rawStdin = await Bun.stdin.text();
	const inputText = rawStdin.trim();
	if (!inputText) {
		console.error("Error: expected scenario text on stdin");
		printUsage();
		process.exit(1);
	}

	const logs: string[] = [];
	const taskSnapshot = await loadTaskSnapshot(options);
	const { source: systemPromptSource, systemPrompt } = await loadSystemPrompt(
		options,
		taskSnapshot,
		logs,
	);

	const timestampIso = options.timestampIso || new Date().toISOString();
	const outputText = options.passthroughInput
		? inputText
		: `Assistant message 1 (${timestampIso}):\n${inputText}`;

	const processor = new ArmOutputProcessor((msg) => logs.push(msg));
	const processorInternal = processor as unknown as {
		model: string;
		baseUrl: string;
		apiKey: string;
	};

	const decision = await processor.processOutput(
		options.armId,
		options.armName,
		outputText,
		systemPrompt,
	);

	const result = {
		config: {
			model: processorInternal.model,
			baseUrl: processorInternal.baseUrl,
			hasApiKey: Boolean(processorInternal.apiKey),
			mode: processorInternal.apiKey ? "llm" : "fallback",
		},
		input: {
			armId: options.armId,
			armName: options.armName,
			armDomain: options.armDomain,
			pendingTasks: options.pendingTasks,
			systemPromptSource,
		},
		outputText,
		decision,
		logs,
	};

	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log("Arm Output Processor Simulation");
	console.log(`- model: ${result.config.model}`);
	console.log(`- baseUrl: ${result.config.baseUrl}`);
	console.log(`- mode: ${result.config.mode}`);
	console.log(`- systemPrompt: ${systemPromptSource}`);
	console.log(`- arm: ${options.armName} (${options.armId})`);

	if (options.showSystemPrompt) {
		console.log("\n--- System Prompt ---");
		console.log(systemPrompt);
	}
	if (options.showOutputText) {
		console.log("\n--- Output Text Sent To Processor ---");
		console.log(outputText);
	}

	console.log("\n--- Decision ---");
	console.log(JSON.stringify(decision, null, 2));

	if (logs.length > 0) {
		console.log("\n--- Logs ---");
		for (const log of logs) {
			console.log(log);
		}
	}
}

await main();
