export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue | undefined }

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ActivityEntry {
	id: string;
	sequence: number | null;
	timestamp: string;
	actor: string;
	action: string;
	target: string | null;
	details: JsonObject;
}
