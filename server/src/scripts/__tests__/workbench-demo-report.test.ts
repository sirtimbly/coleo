import { describe, expect, it } from "bun:test";

import { renderWorkbenchReport } from "../workbench-demo/render-report";

import type { WorkbenchReportData } from "../workbench-demo/types";

const template = '<style>/* REPORT_STYLES */</style><script type="application/json">__REPORT_DATA__</script>' +
	'<script>/* REPORT_CLIENT */</script>';
const data: WorkbenchReportData = {
	generatedAt: "2026-10-02T12:00:00Z", revision: "fixture", blueprint: { label: "Fixture" }, items: [],
	paging: { before: [57], after: [532], pageSize: 25, fixtureTotal: 532, duplicates: 0, tasks: 525, reports: 7 },
	verification: { passed: 62, failed: 0, assertions: 347, typecheck: true },
};

describe("self-contained workbench report embedding", () => {
	it("preserves literal dollar sequences in browser bundles instead of expanding the HTML template", () => {
		const script = 'const replacements = ["$&", "$\'", "$`", "$$"];';
		const output = renderWorkbenchReport(template, ":root{color:blue}", data, script);
		expect(output.endsWith(`<script>${script}</script>`)).toBe(true);
		expect(output.match(/<script/g)).toHaveLength(2);
	});

	it("keeps script-like definition text inside JSON while preserving its meaning on parse", () => {
		const withMarkup = { ...data, blueprint: { label: '</script><img src="unknown" onerror="run()">' } };
		const output = renderWorkbenchReport(template, "", withMarkup, 'const example = "</script>";');
		const serialized = output.match(/<script type="application\/json">([\s\S]*?)<\/script>/)?.[1];
		expect(serialized).toBeDefined();
		expect(JSON.parse(serialized!)).toEqual(withMarkup);
		expect(output).not.toContain("<img");
		expect(output.match(/<\/script>/g)).toHaveLength(2);
		expect(output).toContain('<script>const example = "<\\/script>";</script>');
	});

	it("cleans blank build-output lines without trimming spaces inside definition or script strings", () => {
		const spaced = { ...data, blueprint: { label: "Keep these spaces   " } };
		const script = 'const label = "  keep  ";\n        \nconst ready = true;';
		const output = renderWorkbenchReport(template, "", spaced, script);
		expect(output).not.toMatch(/^[\t ]+$/m);
		expect(output).toContain('const label = "  keep  ";\n\nconst ready = true;');
		const serialized = output.match(/<script type="application\/json">([\s\S]*?)<\/script>/)?.[1];
		expect(JSON.parse(serialized!)).toEqual(spaced);
	});
});
