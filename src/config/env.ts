import { join } from "path";

export async function loadEnvFile(): Promise<void> {
  const projectDir = process.env.COLEO_PROJECT_DIR || process.cwd();
  const coleoDir = process.env.COLEO_DIR || join(projectDir, ".coleo");
  const envPaths = [
    join(coleoDir, ".env"),
    join(projectDir, ".env"),
    join(process.cwd(), ".env"),
  ];

  for (const envPath of envPaths) {
    try {
      const envFile = file(envPath);
      if (await envFile.exists()) {
        const content = await envFile.text();
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
          const eqIndex = normalized.indexOf("=");
          if (eqIndex === -1) continue;
          const key = normalized.slice(0, eqIndex).trim();
          let value = normalized.slice(eqIndex + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
        break;
      }
    } catch {
      // Ignore errors reading .env
    }
  }
}
