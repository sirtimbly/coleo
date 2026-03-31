/**
 * Mail types
 *
 * Type definitions for mail routes and message handling.
 */

import type { Database } from "bun:sqlite";

/**
 * Hono context type for mail routes with Database and coleoDir variables
 */
export interface MailContext {
  Variables: {
    db: Database;
    coleoDir: string;
  };
}

/**
 * Enhanced message metadata for downstream gateways
 */
export interface MessageMetadata {
  id: string;
  filename: string;
  folder: string;
  filePath: string;
  size: number;
  flags: {
    seen: boolean;
    replied: boolean;
    flagged: boolean;
    draft: boolean;
    trashed: boolean;
  };
  headers: {
    from: string;
    to: string;
    subject: string;
    date: string;
    messageId?: string;
  };
  uidl?: string; // Unique ID for POP3/IMAP
  modifiedAt: Date;
}

/**
 * Maildir folder information for gateways
 */
export interface FolderInfo {
  name: string;
  path: string;
  type: 'mailbox' | 'folder';
  messageCount: number;
  unreadCount: number;
  size: number;
  lastModified: Date;
}
