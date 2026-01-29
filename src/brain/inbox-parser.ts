/**
 * Inbox Parser
 *
 * Parses .project/inbox.md to extract tasks, then clears the inbox.
 * Items are deduplicated against existing tasks before creation.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

/** Configuration for deduplication similarity threshold (0.0 - 1.0) */
export const DEDUPLICATION_CONFIG = {
  /** Cosine similarity threshold above which items are considered duplicates */
  SIMILARITY_THRESHOLD: 0.85,
  /** Minimum word count for description to use similarity (below this uses exact match) */
  MIN_WORDS_FOR_SIMILARITY: 5,
} as const;

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
 * Uses cosine similarity to compare both subject and description
 */
export function deduplicateItems(
  items: InboxItem[],
  existingTasks: Array<{ subject: string; description: string }>,
  options?: {
    /** Similarity threshold (0.0 - 1.0). Higher = stricter matching. Default: 0.85 */
    similarityThreshold?: number;
  }
): InboxItem[] {
  const threshold = options?.similarityThreshold ?? DEDUPLICATION_CONFIG.SIMILARITY_THRESHOLD;

  return items.filter(item => {
    // Check if any existing task is similar
    return !existingTasks.some(task => {
      // Combine subject and description for comparison
      const itemText = `${item.subject} ${item.description}`.trim();
      const taskText = `${task.subject} ${task.description}`.trim();

      // Check subject similarity first (fast path)
      const subjectSimilar = isSimilarText(item.subject, task.subject, threshold);
      if (subjectSimilar) {
        return true;
      }

      // Check full text similarity (subject + description)
      const fullTextSimilar = isSimilarText(itemText, taskText, threshold);
      if (fullTextSimilar) {
        return true;
      }

      // Check if descriptions are similar (even if subjects differ)
      if (item.description && task.description) {
        const descriptionSimilar = isSimilarText(item.description, task.description, threshold);
        if (descriptionSimilar) {
          return true;
        }
      }

      return false;
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

/**
 * Tokenize text into words for vectorization
 */
function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter(word => word.length > 2); // Filter out very short words
}

/**
 * Create a word frequency vector from text
 * Returns a Map of word -> frequency
 */
function createWordVector(text: string): Map<string, number> {
  const words = tokenize(text);
  const vector = new Map<string, number>();

  for (const word of words) {
    vector.set(word, (vector.get(word) ?? 0) + 1);
  }

  return vector;
}

/**
 * Calculate cosine similarity between two text strings
 * Returns a value between 0 (completely different) and 1 (identical)
 */
function cosineSimilarity(text1: string, text2: string): number {
  const vec1 = createWordVector(text1);
  const vec2 = createWordVector(text2);

  // If either vector is empty, return 0 similarity
  if (vec1.size === 0 || vec2.size === 0) {
    return 0;
  }

  // Get all unique words from both vectors
  const allWords = new Set<string>();
  vec1.forEach((_, word) => allWords.add(word));
  vec2.forEach((_, word) => allWords.add(word));

  // Calculate dot product and magnitudes
  let dotProduct = 0;
  let magnitude1 = 0;
  let magnitude2 = 0;

  allWords.forEach(word => {
    const val1 = vec1.get(word) ?? 0;
    const val2 = vec2.get(word) ?? 0;

    dotProduct += val1 * val2;
  });

  // Calculate magnitudes
  vec1.forEach(val => {
    magnitude1 += val * val;
  });
  vec2.forEach(val => {
    magnitude2 += val * val;
  });

  magnitude1 = Math.sqrt(magnitude1);
  magnitude2 = Math.sqrt(magnitude2);

  // Handle zero magnitudes
  if (magnitude1 === 0 || magnitude2 === 0) {
    return 0;
  }

  return dotProduct / (magnitude1 * magnitude2);
}

/**
 * Check if two texts are similar using cosine similarity
 * For short texts, falls back to exact/substring matching
 */
function isSimilarText(text1: string, text2: string, threshold: number = DEDUPLICATION_CONFIG.SIMILARITY_THRESHOLD): boolean {
  const words1 = tokenize(text1);
  const words2 = tokenize(text2);

  // For short texts, use exact/substring matching
  if (words1.length < DEDUPLICATION_CONFIG.MIN_WORDS_FOR_SIMILARITY ||
      words2.length < DEDUPLICATION_CONFIG.MIN_WORDS_FOR_SIMILARITY) {
    const norm1 = normalizeText(text1);
    const norm2 = normalizeText(text2);
    return norm1 === norm2 || norm1.includes(norm2) || norm2.includes(norm1);
  }

  // For longer texts, use cosine similarity
  const similarity = cosineSimilarity(text1, text2);
  return similarity >= threshold;
}
