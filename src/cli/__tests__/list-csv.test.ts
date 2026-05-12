import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { exportListToCsv, importListFromCsv } from "../list-csv";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      order_key TEXT,
      claimed_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE bugs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER,
      resolved_at TEXT,
      archived INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("list CSV helpers", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    delete process.env.COLEO_CSV_EDITOR;
    delete process.env.COLEO_EDITOR;
    delete process.env.EDITOR;
    db.close();
  });

  it("exports tasks as editable CSV", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "First task", "first note", "pending", "a", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-2", "Second task", "second note", "claimed", "b", now, now],
    );

    expect(exportListToCsv(db, "tasks")).toBe(
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,First task,pending,1,first note,First task,pending,1,first note\n" +
        "task-2,Second task,claimed,2,second note,Second task,claimed,2,second note\n",
    );
  });

  it("escapes control characters in CSV text cells and restores them on import", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "Task with\ttab, and \"quotes\"", "line one\nline two\\trail, \"quoted\"", "pending", "a", now, now],
    );

    expect(exportListToCsv(db, "tasks")).toBe(
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,Task with%09tab%2C and %22quotes%22,pending,1,line one%0Aline two%5Ctrail%2C %22quoted%22,Task with%09tab%2C and %22quotes%22,pending,1,line one%0Aline two%5Ctrail%2C %22quoted%22\n",
    );

    const result = importListFromCsv(
      db,
      "tasks",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,Task with%09tab%2C and %22quotes%22,pending,1,line one%0Aline three%5Ctrail%2C %22quoted%22,Task with%09tab%2C and %22quotes%22,pending,1,line one%0Aline two%5Ctrail%2C %22quoted%22\n",
    );

    expect(result.changed).toBe(1);
    expect(result.changes).toEqual([{ id: "task-1", fields: ["notes"] }]);

    const row = db.query("SELECT subject, description FROM tasks WHERE id = ?").get("task-1") as {
      subject: string;
      description: string;
    };
    expect(row).toEqual({
      subject: "Task with\ttab, and \"quotes\"",
      description: "line one\nline three\\trail, \"quoted\"",
    });
  });

  it("imports legacy backslash-escaped cells after editors double backslashes", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "Legacy task", "line one\nline two", "pending", "a", now, now],
    );

    const result = importListFromCsv(
      db,
      "tasks",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,Legacy task,pending,1,line one\\\\nline two,Legacy task,pending,1,line one\\nline two\n",
    );

    expect(result.changed).toBe(0);
    expect(result.invalid).toEqual([]);
  });

  it("filters task CSV exports to pending or not-completed rows", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "Pending task", "pending note", "pending", "a", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-2", "Working task", "working note", "in_progress", "b", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-3", "Done task", "done note", "completed", "c", now, now],
    );

    expect(exportListToCsv(db, "tasks", "pending")).toBe(
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,Pending task,pending,1,pending note,Pending task,pending,1,pending note\n",
    );
    expect(exportListToCsv(db, "tasks", "not-completed")).toBe(
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,Pending task,pending,1,pending note,Pending task,pending,1,pending note\n" +
        "task-2,Working task,in_progress,2,working note,Working task,in_progress,2,working note\n",
    );
  });

  it("imports task name, status, and order updates", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "First task", "first note", "pending", "a", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-2", "Second task", "second note", "claimed", "b", now, now],
    );

    const result = importListFromCsv(
      db,
      "tasks",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-2,Updated second,in_progress,1,updated note,Second task,claimed,2,second note\n" +
        "task-1,First task,completed,2,first note,First task,pending,1,first note\n",
    );

    expect(result.changed).toBe(2);
    expect(result.invalid).toEqual([]);

    const rows = db.query(
      "SELECT id, subject, description, status, order_key FROM tasks ORDER BY order_key ASC",
    ).all() as Array<{ id: string; subject: string; description: string; status: string; order_key: string }>;
    expect(rows).toEqual([
      { id: "task-2", subject: "Updated second", description: "updated note", status: "in_progress", order_key: "a" },
      { id: "task-1", subject: "First task", description: "first note", status: "completed", order_key: "b" },
    ]);
  });

  it("imports bug title, status, and order updates", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO bugs (id, title, description, status, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["bug-1", "First bug", "first bug note", "open", 0, now, now],
    );
    db.run(
      "INSERT INTO bugs (id, title, description, status, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["bug-2", "Second bug", "second bug note", "fixing", 1, now, now],
    );

    const result = importListFromCsv(
      db,
      "bugs",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "bug-2,Renamed bug,resolved,1,renamed bug note,Second bug,fixing,2,second bug note\n" +
        "bug-1,First bug,investigating,2,first bug note,First bug,open,1,first bug note\n",
    );

    expect(result.changed).toBe(2);
    expect(result.invalid).toEqual([]);

    const rows = db.query(
      "SELECT id, title, description, status, sort_order FROM bugs ORDER BY sort_order ASC",
    ).all() as Array<{ id: string; title: string; description: string; status: string; sort_order: number }>;
    expect(rows).toEqual([
      { id: "bug-2", title: "Renamed bug", description: "renamed bug note", status: "resolved", sort_order: 0 },
      { id: "bug-1", title: "First bug", description: "first bug note", status: "investigating", sort_order: 1 },
    ]);
  });

  it("filters bug CSV exports to pending or not-completed rows", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO bugs (id, title, description, status, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["bug-1", "Open bug", "open note", "open", 0, now, now],
    );
    db.run(
      "INSERT INTO bugs (id, title, description, status, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["bug-2", "Fixing bug", "fixing note", "fixing", 1, now, now],
    );
    db.run(
      "INSERT INTO bugs (id, title, description, status, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["bug-3", "Closed bug", "closed note", "closed", 2, now, now],
    );

    expect(exportListToCsv(db, "bugs", "pending")).toBe(
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "bug-1,Open bug,open,1,open note,Open bug,open,1,open note\n",
    );
    expect(exportListToCsv(db, "bugs", "not-completed")).toBe(
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "bug-1,Open bug,open,1,open note,Open bug,open,1,open note\n" +
        "bug-2,Fixing bug,fixing,2,fixing note,Fixing bug,fixing,2,fixing note\n",
    );
  });

  it("does not rewrite task order when the imported order is unchanged", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "First task", "first note", "pending", "a", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-2", "Second task", "second note", "claimed", "c", now, now],
    );

    const result = importListFromCsv(
      db,
      "tasks",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,First task,pending,1,first note,First task,pending,1,first note\n" +
        "task-2,Second task,claimed,2,second note,Second task,claimed,2,second note\n",
    );

    expect(result.changed).toBe(0);

    const rows = db.query("SELECT id, order_key FROM tasks ORDER BY order_key ASC").all() as Array<{
      id: string;
      order_key: string;
    }>;
    expect(rows).toEqual([
      { id: "task-1", order_key: "a" },
      { id: "task-2", order_key: "c" },
    ]);
  });

  it("does not report order changes for filtered task imports when relative order is unchanged", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "Pending one", "note one", "pending", "a", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-2", "Done middle", "done note", "completed", "b", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-3", "Pending two", "note two", "pending", "c", now, now],
    );

    const result = importListFromCsv(
      db,
      "tasks",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,Pending one,pending,1,updated note one,Pending one,pending,1,note one\n" +
        "task-3,Pending two,pending,2,note two,Pending two,pending,2,note two\n",
    );

    expect(result.changed).toBe(1);
    expect(result.changes).toEqual([{ id: "task-1", fields: ["notes"] }]);

    const rows = db.query(
      "SELECT id, order_key, description FROM tasks ORDER BY order_key ASC",
    ).all() as Array<{ id: string; order_key: string; description: string }>;
    expect(rows).toEqual([
      { id: "task-1", order_key: "a", description: "updated note one" },
      { id: "task-2", order_key: "b", description: "done note" },
      { id: "task-3", order_key: "c", description: "note two" },
    ]);
  });

  it("does not report order changes for filtered bug imports when relative order is unchanged", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO bugs (id, title, description, status, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["bug-1", "Open one", "note one", "open", 0, now, now],
    );
    db.run(
      "INSERT INTO bugs (id, title, description, status, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["bug-2", "Closed middle", "closed note", "closed", 1, now, now],
    );
    db.run(
      "INSERT INTO bugs (id, title, description, status, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["bug-3", "Open two", "note two", "open", 2, now, now],
    );

    const result = importListFromCsv(
      db,
      "bugs",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "bug-1,Open one,open,1,updated note one,Open one,open,1,note one\n" +
        "bug-3,Open two,open,2,note two,Open two,open,2,note two\n",
    );

    expect(result.changed).toBe(1);
    expect(result.changes).toEqual([{ id: "bug-1", fields: ["notes"] }]);

    const rows = db.query(
      "SELECT id, sort_order, description FROM bugs ORDER BY sort_order ASC",
    ).all() as Array<{ id: string; sort_order: number; description: string }>;
    expect(rows).toEqual([
      { id: "bug-1", sort_order: 0, description: "updated note one" },
      { id: "bug-2", sort_order: 1, description: "closed note" },
      { id: "bug-3", sort_order: 2, description: "note two" },
    ]);
  });

  it("does not overwrite status when the csv value was not edited but the task changed after export", () => {
    const exportedAt = new Date().toISOString();
    const currentAt = new Date(Date.now() + 1000).toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "Pending task", "old note", "completed", "a", exportedAt, currentAt],
    );

    const result = importListFromCsv(
      db,
      "tasks",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,Pending task,pending,1,new note,Pending task,pending,1,old note\n",
    );

    expect(result.changed).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(result.changes).toEqual([{ id: "task-1", fields: ["notes"] }]);

    const row = db.query("SELECT description, status FROM tasks WHERE id = ?").get("task-1") as {
      description: string;
      status: string;
    };
    expect(row).toEqual({ description: "new note", status: "completed" });
  });

  it("reports a conflict when the same field changed after export and in the csv", () => {
    const exportedAt = new Date().toISOString();
    const currentAt = new Date(Date.now() + 1000).toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "Task", "fresh note", "completed", "a", exportedAt, currentAt],
    );

    const result = importListFromCsv(
      db,
      "tasks",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,Task,pending,1,edited stale note,Task,pending,1,stale note\n",
    );

    expect(result.changed).toBe(0);
    expect(result.conflicts).toEqual(["task-1: notes changed since export"]);
  });

  it("reports invalid CSV rows without applying changes", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "First task", "first note", "pending", "a", now, now],
    );

    const result = importListFromCsv(
      db,
      "tasks",
      "id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes\n" +
        "task-1,First task,not-a-status,1,first note,First task,pending,1,first note\n",
    );

    expect(result.changed).toBe(0);
    expect(result.invalid).toEqual(["Line 2: invalid status 'not-a-status'"]);

    const row = db.query("SELECT subject, description, status FROM tasks WHERE id = ?").get("task-1") as {
      subject: string;
      description: string;
      status: string;
    };
    expect(row).toEqual({ subject: "First task", description: "first note", status: "pending" });
  });
});
