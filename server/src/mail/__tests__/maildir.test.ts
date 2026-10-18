import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import { Maildir, initMaildir } from "../maildir";

describe("Maildir", () => {
  let baseDir: string;
  let maildir: Maildir;

  beforeEach(async () => {
    baseDir = join("/tmp", `coleo-maildir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(baseDir, { recursive: true });
    maildir = new Maildir(baseDir);
    await maildir.init();
  });

  afterEach(async () => {
    try {
      await rm(baseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("writes and lists messages", async () => {
    const msg = await maildir.write({
      from: "brain@coleo.local",
      to: "human@local",
      subject: "Hello",
      date: new Date(),
      body: "Test body",
      headers: { "X-Test": "yes" },
    });

    const list = await maildir.list("new");
    expect(list.length).toBe(1);
    expect(list[0]?.subject).toBe("Hello");
    expect(list[0]?.body).toContain("Test body");
    expect(list[0]?.headers["x-test"]).toBe("yes");
    expect(list[0]?.flags.seen).toBe(false);

    // Ensure file is valid RFC-ish content
    const raw = await readFile(msg.filePath!, "utf-8");
    expect(raw).toContain("Subject: Hello");
  });

  it("marks messages as seen and moves to cur/", async () => {
    const msg = await maildir.write({
      from: "a@b",
      to: "c@d",
      subject: "Seen",
      date: new Date(),
      body: "Body",
      headers: {},
    });

    await maildir.markSeen(msg.id);

    const cur = await maildir.list("cur");
    expect(cur.length).toBe(1);
    expect(cur[0]?.flags.seen).toBe(true);
  });

  it("archives and deletes messages", async () => {
    const msg = await maildir.write({
      from: "a@b",
      to: "c@d",
      subject: "Archive",
      date: new Date(),
      body: "Body",
      headers: {},
    });

    // Delete should remove from new/cur/tmp (not archive)
    await maildir.delete(msg.id);
    const afterDelete = await maildir.list("new");
    expect(afterDelete.length).toBe(0);

    const msg2 = await maildir.write({
      from: "a@b",
      to: "c@d",
      subject: "Archive",
      date: new Date(),
      body: "Body",
      headers: {},
    });

    await maildir.archive(msg2.id);

    const archived = await maildir.list("archive");
    expect(archived.length).toBe(1);
    expect(archived[0]?.subject).toBe("Archive");
  });

  it("counts messages in folders", async () => {
    expect(await maildir.count("new")).toBe(0);

    await maildir.write({
      from: "a@b",
      to: "c@d",
      subject: "Count",
      date: new Date(),
      body: "Body",
      headers: {},
    });

    expect(await maildir.count("new")).toBe(1);
  });
});

describe("initMaildir", () => {
  it("creates standard folders", async () => {
    const baseDir = join("/tmp", `coleo-maildir-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(baseDir, { recursive: true });

    try {
      await initMaildir(baseDir);

      const inbox = new Maildir(join(baseDir, "inbox"));
      const list = await inbox.list("new");
      expect(Array.isArray(list)).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
