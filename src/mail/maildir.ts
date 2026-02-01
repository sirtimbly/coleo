/**
 * Maildir implementation for Octopai
 * 
 * Follows the Maildir specification:
 * - new/  : New, unread messages
 * - cur/  : Read messages (moved from new/ by mail client)
 * - tmp/  : Temporary files during atomic write
 * 
 * Message filenames follow: <timestamp>.<unique>.<hostname>:2,<flags>
 */

import { mkdir, readdir, readFile, writeFile, rename, unlink } from "fs/promises";
import { join, basename } from "path";
import { randomBytes } from "crypto";
import { hostname } from "os";

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
  headers: Record<string, string>;
  flags: MailFlags;
  filePath?: string;
}

export interface MailFlags {
  seen: boolean;      // S - seen/read
  replied: boolean;   // R - replied to
  flagged: boolean;   // F - flagged/starred
  draft: boolean;     // D - draft
  trashed: boolean;   // T - trashed
}

const FLAG_MAP: Record<string, keyof MailFlags> = {
  S: "seen",
  R: "replied",
  F: "flagged",
  D: "draft",
  T: "trashed",
};

export class Maildir {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Initialize Maildir structure
   */
  async init(): Promise<void> {
    const dirs = ["new", "cur", "tmp"];
    for (const dir of dirs) {
      await mkdir(join(this.basePath, dir), { recursive: true });
    }
  }

  /**
   * Generate a unique message filename
   */
  private generateFilename(): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const unique = randomBytes(8).toString("hex");
    const host = hostname().replace(/[^a-zA-Z0-9]/g, "");
    return `${timestamp}.${unique}.${host}`;
  }

  /**
   * Write a new message to the mailbox
   */
  async write(message: Omit<MailMessage, "id" | "flags" | "filePath">): Promise<MailMessage> {
    const filename = this.generateFilename();
    const tmpPath = join(this.basePath, "tmp", filename);
    const newPath = join(this.basePath, "new", filename);

    // Format as RFC 5322 email
    const eml = this.formatMessage(message);

    // Atomic write: write to tmp/, then move to new/
    await writeFile(tmpPath, eml, "utf-8");
    await rename(tmpPath, newPath);

    return {
      id: filename,
      ...message,
      flags: {
        seen: false,
        replied: false,
        flagged: false,
        draft: false,
        trashed: false,
      },
      filePath: newPath,
    };
  }

  /**
   * Format message as RFC 5322 email
   */
  private formatMessage(message: Omit<MailMessage, "id" | "flags" | "filePath">): string {
    const lines: string[] = [];
    
    // Required headers
    lines.push(`From: ${message.from}`);
    lines.push(`To: ${message.to}`);
    lines.push(`Subject: ${message.subject}`);
    lines.push(`Date: ${message.date.toUTCString()}`);
    lines.push(`Message-ID: <${this.generateFilename()}@coleo.local>`);
    lines.push(`MIME-Version: 1.0`);
    lines.push(`Content-Type: text/plain; charset=utf-8`);
    
    // Custom headers
    if (message.headers) {
      for (const [key, value] of Object.entries(message.headers)) {
        lines.push(`${key}: ${value}`);
      }
    }
    
    // Empty line separates headers from body
    lines.push("");
    
    // Body
    lines.push(message.body);
    
    return lines.join("\r\n");
  }

  /**
   * Read all messages from a folder
   */
  async list(folder: "new" | "cur" | "sent" | "archive" = "new"): Promise<MailMessage[]> {
    const folderPath = join(this.basePath, folder);
    
    try {
      const files = await readdir(folderPath);
      const messages: MailMessage[] = [];
      
      for (const file of files) {
        if (file.startsWith(".")) continue; // Skip hidden files
        
        try {
          const filePath = join(folderPath, file);
          
          // For archive folder, check if it's a subdirectory (e.g., 2026-01)
          if (folder === "archive") {
            const { stat } = await import("fs/promises");
            const stats = await stat(filePath);
            
            if (stats.isDirectory()) {
              // Read all messages from this archive subdirectory
              const subFiles = await readdir(filePath);
              for (const subFile of subFiles) {
                if (subFile.startsWith(".")) continue;
                try {
                  const message = await this.read(join(filePath, subFile));
                  messages.push(message);
                } catch (err) {
                  console.error(`Failed to read archived message ${subFile}:`, err);
                }
              }
              continue;
            }
          }
          
          // Regular file - read it
          const message = await this.read(filePath);
          messages.push(message);
        } catch (err) {
          console.error(`Failed to read message ${file}:`, err);
        }
      }
      
      // Sort by date, newest first
      messages.sort((a, b) => b.date.getTime() - a.date.getTime());
      
      return messages;
    } catch {
      // Folder doesn't exist yet
      return [];
    }
  }

  /**
   * Read a single message from a file path
   */
  async read(filePath: string): Promise<MailMessage> {
    const content = await readFile(filePath, "utf-8");
    return this.parseMessage(content, filePath);
  }

  /**
   * Parse RFC 5322 email content
   */
  private parseMessage(content: string, filePath: string): MailMessage {
    const filename = basename(filePath);
    const lines = content.split(/\r?\n/);
    
    // Parse headers
    const headers: Record<string, string> = {};
    let i = 0;
    let currentHeader = "";
    let currentValue = "";
    
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) break;
      
      // Empty line marks end of headers
      if (line === "") {
        if (currentHeader) {
          headers[currentHeader.toLowerCase()] = currentValue.trim();
        }
        i++;
        break;
      }
      
      // Continuation line (starts with whitespace)
      if (line.startsWith(" ") || line.startsWith("\t")) {
        currentValue += " " + line.trim();
        continue;
      }
      
      // Save previous header
      if (currentHeader) {
        headers[currentHeader.toLowerCase()] = currentValue.trim();
      }
      
      // Parse new header
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        currentHeader = line.substring(0, colonIndex);
        currentValue = line.substring(colonIndex + 1);
      }
    }
    
    // Body is everything after headers
    const body = lines.slice(i).join("\n");
    
    // Parse flags from filename (after :2,)
    const flags = this.parseFlags(filename);
    
    return {
      id: filename.split(":")[0] ?? filename, // ID is filename without flags
      from: headers["from"] ?? "",
      to: headers["to"] ?? "",
      subject: headers["subject"] ?? "",
      date: new Date(headers["date"] ?? Date.now()),
      body,
      headers,
      flags,
      filePath,
    };
  }

  /**
   * Parse Maildir flags from filename
   */
  private parseFlags(filename: string): MailFlags {
    const flags: MailFlags = {
      seen: false,
      replied: false,
      flagged: false,
      draft: false,
      trashed: false,
    };
    
    const flagMatch = filename.match(/:2,([A-Z]*)/);
    if (flagMatch && flagMatch[1]) {
      for (const char of flagMatch[1]) {
        const flag = FLAG_MAP[char];
        if (flag) {
          flags[flag] = true;
        }
      }
    }
    
    return flags;
  }

  /**
   * Mark a message as seen (move from new/ to cur/ with S flag)
   */
  async markSeen(messageId: string): Promise<void> {
    const newPath = join(this.basePath, "new", messageId);
    const curPath = join(this.basePath, "cur", `${messageId}:2,S`);
    
    try {
      await rename(newPath, curPath);
    } catch {
      // Already in cur/ or doesn't exist
    }
  }

  /**
   * Archive a message
   */
  async archive(messageId: string): Promise<void> {
    const now = new Date();
    const archiveDir = join(
      this.basePath,
      "archive",
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
    );
    
    await mkdir(archiveDir, { recursive: true });
    
    // Try to find message in cur/ or new/
    for (const folder of ["cur", "new"]) {
      try {
        const files = await readdir(join(this.basePath, folder));
        const file = files.find((f) => f.startsWith(messageId));
        if (file) {
          await rename(
            join(this.basePath, folder, file),
            join(archiveDir, file)
          );
          return;
        }
      } catch {
        continue;
      }
    }
  }

  /**
   * Delete a message
   */
  async delete(messageId: string): Promise<void> {
    for (const folder of ["cur", "new", "tmp"]) {
      try {
        const files = await readdir(join(this.basePath, folder));
        const file = files.find((f) => f.startsWith(messageId));
        if (file) {
          await unlink(join(this.basePath, folder, file));
          return;
        }
      } catch {
        continue;
      }
    }
  }

  /**
   * Count messages in a folder
   */
  async count(folder: "new" | "cur" | "sent" = "new"): Promise<number> {
    try {
      const files = await readdir(join(this.basePath, folder));
      return files.filter((f) => !f.startsWith(".")).length;
    } catch {
      return 0;
    }
  }
}

/**
 * Create a standard Octopai mail directory structure
 */
export async function initMaildir(basePath: string): Promise<void> {
  const folders = ["inbox", "sent", "drafts", "archive"];
  
  for (const folder of folders) {
    const maildir = new Maildir(join(basePath, folder));
    await maildir.init();
  }
}
