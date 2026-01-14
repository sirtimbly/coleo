/**
 * Configuration API Routes
 * 
 * CRUD operations for system configuration.
 * Reads from and writes to ~/.octopai/config.toml
 * Also handles arm config files in ~/.octopai/arms/*.toml
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
import type { OctopaiConfig, ArmConfig, ArmConfigSummary } from "../../types";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

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
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to update config: ${message}`);
    }
  });

  // ========================================
  // Arm Configuration Files
  // ========================================

  /**
   * Get arms config directory path
   */
  const getArmsConfigDir = async (): Promise<string> => {
    const octopaiDir = await getOctopaiDir();
    return join(octopaiDir, "arms");
  };

  /**
   * List all arm config files
   * GET /api/config/arms
   */
  app.get("/arms", async (c) => {
    try {
      const armsDir = await getArmsConfigDir();
      
      // Create dir if doesn't exist
      if (!existsSync(armsDir)) {
        await mkdir(armsDir, { recursive: true });
        return c.json({ arms: [] });
      }

      const files = await readdir(armsDir);
      const tomlFiles = files.filter(f => f.endsWith('.toml'));

      const arms: ArmConfigSummary[] = [];
      for (const filename of tomlFiles) {
        try {
          const content = await readFile(join(armsDir, filename), 'utf-8');
          const parsed = parseToml(content) as unknown as ArmConfig;
          arms.push({
            filename,
            name: parsed.arm?.name || filename.replace('.toml', ''),
            domain: parsed.arm?.domain || 'unknown',
            harness: parsed.arm?.harness || 'opencode',
            budget: parsed.context?.budget,
          });
        } catch {
          // Skip invalid files
          arms.push({
            filename,
            name: filename.replace('.toml', ''),
            domain: 'unknown',
            harness: 'unknown',
          });
        }
      }

      return c.json({ arms });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to list arm configs: ${message}`);
    }
  });

  /**
   * Get specific arm config file
   * GET /api/config/arms/:name
   */
  app.get("/arms/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const armsDir = await getArmsConfigDir();
      const filename = name.endsWith('.toml') ? name : `${name}.toml`;
      const filepath = join(armsDir, filename);

      if (!existsSync(filepath)) {
        throw HttpError.notFound(`Arm config '${name}' not found`);
      }

      const content = await readFile(filepath, 'utf-8');
      const config = parseToml(content) as unknown as ArmConfig;

      return c.json({ 
        filename,
        config,
        raw: content,
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to read arm config: ${message}`);
    }
  });

  /**
   * Update arm config file
   * PUT /api/config/arms/:name
   * 
   * Can accept either:
   * - { config: ArmConfig } - will be converted to TOML
   * - { raw: string } - raw TOML content
   */
  app.put("/arms/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const armsDir = await getArmsConfigDir();
      const filename = name.endsWith('.toml') ? name : `${name}.toml`;
      const filepath = join(armsDir, filename);

      // Ensure directory exists
      if (!existsSync(armsDir)) {
        await mkdir(armsDir, { recursive: true });
      }

      const body = await c.req.json<{ config?: ArmConfig; raw?: string }>();

      let content: string;
      if (body.raw) {
        // Validate it's valid TOML
        parseToml(body.raw);
        content = body.raw;
      } else if (body.config) {
        content = stringifyToml(body.config as unknown as Record<string, unknown>);
      } else {
        throw HttpError.badRequest("Either 'config' or 'raw' field is required");
      }

      await writeFile(filepath, content, 'utf-8');

      const config = parseToml(content) as unknown as ArmConfig;
      return c.json({ 
        filename, 
        config,
        raw: content,
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to update arm config: ${message}`);
    }
  });

  /**
   * Delete arm config file
   * DELETE /api/config/arms/:name
   */
  app.delete("/arms/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const armsDir = await getArmsConfigDir();
      const filename = name.endsWith('.toml') ? name : `${name}.toml`;
      const filepath = join(armsDir, filename);

      if (!existsSync(filepath)) {
        throw HttpError.notFound(`Arm config '${name}' not found`);
      }

      const { unlink } = await import("fs/promises");
      await unlink(filepath);

      return c.json({ deleted: true, filename });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to delete arm config: ${message}`);
    }
  });

  return app;
}
