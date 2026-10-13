export type SetupFileScope = "plan" | "coleo" | "all";

export function isSetupFileScope(value: unknown): value is SetupFileScope {
	return value === "plan" || value === "coleo" || value === "all";
}

export function setupPathMatchesScope(
	path: string,
	scope: SetupFileScope,
	canonicalPlanPath: string,
): boolean {
	if (scope === "plan") return path === canonicalPlanPath;
	if (scope === "coleo") return path === ".coleo" || path.startsWith(".coleo/");
	return true;
}

export function filterSetupFilePaths(
	paths: readonly string[],
	scope: SetupFileScope,
	canonicalPlanPath: string,
): readonly string[] {
	if (scope === "plan") return [canonicalPlanPath];
	if (scope === "coleo") {
		return paths.filter((path) => setupPathMatchesScope(path, scope, canonicalPlanPath));
	}
	return paths;
}
