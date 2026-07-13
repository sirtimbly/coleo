import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { DocWatcher, type DocChangeEvent } from "../watcher";
import { LocalWorkspaceAccess } from "../../workspace";

describe("DocWatcher workspace polling", () => {
	let root = "";

	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("detects repository documentation changes through WorkspaceAccess", async () => {
		root = join("/tmp", `coleo-doc-watcher-${crypto.randomUUID()}`);
		await mkdir(join(root, "docs", "guides"), { recursive: true });
		await writeFile(join(root, "docs", "guides", "start.md"), "first\n", "utf-8");
		const watcher = new DocWatcher(root, new LocalWorkspaceAccess(root));
		const events: DocChangeEvent[] = [];
		watcher.onChange((event) => events.push(event));
		await watcher.start();

		expect(await watcher.readDoc("guides/start.md")).toBe("first\n");
		await writeFile(join(root, "docs", "guides", "start.md"), "second\n", "utf-8");
		await writeFile(join(root, "docs", "new.md"), "new\n", "utf-8");
		await watcher.checkForChanges();
		await unlink(join(root, "docs", "new.md"));
		await watcher.checkForChanges();
		watcher.stop();

		expect(events.map((event) => `${event.type}:${event.relativePath}`)).toEqual([
			"modified:guides/start.md",
			"created:new.md",
			"deleted:new.md",
		]);
	});
});
