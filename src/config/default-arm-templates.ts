import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_ARM_TEMPLATES_VERSION = "1";

export const DEFAULT_ARM_TEMPLATES = {
	"balanced.yml": `arm:
  name: Balanced
  domain: general
  harness: opencode-api

context:
  budget: 100000

personality:
  traits: Adaptable, pragmatic, and clear about tradeoffs.
`,
	"builder.yml": `arm:
  name: Builder
  domain: development
  harness: opencode-api

context:
  budget: 120000

personality:
  traits: Implementation-focused, methodical, and attentive to integration details.
`,
	"reviewer.yml": `arm:
  name: Reviewer
  domain: qa
  harness: opencode-api

context:
  budget: 100000

personality:
  traits: Evidence-driven, skeptical, and precise about risks and regressions.
`,
} as const;

export interface DefaultArmTemplateSeedResult {
	created: string[];
	version: string;
}

/**
 * Seed the user-editable Arm templates once for each defaults version.
 * Existing files are never overwritten, and a current marker means a user can
 * intentionally remove a default without it reappearing on every restart.
 */
export async function ensureDefaultArmTemplates(coleoDir: string): Promise<DefaultArmTemplateSeedResult> {
	const templatesDir = join(coleoDir, "templates");
	const markerPath = join(templatesDir, ".defaults-version");
	try {
		if ((await readFile(markerPath, "utf-8")).trim() === DEFAULT_ARM_TEMPLATES_VERSION) {
			return { created: [], version: DEFAULT_ARM_TEMPLATES_VERSION };
		}
	} catch {
		// A fresh or older Coleo state needs the current defaults.
	}

	await mkdir(templatesDir, { recursive: true });
	const created: string[] = [];
	for (const [filename, content] of Object.entries(DEFAULT_ARM_TEMPLATES)) {
		const destination = join(templatesDir, filename);
		try {
			await writeFile(destination, content, { encoding: "utf-8", flag: "wx" });
			created.push(destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	await writeFile(markerPath, `${DEFAULT_ARM_TEMPLATES_VERSION}\n`, "utf-8");
	return { created, version: DEFAULT_ARM_TEMPLATES_VERSION };
}
