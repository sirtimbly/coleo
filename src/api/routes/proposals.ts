/**
 * Proposals routes
 *
 * Governance system for arms to propose changes and vote on them.
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";

interface ProposalsContext {
  Variables: {
    db: Database;
  };
}

export interface Proposal {
  id: string;
  proposer: string;
  type: string;
  title: string;
  description: string;
  status: "open" | "accepted" | "rejected" | "withdrawn" | "expired";
  argumentsFor: Array<{ armId: string; content: string; evidence?: string[]; timestamp: string }>;
  argumentsAgainst: Array<{ armId: string; content: string; evidence?: string[]; timestamp: string }>;
  signals: Record<string, { weight: number; reason?: string }>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  timeoutTicks: number;
  ticksElapsed: number;
}

interface ProposalRow {
  id: string;
  proposer: string;
  type: string;
  title: string;
  description: string;
  status: string;
  arguments_for: string;
  arguments_against: string;
  signals: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution: string | null;
  timeout_ticks: number;
  ticks_elapsed: number;
}

function parseProposalRow(row: ProposalRow): Proposal {
  return {
    id: row.id,
    proposer: row.proposer,
    type: row.type,
    title: row.title,
    description: row.description,
    status: row.status as Proposal["status"],
    argumentsFor: JSON.parse(row.arguments_for || "[]"),
    argumentsAgainst: JSON.parse(row.arguments_against || "[]"),
    signals: JSON.parse(row.signals || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    timeoutTicks: row.timeout_ticks,
    ticksElapsed: row.ticks_elapsed,
  };
}

export function createProposalsRoutes() {
  const app = new Hono<ProposalsContext>();

  /**
   * List proposals with optional filters
   * GET /api/proposals?status=open&type=change&author=arm-id
   */
  app.get("/", (c) => {
    const db = c.get("db");
    const status = c.req.query("status");
    const type = c.req.query("type");
    const author = c.req.query("author");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let query = `
      SELECT id, proposer, type, title, description, status,
             arguments_for, arguments_against, signals,
             created_at, updated_at, resolved_at, resolution,
             timeout_ticks, ticks_elapsed
      FROM proposals
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (status && status !== "all") {
      query += " AND status = ?";
      params.push(status);
    }
    if (type) {
      query += " AND type = ?";
      params.push(type);
    }
    if (author) {
      query += " AND proposer = ?";
      params.push(author);
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    try {
      const rows = db.query(query).all(...(params as (string | number)[])) as ProposalRow[];
      const proposals = rows.map(parseProposalRow);

      // Get total count
      let countQuery = "SELECT COUNT(*) as count FROM proposals WHERE 1=1";
      const countParams: unknown[] = [];
      if (status && status !== "all") {
        countQuery += " AND status = ?";
        countParams.push(status);
      }
      if (type) {
        countQuery += " AND type = ?";
        countParams.push(type);
      }
      if (author) {
        countQuery += " AND proposer = ?";
        countParams.push(author);
      }
      const countRow = db.query(countQuery).get(...(countParams as string[])) as { count: number };

      return c.json({
        proposals,
        pagination: { limit, offset, total: countRow.count },
      });
    } catch {
      return c.json({
        proposals: [],
        pagination: { limit, offset, total: 0 },
      });
    }
  });

  /**
   * Create a new proposal
   * POST /api/proposals
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      proposer: string;
      type: string;
      title: string;
      description: string;
      timeoutTicks?: number;
    }>();

    if (!body.proposer || !body.type || !body.title || !body.description) {
      throw HttpError.badRequest("proposer, type, title, and description are required");
    }

    // Check if proposer arm exists
    const arm = db.query("SELECT id FROM arms WHERE id = ?").get(body.proposer);
    if (!arm) {
      throw HttpError.notFound(`Arm not found: ${body.proposer}`);
    }

    const id = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const timeoutTicks = body.timeoutTicks || 10;

    db.run(
      `INSERT INTO proposals (
        id, proposer, type, title, description, status,
        arguments_for, arguments_against, signals,
        created_at, updated_at, timeout_ticks, ticks_elapsed
      ) VALUES (?, ?, ?, ?, ?, 'open', '[]', '[]', '{}', ?, ?, ?, 0)`,
      [id, body.proposer, body.type, body.title, body.description, now, now, timeoutTicks]
    );

    const proposal: Proposal = {
      id,
      proposer: body.proposer,
      type: body.type,
      title: body.title,
      description: body.description,
      status: "open",
      argumentsFor: [],
      argumentsAgainst: [],
      signals: {},
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
      timeoutTicks,
      ticksElapsed: 0,
    };

    // Broadcast new proposal
    broadcast("proposals", "proposal.new", { proposal });

    return c.json({ proposal }, 201);
  });

  /**
   * Get proposal details
   * GET /api/proposals/:id
   */
  app.get("/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const row = db
      .query(
        `SELECT id, proposer, type, title, description, status,
                arguments_for, arguments_against, signals,
                created_at, updated_at, resolved_at, resolution,
                timeout_ticks, ticks_elapsed
         FROM proposals WHERE id = ?`
      )
      .get(id) as ProposalRow | null;

    if (!row) {
      throw HttpError.notFound(`Proposal not found: ${id}`);
    }

    return c.json({ proposal: parseProposalRow(row) });
  });

  /**
   * Add an argument to a proposal
   * POST /api/proposals/:id/argue
   */
  app.post("/:id/argue", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      armId: string;
      position: "for" | "against";
      content: string;
      evidence?: string[];
    }>();

    if (!body.armId || !body.position || !body.content) {
      throw HttpError.badRequest("armId, position, and content are required");
    }

    if (!["for", "against"].includes(body.position)) {
      throw HttpError.badRequest("position must be 'for' or 'against'");
    }

    // Get current proposal
    const row = db
      .query("SELECT id, status, arguments_for, arguments_against FROM proposals WHERE id = ?")
      .get(id) as { id: string; status: string; arguments_for: string; arguments_against: string } | null;

    if (!row) {
      throw HttpError.notFound(`Proposal not found: ${id}`);
    }

    if (row.status !== "open") {
      throw HttpError.badRequest(`Cannot argue on a ${row.status} proposal`);
    }

    const argument = {
      armId: body.armId,
      content: body.content,
      evidence: body.evidence || [],
      timestamp: new Date().toISOString(),
    };

    let argumentsFor = JSON.parse(row.arguments_for || "[]");
    let argumentsAgainst = JSON.parse(row.arguments_against || "[]");

    if (body.position === "for") {
      argumentsFor.push(argument);
    } else {
      argumentsAgainst.push(argument);
    }

    const now = new Date().toISOString();
    db.run(
      "UPDATE proposals SET arguments_for = ?, arguments_against = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(argumentsFor), JSON.stringify(argumentsAgainst), now, id]
    );

    // Broadcast argument added
    broadcast("proposals", "proposal.argue", { proposalId: id, position: body.position, argument });

    return c.json({ added: true, position: body.position, argument });
  });

  /**
   * Add a signal (support/opposition)
   * POST /api/proposals/:id/signal
   */
  app.post("/:id/signal", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      armId: string;
      weight: number;
      reason?: string;
    }>();

    if (!body.armId || body.weight === undefined) {
      throw HttpError.badRequest("armId and weight are required");
    }

    if (body.weight < -100 || body.weight > 100) {
      throw HttpError.badRequest("weight must be between -100 and 100");
    }

    // Get current proposal
    const row = db.query("SELECT id, status, signals FROM proposals WHERE id = ?").get(id) as {
      id: string;
      status: string;
      signals: string;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Proposal not found: ${id}`);
    }

    if (row.status !== "open") {
      throw HttpError.badRequest(`Cannot signal on a ${row.status} proposal`);
    }

    const signals = JSON.parse(row.signals || "{}");
    signals[body.armId] = { weight: body.weight, reason: body.reason };

    const now = new Date().toISOString();
    db.run("UPDATE proposals SET signals = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(signals),
      now,
      id,
    ]);

    // Broadcast signal added
    broadcast("proposals", "proposal.signal", {
      proposalId: id,
      armId: body.armId,
      weight: body.weight,
      reason: body.reason,
    });

    return c.json({ signaled: true, armId: body.armId, weight: body.weight });
  });

  /**
   * Human resolves an undecided proposal
   * POST /api/proposals/:id/resolve
   */
  app.post("/:id/resolve", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      decision: "accept" | "reject";
      reason?: string;
    }>();

    if (!body.decision) {
      throw HttpError.badRequest("decision is required");
    }

    if (!["accept", "reject"].includes(body.decision)) {
      throw HttpError.badRequest("decision must be 'accept' or 'reject'");
    }

    // Get current proposal
    const row = db.query("SELECT id, status FROM proposals WHERE id = ?").get(id) as {
      id: string;
      status: string;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Proposal not found: ${id}`);
    }

    if (row.status !== "open") {
      throw HttpError.badRequest(`Cannot resolve a ${row.status} proposal`);
    }

    const status = body.decision === "accept" ? "accepted" : "rejected";
    const now = new Date().toISOString();

    db.run(
      "UPDATE proposals SET status = ?, resolution = ?, resolved_at = ?, updated_at = ? WHERE id = ?",
      [status, body.reason || null, now, now, id]
    );

    // Broadcast resolution
    broadcast("proposals", "proposal.resolved", {
      proposalId: id,
      status,
      decision: body.decision,
      reason: body.reason,
    });

    return c.json({ resolved: true, status, decision: body.decision });
  });

  /**
   * Withdraw a proposal (only by proposer)
   * POST /api/proposals/:id/withdraw
   */
  app.post("/:id/withdraw", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      armId: string;
      reason?: string;
    }>();

    if (!body.armId) {
      throw HttpError.badRequest("armId is required");
    }

    // Get current proposal
    const row = db.query("SELECT id, status, proposer FROM proposals WHERE id = ?").get(id) as {
      id: string;
      status: string;
      proposer: string;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Proposal not found: ${id}`);
    }

    if (row.proposer !== body.armId) {
      throw HttpError.forbidden("Only the proposer can withdraw a proposal");
    }

    if (row.status !== "open") {
      throw HttpError.badRequest(`Cannot withdraw a ${row.status} proposal`);
    }

    const now = new Date().toISOString();
    db.run(
      "UPDATE proposals SET status = 'withdrawn', resolution = ?, resolved_at = ?, updated_at = ? WHERE id = ?",
      [body.reason || "Withdrawn by proposer", now, now, id]
    );

    // Broadcast withdrawal
    broadcast("proposals", "proposal.resolved", {
      proposalId: id,
      status: "withdrawn",
      decision: "withdrawn",
      reason: body.reason,
    });

    return c.json({ withdrawn: true });
  });

  return app;
}
