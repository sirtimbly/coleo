import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { connect, type Socket } from "net";
import { initMaildir, Maildir } from "../../mail";
import { ImapServer } from "../server";

interface ImapResponse {
  line: string;
  taggedLines: string[];
}

// Deprecated: IMAP server test coverage is being removed.
describe.skip("ImapServer", () => {
  let coleoDir = "";
  let server: ImapServer | null = null;
  let socket: Socket | null = null;

  beforeEach(async () => {
    coleoDir = await mkdtemp(join(tmpdir(), "coleo-imap-test-"));
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

    server = new ImapServer({
      coleoDir,
      host: "127.0.0.1",
      port: 1143,
      username: "coleo",
      password: "test-password",
    });

    await server.start();

    socket = connect({ host: "127.0.0.1", port: 1143 });
    await waitForLine(socket, (line) => line.includes("IMAP4rev1 Service Ready"));
  });

  afterEach(async () => {
    if (socket && !socket.destroyed) {
      socket.destroy();
    }

    if (server) {
      await server.stop();
    }
  });

  it("authenticates, lists mailboxes, and fetches message headers", async () => {
    const login = await sendTaggedCommand(socket!, "a1 LOGIN coleo test-password", "a1");
    expect(login.taggedLines.some((line) => line.includes("OK LOGIN completed"))).toBe(true);

    const list = await sendTaggedCommand(socket!, 'a2 LIST "" *', "a2");
    expect(list.taggedLines.some((line) => line.includes('LIST (\\HasNoChildren) "/" "INBOX"'))).toBe(true);

    const select = await sendTaggedCommand(socket!, "a3 SELECT INBOX", "a3");
    expect(select.taggedLines.some((line) => line.includes("1 EXISTS"))).toBe(true);

    const fetch = await sendTaggedCommand(socket!, "a4 FETCH 1 (FLAGS BODY[HEADER])", "a4");
    expect(fetch.taggedLines.some((line) => line.includes("BODY[HEADER]"))).toBe(true);
    expect(fetch.taggedLines.some((line) => line.includes("Subject: Test message"))).toBe(true);
  });

  it("rejects invalid credentials", async () => {
    const login = await sendTaggedCommand(socket!, "b1 LOGIN coleo bad-password", "b1");
    expect(login.taggedLines.some((line) => line.includes("NO LOGIN failed"))).toBe(true);
  });
});

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
