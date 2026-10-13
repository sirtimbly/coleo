import type { WorkbenchReportData } from "./types";

/** Embed literal build output, avoiding replacement-string expansion and premature HTML script termination. */
export function renderWorkbenchReport(
	template: string, css: string, data: WorkbenchReportData, client: string,
): string {
	const json = JSON.stringify(data).replace(/</g, "\\u003c");
	return template.replace("/* REPORT_STYLES */", () => css)
		.replace("__REPORT_DATA__", () => json)
		.replace("/* REPORT_CLIENT */", () => client.replace(/<\/script/gi, "<\\/script"))
		// Bundled dependency templates contain indented blank lines; keep the generated artifact diff-clean.
		.replace(/^[\t ]+$/gm, "");
}
