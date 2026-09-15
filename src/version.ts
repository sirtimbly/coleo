import packageJson from "../package.json" with { type: "json" };
import { NATS_SCHEMA_VERSION } from "./shared/version-compatibility";

export { NATS_SCHEMA_VERSION } from "./shared/version-compatibility";
export const VERSION = packageJson.version;
export const RUNTIME_VERSION = { version: VERSION, natsSchemaVersion: NATS_SCHEMA_VERSION } as const;
