import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { collectSwarmSnapshot } from "../swarm-snapshot";
import { actionKey, finishSwarmAction, listSwarmActions, reserveSwarmAction } from "../../db/swarm-actions";
import { proposalSchema, windowBounds } from "../../brain/swarm/types";
import { recordSwarmRecommendations, setSwarmRecommendationDisposition } from "../swarm-inbox";
import { broadcast } from "../websocket";
import { HttpError } from "../middleware";
import type { Database } from "bun:sqlite";

function broadcastOutcome(db: Database, actionId: string): void {
  const row = db.query("SELECT dedup_key AS key FROM brain_swarm_actions WHERE id=?").get(actionId) as { key: string } | null;
  if (row) broadcast("workbench", "workbench.swarm.updated", { itemKey: `swarm:${row.key}` });
}

export function createBrainSwarmRoutes(): Hono<{ Variables: { db: Database } }> {
  const app = new Hono<{ Variables: { db: Database } }>();
  app.get("/snapshot", async (c) => {
    const parsed = z.object({ pollIntervalMs: z.coerce.number().int().positive().max(3600000),
      windowPolls: z.coerce.number().int().min(1).max(100).default(10) }).safeParse(c.req.query());
    if (!parsed.success) throw HttpError.badRequest("Invalid swarm window");
    return c.json(await collectSwarmSnapshot(c.get("db"), windowBounds(parsed.data.pollIntervalMs, parsed.data.windowPolls)));
  });
  app.get("/actions", (c) => {
    const since = c.req.query("since") || new Date(Date.now() - 24 * 3600000).toISOString();
    if (!Number.isFinite(Date.parse(since))) throw HttpError.badRequest("Invalid since");
    return c.json({ actions: listSwarmActions(c.get("db"), since) });
  });
  app.post("/actions", async (c) => {
    const parsed = z.object({ proposal: proposalSchema, execute: z.boolean(),
      detail: z.string().max(4000).default(""), cooldownMs: z.number().int().min(1000).max(360000000) }).safeParse(await c.req.json());
    if (!parsed.success) throw HttpError.badRequest("Invalid swarm action");
    const { proposal, execute, cooldownMs } = parsed.data;
    const db = c.get("db");
    const result = db.transaction(() => {
      const reservation = reserveSwarmAction(db, proposal, execute, cooldownMs);
      // Duplicate polls must not overwrite the original recommendation's explanation.
      if (reservation.reserved || !reservation.receipt) {
        setSwarmRecommendationDisposition(db, proposal,
          reservation.reserved ? execute ? "executing" : "proposed" : "suppressed",
          reservation.reserved ? parsed.data.detail : reservation.reason ?? "");
      }
      return reservation;
    }).immediate();
    broadcast("workbench", "workbench.swarm.updated", { itemKey: `swarm:${actionKey(proposal)}` });
    return c.json(result);
  });
  app.post("/actions/:id/finish", async (c) => {
    const parsed = z.object({ status: z.enum(["succeeded", "uncertain", "rejected"]), detail: z.string().max(4000) }).safeParse(await c.req.json());
    if (!parsed.success) throw HttpError.badRequest("Invalid action outcome");
    const updated = finishSwarmAction(c.get("db"), c.req.param("id"), parsed.data.status, parsed.data.detail);
    if (updated) broadcastOutcome(c.get("db"), c.req.param("id"));
    return c.json({ updated });
  });
  app.post("/evaluations", async (c) => {
    const parsed = z.object({ mode: z.enum(["shadow", "execute"]), snapshot: z.record(z.string(), z.unknown()),
      result: z.record(z.string(), z.unknown()) }).safeParse(await c.req.json());
    if (!parsed.success) throw HttpError.badRequest("Invalid swarm evaluation");
    const id = randomUUID();
    const proposals = z.array(proposalSchema).optional().safeParse(parsed.data.result.proposals);
    if (!proposals.success) throw HttpError.badRequest("Invalid swarm recommendations");
    const db = c.get("db");
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      db.run("INSERT INTO brain_swarm_evaluations (id,created_at,mode,snapshot,result) VALUES (?,?,?,?,?)",
        [id, timestamp, parsed.data.mode, JSON.stringify(parsed.data.snapshot), JSON.stringify(parsed.data.result)]);
      recordSwarmRecommendations(db, id, proposals.data ?? [], timestamp);
    }).immediate();
    if (proposals.data?.length) broadcast("workbench", "workbench.swarm.created", { itemKeys: proposals.data.map((proposal) => `swarm:${actionKey(proposal)}`) });
    return c.json({ id });
  });
  app.get("/evaluations", (c) => {
    const rows = c.get("db").query("SELECT id,created_at AS createdAt,mode,result FROM brain_swarm_evaluations ORDER BY created_at DESC LIMIT 100").all();
    return c.json({ evaluations: rows });
  });
  // Operator reconciliation only: no model or retry loop calls this endpoint.
  app.post("/actions/:id/reconcile", async (c) => {
    const parsed = z.object({ status: z.enum(["succeeded", "rejected"]), detail: z.string().min(10).max(4000) }).safeParse(await c.req.json());
    if (!parsed.success) throw HttpError.badRequest("Reconciliation requires an observed outcome and explanation");
    const result = c.get("db").run(`UPDATE brain_swarm_actions SET status=?,detail=?,updated_at=?
      WHERE id=? AND status IN ('executing','uncertain')`,
    [parsed.data.status, parsed.data.detail, new Date().toISOString(), c.req.param("id")]);
    if (result.changes === 1) broadcastOutcome(c.get("db"), c.req.param("id"));
    return c.json({ updated: result.changes === 1 });
  });
  return app;
}
