import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { connect, createServer, type Socket } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { initMaildir, Maildir } from "../../mail";
import { ImapServer } from "../../imap/server";

interface ImapResponse {
  line: string;
  taggedLines: string[];
}

describe("ImapServer", () => {
  it("authenticates, lists mailboxes, and fetches message headers", async () => {
    const fixture = await createImapFixture();

    try {
      const login = await sendTaggedCommand(fixture.socket, "a1 LOGIN coleo test-password", "a1");
      expect(login.taggedLines.some((line) => line.includes("OK LOGIN completed"))).toBe(true);

      const list = await sendTaggedCommand(fixture.socket, 'a2 LIST "" *', "a2");
      expect(list.taggedLines.some((line) => line.includes('LIST (\\HasNoChildren) "/" "INBOX"'))).toBe(true);

      const select = await sendTaggedCommand(fixture.socket, "a3 SELECT INBOX", "a3");
      expect(select.taggedLines.some((line) => line.includes("1 EXISTS"))).toBe(true);

      const fetch = await sendTaggedCommand(fixture.socket, "a4 FETCH 1 (FLAGS BODY[HEADER])", "a4");
      expect(fetch.taggedLines.some((line) => line.includes("BODY[HEADER]"))).toBe(true);
      expect(fetch.taggedLines.some((line) => line.includes("Subject: Test message"))).toBe(true);
    } finally {
      await cleanupImapFixture(fixture);
    }
  });

  it("rejects invalid credentials", async () => {
    const fixture = await createImapFixture();

    try {
      const login = await sendTaggedCommand(fixture.socket, "b1 LOGIN coleo bad-password", "b1");
      expect(login.taggedLines.some((line) => line.includes("NO LOGIN failed"))).toBe(true);
    } finally {
      await cleanupImapFixture(fixture);
    }
  });
});

interface ImapFixture {
  coleoDir: string;
  server: ImapServer;
  socket: Socket;
}

async function createImapFixture(): Promise<ImapFixture> {
  const coleoDir = await mkdtemp(join(tmpdir(), "coleo-imap-test-"));
  const port = await getAvailablePort();

  await initMaildir(join(coleoDir, "mail"));

  const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
  await inbox.write({
    from: "brain@coleo.local",
    to: "human@coleo.local",
    subject: "Test message",
    date: new Date("2026-01-01T00:00:00.000Z"),
    body: "hello from test",
    headers: {},
  });

  const server = new ImapServer({
    coleoDir,
    host: "127.0.0.1",
    port,
    username: "coleo",
    password: "test-password",
  });
  await server.start();

  const socket = connect({ host: "127.0.0.1", port });
  await waitForLine(socket, (line) => line.includes("IMAP4rev1 Service Ready"));

  return { coleoDir, server, socket };
}

async function cleanupImapFixture(fixture: ImapFixture): Promise<void> {
  if (!fixture.socket.destroyed) {
    fixture.socket.destroy();
  }

  await fixture.server.stop();
  await rm(fixture.coleoDir, { recursive: true, force: true });
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Failed to resolve ephemeral IMAP test port")));
        return;
      }

      const { port } = address;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function waitForLine(socket: Socket, predicate: (line: string) => boolean): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";

    const onData = (data: Buffer): void => {
      buffer += data.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line && predicate(line)) {
          socket.off("data", onData);
          resolve(line);
          return;
        }
      }
    };

    socket.on("data", onData);
  });
}

function sendTaggedCommand(socket: Socket, command: string, tag: string): Promise<ImapResponse> {
  return new Promise((resolve) => {
    let buffer = "";
    const collected: string[] = [];

    const onData = (data: Buffer): void => {
      buffer += data.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;
        collected.push(line);

        if (line.startsWith(`${tag} `)) {
          socket.off("data", onData);
          resolve({ line, taggedLines: collected });
          return;
        }
      }
    };

    socket.on("data", onData);
    socket.write(`${command}\r\n`);
  });
}
