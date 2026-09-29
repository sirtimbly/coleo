/**
 * Brain/API boundary regression test (ADR-015, Phase 1 cleanup).
 *
 * Brain runtime code must not take runtime dependencies on NATS/JetStream,
 * harness, or OpenCode integrations. Those belong to the API server and
 * ArmAgent; Brain integrates exclusively through authenticated API routes
 * (see src/brain/brain-api-client.ts, ApiEventStore, BrainEventPublisher).
 *
 * Allowed in src/brain runtime:
 * - `import type` from anywhere (erased at compile time)
 * - the pure subject-token helper (no connection)
 * - jetstream-types (types + pure predicates only)
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BRAIN_DIR = join(import.meta.dir, "..");

const FORBIDDEN_VALUE_IMPORT = /(^|\/)nats\/jetstream$|^nats$|harness|opencode-ai\/sdk/i;

function collectFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "__tests__") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			collectFiles(path, out);
		} else if (entry.endsWith(".ts")) {
			out.push(path);
		}
	}
	return out;
}

function valueImportsOf(source: string): string[] {
	// Strip comments to avoid false positives.
	const stripped = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|\s)\/\/.*$/gm, "$1");
	const specs: string[] = [];
	const importRe =
		/(^|\n)\s*import\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
	let match: RegExpExecArray | null;
	while ((match = importRe.exec(stripped)) !== null) {
		if (match[2] !== undefined) specs.push(match[2]);
	}
	return specs;
}

describe("Brain/API boundary", () => {
	it("has no runtime NATS/JetStream/harness/OpenCode imports in Brain runtime", () => {
		const violations: string[] = [];
		for (const file of collectFiles(BRAIN_DIR)) {
			const source = readFileSync(file, "utf8");
			for (const spec of valueImportsOf(source)) {
				if (spec === "../nats/jetstream-types") continue;
				if (spec.endsWith("/jetstream-types")) continue;
				if (spec.endsWith("nats/subject-token")) continue;
				if (FORBIDDEN_VALUE_IMPORT.test(spec)) {
					violations.push(`${file}: ${spec}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
