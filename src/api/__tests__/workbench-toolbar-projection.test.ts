import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_TOOLBAR_TEMPLATES } from "../../workbench/toolbar-templates";
import {
	getWorkbenchToolbarProjectionPaths,
	materializeWorkbenchToolbarTemplates,
	readWorkbenchToolbarProjectionFile,
} from "../workbench-toolbar-projection";

describe("workbench toolbar projection", () => {
	let root: string;
	let coleoDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "coleo-toolbar-projection-"));
		coleoDir = join(root, ".coleo");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("switches complete immutable generations through one current pointer", async () => {
		const paths = await materializeWorkbenchToolbarTemplates(coleoDir, "local", {});
		const profileDirectory = paths[0]!.split("/").at(-2)!;
		const physicalProfile = join(
			coleoDir,
			"state",
			"workbench",
			"toolbar-templates",
			profileDirectory,
		);
		const firstGeneration = (await readFile(join(physicalProfile, "current"), "utf-8")).trim();

		const taskTemplate = {
			...DEFAULT_TOOLBAR_TEMPLATES.tasks,
			rows: [
				{ ...DEFAULT_TOOLBAR_TEMPLATES.tasks.rows[0], label: "Projected task controls" },
				DEFAULT_TOOLBAR_TEMPLATES.tasks.rows[1],
			],
		};
		await materializeWorkbenchToolbarTemplates(coleoDir, "local", {
			toolbarTemplates: { tasks: taskTemplate },
		});
		const secondGeneration = (await readFile(join(physicalProfile, "current"), "utf-8")).trim();
		expect(secondGeneration).not.toBe(firstGeneration);

		for (const path of paths) {
			const file = await readWorkbenchToolbarProjectionFile(coleoDir, path);
			expect(file?.readOnly).toBe(true);
			expect(JSON.parse(file!.content).id).toBe(path.split("/").at(-1)!.replace(".json", ""));
		}
		const taskPath = paths.find((path) => path.endsWith("/tasks.json"))!;
		const taskFile = await readWorkbenchToolbarProjectionFile(coleoDir, taskPath);
		expect(JSON.parse(taskFile!.content).rows[0].label).toBe("Projected task controls");

		for (let index = 0; index < 4; index += 1) {
			await materializeWorkbenchToolbarTemplates(coleoDir, "local", {
				toolbarTemplates: {
					tasks: {
						...taskTemplate,
						rows: [
							{ ...taskTemplate.rows[0], label: `Generation ${index}` },
							taskTemplate.rows[1],
						],
					},
				},
			});
		}
		const generations = await readdir(join(physicalProfile, "generations"));
		expect(generations).toHaveLength(3);
		const currentTaskFile = await readWorkbenchToolbarProjectionFile(coleoDir, taskPath);
		expect(JSON.parse(currentTaskFile!.content).rows[0].label).toBe("Generation 3");
	});

	it("rejects projection directories redirected through filesystem links", async () => {
		const external = join(root, "external");
		await Promise.all([mkdir(coleoDir, { recursive: true }), mkdir(external, { recursive: true })]);
		await symlink(external, join(coleoDir, "state"));

		await expect(materializeWorkbenchToolbarTemplates(coleoDir, "local", {}))
			.rejects.toThrow("cannot be filesystem links");
		expect(getWorkbenchToolbarProjectionPaths("local")).toHaveLength(8);
		expect(await readdir(external)).toEqual([]);
	});
});
