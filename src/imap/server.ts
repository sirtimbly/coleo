/**
 * IMAP Server for Octopai
 * 
 * Provides IMAP access to the Octopai Maildir, allowing users to read
 * brain/arm communications using any standard email client (Apple Mail,
 * Thunderbird, etc).
 * 
 * Uses a custom implementation based on RFC 3501 with Maildir integration.
 */

import { createServer, type Server, type Socket } from "net";
import { join } from "path";
import { Maildir, type MailMessage } from "../mail";
import { initDatabase, type Database } from "../db";

// IMAP response tags
const OK = "OK";
const NO = "NO";
const BAD = "BAD";

// IMAP states
type ImapState = "not_authenticated" | "authenticated" | "selected" | "logout";

// IMAP connection context
interface ImapConnection {
  id: string;
  state: ImapState;
  username?: string;
  selectedMailbox?: string;
  socket: Socket;
}

// Mailbox metadata
interface MailboxInfo {
  name: string;
  flags: string[];
  exists: number;
  recent: number;
  unseen: number;
  uidvalidity: number;
  uidnext: number;
}

// Server configuration
export interface ImapServerConfig {
  port: number;
  host: string;
  octopaiDir: string;
  // Authentication - can be static or callback
  authenticate?: (username: string, password: string) => Promise<boolean>;
  // Static credentials (if authenticate not provided)
  username?: string;
  password?: string;
}

const DEFAULT_CONFIG: Partial<ImapServerConfig> = {
  port: 1143,
  host: "127.0.0.1",
};

/**
 * Simple IMAP server implementation backed by Maildir
 */
export class ImapServer {
  private config: ImapServerConfig;
  private server: Server | null = null;
  private connections: Map<string, ImapConnection> = new Map();
  private maildirs: Map<string, Maildir> = new Map();
  private connectionCounter = 0;
  private db: Database | null = null;
  
  // UID validity - should be persistent, using timestamp of first run
  private uidValidity: number;

  constructor(config: ImapServerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.uidValidity = Math.floor(Date.now() / 1000);
  }

  /**
   * Initialize the IMAP server
   */
  async init(): Promise<void> {
    // Initialize database for user storage
    const dbPath = join(this.config.octopaiDir, "octopai.db");
    this.db = await initDatabase(dbPath);
    
    // Initialize Maildir instances for each folder
    const mailPath = join(this.config.octopaiDir, "mail");
    const folders = ["inbox", "sent", "drafts", "archive"];
    
    for (const folder of folders) {
      const maildir = new Maildir(join(mailPath, folder));
      await maildir.init();
      this.maildirs.set(folder.toUpperCase(), maildir);
    }
    
    // Map INBOX to inbox folder
    this.maildirs.set("INBOX", this.maildirs.get("INBOX") || new Maildir(join(mailPath, "inbox")));
  }

  /**
   * Start the IMAP server
   */
  async start(): Promise<void> {
    await this.init();
    
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", (err) => {
        console.error("[imap] Server error:", err);
        reject(err);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[imap] IMAP server listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the IMAP server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // Close all connections
        for (const conn of this.connections.values()) {
          conn.socket.destroy();
        }
        this.connections.clear();
        
        this.server.close(() => {
          console.log("[imap] IMAP server stopped");
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle a new connection
   */
  private handleConnection(socket: Socket): void {
    const connId = `conn-${++this.connectionCounter}`;
    const conn: ImapConnection = {
      id: connId,
      state: "not_authenticated",
      socket,
    };
    
    this.connections.set(connId, conn);
    console.log(`[imap] New connection: ${connId}`);
    
    // Send greeting
    this.send(conn, "* OK Octopai IMAP4rev1 Service Ready");
    
    let buffer = "";
    
    socket.on("data", (data) => {
      buffer += data.toString();
      
      // Process complete lines
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 2);
        
        if (line.trim()) {
          this.handleCommand(conn, line).catch((err) => {
            console.error(`[imap] Error handling command: ${err}`);
          });
        }
      }
    });
    
    socket.on("close", () => {
      console.log(`[imap] Connection closed: ${connId}`);
      this.connections.delete(connId);
    });
    
    socket.on("error", (err) => {
      console.error(`[imap] Socket error for ${connId}:`, err);
      this.connections.delete(connId);
    });
  }

  /**
   * Send a response to the client
   */
  private send(conn: ImapConnection, message: string): void {
    if (!conn.socket.destroyed) {
      conn.socket.write(message + "\r\n");
    }
  }

  /**
   * Handle an IMAP command
   */
  private async handleCommand(conn: ImapConnection, line: string): Promise<void> {
    // Parse command: TAG COMMAND [args...]
    const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      this.send(conn, `* BAD Invalid command format`);
      return;
    }
    
    const tag = match[1] ?? "";
    const command = match[2] ?? "";
    const args = match[3] ?? "";
    const cmd = command.toUpperCase();
    
    console.log(`[imap] ${conn.id} <- ${tag} ${cmd} ${args}`);
    
    try {
      switch (cmd) {
        case "CAPABILITY":
          await this.handleCapability(conn, tag);
          break;
          
        case "NOOP":
          this.send(conn, `${tag} ${OK} NOOP completed`);
          break;
          
        case "LOGOUT":
          await this.handleLogout(conn, tag);
          break;
          
        case "LOGIN":
          await this.handleLogin(conn, tag, args);
          break;
          
        case "AUTHENTICATE":
          await this.handleAuthenticate(conn, tag, args);
          break;
          
        case "SELECT":
          await this.handleSelect(conn, tag, args);
          break;
          
        case "EXAMINE":
          await this.handleSelect(conn, tag, args, true);
          break;
          
        case "LIST":
          await this.handleList(conn, tag, args);
          break;
          
        case "LSUB":
          await this.handleLsub(conn, tag, args);
          break;
          
        case "STATUS":
          await this.handleStatus(conn, tag, args);
          break;
          
        case "FETCH":
          await this.handleFetch(conn, tag, args);
          break;
          
        case "UID":
          await this.handleUid(conn, tag, args);
          break;
          
        case "SEARCH":
          await this.handleSearch(conn, tag, args);
          break;
          
        case "STORE":
          await this.handleStore(conn, tag, args);
          break;
          
        case "CLOSE":
          await this.handleClose(conn, tag);
          break;
          
        case "EXPUNGE":
          await this.handleExpunge(conn, tag);
          break;
          
        case "CHECK":
          this.send(conn, `${tag} ${OK} CHECK completed`);
          break;
          
        case "IDLE":
          await this.handleIdle(conn, tag);
          break;
          
        default:
          this.send(conn, `${tag} ${BAD} Unknown command: ${cmd}`);
      }
    } catch (err) {
      console.error(`[imap] Error handling ${cmd}:`, err);
      this.send(conn, `${tag} ${NO} Internal server error`);
    }
  }

  /**
   * Handle CAPABILITY command
   */
  private async handleCapability(conn: ImapConnection, tag: string): Promise<void> {
    const capabilities = [
      "IMAP4rev1",
      "AUTH=PLAIN",
      "IDLE",
      "UIDPLUS",
      "LITERAL+",
    ];
    
    this.send(conn, `* CAPABILITY ${capabilities.join(" ")}`);
    this.send(conn, `${tag} ${OK} CAPABILITY completed`);
  }

  /**
   * Handle LOGOUT command
   */
  private async handleLogout(conn: ImapConnection, tag: string): Promise<void> {
    conn.state = "logout";
    this.send(conn, "* BYE Octopai IMAP server logging out");
    this.send(conn, `${tag} ${OK} LOGOUT completed`);
    conn.socket.end();
  }

  /**
   * Handle LOGIN command
   */
  private async handleLogin(conn: ImapConnection, tag: string, args: string): Promise<void> {
    // Parse username and password (may be quoted)
    const match = args.match(/^"?([^"\s]+)"?\s+"?([^"\s]+)"?$/);
    if (!match) {
      this.send(conn, `${tag} ${BAD} Invalid LOGIN arguments`);
      return;
    }
    
    const username = match[1] ?? "";
    const password = match[2] ?? "";
    
    const authenticated = await this.authenticate(username, password);
    
    if (authenticated) {
      conn.state = "authenticated";
      conn.username = username;
      this.send(conn, `${tag} ${OK} LOGIN completed`);
    } else {
      this.send(conn, `${tag} ${NO} LOGIN failed - invalid credentials`);
    }
  }

  /**
   * Handle AUTHENTICATE command
   */
  private async handleAuthenticate(conn: ImapConnection, tag: string, args: string): Promise<void> {
    const mechanism = args.trim().toUpperCase();
    
    if (mechanism !== "PLAIN") {
      this.send(conn, `${tag} ${NO} Unsupported authentication mechanism`);
      return;
    }
    
    // For PLAIN auth, client sends base64-encoded "\0username\0password"
    // Send continuation request
    this.send(conn, "+ ");
    
    // Wait for credentials
    // Note: This is a simplified implementation - real impl would need proper state machine
    conn.socket.once("data", async (data) => {
      try {
        const credentials = Buffer.from(data.toString().trim(), "base64").toString();
        const parts = credentials.split("\0");
        
        if (parts.length < 3) {
          this.send(conn, `${tag} ${NO} Invalid PLAIN credentials format`);
          return;
        }
        
        const username = parts[1] ?? "";
        const password = parts[2] ?? "";
        const authenticated = await this.authenticate(username, password);
        
        if (authenticated) {
          conn.state = "authenticated";
          conn.username = username;
          this.send(conn, `${tag} ${OK} AUTHENTICATE completed`);
        } else {
          this.send(conn, `${tag} ${NO} AUTHENTICATE failed`);
        }
      } catch {
        this.send(conn, `${tag} ${NO} AUTHENTICATE failed`);
      }
    });
  }

  /**
   * Authenticate a user
   */
  private async authenticate(username: string, password: string): Promise<boolean> {
    // Use callback if provided
    if (this.config.authenticate) {
      return this.config.authenticate(username, password);
    }
    
    // Use static credentials if provided
    if (this.config.username && this.config.password) {
      return username === this.config.username && password === this.config.password;
    }
    
    // Check database for IMAP credentials
    if (this.db) {
      try {
        const row = this.db.query(
          "SELECT value FROM config WHERE key = 'imap_password'"
        ).get() as { value: string } | null;
        
        if (row) {
          // Simple comparison - in production, use bcrypt
          return username === "octopai" && password === row.value;
        }
      } catch {
        // Config table may not exist
      }
    }
    
    // Default: accept any credentials in dev mode
    console.log(`[imap] Warning: Accepting any credentials (dev mode)`);
    return true;
  }

  /**
   * Handle SELECT/EXAMINE command
   */
  private async handleSelect(conn: ImapConnection, tag: string, args: string, readOnly = false): Promise<void> {
    if (conn.state === "not_authenticated") {
      this.send(conn, `${tag} ${NO} Not authenticated`);
      return;
    }
    
    // Parse mailbox name (may be quoted)
    const mailboxName = args.replace(/^"(.*)"$/, "$1").toUpperCase();
    
    const mailbox = await this.getMailboxInfo(mailboxName);
    if (!mailbox) {
      this.send(conn, `${tag} ${NO} Mailbox does not exist`);
      return;
    }
    
    conn.state = "selected";
    conn.selectedMailbox = mailboxName;
    
    // Send mailbox info
    this.send(conn, `* ${mailbox.exists} EXISTS`);
    this.send(conn, `* ${mailbox.recent} RECENT`);
    this.send(conn, `* OK [UNSEEN ${mailbox.unseen}] First unseen message`);
    this.send(conn, `* OK [UIDVALIDITY ${mailbox.uidvalidity}] UIDs valid`);
    this.send(conn, `* OK [UIDNEXT ${mailbox.uidnext}] Predicted next UID`);
    this.send(conn, `* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)`);
    this.send(conn, `* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Permanent flags`);
    
    const mode = readOnly ? "READ-ONLY" : "READ-WRITE";
    this.send(conn, `${tag} ${OK} [${mode}] SELECT completed`);
  }

  /**
   * Get mailbox information
   */
  private async getMailboxInfo(name: string): Promise<MailboxInfo | null> {
    const maildir = this.maildirs.get(name);
    if (!maildir) {
      return null;
    }
    
    try {
      const newMessages = await maildir.list("new");
      const curMessages = await maildir.list("cur");
      const allMessages = [...newMessages, ...curMessages];
      
      return {
        name,
        flags: ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"],
        exists: allMessages.length,
        recent: newMessages.length,
        unseen: newMessages.length,
        uidvalidity: this.uidValidity,
        uidnext: allMessages.length + 1,
      };
    } catch {
      return null;
    }
  }

  /**
   * Handle LIST command
   */
  private async handleList(conn: ImapConnection, tag: string, args: string): Promise<void> {
    if (conn.state === "not_authenticated") {
      this.send(conn, `${tag} ${NO} Not authenticated`);
      return;
    }
    
    // Parse reference and mailbox pattern
    const match = args.match(/^"?([^"\s]*)"?\s+"?([^"\s]*)"?$/);
    if (!match) {
      this.send(conn, `${tag} ${BAD} Invalid LIST arguments`);
      return;
    }
    
    const pattern = match[2] ?? "*";
    
    // List available mailboxes
    const mailboxes = ["INBOX", "SENT", "DRAFTS", "ARCHIVE"];
    
    for (const mailbox of mailboxes) {
      if (pattern === "*" || pattern === "%" || mailbox.includes(pattern.replace("*", ""))) {
        this.send(conn, `* LIST (\\HasNoChildren) "/" "${mailbox}"`);
      }
    }
    
    this.send(conn, `${tag} ${OK} LIST completed`);
  }

  /**
   * Handle LSUB command (subscribed mailboxes)
   */
  private async handleLsub(conn: ImapConnection, tag: string, args: string): Promise<void> {
    // For simplicity, LSUB returns same as LIST
    await this.handleList(conn, tag, args);
  }

  /**
   * Handle STATUS command
   */
  private async handleStatus(conn: ImapConnection, tag: string, args: string): Promise<void> {
    if (conn.state === "not_authenticated") {
      this.send(conn, `${tag} ${NO} Not authenticated`);
      return;
    }
    
    // Parse mailbox and status items
    const match = args.match(/^"?([^"\s]+)"?\s+\(([^)]+)\)$/);
    if (!match) {
      this.send(conn, `${tag} ${BAD} Invalid STATUS arguments`);
      return;
    }
    
    const mailboxName = match[1] ?? "";
    const itemsStr = match[2] ?? "";
    const mailbox = await this.getMailboxInfo(mailboxName.toUpperCase());
    
    if (!mailbox) {
      this.send(conn, `${tag} ${NO} Mailbox does not exist`);
      return;
    }
    
    const items = itemsStr.toUpperCase().split(/\s+/);
    const results: string[] = [];
    
    for (const item of items) {
      switch (item) {
        case "MESSAGES":
          results.push(`MESSAGES ${mailbox.exists}`);
          break;
        case "RECENT":
          results.push(`RECENT ${mailbox.recent}`);
          break;
        case "UNSEEN":
          results.push(`UNSEEN ${mailbox.unseen}`);
          break;
        case "UIDVALIDITY":
          results.push(`UIDVALIDITY ${mailbox.uidvalidity}`);
          break;
        case "UIDNEXT":
          results.push(`UIDNEXT ${mailbox.uidnext}`);
          break;
      }
    }
    
    this.send(conn, `* STATUS "${mailboxName}" (${results.join(" ")})`);
    this.send(conn, `${tag} ${OK} STATUS completed`);
  }

  /**
   * Handle FETCH command
   */
  private async handleFetch(conn: ImapConnection, tag: string, args: string): Promise<void> {
    if (conn.state !== "selected" || !conn.selectedMailbox) {
      this.send(conn, `${tag} ${NO} No mailbox selected`);
      return;
    }
    
    // Parse sequence set and fetch items
    const match = args.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      this.send(conn, `${tag} ${BAD} Invalid FETCH arguments`);
      return;
    }
    
    const sequenceSet = match[1] ?? "";
    const itemsStr = match[2] ?? "";
    const messages = await this.getMessagesBySequence(conn.selectedMailbox, sequenceSet);
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      const seqNum = i + 1;
      const fetchData = await this.buildFetchResponse(msg, itemsStr);
      this.send(conn, `* ${seqNum} FETCH (${fetchData})`);
    }
    
    this.send(conn, `${tag} ${OK} FETCH completed`);
  }

  /**
   * Handle UID command (UID FETCH, UID SEARCH, etc.)
   */
  private async handleUid(conn: ImapConnection, tag: string, args: string): Promise<void> {
    if (conn.state !== "selected" || !conn.selectedMailbox) {
      this.send(conn, `${tag} ${NO} No mailbox selected`);
      return;
    }
    
    const match = args.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      this.send(conn, `${tag} ${BAD} Invalid UID arguments`);
      return;
    }
    
    const subCommand = match[1] ?? "";
    const subArgs = match[2] ?? "";
    
    switch (subCommand.toUpperCase()) {
      case "FETCH":
        await this.handleUidFetch(conn, tag, subArgs);
        break;
      case "SEARCH":
        await this.handleUidSearch(conn, tag, subArgs);
        break;
      case "STORE":
        await this.handleUidStore(conn, tag, subArgs);
        break;
      default:
        this.send(conn, `${tag} ${BAD} Unknown UID command: ${subCommand}`);
    }
  }

  /**
   * Handle UID FETCH command
   */
  private async handleUidFetch(conn: ImapConnection, tag: string, args: string): Promise<void> {
    if (!conn.selectedMailbox) {
      this.send(conn, `${tag} ${NO} No mailbox selected`);
      return;
    }
    
    const match = args.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      this.send(conn, `${tag} ${BAD} Invalid UID FETCH arguments`);
      return;
    }
    
    const uidSet = match[1] ?? "";
    const itemsStr = match[2] ?? "";
    const messages = await this.getMessagesByUid(conn.selectedMailbox, uidSet);
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      const uid = this.getMessageUid(msg);
      const fetchData = await this.buildFetchResponse(msg, itemsStr, uid);
      this.send(conn, `* ${i + 1} FETCH (UID ${uid} ${fetchData})`);
    }
    
    this.send(conn, `${tag} ${OK} UID FETCH completed`);
  }

  /**
   * Handle SEARCH command
   */
  private async handleSearch(conn: ImapConnection, tag: string, _args: string): Promise<void> {
    if (conn.state !== "selected" || !conn.selectedMailbox) {
      this.send(conn, `${tag} ${NO} No mailbox selected`);
      return;
    }
    
    // Simple implementation - return all message sequence numbers
    const mailbox = await this.getMailboxInfo(conn.selectedMailbox);
    if (!mailbox) {
      this.send(conn, `${tag} ${NO} Mailbox error`);
      return;
    }
    
    const sequences = Array.from({ length: mailbox.exists }, (_, i) => i + 1);
    this.send(conn, `* SEARCH ${sequences.join(" ")}`);
    this.send(conn, `${tag} ${OK} SEARCH completed`);
  }

  /**
   * Handle UID SEARCH command
   */
  private async handleUidSearch(conn: ImapConnection, tag: string, _args: string): Promise<void> {
    if (!conn.selectedMailbox) {
      this.send(conn, `${tag} ${NO} No mailbox selected`);
      return;
    }
    
    const mailbox = await this.getMailboxInfo(conn.selectedMailbox);
    if (!mailbox) {
      this.send(conn, `${tag} ${NO} Mailbox error`);
      return;
    }
    
    // Return UIDs (1-based for simplicity)
    const uids = Array.from({ length: mailbox.exists }, (_, i) => i + 1);
    this.send(conn, `* SEARCH ${uids.join(" ")}`);
    this.send(conn, `${tag} ${OK} UID SEARCH completed`);
  }

  /**
   * Handle STORE command
   */
  private async handleStore(conn: ImapConnection, tag: string, _args: string): Promise<void> {
    if (conn.state !== "selected") {
      this.send(conn, `${tag} ${NO} No mailbox selected`);
      return;
    }
    
    // Parse: sequence FLAGS (flags) or +FLAGS (flags) or -FLAGS (flags)
    this.send(conn, `${tag} ${OK} STORE completed`);
  }

  /**
   * Handle UID STORE command
   */
  private async handleUidStore(conn: ImapConnection, tag: string, _args: string): Promise<void> {
    this.send(conn, `${tag} ${OK} UID STORE completed`);
  }

  /**
   * Handle CLOSE command
   */
  private async handleClose(conn: ImapConnection, tag: string): Promise<void> {
    conn.state = "authenticated";
    conn.selectedMailbox = undefined;
    this.send(conn, `${tag} ${OK} CLOSE completed`);
  }

  /**
   * Handle EXPUNGE command
   */
  private async handleExpunge(conn: ImapConnection, tag: string): Promise<void> {
    if (conn.state !== "selected") {
      this.send(conn, `${tag} ${NO} No mailbox selected`);
      return;
    }
    
    // No messages to expunge (we don't track deleted flags yet)
    this.send(conn, `${tag} ${OK} EXPUNGE completed`);
  }

  /**
   * Handle IDLE command
   */
  private async handleIdle(conn: ImapConnection, tag: string): Promise<void> {
    if (conn.state !== "selected") {
      this.send(conn, `${tag} ${NO} No mailbox selected`);
      return;
    }
    
    this.send(conn, "+ idling");
    
    // Wait for DONE
    conn.socket.once("data", (data) => {
      const line = data.toString().trim().toUpperCase();
      if (line === "DONE") {
        this.send(conn, `${tag} ${OK} IDLE terminated`);
      }
    });
  }

  /**
   * Get messages by sequence set (e.g., "1:*", "1,3,5", "2:4")
   */
  private async getMessagesBySequence(mailboxName: string, sequenceSet: string): Promise<MailMessage[]> {
    const maildir = this.maildirs.get(mailboxName);
    if (!maildir) return [];
    
    const newMessages = await maildir.list("new");
    const curMessages = await maildir.list("cur");
    const allMessages = [...newMessages, ...curMessages];
    
    // Sort by date
    allMessages.sort((a, b) => a.date.getTime() - b.date.getTime());
    
    // Parse sequence set and filter
    return this.filterBySequenceSet(allMessages, sequenceSet);
  }

  /**
   * Get messages by UID set
   */
  private async getMessagesByUid(mailboxName: string, uidSet: string): Promise<MailMessage[]> {
    // For simplicity, UIDs are 1-indexed sequence numbers
    return this.getMessagesBySequence(mailboxName, uidSet);
  }

  /**
   * Filter messages by sequence set
   */
  private filterBySequenceSet(messages: MailMessage[], sequenceSet: string): MailMessage[] {
    const total = messages.length;
    const indices = new Set<number>();
    
    for (const part of sequenceSet.split(",")) {
      if (part.includes(":")) {
        const [startStr, endStr] = part.split(":");
        const startNum = startStr === "*" ? total : parseInt(startStr ?? "1", 10);
        const endNum = endStr === "*" ? total : parseInt(endStr ?? "1", 10);
        
        for (let i = Math.min(startNum, endNum); i <= Math.max(startNum, endNum); i++) {
          if (i >= 1 && i <= total) {
            indices.add(i - 1);
          }
        }
      } else if (part === "*") {
        indices.add(total - 1);
      } else {
        const num = parseInt(part, 10);
        if (num >= 1 && num <= total) {
          indices.add(num - 1);
        }
      }
    }
    
    return Array.from(indices)
      .sort((a, b) => a - b)
      .map(i => messages[i])
      .filter((m): m is MailMessage => m !== undefined);
  }

  /**
   * Get a message's UID (using timestamp hash for stability)
   */
  private getMessageUid(msg: MailMessage): number {
    // Simple UID based on message ID hash
    let hash = 0;
    for (let i = 0; i < msg.id.length; i++) {
      hash = ((hash << 5) - hash) + msg.id.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash) % 1000000 + 1;
  }

  /**
   * Build FETCH response data
   */
  private async buildFetchResponse(msg: MailMessage, itemsStr: string, _uid?: number): Promise<string> {
    const items = itemsStr.toUpperCase();
    const results: string[] = [];
    
    // Parse fetch items - handle both parenthesized and non-parenthesized
    const fetchItems = items.replace(/^\(/, "").replace(/\)$/, "");
    
    if (fetchItems.includes("FLAGS")) {
      const flags = [];
      if (msg.flags.seen) flags.push("\\Seen");
      if (msg.flags.replied) flags.push("\\Answered");
      if (msg.flags.flagged) flags.push("\\Flagged");
      if (msg.flags.draft) flags.push("\\Draft");
      if (msg.flags.trashed) flags.push("\\Deleted");
      results.push(`FLAGS (${flags.join(" ")})`);
    }
    
    if (fetchItems.includes("INTERNALDATE")) {
      const date = msg.date.toUTCString();
      results.push(`INTERNALDATE "${date}"`);
    }
    
    if (fetchItems.includes("RFC822.SIZE") || fetchItems.includes("BODY.SIZE")) {
      const size = Buffer.byteLength(this.formatRfc822(msg), "utf-8");
      results.push(`RFC822.SIZE ${size}`);
    }
    
    if (fetchItems.includes("ENVELOPE")) {
      results.push(this.buildEnvelope(msg));
    }
    
    if (fetchItems.includes("BODY[]") || fetchItems.includes("RFC822") || fetchItems.includes("BODY.PEEK[]")) {
      const rfc822 = this.formatRfc822(msg);
      results.push(`BODY[] {${Buffer.byteLength(rfc822, "utf-8")}}\r\n${rfc822}`);
    }
    
    if (fetchItems.includes("BODY[HEADER]") || fetchItems.includes("BODY.PEEK[HEADER]")) {
      const headers = this.formatHeaders(msg);
      results.push(`BODY[HEADER] {${Buffer.byteLength(headers, "utf-8")}}\r\n${headers}`);
    }
    
    if (fetchItems.includes("BODY[TEXT]")) {
      results.push(`BODY[TEXT] {${Buffer.byteLength(msg.body, "utf-8")}}\r\n${msg.body}`);
    }
    
    if (fetchItems.includes("BODYSTRUCTURE")) {
      results.push(this.buildBodyStructure(msg));
    }
    
    return results.join(" ");
  }

  /**
   * Format message as RFC822
   */
  private formatRfc822(msg: MailMessage): string {
    const headers = this.formatHeaders(msg);
    return `${headers}\r\n${msg.body}`;
  }

  /**
   * Format message headers
   */
  private formatHeaders(msg: MailMessage): string {
    const lines: string[] = [
      `From: ${msg.from}`,
      `To: ${msg.to}`,
      `Subject: ${msg.subject}`,
      `Date: ${msg.date.toUTCString()}`,
      `Message-ID: <${msg.id}@octopai.local>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
    ];
    
    for (const [key, value] of Object.entries(msg.headers)) {
      if (!["from", "to", "subject", "date", "message-id", "mime-version", "content-type"].includes(key.toLowerCase())) {
        lines.push(`${key}: ${value}`);
      }
    }
    
    return lines.join("\r\n") + "\r\n";
  }

  /**
   * Build ENVELOPE response
   */
  private buildEnvelope(msg: MailMessage): string {
    const escape = (s: string) => s.replace(/"/g, '\\"');
    const formatAddr = (addr: string) => {
      const match = addr.match(/^(.+?)\s*<(.+?)>$/);
      if (match) {
        const name = match[1] ?? "";
        const email = match[2] ?? "";
        const [localPart, domain] = email.split("@");
        return `(("${escape(name)}" NIL "${localPart ?? ""}" "${domain ?? ""}"))`;
      }
      const [localPart, domain] = addr.split("@");
      return `((NIL NIL "${localPart ?? addr}" "${domain ?? ""}"))`;
    };
    
    return `ENVELOPE ("${msg.date.toUTCString()}" "${escape(msg.subject)}" ${formatAddr(msg.from)} ${formatAddr(msg.from)} ${formatAddr(msg.from)} ${formatAddr(msg.to)} NIL NIL NIL "<${msg.id}@octopai.local>")`;
  }

  /**
   * Build BODYSTRUCTURE response
   */
  private buildBodyStructure(msg: MailMessage): string {
    const size = Buffer.byteLength(msg.body, "utf-8");
    const lines = msg.body.split(/\r?\n/).length;
    return `BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${size} ${lines})`;
  }
}

/**
 * Create and start an IMAP server
 */
export async function startImapServer(config: ImapServerConfig): Promise<ImapServer> {
  const server = new ImapServer(config);
  await server.start();
  return server;
}
