/** Generate a self-contained, evidence-backed report; optionally serve it on a separate local port. */
import { resolve } from "node:path";

import { INBOX_TRIAGE_REGISTRY } from "../workbench/examples/inbox-triage-registry";
import { parseResourceViewDefinition } from "../workbench/resource-view-definition";
import { collectPagingEvidence, verifyWorkbenchDemo } from "./workbench-demo/evidence";
import { DEMO_ITEMS } from "./workbench-demo/fixtures";
import { renderWorkbenchReport } from "./workbench-demo/render-report";

import type { WorkbenchReportData } from "./workbench-demo/types";

const root = resolve(import.meta.dir, "../..");
const directory = resolve(import.meta.dir, "workbench-demo");
const outputPath = resolve(root, "docs/public/workbench-report.html");

const verification = verifyWorkbenchDemo(root);
const paging = await collectPagingEvidence();
const blueprint = await Bun.file(resolve(root, "src/workbench/examples/inbox-triage.json")).json();
parseResourceViewDefinition(blueprint, INBOX_TRIAGE_REGISTRY);
const revision = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
const data: WorkbenchReportData = {
	generatedAt: new Date().toISOString(), revision: new TextDecoder().decode(revision.stdout).trim(),
	blueprint, items: DEMO_ITEMS, paging, verification,
};
const build = await Bun.build({
	entrypoints: [resolve(directory, "browser/report-client.ts")], target: "browser", format: "iife", minify: true,
});
if (!build.success || !build.outputs[0]) throw new Error(`Report browser build failed: ${build.logs.join("\n")}`);
const [template, css, client] = await Promise.all([
	Bun.file(resolve(directory, "report.html")).text(), Bun.file(resolve(directory, "report.css")).text(),
	build.outputs[0].text(),
]);
const html = renderWorkbenchReport(template, css, data, client);
await Bun.write(outputPath, html);
console.log(`Workbench report: ${outputPath}`);
console.log(`Verified ${verification.passed} tests; paging ${paging.before.at(-1)} → ${paging.after.at(-1)} records.`);

if (process.argv.includes("--serve")) {
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 4174,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== "/" && url.pathname !== "/workbench-report.html") return new Response("Not found", { status: 404 });
			return new Response(Bun.file(outputPath), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
		},
	});
	console.log(`Open ${server.url}workbench-report.html`);
}
