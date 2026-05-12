import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

import { Maildir } from "../../mail";
import { Brain } from "../brain";

describe("Brain human mail processing", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-human-mail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    for (const folder of ["inbox", "sent"]) {
      await mkdir(join(testDir, "mail", folder, "new"), { recursive: true });
      await mkdir(join(testDir, "mail", folder, "cur"), { recursive: true });
      await mkdir(join(testDir, "mail", folder, "tmp"), { recursive: true });
    }
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("processes human-message mail written to sent/", async () => {
    const brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
    });
    const sent = new Maildir(join(testDir, "mail", "sent"));

    const messageId = "<human-msg@example.test>";
    const message = await sent.write({
      from: "human@coleo.local",
      to: "brain@coleo.local",
      subject: "Please fix this",
      date: new Date(),
      body: "Track this as a task.",
      headers: {
        "Message-ID": messageId,
        "X-Coleo-Type": "human-message",
      },
    });

    const processed: Array<{ subject: string; body: string; mailThreadId?: string }> = [];
    const replies: Array<{ subject: string; body: string; headers?: Record<string, string> }> = [];

    (brain as any).mailProcessor = {
      processMessage: async () => ({
        type: "new_task",
        reasoning: "test",
        subject: "Processed task",
        body: "Processed body",
        priority: "normal",
      }),
    };
    (brain as any).templates = {
      loadMailProcessorSystemPrompt: async () => "system prompt",
    };
    (brain as any).listRecentActivitySummary = async () => [];
    (brain as any).createTask = async (
      subject: string,
      body: string,
      mailThreadId?: string,
    ) => {
      processed.push({ subject, body, mailThreadId });
      return {
        id: "task-1",
        subject,
        body,
        priority: "normal",
        status: "pending",
      };
    };
    (brain as any).sendToHuman = async (reply: {
      subject: string;
      body: string;
      headers?: Record<string, string>;
    }) => {
      replies.push(reply);
    };

    await (brain as any).processHumanMail();

    expect(processed).toEqual([
      {
        subject: "Processed task",
        body: "Processed body",
        mailThreadId: messageId,
      },
    ]);

    expect(replies[0]?.headers).toMatchObject({
      "X-Coleo-Type": "task-created",
      "X-Coleo-Task-Id": "task-1",
      "X-Coleo-Thread-Id": messageId,
      "In-Reply-To": messageId,
      References: messageId,
    });

    const remainingNew = await sent.list("new");
    expect(remainingNew.some((entry) => entry.id === message.id)).toBe(false);

    const seenMessages = await sent.list("cur");
    const seenMessage = seenMessages.find((entry) => entry.id === message.id);
    expect(seenMessage).toBeTruthy();
    expect(seenMessage?.flags.seen).toBe(true);
  });
});
