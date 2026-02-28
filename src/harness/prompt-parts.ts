import type { TaskAttachment } from "../types";

export type HarnessPromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename: string; url: string };

export function buildHarnessPromptParts(
  prompt: string,
  attachments: TaskAttachment[] | undefined,
): HarnessPromptPart[] {
  const parts: HarnessPromptPart[] = [{ type: "text", text: prompt }];

  for (const attachment of attachments || []) {
    if (attachment.kind !== "image") {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.filename,
      url: attachment.contentUrl,
    });
  }

  return parts;
}
