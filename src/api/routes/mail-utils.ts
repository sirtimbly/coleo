/**
 * Mail utilities
 *
 * Helper functions for mail message handling and metadata extraction.
 */

import { basename } from "path";
import { stat } from "fs/promises";
import { Maildir } from "../../mail/maildir";
import type { MessageMetadata } from "./mail-types";

/**
 * Get detailed message metadata for a maildir subfolder
 * Optimized for IMAP/POP3 gateways
 */
export async function getDetailedMessages(
  maildir: Maildir,
  subfolder: "new" | "cur"
): Promise<MessageMetadata[]> {
  const messages = await maildir.list(subfolder);
  const detailed: MessageMetadata[] = [];

  for (const message of messages) {
    if (!message.filePath) continue;

    try {
      const fileStat = await stat(message.filePath);
      const filename = basename(message.filePath);

      detailed.push({
        id: message.id,
        filename,
        folder: subfolder,
        filePath: message.filePath,
        size: fileStat.size,
        flags: message.flags,
        headers: {
          from: message.from,
          to: message.to,
          subject: message.subject,
          date: message.date.toISOString(),
          messageId: message.headers["message-id"],
        },
        uidl: `${message.id}.${fileStat.mtime.getTime()}`, // Unique ID for POP3
        modifiedAt: fileStat.mtime,
      });
    } catch (err) {
      console.warn(`Failed to get metadata for message ${message.id}:`, err);
    }
  }

  return detailed;
}
