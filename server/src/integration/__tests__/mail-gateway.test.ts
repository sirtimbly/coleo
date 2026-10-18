import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createApp } from "../../api/server";
import { loadApiConfig, type ApiConfig } from "../../api/config";
import { initDatabase } from "../../db";
import { initMaildir, Maildir } from "../../mail";

describe("Mail gateway integration", () => {
  let app: ReturnType<typeof createApp>;
  let db: Database;
  let coleoDir = "";
  let previousColeoDir: string | undefined;
  let previousWebhookToken: string | undefined;
  const apiKey = "test-api-key-12345";

  beforeEach(async () => {
    coleoDir = await mkdtemp(join(tmpdir(), "coleo-mail-gateway-"));
    previousColeoDir = process.env.COLEO_DIR;
    previousWebhookToken = process.env.COLEO_POSTMARK_INBOUND_TOKEN;

    process.env.COLEO_DIR = coleoDir;
    delete process.env.COLEO_POSTMARK_INBOUND_TOKEN;

    await initMaildir(join(coleoDir, "mail"));
    db = await initDatabase(":memory:");

    const baseConfig = loadApiConfig();
    const config: ApiConfig = { ...baseConfig, apiKey };
    app = createApp(db, config);
  });

  afterEach(async () => {
    db.close();

    if (previousColeoDir === undefined) {
      delete process.env.COLEO_DIR;
    } else {
      process.env.COLEO_DIR = previousColeoDir;
    }

    if (previousWebhookToken === undefined) {
      delete process.env.COLEO_POSTMARK_INBOUND_TOKEN;
    } else {
      process.env.COLEO_POSTMARK_INBOUND_TOKEN = previousWebhookToken;
    }

    if (coleoDir) {
      await rm(coleoDir, { recursive: true, force: true });
    }
  });

  it("persists normalized inbound Postmark mail into the inbox", async () => {
    const response = await app.request(
      new Request("http://localhost/api/mail/gateway/postmark/inbound", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          From: "sender@example.com",
          To: "brain@example.com",
          Subject: "Inbound message",
          TextBody: "Hello from Postmark",
          MessageID: "message-123",
        }),
      }),
    );

    expect(response.status).toBe(201);

    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
    const messages = await inbox.list("new");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.from).toBe("sender@example.com");
    expect(messages[0]?.to).toBe("brain@example.com");
    expect(messages[0]?.subject).toBe("Inbound message");
    expect(messages[0]?.body).toContain("Hello from Postmark");
    expect(messages[0]?.headers["x-mail-provider"]).toBe("postmark");
    expect(messages[0]?.headers["x-postmark-message-id"]).toBe("message-123");
  });

  it("enforces the optional inbound webhook token before persisting mail", async () => {
    process.env.COLEO_POSTMARK_INBOUND_TOKEN = "expected-token";

    const unauthorizedResponse = await app.request(
      new Request("http://localhost/api/mail/gateway/postmark/inbound", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          From: "sender@example.com",
          To: "brain@example.com",
          Subject: "Blocked message",
          TextBody: "Should not persist",
        }),
      }),
    );

    expect(unauthorizedResponse.status).toBe(401);

    const authorizedResponse = await app.request(
      new Request("http://localhost/api/mail/gateway/postmark/inbound", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "x-coleo-webhook-token": "expected-token",
        },
        body: JSON.stringify({
          From: "sender@example.com",
          To: "brain@example.com",
          Subject: "Allowed message",
          TextBody: "Should persist",
        }),
      }),
    );

    expect(authorizedResponse.status).toBe(201);

    const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
    const messages = await inbox.list("new");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe("Allowed message");
  });
});
