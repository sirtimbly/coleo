import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseEditorCommand } from "./helpers/editor";
import { generateKeyBetween } from "../lib/fractional-indexing";

export type CsvListKind = "tasks" | "bugs";
export type CsvListFilter = "all" | "pending" | "not-completed";

type TaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "completing"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

type BugStatus =
  | "open"
  | "investigating"
  | "fixing"
  | "verifying"
  | "resolved"
  | "closed";

interface CsvRow {
  id: string;
  name: string;
  status: string;
  order: number;
  notes: string;
  originalName: string;
  originalStatus: string;
  originalOrder: number;
  originalNotes: string;
}

function matchesFilter(kind: CsvListKind, status: string, filter: CsvListFilter): boolean {
  if (filter === "all") {
    return true;
  }

  if (kind === "tasks") {
    if (filter === "pending") {
      return status === "pending";
    }
    return status !== "completed";
  }

  if (filter === "pending") {
    return status === "open";
  }
  return status !== "resolved" && status !== "closed";
}

interface ParsedCsvRow extends CsvRow {
  line: number;
  fileIndex: number;
}

interface ImportChange {
  id: string;
  fields: Array<"name" | "status" | "order" | "notes">;
}

export interface CsvImportResult {
  totalRows: number;
  changed: number;
  unchanged: number;
  missing: string[];
  invalid: string[];
  conflicts: string[];
  changes: ImportChange[];
}

const TASK_STATUSES = new Set<TaskStatus>([
  "pending",
  "claimed",
  "in_progress",
  "completing",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);

const BUG_STATUSES = new Set<BugStatus>([
  "open",
  "investigating",
  "fixing",
  "verifying",
  "resolved",
  "closed",
]);

function escapeCsvCell(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function encodeTextCell(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\\/g, "%5C")
    .replace(/,/g, "%2C")
    .replace(/"/g, "%22")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D")
    .replace(/\t/g, "%09");
}

function decodePercentEncodedTextCell(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    if (!Number.isFinite(code)) {
      return match;
    }
    return String.fromCharCode(code);
  });
}

function decodeLegacyBackslashTextCell(value: string): string {
  let normalized = value;
  while (/\\\\(?=[cnqrt\\])/g.test(normalized)) {
    normalized = normalized.replace(/\\\\(?=[cnqrt\\])/g, "\\");
  }

  return normalized.replace(/\\(.)/g, (_match, char: string) => {
    if (char === "c") {
      return ",";
    }
    if (char === "q") {
      return '"';
    }
    if (char === "n") {
      return "\n";
    }
    if (char === "r") {
      return "\r";
    }
    if (char === "t") {
      return "\t";
    }
    if (char === "\\") {
      return "\\";
    }
    return `\\${char}`;
  });
}

function decodeTextCell(value: string): string {
  if (/%[0-9A-Fa-f]{2}/.test(value)) {
    return decodePercentEncodedTextCell(value);
  }
  if (/\\[cnqrt\\]/.test(value)) {
    return decodeLegacyBackslashTextCell(value);
  }
  return value;
}

function serializeCsv(rows: CsvRow[]): string {
  const lines = ["id,name,status,order,notes,_original_name,_original_status,_original_order,_original_notes"];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        encodeTextCell(row.name),
        row.status,
        String(row.order),
        encodeTextCell(row.notes),
        encodeTextCell(row.originalName),
        row.originalStatus,
        String(row.originalOrder),
        encodeTextCell(row.originalNotes),
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }

    if (char === "\r") {
      i++;
      continue;
    }

    cell += char;
    i++;
  }

  if (inQuotes) {
    throw new Error("CSV ended inside a quoted field");
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function getStatusSet(kind: CsvListKind): Set<string> {
  return kind === "tasks" ? TASK_STATUSES : BUG_STATUSES;
}

function parseCsvRows(kind: CsvListKind, text: string): { rows: ParsedCsvRow[]; invalid: string[] } {
  const matrix = parseCsv(text);
  if (matrix.length === 0) {
    return { rows: [], invalid: ["CSV file is empty"] };
  }

  const [header, ...dataRows] = matrix;
  const expectedHeader = [
    "id",
    "name",
    "status",
    "order",
    "notes",
    "_original_name",
    "_original_status",
    "_original_order",
    "_original_notes",
  ];
  if (!header || header.length !== expectedHeader.length || header.some((value, index) => value.trim() !== expectedHeader[index])) {
    return {
      rows: [],
      invalid: [`Expected CSV header: ${expectedHeader.join(",")}`],
    };
  }

  const invalid: string[] = [];
  const rows: ParsedCsvRow[] = [];
  const validStatuses = getStatusSet(kind);

  dataRows.forEach((rawRow, index) => {
    const line = index + 2;
    if (rawRow.every((value) => value.trim() === "")) {
      return;
    }
    if (rawRow.length !== expectedHeader.length) {
      invalid.push(`Line ${line}: expected ${expectedHeader.length} columns, found ${rawRow.length}`);
      return;
    }

    const id = rawRow[0]?.trim() ?? "";
    const name = decodeTextCell(rawRow[1] ?? "").trim();
    const status = rawRow[2]?.trim() ?? "";
    const orderText = rawRow[3]?.trim() ?? "";
    const notes = decodeTextCell(rawRow[4] ?? "");
    const originalName = decodeTextCell(rawRow[5] ?? "").trim();
    const originalStatus = rawRow[6]?.trim() ?? "";
    const originalOrderText = rawRow[7]?.trim() ?? "";
    const originalNotes = decodeTextCell(rawRow[8] ?? "");
    if (!id) {
      invalid.push(`Line ${line}: id is required`);
      return;
    }
    if (!name) {
      invalid.push(`Line ${line}: name is required`);
      return;
    }
    if (!validStatuses.has(status)) {
      invalid.push(`Line ${line}: invalid status '${status}'`);
      return;
    }

    const order = Number.parseInt(orderText, 10);
    if (!Number.isFinite(order) || order < 1) {
      invalid.push(`Line ${line}: order must be an integer >= 1`);
      return;
    }

    const originalOrder = Number.parseInt(originalOrderText, 10);
    if (!Number.isFinite(originalOrder) || originalOrder < 1) {
      invalid.push(`Line ${line}: _original_order must be an integer >= 1`);
      return;
    }

    if (!validStatuses.has(originalStatus)) {
      invalid.push(`Line ${line}: invalid _original_status '${originalStatus}'`);
      return;
    }

    rows.push({
      id,
      name,
      status,
      order,
      notes,
      originalName,
      originalStatus,
      originalOrder,
      originalNotes,
      line,
      fileIndex: index,
    });
  });

  return { rows, invalid };
}

function getPreferredEditor(): string {
  return (
    process.env.COLEO_CSV_EDITOR?.trim() ||
    process.env.COLEO_EDITOR?.trim() ||
    process.env.EDITOR?.trim() ||
    "vi"
  );
}

function loadTaskRows(db: Database, filter: CsvListFilter): CsvRow[] {
  const rows = db.query(
    `SELECT id, subject, description, status
     FROM tasks
     ORDER BY order_key ASC, created_at DESC`,
  ).all() as Array<{ id: string; subject: string; description: string; status: string }>;

  return rows
    .filter((row) => matchesFilter("tasks", row.status, filter))
    .map((row, index) => ({
    id: row.id,
    name: row.subject,
    status: row.status,
    order: index + 1,
    notes: row.description,
    originalName: row.subject,
    originalStatus: row.status,
    originalOrder: index + 1,
    originalNotes: row.description,
    }));
}

function getOrderedTaskIds(db: Database): string[] {
  const rows = db.query(
    `SELECT id
     FROM tasks
     ORDER BY order_key ASC, created_at DESC`,
  ).all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function getOrderedBugIds(db: Database): string[] {
  const rows = db.query(
    `SELECT id
     FROM bugs
     WHERE archived = 0
     ORDER BY sort_order ASC, created_at DESC`,
  ).all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function loadBugRows(db: Database, filter: CsvListFilter): CsvRow[] {
  const rows = db.query(
    `SELECT id, title, description, status
     FROM bugs
     WHERE archived = 0
     ORDER BY sort_order ASC, created_at DESC`,
  ).all() as Array<{ id: string; title: string; description: string; status: string }>;

  return rows
    .filter((row) => matchesFilter("bugs", row.status, filter))
    .map((row, index) => ({
    id: row.id,
    name: row.title,
    status: row.status,
    order: index + 1,
    notes: row.description,
    originalName: row.title,
    originalStatus: row.status,
    originalOrder: index + 1,
    originalNotes: row.description,
    }));
}

export function exportListToCsv(db: Database, kind: CsvListKind, filter: CsvListFilter = "all"): string {
  const rows = kind === "tasks" ? loadTaskRows(db, filter) : loadBugRows(db, filter);
  return serializeCsv(rows);
}

function importTasksFromRows(db: Database, rows: ParsedCsvRow[]): CsvImportResult {
  const existingRows = db.query(
    `SELECT id, subject, description, status, order_key
     FROM tasks`,
  ).all() as Array<{ id: string; subject: string; description: string; status: string; order_key: string | null }>;
  const existing = new Map(existingRows.map((row) => [row.id, row]));
  const missing: string[] = [];
  const conflicts: string[] = [];
  const changes: ImportChange[] = [];
  let changed = 0;
  let unchanged = 0;

  const orderedRows = [...rows].sort((left, right) => left.order - right.order || left.fileIndex - right.fileIndex);
  const importedIdSet = new Set(orderedRows.map((row) => row.id));
  const originalOrderedIds = [...orderedRows]
    .sort((left, right) => left.originalOrder - right.originalOrder || left.fileIndex - right.fileIndex)
    .map((row) => row.id);
  const importedOrderedIds = orderedRows.map((row) => row.id);
  const orderEdited =
    originalOrderedIds.length !== importedOrderedIds.length ||
    originalOrderedIds.some((id, index) => id !== importedOrderedIds[index]);
  let previousOrderKey: string | null = null;
  const nextOrderKeyById = new Map<string, string>();
  if (orderEdited) {
    for (const row of orderedRows) {
      const nextOrderKey = generateKeyBetween(previousOrderKey, null);
      nextOrderKeyById.set(row.id, nextOrderKey);
      previousOrderKey = nextOrderKey;
    }
  } else {
    for (const row of orderedRows) {
      const current = existing.get(row.id);
      if (current?.order_key) {
        nextOrderKeyById.set(row.id, current.order_key);
      }
    }
  }

  db.transaction(() => {
    for (const row of rows) {
      const current = existing.get(row.id);
      if (!current) {
        missing.push(row.id);
        continue;
      }

      const fieldChanges: Array<"name" | "status" | "order" | "notes"> = [];
      const nextOrderKey = nextOrderKeyById.get(row.id) ?? current.order_key ?? "a";
      const now = new Date().toISOString();
      const nameEdited = row.name !== row.originalName;
      const statusEdited = row.status !== row.originalStatus;
      const notesEdited = row.notes !== row.originalNotes;
      if (nameEdited && current.subject !== row.originalName) {
        conflicts.push(`${row.id}: name changed since export`);
        continue;
      }
      if (statusEdited && current.status !== row.originalStatus) {
        conflicts.push(`${row.id}: status changed since export`);
        continue;
      }
      if (notesEdited && current.description !== row.originalNotes) {
        conflicts.push(`${row.id}: notes changed since export`);
        continue;
      }

      if (nameEdited) {
        fieldChanges.push("name");
      }
      if (notesEdited) {
        fieldChanges.push("notes");
      }
      if (statusEdited) {
        fieldChanges.push("status");
      }
      if (orderEdited) {
        fieldChanges.push("order");
      }

      if (fieldChanges.length === 0) {
        unchanged++;
        continue;
      }

      const updates = ["updated_at = ?"];
      const params: Array<string | null> = [now];
      if (nameEdited) {
        updates.unshift("subject = ?");
        params.unshift(row.name);
      }
      if (notesEdited) {
        updates.splice(nameEdited ? 1 : 0, 0, "description = ?");
        params.splice(nameEdited ? 1 : 0, 0, row.notes);
      }
      if (statusEdited) {
        const statusInsertIndex = updates.length - 1;
        updates.splice(statusInsertIndex, 0, "status = ?");
        params.splice(statusInsertIndex, 0, row.status);
      }
      if (orderEdited) {
        updates.push("order_key = ?");
        params.push(nextOrderKey);
      }
      if (statusEdited) {
        if (row.status === "claimed") {
          updates.push("claimed_at = ?", "completed_at = NULL");
          params.push(now);
        } else if (row.status === "in_progress" || row.status === "completing") {
          updates.push("claimed_at = COALESCE(claimed_at, ?)", "started_at = ?", "completed_at = NULL");
          params.push(now, now);
        } else if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
          updates.push("completed_at = ?");
          params.push(now);
        } else if (row.status === "pending" || row.status === "blocked") {
          updates.push("completed_at = NULL");
        }
      }
      params.push(row.id);
      db.run(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`, params);
      changed++;
      changes.push({ id: row.id, fields: fieldChanges });
    }
  })();

  return {
    totalRows: rows.length,
    changed,
    unchanged,
    missing,
    invalid: [],
    conflicts,
    changes,
  };
}

function importBugsFromRows(db: Database, rows: ParsedCsvRow[]): CsvImportResult {
  const existingRows = db.query(
    `SELECT id, title, description, status, sort_order
     FROM bugs
     WHERE archived = 0`,
  ).all() as Array<{ id: string; title: string; description: string; status: string; sort_order: number | null }>;
  const existing = new Map(existingRows.map((row) => [row.id, row]));
  const missing: string[] = [];
  const conflicts: string[] = [];
  const changes: ImportChange[] = [];
  let changed = 0;
  let unchanged = 0;

  const orderedRows = [...rows].sort((left, right) => left.order - right.order || left.fileIndex - right.fileIndex);
  const importedIdSet = new Set(orderedRows.map((row) => row.id));
  const originalOrderedIds = [...orderedRows]
    .sort((left, right) => left.originalOrder - right.originalOrder || left.fileIndex - right.fileIndex)
    .map((row) => row.id);
  const importedOrderedIds = orderedRows.map((row) => row.id);
  const orderEdited =
    originalOrderedIds.length !== importedOrderedIds.length ||
    originalOrderedIds.some((id, index) => id !== importedOrderedIds[index]);
  const nextSortOrderById = new Map<string, number>();
  if (orderEdited) {
    orderedRows.forEach((row, index) => {
      nextSortOrderById.set(row.id, index);
    });
  } else {
    orderedRows.forEach((row) => {
      const current = existing.get(row.id);
      if (current?.sort_order !== null && current?.sort_order !== undefined) {
        nextSortOrderById.set(row.id, current.sort_order);
      }
    });
  }

  db.transaction(() => {
    for (const row of rows) {
      const current = existing.get(row.id);
      if (!current) {
        missing.push(row.id);
        continue;
      }

      const fieldChanges: Array<"name" | "status" | "order" | "notes"> = [];
      const nextSortOrder = nextSortOrderById.get(row.id) ?? current.sort_order ?? 0;
      const now = new Date().toISOString();
      const nameEdited = row.name !== row.originalName;
      const statusEdited = row.status !== row.originalStatus;
      const notesEdited = row.notes !== row.originalNotes;
      if (nameEdited && current.title !== row.originalName) {
        conflicts.push(`${row.id}: name changed since export`);
        continue;
      }
      if (statusEdited && current.status !== row.originalStatus) {
        conflicts.push(`${row.id}: status changed since export`);
        continue;
      }
      if (notesEdited && current.description !== row.originalNotes) {
        conflicts.push(`${row.id}: notes changed since export`);
        continue;
      }

      if (nameEdited) {
        fieldChanges.push("name");
      }
      if (notesEdited) {
        fieldChanges.push("notes");
      }
      if (statusEdited) {
        fieldChanges.push("status");
      }
      if (orderEdited) {
        fieldChanges.push("order");
      }

      if (fieldChanges.length === 0) {
        unchanged++;
        continue;
      }

      const updates = ["updated_at = ?"];
      const params: Array<string | number> = [now];
      if (nameEdited) {
        updates.unshift("title = ?");
        params.unshift(row.name);
      }
      if (notesEdited) {
        updates.splice(nameEdited ? 1 : 0, 0, "description = ?");
        params.splice(nameEdited ? 1 : 0, 0, row.notes);
      }
      if (statusEdited) {
        const statusInsertIndex = updates.length - 1;
        updates.splice(statusInsertIndex, 0, "status = ?");
        params.splice(statusInsertIndex, 0, row.status);
      }
      if (orderEdited) {
        updates.splice(updates.length - 1, 0, "sort_order = ?");
        params.splice(params.length - 1, 0, nextSortOrder);
      }
      if (statusEdited) {
        if (row.status === "resolved" || row.status === "closed") {
          updates.push("resolved_at = ?");
          params.push(now);
        } else {
          updates.push("resolved_at = NULL");
        }
      }
      params.push(row.id);
      db.run(`UPDATE bugs SET ${updates.join(", ")} WHERE id = ?`, params);
      changed++;
      changes.push({ id: row.id, fields: fieldChanges });
    }
  })();

  return {
    totalRows: rows.length,
    changed,
    unchanged,
    missing,
    invalid: [],
    conflicts,
    changes,
  };
}

export function importListFromCsv(db: Database, kind: CsvListKind, text: string): CsvImportResult {
  const parsed = parseCsvRows(kind, text);
  if (parsed.invalid.length > 0) {
    return {
      totalRows: parsed.rows.length,
      changed: 0,
      unchanged: 0,
      missing: [],
      invalid: parsed.invalid,
      conflicts: [],
      changes: [],
    };
  }

  return kind === "tasks"
    ? importTasksFromRows(db, parsed.rows)
    : importBugsFromRows(db, parsed.rows);
}

export function printImportResult(kind: CsvListKind, result: CsvImportResult): void {
  const label = kind === "tasks" ? "task" : "bug";
  console.log(`Imported ${result.totalRows} ${label} row(s)`);
  console.log(`  Changed: ${result.changed}`);
  console.log(`  Unchanged: ${result.unchanged}`);

  if (result.changes.length > 0) {
    console.log("  Updated rows:");
    for (const change of result.changes) {
      console.log(`    - ${change.id}: ${change.fields.join(", ")}`);
    }
  }

  if (result.missing.length > 0) {
    console.log("  Missing IDs:");
    for (const id of result.missing) {
      console.log(`    - ${id}`);
    }
  }

  if (result.invalid.length > 0) {
    console.log("  Invalid rows:");
    for (const error of result.invalid) {
      console.log(`    - ${error}`);
    }
  }

  if (result.conflicts.length > 0) {
    console.log("  Conflicts:");
    for (const conflict of result.conflicts) {
      console.log(`    - ${conflict}`);
    }
  }
}

function openDatabase(dbPath: string, readonly: boolean): Database {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }
  return new Database(dbPath, readonly ? { readonly: true } : { readwrite: true });
}

export async function exportListCsvToPath(
  dbPath: string,
  kind: CsvListKind,
  outputPath: string,
  filter: CsvListFilter = "all",
): Promise<void> {
  const db = openDatabase(dbPath, true);
  try {
    await writeFile(outputPath, exportListToCsv(db, kind, filter), "utf-8");
  } finally {
    db.close();
  }
}

export async function importListCsvFromPath(dbPath: string, kind: CsvListKind, inputPath: string): Promise<CsvImportResult> {
  const csv = await readFile(inputPath, "utf-8");
  const db = openDatabase(dbPath, false);
  try {
    return importListFromCsv(db, kind, csv);
  } finally {
    db.close();
  }
}

export async function editListCsvInEditor(
  dbPath: string,
  kind: CsvListKind,
  filter: CsvListFilter = "all",
): Promise<CsvImportResult> {
  const directory = await mkdtemp(join(tmpdir(), `coleo-${kind}-`));
  const filePath = join(directory, `${kind}.csv`);
  try {
    await exportListCsvToPath(dbPath, kind, filePath, filter);

    const editor = getPreferredEditor();
    const command = parseEditorCommand(editor);
    const proc = Bun.spawn([...command, filePath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Editor exited with code ${exitCode}`);
    }

    return await importListCsvFromPath(dbPath, kind, filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
