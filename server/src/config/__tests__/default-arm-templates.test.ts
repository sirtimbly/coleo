import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_ARM_TEMPLATES, ensureDefaultArmTemplates } from "../default-arm-templates";

describe("default Arm template seeding", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("seeds the YAML defaults into a fresh Coleo directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "coleo-default-templates-"));
		roots.push(root);

		const result = await ensureDefaultArmTemplates(root);

		expect(result.created).toHaveLength(Object.keys(DEFAULT_ARM_TEMPLATES).length);
		expect(await readFile(join(root, "templates", "balanced.yml"), "utf-8")).toContain("name: Balanced");
		expect(await readFile(join(root, "templates", ".defaults-version"), "utf-8")).toBe("1\n");
	});

	it("does not overwrite edits or restore deleted defaults after seeding", async () => {
		const root = await mkdtemp(join(tmpdir(), "coleo-default-templates-"));
		roots.push(root);
		await ensureDefaultArmTemplates(root);
		const balanced = join(root, "templates", "balanced.yml");
		const reviewer = join(root, "templates", "reviewer.yml");
		await writeFile(balanced, "custom\n", "utf-8");
		await unlink(reviewer);

		const result = await ensureDefaultArmTemplates(root);

		expect(result.created).toEqual([]);
		expect(await readFile(balanced, "utf-8")).toBe("custom\n");
		expect(access(reviewer)).rejects.toThrow();
	});
});
