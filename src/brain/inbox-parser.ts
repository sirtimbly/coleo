/**
 * Inbox Parser
 * 
 * Parses .project/inbox.md to extract tasks, then clears the inbox.
 * Items are deduplicated against existing tasks before creation.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

export interface InboxItem {
  id: string;
  subject: string;
  description: string;
  priority: "critical" | "high" | "normal" | "low";
  lineStart: number;
  lineEnd: number;
}

export interface InboxParseResult {
  items: InboxItem[];
  wasEmpty: boolean;
  errors: string[];
}

const INBOX_HEADER = `# Inbox

Tasks and requests for the brain to process. Items here are automatically converted to tasks and removed.

**Goal: This file should always be empty after the brain processes it.**

---

<!-- 
Add items below this line. Format:

## Task Title
Optional description with details.

Or simple format:
- [ ] Single line task

Items are deduplicated against existing tasks in the database and plan.md.
After processing, items are removed from this file.
-->

`;

/**
 * Parse inbox.md and extract items
 */
export async function parseInbox(projectRoot: string): Promise<InboxParseResult> {
  const inboxPath = join(projectRoot, ".project", "inbox.md");
  const errors: string[] = [];
  const items: InboxItem[] = [];

  try {
    const content = await readFile(inboxPath, "utf-8");
    const lines = content.split("\n");

    // Find content after the separator
    let contentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.trim() === "-->") {
        contentStart = i + 1;
        break;
      }
    }

    // Check if there's any content after header
    const contentLines = lines.slice(contentStart);
    const hasContent = contentLines.some(line => line.trim() && !line.startsWith("<!--"));

    if (!hasContent) {
      return { items: [], wasEmpty: true, errors: [] };
    }

    // Parse items
    let currentItem: Partial<InboxItem> | null = null;
    let descriptionLines: string[] = [];
    let itemLineStart = 0;

    for (let i = contentStart; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineNumber = i + 1;

      // Check for ## headers (task titles)
      const headerMatch = line.match(/^##\s+(.+)/);
      if (headerMatch) {
        // Save previous item if exists
        if (currentItem?.subject) {
          items.push(finalizeItem(currentItem, descriptionLines, itemLineStart, i));
        }

        currentItem = {
          subject: headerMatch[1]?.trim() ?? "",
          priority: detectPriority(headerMatch[1] ?? ""),
        };
        descriptionLines = [];
        itemLineStart = lineNumber;
        continue;
      }

      // Check for checkbox items
      const checkboxMatch = line.match(/^-\s+\[\s*\]\s+(.+)/);
      if (checkboxMatch) {
        // Save previous item if exists
        if (currentItem?.subject) {
          items.push(finalizeItem(currentItem, descriptionLines, itemLineStart, i));
        }

        const taskText = checkboxMatch[1]?.trim() ?? "";
        items.push({
          id: generateItemId(taskText),
          subject: taskText,
          description: "",
          priority: detectPriority(taskText),
          lineStart: lineNumber,
          lineEnd: lineNumber,
        });

        currentItem = null;
        descriptionLines = [];
        continue;
      }

      // Accumulate description for current header item
      if (currentItem && line.trim()) {
        descriptionLines.push(line);
      }
    }

    // Save last item
    if (currentItem?.subject) {
      items.push(finalizeItem(currentItem, descriptionLines, itemLineStart, lines.length));
    }

    return { items, wasEmpty: false, errors };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Inbox doesn't exist, that's fine
      return { items: [], wasEmpty: true, errors: [] };
    }
    errors.push(`Failed to read inbox: ${err}`);
    return { items: [], wasEmpty: true, errors };
  }
}

/**
 * Clear the inbox after processing
 */
export async function clearInbox(projectRoot: string): Promise<void> {
  const inboxPath = join(projectRoot, ".project", "inbox.md");
  await writeFile(inboxPath, INBOX_HEADER, "utf-8");
}

/**
 * Deduplicate inbox items against existing tasks
 */
export function deduplicateItems(
  items: InboxItem[],
  existingTasks: Array<{ subject: string; description: string }>
): InboxItem[] {
  return items.filter(item => {
    const normalizedSubject = normalizeText(item.subject);
    
    // Check if any existing task has similar subject
    return !existingTasks.some(task => {
      const taskSubject = normalizeText(task.subject);
      return (
        taskSubject === normalizedSubject ||
        taskSubject.includes(normalizedSubject) ||
        normalizedSubject.includes(taskSubject)
      );
    });
  });
}

function finalizeItem(
  partial: Partial<InboxItem>,
  descriptionLines: string[],
  lineStart: number,
  lineEnd: number
): InboxItem {
  const subject = partial.subject ?? "";
  return {
    id: generateItemId(subject),
    subject,
    description: descriptionLines.join("\n").trim(),
    priority: partial.priority ?? "normal",
    lineStart,
    lineEnd,
  };
}

function generateItemId(content: string): string {
  const hash = createHash("md5")
    .update(content.slice(0, 50))
    .digest("hex")
    .slice(0, 8);
  return `inbox-${hash}`;
}

function detectPriority(text: string): InboxItem["priority"] {
  const lower = text.toLowerCase();
  if (/\b(critical|urgent|blocker)\b/.test(lower)) return "critical";
  if (/\b(high|important|asap)\b/.test(lower)) return "high";
  if (/\b(low|nice.?to.?have|someday)\b/.test(lower)) return "low";
  return "normal";
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}
