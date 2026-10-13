/** Keep transport content from injecting terminal controls; JSON escapes original values. */
export function terminalText(value: unknown): string {
	return String(value ?? "—").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
