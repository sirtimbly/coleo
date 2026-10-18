import type { TaskAttachment } from "../types";

export function formatTaskAttachmentList(
  attachments: TaskAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  const lines = attachments.map((attachment, index) => {
    const label = attachment.filename || `image-${index + 1}`;
    return `- ${label} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)\n  URL: ${attachment.contentUrl}\n  Markdown: ![${label}](${attachment.contentUrl})`;
  });

  return `## ATTACHED IMAGES\n${lines.join("\n")}`;
}

export function appendTaskAttachmentsToPromptText(
  text: string,
  attachments: TaskAttachment[] | undefined,
): string {
  const attachmentSection = formatTaskAttachmentList(attachments);
  if (!attachmentSection) {
    return text;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return attachmentSection;
  }

  return `${trimmed}\n\n${attachmentSection}`;
}
