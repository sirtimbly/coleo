import { Command } from "commander";
import { join } from "path";
import { getColeoDir } from "../context";
import { startImapServer } from "../../imap";

export function registerImapCommands(program: Command): void {
  const imapCmd = program.command("imap").description("IMAP server for email clients");

  imapCmd
    .command("serve")
    .description("Start the IMAP server")
    .option("-p, --port <port>", "IMAP server port", "1143")
    .option("-h, --host <host>", "IMAP server host", "127.0.0.1")
    .option("-u, --username <username>", "IMAP username", "coleo")
    .option("--password <password>", "IMAP password (defaults to auto-generated)")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      let password = options.password;

      if (!password) {
        try {
          const { Database } = await import("bun:sqlite");
          const dbPath = join(coleoDir, "coleo.db");
          const db = new Database(dbPath);
          const row = db.query("SELECT value FROM config WHERE key = 'imap_password'").get() as { value: string } | null;
          if (row) {
            password = row.value;
          } else {
            const crypto = await import("crypto");
            password = crypto.randomBytes(16).toString("hex");
            db.run(
              "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
              ["imap_password", password, new Date().toISOString()],
            );
          }
          db.close();
        } catch {
          const crypto = await import("crypto");
          password = crypto.randomBytes(16).toString("hex");
        }
      }

      console.log(`Starting IMAP server...`);
      console.log(`  Host: ${options.host}`);
      console.log(`  Port: ${options.port}`);
      console.log(`  Username: ${options.username}`);
      console.log(`  Password: ${password}`);
      console.log("");
      console.log(`Connect with your email client using:`);
      console.log(`  Server: ${options.host}`);
      console.log(`  Port: ${options.port}`);
      console.log(`  Security: None (local only)`);
      console.log(`  Username: ${options.username}`);
      console.log(`  Password: ${password}`);
      console.log("");

      const server = await startImapServer({
        port: parseInt(options.port, 10),
        host: options.host,
        octopaiDir: coleoDir,
        username: options.username,
        password,
      });

      process.on("SIGINT", async () => {
        console.log("\nStopping IMAP server...");
        await server.stop();
        process.exit(0);
      });

      process.on("SIGTERM", async () => {
        await server.stop();
        process.exit(0);
      });
    });

  imapCmd
    .command("password")
    .description("Show or reset the IMAP password")
    .option("-r, --reset", "Generate a new password")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath);

        if (options.reset) {
          const crypto = await import("crypto");
          const password = crypto.randomBytes(16).toString("hex");
          db.run(
            "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
            ["imap_password", password, new Date().toISOString()],
          );
          console.log(`New IMAP password: ${password}`);
        } else {
          const row = db.query("SELECT value FROM config WHERE key = 'imap_password'").get() as { value: string } | null;
          if (row) {
            console.log(`IMAP password: ${row.value}`);
          } else {
            console.log("No IMAP password set. Start the IMAP server to auto-generate one.");
          }
        }

        db.close();
      } catch (err) {
        console.error(`Failed to access database: ${err}`);
        process.exit(1);
      }
    });
}
