/** Accept old named sizes when loading saved views; new changes save pixels. */
export function resolveGridFontSize(value: unknown): number {
	if (value === "medium") return 13;
	if (value === "large") return 15;
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(28, Math.max(8, Math.round(value)))
		: 11;
}
