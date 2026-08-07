import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

import { Maildir } from "../../mail";
import { Brain } from "../brain";
import { detectBrainModelAccessIssue } from "../model-access";

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

  it("warns the human when fallback intent handling was caused by exhausted API credits", async () => {
    const brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
    });
    const sent = new Maildir(join(testDir, "mail", "sent"));
    await sent.write({
      from: "human@coleo.local",
      to: "brain@coleo.local",
      subject: "Evaluate this request",
      date: new Date(),
      body: "Turn this into planned work.",
      headers: {
        "Message-ID": "<credits@example.test>",
        "X-Coleo-Type": "human-message",
      },
    });
    const modelIssue = detectBrainModelAccessIssue(
      429,
      '{"error":{"message":"You have no credits remaining. Add credits to continue."}}',
      "openai",
    );
    expect(modelIssue).not.toBeNull();
    if (!modelIssue) return;

    (brain as any).mailProcessor = {
      processMessage: async () => ({
        type: "new_task",
        reasoning: "Fallback: treated as new task",
        subject: "Evaluate this request",
        body: "Turn this into planned work.",
        priority: "normal",
        modelIssue,
      }),
    };
    (brain as any).templates = {
      loadMailProcessorSystemPrompt: async () => "system prompt",
    };
    (brain as any).listRecentActivitySummary = async () => [];
    (brain as any).createTask = async () => ({
      id: "task-credits",
      subject: "Evaluate this request",
      priority: "normal",
      status: "pending",
    });
    const replies: Array<{ subject: string; body: string; headers?: Record<string, string> }> = [];
    (brain as any).sendToHuman = async (reply: {
      subject: string;
      body: string;
      headers?: Record<string, string>;
    }) => {
      replies.push(reply);
    };

    await (brain as any).processHumanMail();

    expect(replies).toHaveLength(2);
    expect(replies[0]?.headers?.["X-Coleo-Type"]).toBe("brain-model-access-blocked");
    expect(replies[0]?.subject).toContain("plan evaluation blocked");
    expect(replies[0]?.body).toContain("fallback intent handling");
    expect(replies[0]?.body).toContain("platform.openai.com");
    expect(replies[1]?.headers?.["X-Coleo-Type"]).toBe("task-created");
  });

  it("records a task-thread reply as actionable discussion input", async () => {
    const brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
    });
    const sent = new Maildir(join(testDir, "mail", "sent"));
    await sent.write({
      from: "human@coleo.local",
      to: "brain@coleo.local",
      subject: "Re: Task blocked",
      date: new Date(),
      body: "The requested access is available now.",
      headers: {
        "Message-ID": "<task-reply@example.test>",
        "X-Coleo-Type": "human-message",
        "X-Coleo-Task-Id": "task-42",
      },
    });

    (brain as any).getTaskFromApi = async () => ({ id: "task-42", status: "blocked" });
    const requests: Array<{ path: string; body?: string }> = [];
    (brain as any).apiRequest = async (path: string, options?: RequestInit) => {
      requests.push({ path, body: options?.body?.toString() });
      return { comment: { id: "comment-1" } };
    };
    (brain as any).sendToHuman = async () => undefined;
    (brain as any).mailProcessor = {
      processMessage: async () => {
        throw new Error("task replies should bypass intent parsing");
      },
    };
    (brain as any).templates = {
      loadMailProcessorSystemPrompt: async () => "system prompt",
    };
    (brain as any).listRecentActivitySummary = async () => [];

    await (brain as any).processHumanMail();

    expect(requests[0]?.path).toBe("/api/tasks/task-42/discussions");
    expect(JSON.parse(requests[0]?.body || "{}")).toMatchObject({
      content: "The requested access is available now.",
      authorType: "human",
      client: "mail",
    });
  });

  it("routes task-thread approval replies through the human review gate", async () => {
    const brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
    });
    const sent = new Maildir(join(testDir, "mail", "sent"));
    await sent.write({
      from: "human@coleo.local",
      to: "brain@coleo.local",
      subject: "Re: Approval required: Interactive garden",
      date: new Date(),
      body: "APPROVE [task-garden]\n\nThe navigation works as expected.",
      headers: {
        "Message-ID": "<task-approval@example.test>",
        "X-Coleo-Type": "human-message",
        "X-Coleo-Task-Id": "task-garden",
      },
    });

    (brain as any).getTaskFromApi = async () => ({
      id: "task-garden",
      status: "completing",
      metadata: { humanReview: { status: "pending" } },
    });
    const approvals: Array<{ taskId: string; approved: boolean; comment: string }> = [];
    (brain as any).handleApprovalResponse = async (
      taskId: string,
      approved: boolean,
      comment: string,
    ) => approvals.push({ taskId, approved, comment });
    (brain as any).apiRequest = async () => {
      throw new Error("approval replies must not be recorded as ordinary discussions");
    };
    (brain as any).mailProcessor = {
      processMessage: async () => {
        throw new Error("approval replies should bypass intent parsing");
      },
    };
    (brain as any).templates = {
      loadMailProcessorSystemPrompt: async () => "system prompt",
    };
    (brain as any).listRecentActivitySummary = async () => [];

    await (brain as any).processHumanMail();

    expect(approvals).toEqual([{
      taskId: "task-garden",
      approved: true,
      comment: "APPROVE [task-garden]\n\nThe navigation works as expected.",
    }]);
  });
});
