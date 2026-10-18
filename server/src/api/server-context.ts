import type { Database } from "bun:sqlite";

export interface ServerContext {
  Variables: {
    db: Database;
    startedAt: Date;
  };
}
