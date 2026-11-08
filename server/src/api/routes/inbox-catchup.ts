import { Hono } from "hono";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { getColeoDir } from "../../config";
import { createCatchupModel } from "../../brain/inbox-catchup-model";
import { planCatalogueCatchup } from "../../brain/inbox-catchup-catalogue";
import { CATCHUP_DEFAULTS } from "../../brain/inbox-catchup-batching";
import { readCatchupFacts } from "../../brain/inbox-catchup-facts";
import { applyCatchup, catchupDirectory, lockCatchup, readCatchup, recoverInterruptedCatchup, snapshotCatchup, writeCatchup } from "../../mail/inbox-catchup-store";
import { broadcast } from "../websocket";
import { HttpError } from "../middleware/error";
import type { CatchupModel } from "../../brain/inbox-catchup-model";
import type { CatchupJob, CatchupSnapshot } from "../../mail/inbox-catchup-store";
import type { CatchupPlan, CatchupSource } from "../../workbench/inbox-catchup";
import type { EntryType } from "@typesafe-ai/sdk";

/** Mounted under authenticated /api/workbench/inbox. Jobs outlive HTTP requests. */
export function createInboxCatchupRoutes(options: { coleoDir?: string; model?: CatchupModel;
  planner?: (sources: CatchupSource[], progress: (detail: string) => Promise<void>) => Promise<CatchupPlan> } = {}): Hono {
  const app = new Hono();
  const root = () => options.coleoDir ?? getColeoDir();
  const jobId = (value: string) => {
    if (!z.uuid().safeParse(value).success) throw HttpError.badRequest("Invalid catch-up ID");
    return value;
  };
  const read = async (directory: string, id: string) => {
    try {
      const stored = await readCatchup(directory, jobId(id));
      // Derive subject-only provenance for older, already-reviewed jobs too.
      const archiveIds = new Set(stored.job.plan?.archiveSourceIds);
      stored.job.sourceSubjects = stored.sources.map(source => ({ sourceId: source.id, subject: source.subject }));
      stored.job.archiveSubjects = stored.sources.filter(source => source.unread && (!stored.job.plan?.archiveSourceIds || archiveIds.has(source.id)))
        .map(source => ({ sourceId: source.id, subject: source.subject }));
      return stored;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw HttpError.notFound("Catch-up not found");
      throw error;
    }
  };
  const lock = async (directory: string, id: string) => {
    try { return await lockCatchup(directory, id); }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "Another catch-up is running"); }
  };

  app.post("/catch-up", async c => {
    const directory = root();
    const id = crypto.randomUUID();
    await mkdir(catchupDirectory(directory), { recursive: true, mode: 0o700 });
    const job: CatchupJob = { id, status: "analyzing", startedAt: new Date().toISOString(), detail: "Reading an inbox snapshot", unreadCount: 0 };
    const release = await lock(directory, id);
    const stored = { job, sources: [] as CatchupSnapshot[], moves: [] };
    try {
      stored.sources = await snapshotCatchup(directory);
      job.unreadCount = stored.sources.filter(source => source.unread).length;
      job.archiveSubjects = stored.sources.filter(source => source.unread)
        .map(source => ({ sourceId: source.id, subject: source.subject }));
      await writeCatchup(directory, stored);
      const latestPath = join(catchupDirectory(directory), "latest.json");
      const temp = `${latestPath}.${id}.tmp`;
      await writeFile(temp, JSON.stringify({ id }), { mode: 0o600 });
      await rename(temp, latestPath);
    } catch (error) { await release(); throw error; }
    // A handled task, not tied to the browser connection. Every transition is durable.
    void (async () => {
      try {
        const progress = async (detail: string) => {
          job.detail = detail; await writeCatchup(directory, stored);
        };
        if (!job.unreadCount) job.plan = { actions: [], resolvedTopics: 0, informationalTopics: 0,
          applyPolicyVersion: 2, archiveSourceIds: [], retainedSources: [] };
        else if (options.planner) job.plan = await options.planner(stored.sources, progress);
        else {
          await progress("Checking current task, bug, arm and file-claim state");
          const facts = readCatchupFacts(directory, stored.sources);
          const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
          let client: TypeSafeClient | undefined;
          const brain = options.model ?? createCatchupModel({ maxInputBytes: 480_000, maxCompletionTokens: 16_384 });
          const concurrency = Number(process.env.COLEO_INBOX_CATCHUP_CONCURRENCY ?? CATCHUP_DEFAULTS.concurrency);
          const batchMessages = Number(process.env.COLEO_INBOX_CATCHUP_BATCH_MESSAGES ?? CATCHUP_DEFAULTS.batchMessages);
          const result = await planCatalogueCatchup(stored.sources, brain, { facts, progress, concurrency, batchMessages,
            query: request => {
              if (!apiKey) throw new Error("JEV_API_KEY or TYPESAFE_API_KEY is required for Catch me up. Originals were left untouched.");
              client ??= new TypeSafeClient({ apiKey, baseURL: "https://api.typesafe.ai", logLevel: "off", timeout: 60_000, retry: { maxRetries: 2 } });
              return client.systemOne({ model: "jev-latest", state: request.state as EntryType, questions: request.questions },
                { signal: AbortSignal.timeout(120_000) });
            } });
          // Private, body-free diagnostics let us explain a missed decision without rerunning models.
          await writeFile(join(catchupDirectory(directory), `${id}.analysis.json`), JSON.stringify({
            threads: result.threads, decisions: result.decisions, messageAssessments: result.messageAssessments, metrics: result.metrics,
          }), { mode: 0o600 });
          job.plan = result.plan;
          const metrics = result.metrics;
          job.plan.analysis = { engine: "catalogue", concurrency, modelCalls: metrics.brainCalls + metrics.jevRequests,
            extractionBatches: metrics.discoveryBatches, comparisonBatches: 0, topics: result.threads.length, durationMs: metrics.durationMs,
            jev: { requests: metrics.jevRequests, questions: metrics.jevQuestions, inputTokens: metrics.jevInputTokens,
              outputTokens: metrics.jevOutputTokens, models: metrics.jevModels, uncertainDecisions: metrics.uncertainAssignments } };
        }
        job.sourceSubjects = stored.sources.map(source => ({ sourceId: source.id, subject: source.subject }));
        const archiveIds = new Set(job.plan.archiveSourceIds);
        job.archiveSubjects = stored.sources.filter(source => archiveIds.has(source.id)).map(source => ({ sourceId: source.id, subject: source.subject }));
        job.status = "review"; job.detail = job.unreadCount ? "Ready for your review" : "No unread messages to catch up on";
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error && !error.name.startsWith("Zod") ? error.message : "Brain response failed validation; no messages were archived.";
      } finally {
        try { await writeCatchup(directory, stored); } finally { await release(); }
      }
    })().catch(error => console.error("[inbox-catchup] Could not persist job status", error instanceof Error ? error.name : "unknown"));
    return c.json({ job }, 202);
  });

  app.get("/catch-up", async c => {
    const directory = root();
    let id: string;
    try { id = JSON.parse(await readFile(join(catchupDirectory(directory), "latest.json"), "utf8")).id; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ job: null });
      throw error;
    }
    const { job } = await read(directory, id);
    return c.json({ job: await recoverInterruptedCatchup(directory, job) });
  });

  app.get("/catch-up/:id", async c => {
    const { job } = await read(root(), c.req.param("id"));
    return c.json({ job: await recoverInterruptedCatchup(root(), job) });
  });

  app.post("/catch-up/:id/apply", async c => {
    const directory = root();
    const id = jobId(c.req.param("id"));
    const release = await lock(directory, id);
    try {
      const stored = await read(directory, id);
      if (stored.job.status === "completed") return c.json({ job: stored.job });
      if (stored.job.status !== "review") throw new HttpError(409, "Catch-up is not ready to apply. Start a new review.");
      if (stored.job.plan?.applyPolicyVersion !== 2) throw new HttpError(409, "Start a fresh review to use safe archive/retain decisions. Originals were left untouched.");
      try { await applyCatchup(directory, stored); }
      catch { throw new HttpError(409, stored.job.error ?? "Inbox or system state changed, or this review is no longer safe to apply. Start a fresh review; originals were left untouched."); }
      broadcast("mail", "mail.archived", { catchupId: id, archivedCount: stored.job.archivedCount });
      broadcast("mail", "mail.received", { catchupId: id, count: stored.job.plan?.actions.length });
      return c.json({ job: stored.job });
    } finally { await release(); }
  });
  return app;
}
