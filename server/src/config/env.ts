import { file } from "bun";
import { basename, dirname, join } from "path";

const loadedOrigins = new Map<string, string>();

export function getEnvFileOrigin(name: string): string | undefined {
	return loadedOrigins.get(name);
}

async function findColeoDir(startDir: string): Promise<string | null> {
	let current = startDir;
	while (true) {
		const candidate = join(current, ".coleo");
		try {
			if (await file(candidate).exists()) {
				return candidate;
			}
		} catch {
			// Ignore filesystem errors while searching
		}
		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

export async function loadEnvFile(projectDirectory?: string): Promise<string | undefined> {
	loadedOrigins.clear();
	const projectDir = process.env.COLEO_PROJECT_DIR || projectDirectory || process.cwd();
	const explicitColeoDir = process.env.COLEO_DIR;
	const discoveredColeoDir = explicitColeoDir ? null : await findColeoDir(projectDir);
	const coleoDir = explicitColeoDir || discoveredColeoDir || join(projectDir, ".coleo");
	const envPaths = [
		() => join(coleoDir, ".env"),
		() => join(process.env.COLEO_PROJECT_DIR || projectDirectory
			|| (basename(coleoDir) === ".coleo" ? dirname(coleoDir) : projectDir), ".env"),
	];

	let loadedPath: string | undefined;
	for (const getEnvPath of envPaths) {
		const envPath = getEnvPath();
		if (envPath === loadedPath) continue;
		try {
			const envFile = file(envPath);
			if (await envFile.exists()) {
				loadedPath ??= envPath;
				const content = await envFile.text();
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith("#")) continue;
					const normalized = trimmed.startsWith("export ")
						? trimmed.slice(7).trim()
						: trimmed;
					const eqIndex = normalized.indexOf("=");
					if (eqIndex === -1) continue;
					const key = normalized.slice(0, eqIndex).trim();
					let value = normalized.slice(eqIndex + 1).trim();
					if (
						(value.startsWith('"') && value.endsWith('"')) ||
						(value.startsWith("'") && value.endsWith("'"))
					) {
						value = value.slice(1, -1);
					}
					if (!process.env[key]) {
						process.env[key] = value;
						loadedOrigins.set(key, envPath);
					}
				}
			}
		} catch {
			// Ignore errors reading .env
		}
	}
	return loadedPath;
}
