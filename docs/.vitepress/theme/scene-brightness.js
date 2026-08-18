const STORAGE_KEY = "coleo.docs.sceneBrightness";
const LIGHT_DEFAULT = 70;
const DARK_DEFAULT = 30;

export function normalizeSceneBrightness(value, fallback = LIGHT_DEFAULT) {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(100, Math.max(0, Math.round(parsed)));
}

export function getStoredSceneBrightness() {
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (stored === null) return null;
		const parsed = Number(stored);
		return Number.isFinite(parsed) ? normalizeSceneBrightness(parsed) : null;
	} catch (_) {
		return null;
	}
}

export function getInitialSceneBrightness(systemIsLight) {
	return (
		getStoredSceneBrightness() ?? (systemIsLight ? LIGHT_DEFAULT : DARK_DEFAULT)
	);
}

export function saveSceneBrightness(value) {
	const normalized = normalizeSceneBrightness(value);
	try {
		window.localStorage.setItem(STORAGE_KEY, String(normalized));
	} catch (_) {}
	return normalized;
}
