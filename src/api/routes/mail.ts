/**
 * Mail routes for managing messages
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Maildir } from "../../mail/maildir";
import { homedir } from "os";
import { join } from "path";

interface MailContext {
  Variables: {
    db: Database;
    octopaiDir: string;
  };
}

export function createMailRoutes() {
  const app = new Hono<MailContext>();

  app.use("*", async (c, next) => {
    const octopaiDir = process.env.OCTOPAI_DIR || join(homedir(), ".octopai");
    c.set("octopaiDir", octopaiDir);
    await next();
  });

  app.get("/inbox", async (c) => {
    const octopaiDir = c.get("octopaiDir");
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));

    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const newMessages = await inbox.list("new");
    const curMessages = await inbox.list("cur");
    const allMessages = [...newMessages, ...curMessages];

    const messages = allMessages.slice(offset, offset + limit);

    return c.json({
      messages,
      pagination: {
        limit,
        offset,
        total: allMessages.length,
        unread: newMessages.length,
      },
    });
  });

  app.get("/inbox/:id", async (c) => {
    const octopaiDir = c.get("octopaiDir");
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));
    const id = c.req.param("id");

    const newMessages = await inbox.list("new");
    const curMessages = await inbox.list("cur");
    const allMessages = [...newMessages, ...curMessages];
    const message = allMessages.find((m) => m.id.startsWith(id));

    if (!message) {
      return c.json({ error: "Message not found" }, 404);
    }

    return c.json({ message });
  });

  app.post("/inbox/:id/read", async (c) => {
    const octopaiDir = c.get("octopaiDir");
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));
    const id = c.req.param("id");

    await inbox.markSeen(id);

    return c.json({ success: true });
  });

  app.get("/sent", async (c) => {
    const octopaiDir = c.get("octopaiDir");
    const sent = new Maildir(join(octopaiDir, "mail", "sent"));

    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const allMessages = await sent.list("new");
    const messages = allMessages.slice(offset, offset + limit);

    return c.json({
      messages,
      pagination: {
        limit,
        offset,
        total: allMessages.length,
      },
    });
  });

  app.post("/send", async (c) => {
    const octopaiDir = c.get("octopaiDir");
    const sent = new Maildir(join(octopaiDir, "mail", "sent"));

    const body = await c.req.json<{
      from: string;
      to: string;
      subject: string;
      body: string;
      headers?: Record<string, string>;
    }>();

    if (!body.from || !body.to || !body.subject || !body.body) {
      return c.json({ error: "from, to, subject, and body are required" }, 400);
    }

    const message = await sent.write({
      from: body.from,
      to: body.to,
      subject: body.subject,
      date: new Date(),
      body: body.body,
      headers: body.headers || {},
    });

    return c.json({ message }, 201);
  });

  app.delete("/inbox/:id", async (c) => {
    const octopaiDir = c.get("octopaiDir");
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));
    const id = c.req.param("id");

    await inbox.delete(id);

    return c.json({ success: true });
  });

  app.post("/inbox/:id/archive", async (c) => {
    const octopaiDir = c.get("octopaiDir");
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));
    const id = c.req.param("id");

    await inbox.archive(id);

    return c.json({ success: true });
  });

  return app;
}
