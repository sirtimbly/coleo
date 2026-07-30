#!/usr/bin/env bun

/**
 * JetStream Transcript Indexer
 *
 * Consumes arm events from JetStream and indexes transcript-like text into Qdrant.
 * This is intended for semantic history search across arm activity.
 */

import { basename } from "path";
import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
} from "nats";
import type { JsMsg } from "nats";
import { embeddingService } from "../embedding";
import { qdrantStore } from "../qdrant";
import { connectToNats } from "../nats/transport";
import { eventMatchesProject, type EventData } from "../nats/jetstream";
import {
  getProjectDurableName,
  getProjectScope,
  getTranscriptCollectionName,
} from "../project-scope";
import { resolveNatsUrl } from "../network-config";

const STREAM_NAME = process.env.COLEO_EVENT_STREAM || "coleo-events";
const FILTER_SUBJECT = process.env.COLEO_TRANSCRIPT_INDEX_SUBJECT || "coleo.events.arm.>";
const PROJECT_SCOPE = getProjectScope();
const CONSUMER_DURABLE = getProjectDurableName(
  process.env.COLEO_TRANSCRIPT_INDEX_DURABLE || "transcript-indexer-v2",
  PROJECT_SCOPE,
);
const COLLECTION_NAME = getTranscriptCollectionName(process.env, PROJECT_SCOPE);
const NATS_URL = resolveNatsUrl();
const NATS_TOKEN = process.env.COLEO_NATS_TOKEN;
const BATCH_SIZE = parsePositiveInt(process.env.COLEO_TRANSCRIPT_INDEX_BATCH, 24, 200);
const FETCH_EXPIRES_MS = parsePositiveInt(process.env.COLEO_TRANSCRIPT_INDEX_FETCH_EXPIRES_MS, 5000, 60000);

interface IndexableEvent {
  msg: JsMsg;
  pointId: string;
  text: string;
  payload: Record<string, unknown>;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function deriveProject(workdir: string | null): string | null {
  if (!workdir) {
    return null;
  }

  const normalized = workdir.replace(/\\/g, "/").replace(/\/+$/, "");
  const project = basename(normalized);
  return project.length > 0 ? project : null;
}

function serializeValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return values.length > 0 ? values.join(" ") : null;
  }
  return null;
}

function buildTranscriptText(event: EventData): string {
  const details = event.data || {};
  const preferredKeys = [
    "message",
    "prompt",
    "content",
    "text",
    "summary",
    "error",
    "reason",
    "title",
  ];

  const parts: string[] = [];
  for (const key of preferredKeys) {
    const value = serializeValue(details[key]);
    if (value) {
      parts.push(value);
    }
  }

  const detailText = parts.length > 0 ? parts.join(" ") : JSON.stringify(details);
  const combined = `${event.type} ${detailText}`.trim();
  return combined.length > 4000 ? `${combined.slice(0, 4000)}...` : combined;
}

function parseEvent(msg: JsMsg): EventData | null {
  try {
    return JSON.parse(msg.string()) as EventData;
  } catch {
    return null;
  }
}

export function buildIndexableEvent(msg: JsMsg, event: EventData): IndexableEvent {
  const armId = event.armId || "unknown";
  const workdir = typeof event.data?.workdir === "string" ? event.data.workdir : event.projectDir || null;
  const project = typeof event.data?.project === "string" ? event.data.project : deriveProject(event.projectDir || workdir);
  const host = typeof event.data?.host === "string" ? event.data.host : null;

  const text = buildTranscriptText(event);
  const pointId = `${STREAM_NAME}:${msg.seq}`;
  const metadata = {
    arm_id: armId,
    session_id: event.sessionId || null,
    action: event.type,
    timestamp: event.timestamp,
    subject: msg.subject,
    host,
    project,
    workdir,
    project_dir: event.projectDir,
    project_key: event.projectKey,
  };

  return {
    msg,
    pointId,
    text,
    payload: {
      type: "arm_transcript",
      title: `${armId} ${event.type}`,
      content: text,
      metadata: {
        ...metadata,
        event_data: event.data || {},
      },
      created_at: event.timestamp,
      updated_at: event.timestamp,
    },
  };
}

async function ensureDurableConsumer(): Promise<void> {
  const nc = await connectToNats({ servers: NATS_URL, token: NATS_TOKEN });
  try {
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.consumers.info(STREAM_NAME, CONSUMER_DURABLE);
    } catch {
      await jsm.consumers.add(STREAM_NAME, {
        durable_name: CONSUMER_DURABLE,
        filter_subject: FILTER_SUBJECT,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
      });
      console.log(
        `[transcript-indexer] Created durable consumer ${CONSUMER_DURABLE} (subject=${FILTER_SUBJECT})`,
      );
    }
  } finally {
    await nc.close();
  }
}

async function main(): Promise<void> {
  let isStopping = false;

  const stopHandler = () => {
    isStopping = true;
  };

  process.on("SIGINT", stopHandler);
  process.on("SIGTERM", stopHandler);

  await qdrantStore.initialize();
  await qdrantStore.createCollection(COLLECTION_NAME, embeddingService.getVectorSize(), "Cosine");
  await Promise.all([
    qdrantStore.createPayloadIndex(COLLECTION_NAME, "type", "keyword"),
    qdrantStore.createPayloadIndex(COLLECTION_NAME, "metadata.project_key", "keyword"),
    qdrantStore.createPayloadIndex(COLLECTION_NAME, "metadata.project_dir", "keyword"),
    qdrantStore.createPayloadIndex(COLLECTION_NAME, "metadata.arm_id", "keyword"),
  ]);
  await ensureDurableConsumer();

  const nc = await connectToNats({ servers: NATS_URL, token: NATS_TOKEN });
  const js = nc.jetstream();
  const consumer = await js.consumers.get(STREAM_NAME, CONSUMER_DURABLE);

  console.log("[transcript-indexer] Started");
  console.log(`[transcript-indexer] NATS: ${NATS_URL}`);
  console.log(`[transcript-indexer] Stream: ${STREAM_NAME}`);
  console.log(`[transcript-indexer] Subject: ${FILTER_SUBJECT}`);
  console.log(`[transcript-indexer] Durable: ${CONSUMER_DURABLE}`);
  console.log(`[transcript-indexer] Qdrant collection: ${COLLECTION_NAME}`);
  console.log(`[transcript-indexer] Batch size: ${BATCH_SIZE}`);

  while (!isStopping) {
    const batch = await consumer.fetch({
      max_messages: BATCH_SIZE,
      expires: FETCH_EXPIRES_MS,
    });

    const pending: IndexableEvent[] = [];

    for await (const msg of batch) {
      const event = parseEvent(msg);
      if (!event || !event.data || !event.type || !event.timestamp) {
        msg.ack();
        continue;
      }
      if (!eventMatchesProject(event, PROJECT_SCOPE.projectKey)) {
        msg.ack();
        continue;
      }

      const indexable = buildIndexableEvent(msg, event);
      if (!indexable.text || indexable.text.trim().length === 0) {
        msg.ack();
        continue;
      }

      pending.push(indexable);
    }

    if (pending.length === 0) {
      continue;
    }

    try {
      const embeddings = await embeddingService.embedBatch(pending.map((entry) => entry.text));

      await qdrantStore.upsertPoints(
        COLLECTION_NAME,
        pending.map((entry, index) => ({
          id: entry.pointId,
          vector: embeddings.embeddings[index]!,
          payload: entry.payload,
        })),
      );

      for (const entry of pending) {
        entry.msg.ack();
      }

      console.log(`[transcript-indexer] Indexed ${pending.length} event(s)`);
    } catch (err) {
      console.error("[transcript-indexer] Failed to index batch:", err);
      // Do not ack failed batch so JetStream can redeliver.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log("[transcript-indexer] Stopping...");
  await nc.close();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[transcript-indexer] Fatal error:", err);
    process.exit(1);
  });
}
