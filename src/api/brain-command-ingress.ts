import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { recordDeadLetterMessage } from "../db/state";
import { createCommandEnvelope, type CommandEnvelope } from "../nats/command-types";
import { isBrainInboxMessageType, validateBrainInboxPayload } from "../types/brain-inbox";

export type CommandIngressSource = "api_queue" | "api_publish" | "jetstream_projector";

interface CommandEnvelopeBody {
  id?: string;
  requestId?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  type?: string;
  payload?: unknown;
  createdAt?: string;
  schemaVersion?: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeCommandEnvelope(body: CommandEnvelopeBody): CommandEnvelope {
  return createCommandEnvelope({
    id: body.id,
    requestId: body.requestId,
    correlationId: body.correlationId,
    from: body.from || "",
    to: body.to || "",
    type: body.type || "",
    payload: body.payload,
    createdAt: body.createdAt,
    schemaVersion: body.schemaVersion,
  });
}

export function validateCommandEnvelope(envelope: CommandEnvelope): string | null {
  if (!isNonEmptyString(envelope.id)) {
    return "id is required";
  }
  if (!isNonEmptyString(envelope.from)) {
    return "from is required";
  }
  if (!isNonEmptyString(envelope.to)) {
    return "to is required";
  }
  if (!isNonEmptyString(envelope.type)) {
    return "type is required";
  }
  if (!isNonEmptyString(envelope.createdAt) || Number.isNaN(new Date(envelope.createdAt).getTime())) {
    return "createdAt must be an ISO date string";
  }
  if (!Number.isInteger(envelope.schemaVersion) || envelope.schemaVersion < 1) {
    return "schemaVersion must be a positive integer";
  }

  if (envelope.to === "brain") {
    if (!isBrainInboxMessageType(envelope.type)) {
      return `unsupported brain message type: ${envelope.type}`;
    }
    const payloadError = validateBrainInboxPayload(envelope.type, envelope.payload);
    if (payloadError) {
      return payloadError;
    }
  }

  return null;
}

export function validateAndRecordCommandEnvelope(
  db: Database,
  envelope: CommandEnvelope,
  source: CommandIngressSource,
): string | null {
  const error = validateCommandEnvelope(envelope);
  if (!error) {
    return null;
  }

  recordDeadLetterMessage(db, {
    id: `deadletter-${randomUUID()}`,
    from: envelope.from || "unknown",
    type: envelope.type || "invalid_command",
    payload: envelope.payload,
    reason: error,
    source,
  });
  return error;
}
