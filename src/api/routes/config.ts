/**
 * Configuration API Routes
 * 
 * CRUD operations for system configuration.
 * Reads from and writes to ~/.octopai/config.toml
 */

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import {
  loadConfig,
  updateConfig,
  readTomlConfig,
  writeTomlConfig,
  configToToml,
  getOctopaiDir,
} from "../../config";
import type { OctopaiConfig } from "../../types";

interface ConfigContext {
  Variables: {
    db: Database;
  };
}

export function createConfigRoutes() {
  const app = new Hono<ConfigContext>();

  /**
   * Get full configuration
   * GET /api/config
   */
  app.get("/", async (c) => {
    try {
      const config = await loadConfig();
      return c.json({ config });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to load config: ${message}`);
    }
  });

  /**
   * Update configuration
   * PATCH /api/config
   * 
   * Accepts partial config updates that are merged with existing config.
   */
  app.patch("/", async (c) => {
    try {
      const updates = await c.req.json<Partial<OctopaiConfig>>();
      const config = await updateConfig(updates);
      return c.json({ config });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to update config: ${message}`);
    }
  });

  /**
   * Get raw TOML content
   * GET /api/config/toml
   */
  app.get("/toml", async (c) => {
    try {
      const toml = await readTomlConfig();
      if (!toml) {
        return c.json({ toml: null, message: "No config file found" });
      }
      return c.json({ toml });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to read config: ${message}`);
    }
  });

  /**
   * Write raw TOML content
   * PUT /api/config/toml
   */
  app.put("/toml", async (c) => {
    try {
      const body = await c.req.json<{ toml: Record<string, unknown> }>();
      if (!body.toml) {
        throw HttpError.badRequest("toml field is required");
      }
      await writeTomlConfig(body.toml);
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to write config: ${message}`);
    }
  });

  /**
   * Get defaults section only
   * GET /api/config/defaults
   */
  app.get("/defaults", async (c) => {
    try {
      const config = await loadConfig();
      return c.json({ defaults: config.defaults });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to load config: ${message}`);
    }
  });

  /**
   * Update defaults section
   * PATCH /api/config/defaults
   */
  app.patch("/defaults", async (c) => {
    try {
      const updates = await c.req.json<Partial<OctopaiConfig["defaults"]>>();
      const config = await updateConfig({ defaults: updates as OctopaiConfig["defaults"] });
      return c.json({ defaults: config.defaults });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to update config: ${message}`);
    }
  });

  /**
   * Get brain configuration
   * GET /api/config/brain
   */
  app.get("/brain", async (c) => {
    try {
      const config = await loadConfig();
      return c.json({ brain: config.brain });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to load config: ${message}`);
    }
  });

  /**
   * Update brain configuration
   * PATCH /api/config/brain
   */
  app.patch("/brain", async (c) => {
    try {
      const updates = await c.req.json<Partial<OctopaiConfig["brain"]>>();
      const config = await updateConfig({ brain: updates as OctopaiConfig["brain"] });
      return c.json({ brain: config.brain });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to update config: ${message}`);
    }
  });

  return app;
}
