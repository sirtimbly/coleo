/**
 * Mail routes for managing messages
 * Enhanced to expose Maildir metadata for downstream gateways (IMAP/SMTP)
 */
import { Hono } from "hono";
import { Maildir } from "../../mail/maildir";
import { broadcastMailEvent } from "../websocket";
import { getColeoDir } from "../../config";
import { join } from "path";
import { readdir, stat } from "fs/promises";
import { HttpError } from "../middleware/error";
import { eventStore } from "../../nats/jetstream";
import { normalizePostmarkInbound, sendPostmarkMessage } from "../../mail/postmark-gateway";
import type { MailContext, MessageMetadata, FolderInfo } from "./mail-types";
import { getDetailedMessages } from "./mail-utils";

export type { MailContext, MessageMetadata, FolderInfo } from "./mail-types";
export { getDetailedMessages } from "./mail-utils";

export function createMailRoutes() {
  const app = new Hono<MailContext>();

  app.use("*", async (c, next) => {
    const coleoDir = getColeoDir();
    c.set("coleoDir", coleoDir);
    await next();
  });

  // Enhanced API for downstream gateways
  
  /**
   * Get all maildir folders with metadata - for IMAP/SMTP gateways
   */
  app.get("/folders", async (c) => {
    const coleoDir = c.get("coleoDir");
    const mailPath = join(coleoDir, "mail");
    
    try {
      const entries = await readdir(mailPath, { withFileTypes: true });
      const folders: FolderInfo[] = [];
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const folderPath = join(mailPath, entry.name);
          const maildir = new Maildir(folderPath);
          
          try {
            const newMessages = await maildir.list("new");
            const curMessages = await maildir.list("cur");
            const totalMessages = newMessages.length + curMessages.length;
            const folderStat = await stat(folderPath);
            
            folders.push({
              name: entry.name,
              path: folderPath,
              type: 'mailbox',
              messageCount: totalMessages,
              unreadCount: newMessages.length,
              size: folderStat.size,
              lastModified: folderStat.mtime,
            });
          } catch (err) {
            console.warn(`Failed to read folder ${entry.name}:`, err);
          }
        }
      }
      
      return c.json({ folders });
    } catch (err) {
      throw HttpError.internal(`Failed to list mail folders: ${err}`);
    }
  });

  /**
   * Get detailed message list with metadata for a specific folder
   * Optimized for IMAP/POP3 gateways
   */
  app.get("/folders/:folder/messages", async (c) => {
    const coleoDir = c.get("coleoDir");
    const folder = c.req.param("folder");
    const subfolder = c.req.query("subfolder") || "all"; // "new", "cur", or "all"
    const limit = Math.min(parseInt(c.req.query("limit") || "1000", 10), 1000);
    const offset = parseInt(c.req.query("offset") || "0", 10);
    
    const maildir = new Maildir(join(coleoDir, "mail", folder));
    
    try {
      let allMessages: MessageMetadata[] = [];
      
      if (subfolder === "all" || subfolder === "new") {
        const newMessages = await getDetailedMessages(maildir, "new");
        allMessages.push(...newMessages);
      }
      
      if (subfolder === "all" || subfolder === "cur") {
        const curMessages = await getDetailedMessages(maildir, "cur");
        allMessages.push(...curMessages);
      }
      
      // Sort by filename (which includes timestamp)
      allMessages.sort((a, b) => b.filename.localeCompare(a.filename));
      
      const messages = allMessages.slice(offset, offset + limit);
      
      return c.json({
        folder,
        subfolder,
        messages,
        pagination: {
          limit,
          offset,
          total: allMessages.length,
          unreadCount: allMessages.filter(m => !m.flags.seen).length,
        },
      });
    } catch (err) {
      throw HttpError.internal(`Failed to list messages in folder ${folder}: ${err}`);
    }
  });

  /**
   * Get raw message content by ID - for efficient gateway access
   */
  app.get("/folders/:folder/messages/:id/raw", async (c) => {
    const coleoDir = c.get("coleoDir");
    const folder = c.req.param("folder");
    const id = c.req.param("id");
    
    const maildir = new Maildir(join(coleoDir, "mail", folder));
    
    try {
      const newMessages = await maildir.list("new");
      const curMessages = await maildir.list("cur");
      const allMessages = [...newMessages, ...curMessages];
      const message = allMessages.find((m) => m.id.startsWith(id));

      if (!message || !message.filePath) {
        throw HttpError.notFound(`Message not found: ${id}`);
      }

      // Return raw RFC 5322 content
      const rawContent = await Bun.file(message.filePath).text();
      
      return new Response(rawContent, {
        headers: {
          "Content-Type": "message/rfc822",
          "Content-Length": rawContent.length.toString(),
        },
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.internal(`Failed to read raw message ${id}: ${err}`);
    }
  });

  /**
   * Mark message as read - tracks processing confirmation
   * POST /api/mail/inbox/:id/read
   */
  app.post("/inbox/:id/read", async (c) => {
    const coleoDir = c.get("coleoDir");
    const id = c.req.param("id");

    const maildir = new Maildir(join(coleoDir, "mail", "inbox"));

    try {
      // Move message from new/ to cur/ (mark as read)
      await maildir.markSeen(id);

      broadcastMailEvent("read", {
        messageId: id,
        from: "unknown", // Could be enhanced to extract from message
        to: "brain",
        subject: "unknown",
      });

      return c.json({ success: true });
    } catch (err) {
      throw HttpError.internal(`Failed to mark message as read: ${err}`);
    }
  });

  /**
   * Archive message - tracks that message was processed
   * POST /api/mail/inbox/:id/archive
   */
  app.post("/inbox/:id/archive", async (c) => {
    const coleoDir = c.get("coleoDir");
    const id = c.req.param("id");

    const maildir = new Maildir(join(coleoDir, "mail", "inbox"));

    try {
      // Move message to archive folder (or mark as archived)
      await maildir.archive(id);

      broadcastMailEvent("archived", {
        messageId: id,
        from: "unknown",
        to: "brain",
        subject: "unknown",
      });

      return c.json({ success: true });
    } catch (err) {
      throw HttpError.internal(`Failed to archive message: ${err}`);
    }
  });

  /**
   * Track message processing outcomes
   * POST /api/mail/inbox/:id/track
   */
  app.post("/inbox/:id/track", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      outcome: "added_to_plan" | "unblocked_arm" | "created_task" | "ignored" | "error";
      details?: Record<string, unknown>;
      taskId?: string;
      armId?: string;
    }>();

    if (!body.outcome) {
      throw HttpError.badRequest("outcome is required");
    }

    try {
      // Log the message processing outcome to JetStream
      if (eventStore.isInitialized()) {
        await eventStore.publishEvent(`coleo.events.mail.${id}.processed`, {
          type: "message_processed",
          data: {
            actor: "brain",
            outcome: body.outcome,
            details: body.details,
            taskId: body.taskId,
            armId: body.armId,
          },
          timestamp: new Date().toISOString(),
        });
      }

      return c.json({ success: true });
    } catch (err) {
      throw HttpError.internal(`Failed to track message processing: ${err}`);
    }
  });

  /**
    * Update message flags - for IMAP flag synchronization
    */
   app.patch("/folders/:folder/messages/:id/flags", async (c) => {
    const coleoDir = c.get("coleoDir");
    const folder = c.req.param("folder");
    const id = c.req.param("id");
    
    const body = await c.req.json<{
      flags: Partial<{
        seen: boolean;
        replied: boolean;
        flagged: boolean;
        draft: boolean;
        trashed: boolean;
      }>;
    }>();
    
    if (!body.flags) {
      throw HttpError.badRequest("flags object is required");
    }
    
    const maildir = new Maildir(join(coleoDir, "mail", folder));
    
    try {
      // For now, we only support the 'seen' flag (others would require extending Maildir class)
      if (body.flags.seen !== undefined) {
        if (body.flags.seen) {
          await maildir.markSeen(id);
        }
        // Note: unmarking as seen would require additional Maildir method
      }
      
      return c.json({ success: true, updated: Object.keys(body.flags) });
    } catch (err) {
      throw HttpError.internal(`Failed to update flags for message ${id}: ${err}`);
    }
  });

  // Existing API endpoints (enhanced with proper error handling)
  
  app.get("/inbox", async (c) => {
    const coleoDir = c.get("coleoDir");
    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));

    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    try {
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
    } catch (err) {
      throw HttpError.internal(`Failed to list inbox messages: ${err}`);
    }
  });

  app.get("/inbox/:id", async (c) => {
    const coleoDir = c.get("coleoDir");
    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
    const id = c.req.param("id");

    try {
      const newMessages = await inbox.list("new");
      const curMessages = await inbox.list("cur");
      const allMessages = [...newMessages, ...curMessages];
      const message = allMessages.find((m) => m.id.startsWith(id));

      if (!message) {
        throw HttpError.notFound(`Message not found: ${id}`);
      }

      return c.json({ message });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.internal(`Failed to read message ${id}: ${err}`);
    }
  });

  app.post("/inbox/:id/read", async (c) => {
    const coleoDir = c.get("coleoDir");
    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
    const id = c.req.param("id");

    try {
      await inbox.markSeen(id);

      // Get updated unread count
      const newMessages = await inbox.list("new");
      
      // Broadcast mail read event
      broadcastMailEvent("read", {
        messageId: id,
        unreadCount: newMessages.length,
      });

      return c.json({ success: true });
    } catch (err) {
      throw HttpError.internal(`Failed to mark message ${id} as read: ${err}`);
    }
  });

  app.get("/sent", async (c) => {
    const coleoDir = c.get("coleoDir");
    const sent = new Maildir(join(coleoDir, "mail", "sent"));

    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    try {
      const newMessages = await sent.list("new");
      const curMessages = await sent.list("cur");
      const allMessages = [...newMessages, ...curMessages];
      const messages = allMessages.slice(offset, offset + limit);

      return c.json({
        messages,
        pagination: {
          limit,
          offset,
          total: allMessages.length,
        },
      });
    } catch (err) {
      throw HttpError.internal(`Failed to list sent messages: ${err}`);
    }
  });

  app.get("/archive", async (c) => {
    const coleoDir = c.get("coleoDir");
    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));

    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    try {
      const allMessages = await inbox.list("archive");
      const messages = allMessages.slice(offset, offset + limit);

      return c.json({
        messages,
        pagination: {
          limit,
          offset,
          total: allMessages.length,
        },
      });
    } catch (err) {
      throw HttpError.internal(`Failed to list archived messages: ${err}`);
    }
  });

  app.post("/send", async (c) => {
    const coleoDir = c.get("coleoDir");
    const sent = new Maildir(join(coleoDir, "mail", "sent"));

    const body = await c.req.json<{
      from: string;
      to: string;
      subject: string;
      body: string;
      headers?: Record<string, string>;
    }>();

    if (!body.from || !body.to || !body.subject || !body.body) {
      throw HttpError.badRequest("from, to, subject, and body are required");
    }

    try {
      const message = await sent.write({
        from: body.from,
        to: body.to,
        subject: body.subject,
        date: new Date(),
        body: body.body,
        headers: body.headers || {},
      });

      // Broadcast mail sent event
      broadcastMailEvent("sent", {
        messageId: message.id,
        from: body.from,
        to: body.to,
        subject: body.subject,
      });

      return c.json({ message }, 201);
    } catch (err) {
      throw HttpError.internal(`Failed to send message: ${err}`);
    }
  });

  app.post("/gateway/postmark/inbound", async (c) => {
    const coleoDir = c.get("coleoDir");
    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
    const webhookToken = process.env.COLEO_POSTMARK_INBOUND_TOKEN;

    if (webhookToken) {
      const incomingToken = c.req.header("x-coleo-webhook-token");
      if (!incomingToken || incomingToken !== webhookToken) {
        throw HttpError.unauthorized("Invalid webhook token");
      }
    }

    const payload = await c.req.json<unknown>();

    let inboundMessage;
    try {
      inboundMessage = normalizePostmarkInbound(payload);
    } catch (err) {
      throw HttpError.badRequest(`Invalid Postmark inbound payload: ${err}`);
    }

    try {
      const message = await inbox.write({
        from: inboundMessage.from,
        to: inboundMessage.to,
        subject: inboundMessage.subject,
        date: new Date(),
        body: inboundMessage.body,
        headers: inboundMessage.headers,
      });

      broadcastMailEvent("received", {
        messageId: message.id,
        from: message.from,
        to: message.to,
        subject: message.subject,
      });

      return c.json({ message }, 201);
    } catch (err) {
      throw HttpError.internal(`Failed to persist Postmark inbound message: ${err}`);
    }
  });

  app.post("/gateway/postmark/send", async (c) => {
    const coleoDir = c.get("coleoDir");
    const sent = new Maildir(join(coleoDir, "mail", "sent"));
    const apiToken = process.env.COLEO_POSTMARK_SERVER_TOKEN;

    if (!apiToken) {
      throw HttpError.badRequest("COLEO_POSTMARK_SERVER_TOKEN is not configured");
    }

    const body = await c.req.json<{
      to: string;
      subject: string;
      body: string;
      from?: string;
      replyTo?: string;
    }>();

    if (!body.from || !body.to || !body.subject || !body.body) {
      throw HttpError.badRequest("from, to, subject, and body are required");
    }

    const from = body.from;

    try {
      const sendResult = await sendPostmarkMessage({
        apiToken,
        from,
        to: body.to,
        subject: body.subject,
        textBody: body.body,
        replyTo: body.replyTo,
      });

      const message = await sent.write({
        from,
        to: body.to,
        subject: body.subject,
        date: new Date(),
        body: body.body,
        headers: {
          "x-mail-provider": "postmark",
          "x-postmark-message-id": sendResult.messageId,
        },
      });

      broadcastMailEvent("sent", {
        messageId: message.id,
        from,
        to: body.to,
        subject: body.subject,
      });

      return c.json({ message, provider: sendResult }, 202);
    } catch (err) {
      throw HttpError.internal(`Failed to send message via Postmark: ${err}`);
    }
  });

  app.delete("/inbox/:id", async (c) => {
    const coleoDir = c.get("coleoDir");
    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
    const id = c.req.param("id");

    try {
      await inbox.delete(id);

      // Get updated unread count
      const newMessages = await inbox.list("new");
      
      // Broadcast mail deleted event
      broadcastMailEvent("deleted", {
        messageId: id,
        unreadCount: newMessages.length,
      });

      return c.json({ success: true });
    } catch (err) {
      throw HttpError.internal(`Failed to delete message ${id}: ${err}`);
    }
  });

  app.post("/inbox/:id/archive", async (c) => {
    const coleoDir = c.get("coleoDir");
    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
    const id = c.req.param("id");

    try {
      await inbox.archive(id);

      // Get updated unread count
      const newMessages = await inbox.list("new");
      
      // Broadcast mail archived event
      broadcastMailEvent("archived", {
        messageId: id,
        unreadCount: newMessages.length,
      });

      return c.json({ success: true });
    } catch (err) {
      throw HttpError.internal(`Failed to archive message ${id}: ${err}`);
    }
  });

  return app;
}
