/**
 * IMAP4rev1 server implementation backed by Maildir
 * 
 * Implements RFC 3501 - Internet Message Access Protocol version 4rev1
 * Provides IMAP access to Octopai Maildir storage for downstream email clients
 */

import { createServer, type Server, type Socket } from 'net';
import { EventEmitter } from 'events';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { Maildir, type MailMessage, type MailFlags } from './maildir';
import { getOctopaiDir } from '../config';

/**
 * IMAP server states as defined by RFC 3501
 */
type IMAPState = 'not-authenticated' | 'authenticated' | 'selected' | 'logout';

/**
 * IMAP response types
 */
type IMAPResponseType = 'OK' | 'NO' | 'BAD' | 'PREAUTH' | 'BYE';

/**
 * IMAP client session
 */
interface IMAPSession {
  id: string;
  socket: Socket;
  state: IMAPState;
  username?: string;
  selectedMailbox?: string;
  selectedMaildir?: Maildir;
  authenticated: boolean;
  lastCommand: number;
  messageSequenceNumbers: Map<number, string>; // seq -> UID mapping
  uidNext: number;
  uidValidity: number;
}

/**
 * IMAP command structure
 */
interface IMAPCommand {
  tag: string;
  command: string;
  args: string[];
}

/**
 * IMAP server configuration
 */
interface IMAPServerConfig {
  port: number;
  hostname: string;
  octopaiDir: string;
}

/**
 * IMAP4rev1 server implementation
 */
export class IMAPServer extends EventEmitter {
  private server: Server;
  private sessions = new Map<string, IMAPSession>();
  private config: IMAPServerConfig;

  constructor(config: Partial<IMAPServerConfig> = {}) {
    super();
    
    this.config = {
      port: 1143, // Non-standard port to avoid conflicts
      hostname: '0.0.0.0',
      octopaiDir: '', // Will be set in start()
      ...config
    };

    this.server = createServer((socket) => this.handleConnection(socket));
  }

  /**
   * Start the IMAP server
   */
  async start(): Promise<void> {
    // Initialize octopaiDir if not provided
    if (!this.config.octopaiDir) {
      this.config.octopaiDir = await getOctopaiDir();
    }

    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.hostname, () => {
        console.log(`IMAP server listening on ${this.config.hostname}:${this.config.port}`);
        this.emit('listening');
        resolve();
      });

      this.server.on('error', (err) => {
        console.error('IMAP server error:', err);
        reject(err);
      });
    });
  }

  /**
   * Stop the IMAP server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all sessions
      for (const session of this.sessions.values()) {
        session.socket.destroy();
      }
      this.sessions.clear();

      this.server.close(() => {
        console.log('IMAP server stopped');
        resolve();
      });
    });
  }

  /**
   * Handle new client connection
   */
  private handleConnection(socket: Socket): void {
    const sessionId = this.generateSessionId();
    const session: IMAPSession = {
      id: sessionId,
      socket,
      state: 'not-authenticated',
      authenticated: false,
      lastCommand: Date.now(),
      messageSequenceNumbers: new Map(),
      uidNext: 1,
      uidValidity: Math.floor(Date.now() / 1000) // Use timestamp for UIDVALIDITY
    };

    this.sessions.set(sessionId, session);
    console.log(`[IMAP] New connection: ${sessionId} from ${socket.remoteAddress}`);

    // Send greeting
    this.sendResponse(session, null, 'OK', 'Octopai IMAP4rev1 Server ready');

    // Handle data
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      
      // Process complete lines
      while (buffer.includes('\r\n')) {
        const lineEnd = buffer.indexOf('\r\n');
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        
        try {
          this.handleCommand(session, line.trim());
        } catch (err) {
          console.error(`[IMAP] Command error for ${sessionId}:`, err);
          this.sendResponse(session, null, 'BAD', 'Internal server error');
        }
      }
    });

    // Handle disconnection
    socket.on('close', () => {
      console.log(`[IMAP] Connection closed: ${sessionId}`);
      this.sessions.delete(sessionId);
    });

    socket.on('error', (err) => {
      console.error(`[IMAP] Socket error for ${sessionId}:`, err);
      this.sessions.delete(sessionId);
    });
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `imap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Parse IMAP command line
   */
  private parseCommand(line: string): IMAPCommand {
    const parts = line.split(' ');
    if (parts.length < 2) {
      throw new Error('Invalid command format');
    }

    return {
      tag: parts[0] || '',
      command: (parts[1] || '').toUpperCase(),
      args: parts.slice(2)
    };
  }

  /**
   * Handle IMAP command
   */
  private async handleCommand(session: IMAPSession, line: string): Promise<void> {
    if (!line.trim()) return;

    session.lastCommand = Date.now();
    
    try {
      const cmd = this.parseCommand(line);
      console.log(`[IMAP] ${session.id}: ${cmd.tag} ${cmd.command} ${cmd.args.join(' ')}`);

      // Route command based on current state
      switch (cmd.command) {
        // Any state commands
        case 'CAPABILITY':
          await this.handleCapability(session, cmd);
          break;
        case 'NOOP':
          await this.handleNoop(session, cmd);
          break;
        case 'LOGOUT':
          await this.handleLogout(session, cmd);
          break;

        // Not authenticated state commands
        case 'LOGIN':
          await this.handleLogin(session, cmd);
          break;

        // Authenticated state commands  
        case 'LIST':
          await this.handleList(session, cmd);
          break;
        case 'SELECT':
          await this.handleSelect(session, cmd);
          break;
        case 'EXAMINE':
          await this.handleExamine(session, cmd);
          break;

        // Selected state commands
        case 'FETCH':
          await this.handleFetch(session, cmd);
          break;
        case 'SEARCH':
          await this.handleSearch(session, cmd);
          break;
        case 'STORE':
          await this.handleStore(session, cmd);
          break;

        default:
          this.sendResponse(session, cmd.tag, 'BAD', `Unknown command: ${cmd.command}`);
      }
    } catch (err) {
      console.error(`[IMAP] Command parse error:`, err);
      this.sendResponse(session, null, 'BAD', 'Command parsing failed');
    }
  }

  /**
   * Send IMAP response to client
   */
  private sendResponse(session: IMAPSession, tag: string | null, type: IMAPResponseType, message: string, data?: string): void {
    let response: string;
    
    if (tag) {
      response = `${tag} ${type} ${message}`;
    } else {
      response = `* ${type} ${message}`;
    }

    if (data) {
      response = `* ${data}\r\n${response}`;
    }

    response += '\r\n';
    
    console.log(`[IMAP] ${session.id} <- ${response.trim()}`);
    session.socket.write(response);
  }

  /**
   * Send untagged data response
   */
  private sendData(session: IMAPSession, data: string): void {
    const response = `* ${data}\r\n`;
    console.log(`[IMAP] ${session.id} <- ${response.trim()}`);
    session.socket.write(response);
  }

  // Command handlers

  /**
   * CAPABILITY command - RFC 3501 Section 6.1.1
   */
  private async handleCapability(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    this.sendData(session, 'CAPABILITY IMAP4rev1 AUTH=PLAIN');
    this.sendResponse(session, cmd.tag, 'OK', 'CAPABILITY completed');
  }

  /**
   * NOOP command - RFC 3501 Section 6.1.2
   */
  private async handleNoop(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    this.sendResponse(session, cmd.tag, 'OK', 'NOOP completed');
  }

  /**
   * LOGOUT command - RFC 3501 Section 6.1.3
   */
  private async handleLogout(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    session.state = 'logout';
    this.sendResponse(session, null, 'BYE', 'Octopai IMAP Server logging out');
    this.sendResponse(session, cmd.tag, 'OK', 'LOGOUT completed');
    session.socket.destroy();
  }

  /**
   * LOGIN command - RFC 3501 Section 6.2.3
   */
  private async handleLogin(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    if (session.state !== 'not-authenticated') {
      this.sendResponse(session, cmd.tag, 'BAD', 'Already authenticated');
      return;
    }

    if (cmd.args.length < 2) {
      this.sendResponse(session, cmd.tag, 'BAD', 'LOGIN requires username and password');
      return;
    }

    const username = this.unquoteString(cmd.args[0] ?? '');
    const password = this.unquoteString(cmd.args[1] ?? '');

    // Authenticate using database-stored credentials
    if (await this.authenticateUser(username, password)) {
      session.username = username;
      session.authenticated = true;
      session.state = 'authenticated';
      this.sendResponse(session, cmd.tag, 'OK', 'LOGIN completed');
    } else {
      this.sendResponse(session, cmd.tag, 'NO', 'LOGIN failed');
    }
  }

  /**
   * Authenticate user against database credentials
   */
  private async authenticateUser(username: string, password: string): Promise<boolean> {
    try {
      const octopaiDir = await getOctopaiDir();
      const dbPath = join(octopaiDir, 'octopai.db');
      const db = new Database(dbPath);
      
      // Get stored IMAP password
      const row = db.query("SELECT value FROM config WHERE key = 'imap_password'").get() as { value: string } | null;
      db.close();
      
      if (!row) {
        console.warn('No IMAP password configured in database');
        return false;
      }
      
      // For now, username can be anything, password must match stored value
      // TODO: In production, implement proper user management
      return password === row.value;
      
    } catch (error) {
      console.error('Authentication error:', error);
      return false;
    }
  }

  /**
   * LIST command - RFC 3501 Section 6.3.8
   */
  private async handleList(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    if (session.state === 'not-authenticated') {
      this.sendResponse(session, cmd.tag, 'NO', 'Not authenticated');
      return;
    }

    // For simplicity, return available mailboxes from Maildir structure
    const mailboxes = ['INBOX', 'Sent', 'Drafts', 'Archive'];
    
    for (const mailbox of mailboxes) {
      this.sendData(session, `LIST (\\HasNoChildren) "." "${mailbox}"`);
    }
    
    this.sendResponse(session, cmd.tag, 'OK', 'LIST completed');
  }

  /**
   * SELECT command - RFC 3501 Section 6.3.1
   */
  private async handleSelect(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    if (session.state === 'not-authenticated') {
      this.sendResponse(session, cmd.tag, 'NO', 'Not authenticated');
      return;
    }

    if (cmd.args.length < 1) {
      this.sendResponse(session, cmd.tag, 'BAD', 'SELECT requires mailbox name');
      return;
    }

    const mailboxName = this.unquoteString(cmd.args[0] ?? '').toLowerCase();
    let maildirName: string;
    
    // Map IMAP mailbox names to Maildir folders
    switch (mailboxName) {
      case 'inbox':
        maildirName = 'inbox';
        break;
      case 'sent':
        maildirName = 'sent';
        break;
      case 'drafts':
        maildirName = 'drafts';
        break;
      case 'archive':
        maildirName = 'archive';
        break;
      default:
        this.sendResponse(session, cmd.tag, 'NO', 'Mailbox does not exist');
        return;
    }

    try {
      const maildir = new Maildir(join(this.config.octopaiDir, 'mail', maildirName));
      const newMessages = await maildir.list('new');
      const curMessages = await maildir.list('cur');
      const allMessages = [...newMessages, ...curMessages];

      // Build sequence number to UID mapping
      session.messageSequenceNumbers.clear();
      allMessages.sort((a, b) => a.id.localeCompare(b.id)); // Sort by UID
      
      allMessages.forEach((msg, index) => {
        session.messageSequenceNumbers.set(index + 1, msg.id);
      });

      session.selectedMailbox = mailboxName;
      session.selectedMaildir = maildir;
      session.state = 'selected';
      session.uidNext = this.calculateNextUID(allMessages);

      // Send required SELECT responses
      this.sendData(session, `FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`);
      this.sendData(session, `OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Limited`);
      this.sendData(session, `${allMessages.length} EXISTS`);
      this.sendData(session, `${newMessages.length} RECENT`);
      this.sendData(session, `OK [UIDVALIDITY ${session.uidValidity}] UIDs valid`);
      this.sendData(session, `OK [UIDNEXT ${session.uidNext}] Predicted next UID`);
      
      this.sendResponse(session, cmd.tag, 'OK', `[READ-WRITE] SELECT completed`);
    } catch (err) {
      console.error('SELECT error:', err);
      this.sendResponse(session, cmd.tag, 'NO', 'SELECT failed');
    }
  }

  /**
   * EXAMINE command - RFC 3501 Section 6.3.2
   */
  private async handleExamine(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    // EXAMINE is like SELECT but read-only
    await this.handleSelect(session, cmd);
    // TODO: Mark as read-only in session
  }

  /**
   * FETCH command - RFC 3501 Section 6.4.5
   */
  private async handleFetch(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    if (session.state !== 'selected' || !session.selectedMaildir) {
      this.sendResponse(session, cmd.tag, 'NO', 'Not in selected state');
      return;
    }

    if (cmd.args.length < 2) {
      this.sendResponse(session, cmd.tag, 'BAD', 'FETCH requires sequence set and fetch items');
      return;
    }

    const sequenceSet = cmd.args[0] ?? '';
    const fetchItems = cmd.args[1] ?? '';

    try {
      // Parse sequence set (simplified - supports single numbers and ranges)
      const sequences = this.parseSequenceSet(sequenceSet, session.messageSequenceNumbers.size);
      const items = this.parseFetchItems(fetchItems);

      for (const seqNum of sequences) {
        const uid = session.messageSequenceNumbers.get(seqNum);
        if (!uid || !session.selectedMaildir) continue;

        try {
          // For now, get the message by listing and finding by ID
          // This is inefficient but works with current Maildir API
          const folderName = session.selectedMailbox === 'inbox' ? 'new' : 'cur';
          const messages = await session.selectedMaildir.list(folderName as 'new' | 'cur');
          const message = messages.find(msg => msg.id === uid);
          
          if (!message) continue;

          const responseItems: string[] = [];

          for (const item of items) {
            switch (item.toUpperCase()) {
              case 'UID':
                responseItems.push(`UID ${uid}`);
                break;
              case 'FLAGS':
                const flagStr = this.buildFlagsString(message.flags);
                responseItems.push(`FLAGS ${flagStr}`);
                break;
              case 'RFC822.SIZE':
                responseItems.push(`RFC822.SIZE ${message.body?.length || 0}`);
                break;
              case 'ENVELOPE':
                responseItems.push(`ENVELOPE (${this.buildEnvelope(message)})`);
                break;
              case 'BODY[]':
              case 'RFC822':
                // Return full message content (simplified - should include headers)
                if (message.body) {
                  responseItems.push(`RFC822 {${message.body.length}}\r\n${message.body}`);
                }
                break;
            }
          }

          this.sendData(session, `${seqNum} FETCH (${responseItems.join(' ')})`);
        } catch (error) {
          console.error(`Failed to fetch message ${uid}:`, error);
        }
      }

      this.sendResponse(session, cmd.tag, 'OK', 'FETCH completed');
    } catch (error) {
      this.sendResponse(session, cmd.tag, 'BAD', `FETCH failed: ${error}`);
    }
  }

  /**
   * SEARCH command - RFC 3501 Section 6.4.4  
   */
  private async handleSearch(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    if (session.state !== 'selected') {
      this.sendResponse(session, cmd.tag, 'NO', 'Not in selected state');
      return;
    }

    // Simple search implementation - return all messages
    const messageCount = session.messageSequenceNumbers.size;
    const searchResults = Array.from({ length: messageCount }, (_, i) => i + 1);
    
    this.sendData(session, `SEARCH ${searchResults.join(' ')}`);
    this.sendResponse(session, cmd.tag, 'OK', 'SEARCH completed');
  }

  /**
   * STORE command - RFC 3501 Section 6.4.6
   */
  private async handleStore(session: IMAPSession, cmd: IMAPCommand): Promise<void> {
    if (session.state !== 'selected' || !session.selectedMaildir) {
      this.sendResponse(session, cmd.tag, 'NO', 'Not in selected state');
      return;
    }

    // TODO: Implement flag storage
    this.sendResponse(session, cmd.tag, 'OK', 'STORE completed');
  }

  // Helper methods

  /**
   * Remove quotes from IMAP string if present
   */
  private unquoteString(str: string): string {
    if (str.startsWith('"') && str.endsWith('"')) {
      return str.slice(1, -1);
    }
    return str;
  }

  /**
   * Parse IMAP sequence set (simplified implementation)
   */
  private parseSequenceSet(sequenceSet: string, maxSeq: number): number[] {
    const sequences: number[] = [];
    const parts = sequenceSet.split(',');
    
    for (const part of parts) {
      if (part.includes(':')) {
        // Range like "1:5"
        const rangeParts = part.split(':');
        const start = rangeParts[0] === '*' ? maxSeq : parseInt(rangeParts[0] ?? '1', 10);
        const end = rangeParts[1] === '*' ? maxSeq : parseInt(rangeParts[1] ?? '1', 10);
        for (let i = Math.min(start, end); i <= Math.max(start, end) && i <= maxSeq; i++) {
          sequences.push(i);
        }
      } else {
        // Single number or *
        const num = part === '*' ? maxSeq : parseInt(part, 10);
        if (num > 0 && num <= maxSeq) {
          sequences.push(num);
        }
      }
    }
    
    return [...new Set(sequences)].sort((a, b) => a - b);
  }

  /**
   * Parse FETCH items
   */
  private parseFetchItems(items: string): string[] {
    // Remove parentheses if present
    let cleanItems = items.trim();
    if (cleanItems.startsWith('(') && cleanItems.endsWith(')')) {
      cleanItems = cleanItems.slice(1, -1);
    }
    
    // Split by spaces (simplified - doesn't handle nested parens)
    return cleanItems.split(/\s+/).filter(item => item.length > 0);
  }

  /**
   * Build ENVELOPE structure for message (simplified)
   */
  private buildEnvelope(message: MailMessage): string {
    // Simplified envelope using available MailMessage properties
    const date = message.date ? `"${message.date.toISOString()}"` : 'NIL';
    const subject = message.subject ? `"${message.subject.replace(/"/g, '\\"')}"` : 'NIL';
    const from = message.from ? `(("${message.from}" NIL NIL NIL))` : 'NIL';
    const sender = 'NIL'; // Same as from for simplicity
    const replyTo = 'NIL';
    const to = message.to ? `(("${message.to}" NIL NIL NIL))` : 'NIL';
    const cc = 'NIL';
    const bcc = 'NIL';
    const inReplyTo = 'NIL';
    const messageId = message.headers?.['message-id'] ? `"${message.headers['message-id']}"` : 'NIL';
    
    return `${date} ${subject} ${from} ${sender} ${replyTo} ${to} ${cc} ${bcc} ${inReplyTo} ${messageId}`;
  }

  /**
   * Build flags string from MailFlags
   */
  private buildFlagsString(flags: MailFlags): string {
    const flagArray: string[] = [];
    if (flags.seen) flagArray.push('\\Seen');
    if (flags.replied) flagArray.push('\\Answered');
    if (flags.flagged) flagArray.push('\\Flagged');
    if (flags.trashed) flagArray.push('\\Deleted');
    if (flags.draft) flagArray.push('\\Draft');
    
    return `(${flagArray.join(' ')})`;
  }

  /**
   * Calculate next UID for a mailbox
   */
  private calculateNextUID(messages: MailMessage[]): number {
    if (messages.length === 0) return 1;
    
    const uids = messages.map(msg => {
      const parts = msg.id.split('.');
      return parseInt(parts[0] ?? '1', 10) || 1;
    });
    return Math.max(...uids) + 1;
  }
}

/**
 * Start IMAP server
 */
export async function startIMAPServer(config?: Partial<IMAPServerConfig>): Promise<IMAPServer> {
  const server = new IMAPServer(config);
  await server.start();
  return server;
}