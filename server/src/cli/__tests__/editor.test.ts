import { describe, expect, it } from "bun:test";

import { parseEditorCommand } from "../helpers/editor";

describe("parseEditorCommand", () => {
	it("splits quoted editor commands into argv parts", () => {
		expect(parseEditorCommand('"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" --wait')).toEqual([
			"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl",
			"--wait",
		]);
		expect(parseEditorCommand("code --wait")).toEqual(["code", "--wait"]);
	});

	it("falls back to vi for blank values", () => {
		expect(parseEditorCommand("   ")).toEqual(["vi"]);
	});
});
