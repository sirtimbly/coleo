#!/usr/bin/env bun
/**
 * Coleo CLI
 *
 * AI agent orchestrator using the Octopus Model
 */

import { loadEnvFile } from "./context";
import { buildCliProgram } from "./program";

await loadEnvFile();

const program = buildCliProgram();
await program.parseAsync();
