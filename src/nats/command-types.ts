import { randomUUID } from "crypto";

export const COMMAND_STREAM_NAME = "coleo-commands";

export const COMMAND_SUBJECTS = {
  TO_BRAIN: "coleo.cmd.to.brain",
  TO_ARM_PREFIX: "coleo.cmd.to.arm",
  RESULT_PREFIX: "coleo.cmd.result",
} as const;

export const COMMAND_STREAM_SUBJECTS = [
  COMMAND_SUBJECTS.TO_BRAIN,
  `${COMMAND_SUBJECTS.TO_ARM_PREFIX}.*`,
  `${COMMAND_SUBJECTS.RESULT_PREFIX}.*`,
] as const;

export const COMMAND_SCHEMA_VERSION = 1;

export interface CommandEnvelope {
  id: string;
  requestId?: string;
  correlationId?: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  createdAt: string;
  schemaVersion: number;
}

export type McpCommandPublishMode = "api" | "nats" | "auto";

export function getMcpCommandPublishMode(
  value = process.env.COLEO_MCP_COMMAND_PUBLISH_MODE,
): McpCommandPublishMode {
  const normalized = (value || "api").trim().toLowerCase();
  if (normalized === "api" || normalized === "nats" || normalized === "auto") {
    return normalized;
  }
  return "api";
}

export function createCommandEnvelope(input: {
  id?: string;
  requestId?: string;
  correlationId?: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  createdAt?: string;
  schemaVersion?: number;
}): CommandEnvelope {
  return {
    id: input.id || `cmd-${randomUUID()}`,
    requestId: input.requestId,
    correlationId: input.correlationId,
    from: input.from,
    to: input.to,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt || new Date().toISOString(),
    schemaVersion: input.schemaVersion ?? COMMAND_SCHEMA_VERSION,
  };
}

export function commandSubjectForRecipient(to: string): string {
  if (to === "brain") {
    return COMMAND_SUBJECTS.TO_BRAIN;
  }
  return `${COMMAND_SUBJECTS.TO_ARM_PREFIX}.${toSubjectToken(to)}`;
}

export function commandSubjectForEnvelope(envelope: Pick<CommandEnvelope, "to">): string {
  return commandSubjectForRecipient(envelope.to);
}

function toSubjectToken(value: string): string {
  const normalized = value.trim().toLowerCase();
  const token = normalized.replace(/[^a-z0-9_-]/g, "-");
  return token.length > 0 ? token : "unknown";
}
