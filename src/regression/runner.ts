/**
 * Regression Test Runner
 * 
 * Executes test scenarios and collects metrics for comparison.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { spawn } from "bun";
import type { TestSuiteConfig, TestSuiteResult, TestResult, TestScenario } from "./types";
import { runScenario } from "./harness";
import { coreScenarios } from "./scenarios";

/**
 * Default models to test against
 * Using opencode-zen hosted models for cost-effectiveness.
 * These are cheaper alternatives good for regression testing.
 */
const DEFAULT_MODELS = [
  { provider: "opencode", model: "gpt-5.1-codex-mini" },
  { provider: "opencode", model: "claude-3-5-haiku" },
];

/**
 * Clean up orphaned test processes from previous runs
 * This helps ensure we don't have port conflicts or stale processes
 */
async function cleanupOrphanedProcesses(): Promise<void> {
  // Kill any processes listening on test ports (18000-18100)
  // and OpenCode test ports (19300-19400)
  try {
    // Find and kill processes on test API ports
    const lsofApi = spawn(["lsof", "-t", "-i", ":18000-18100"], { stdout: "pipe", stderr: "pipe" });
    const apiPids = await new Response(lsofApi.stdout).text();
    for (const pid of apiPids.trim().split("\n").filter(Boolean)) {
      if (pid === String(process.pid)) continue; // Don't kill self
      try {
        process.kill(parseInt(pid, 10), "SIGKILL");
      } catch {
        // Process may not exist
      }
    }
    
    // Find and kill processes on OpenCode test ports
    const lsofOc = spawn(["lsof", "-t", "-i", ":19300-19400"], { stdout: "pipe", stderr: "pipe" });
    const ocPids = await new Response(lsofOc.stdout).text();
    for (const pid of ocPids.trim().split("\n").filter(Boolean)) {
      if (pid === String(process.pid)) continue; // Don't kill self
      try {
        process.kill(parseInt(pid, 10), "SIGKILL");
      } catch {
        // Process may not exist
      }
    }
  } catch {
    // lsof may not be available or no processes found - that's fine
  }
}

/**
 * Run a test suite
 */
export async function runTestSuite(config: TestSuiteConfig): Promise<TestSuiteResult> {
  const suiteId = randomUUID().slice(0, 8);
  const startedAt = new Date();
  const results: TestResult[] = [];

  // Clean up any orphaned processes from previous runs
  await cleanupOrphanedProcesses();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Octopai Regression Test Suite: ${suiteId}`);
  console.log(`${"=".repeat(60)}\n`);

  // Determine which scenarios to run
  let scenarios = coreScenarios;
  
  if (config.scenarios && config.scenarios.length > 0) {
    scenarios = coreScenarios.filter(s => config.scenarios!.includes(s.name));
  }
  
  if (config.includeTags && config.includeTags.length > 0) {
    scenarios = scenarios.filter(s => 
      config.includeTags!.some(tag => s.tags.includes(tag))
    );
  }
  
  if (config.excludeTags && config.excludeTags.length > 0) {
    scenarios = scenarios.filter(s => 
      !config.excludeTags!.some(tag => s.tags.includes(tag))
    );
  }

  const iterations = config.iterations || 1;
  const models = config.models.length > 0 ? config.models : DEFAULT_MODELS;

  console.log(`Scenarios: ${scenarios.map(s => s.name).join(", ")}`);
  console.log(`Models: ${models.map(m => `${m.provider}/${m.model}`).join(", ")}`);
  console.log(`Iterations: ${iterations}`);
  console.log("");

  // Run scenarios
  for (const scenario of scenarios) {
    for (const model of models) {
      for (let i = 0; i < iterations; i++) {
        const iterLabel = iterations > 1 ? ` (iteration ${i + 1}/${iterations})` : "";
        console.log(`\n${"─".repeat(50)}`);
        console.log(`Running: ${scenario.name} with ${model.provider}/${model.model}${iterLabel}`);
        console.log(`${"─".repeat(50)}`);

        try {
          const result = await runScenario(scenario, model, { keepOnFailure: true });
          result.scenario = scenario.name; // Ensure scenario name is set
          results.push(result);

          const status = result.passed ? "✓ PASSED" : "✗ FAILED";
          const timing = `${result.timing.total}ms`;
          const quality = result.quality ? `quality: ${result.quality.score}%` : "";
          
          console.log(`\n${status} in ${timing} ${quality}`);
          
          if (!result.passed && result.error) {
            console.log(`Error: ${result.error}`);
          }
        } catch (error) {
          console.error(`Scenario crashed: ${error}`);
          results.push({
            runId: randomUUID().slice(0, 8),
            scenario: scenario.name,
            passed: false,
            error: `Crash: ${error}`,
            timing: { total: 0 },
            model,
            startedAt: new Date(),
            endedAt: new Date(),
          });
        }
      }
    }
  }

  const endedAt = new Date();
  const duration = endedAt.getTime() - startedAt.getTime();

  // Calculate summary statistics
  const summary = calculateSummary(results);

  const suiteResult: TestSuiteResult = {
    suiteId,
    startedAt,
    endedAt,
    duration,
    config,
    results,
    summary,
  };

  // Print summary
  printSummary(suiteResult);

  // Save results if output directory specified
  if (config.outputDir) {
    await saveResults(suiteResult, config.outputDir);
  }

  return suiteResult;
}

/**
 * Calculate summary statistics from results
 */
function calculateSummary(results: TestResult[]): TestSuiteResult["summary"] {
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;
  const passRate = total > 0 ? (passed / total) * 100 : 0;

  // Average timing by scenario
  const avgTiming: Record<string, Record<string, number>> = {};
  const scenarioResults = new Map<string, TestResult[]>();
  
  for (const result of results) {
    if (!scenarioResults.has(result.scenario)) {
      scenarioResults.set(result.scenario, []);
    }
    scenarioResults.get(result.scenario)!.push(result);
  }

  for (const [scenario, scenarioRes] of scenarioResults) {
    avgTiming[scenario] = {};
    const timingKeys = new Set<string>();
    
    for (const r of scenarioRes) {
      for (const key of Object.keys(r.timing)) {
        timingKeys.add(key);
      }
    }

    for (const key of timingKeys) {
      const values = scenarioRes
        .map(r => (r.timing as Record<string, number | undefined>)[key])
        .filter((v): v is number => v !== undefined);
      
      if (values.length > 0) {
        avgTiming[scenario][key] = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      }
    }
  }

  // Average quality by scenario
  const avgQuality: Record<string, number> = {};
  for (const [scenario, scenarioRes] of scenarioResults) {
    const scores = scenarioRes
      .map(r => r.quality?.score)
      .filter((s): s is number => s !== undefined);
    
    if (scores.length > 0) {
      avgQuality[scenario] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }
  }

  // Results by model
  const byModel: Record<string, { passed: number; failed: number; avgTime: number; avgQuality: number }> = {};
  const modelResults = new Map<string, TestResult[]>();
  
  for (const result of results) {
    const modelKey = `${result.model.provider}/${result.model.model}`;
    if (!modelResults.has(modelKey)) {
      modelResults.set(modelKey, []);
    }
    modelResults.get(modelKey)!.push(result);
  }

  for (const [modelKey, modelRes] of modelResults) {
    const modelPassed = modelRes.filter(r => r.passed).length;
    const modelFailed = modelRes.length - modelPassed;
    const times = modelRes.map(r => r.timing.total);
    const qualities = modelRes
      .map(r => r.quality?.score)
      .filter((s): s is number => s !== undefined);

    byModel[modelKey] = {
      passed: modelPassed,
      failed: modelFailed,
      avgTime: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      avgQuality: qualities.length > 0 
        ? Math.round(qualities.reduce((a, b) => a + b, 0) / qualities.length)
        : 0,
    };
  }

  return {
    total,
    passed,
    failed,
    passRate,
    avgTiming,
    avgQuality,
    byModel,
  };
}

/**
 * Print summary to console
 */
function printSummary(result: TestSuiteResult): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST SUITE SUMMARY");
  console.log(`${"=".repeat(60)}\n`);

  console.log(`Suite ID: ${result.suiteId}`);
  console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
  console.log(`Total: ${result.summary.total} | Passed: ${result.summary.passed} | Failed: ${result.summary.failed}`);
  console.log(`Pass Rate: ${result.summary.passRate.toFixed(1)}%\n`);

  // By scenario
  console.log("By Scenario:");
  for (const [scenario, timing] of Object.entries(result.summary.avgTiming)) {
    const quality = result.summary.avgQuality[scenario];
    console.log(`  ${scenario}:`);
    console.log(`    Avg Time: ${timing.total}ms`);
    if (quality !== undefined) {
      console.log(`    Avg Quality: ${quality}%`);
    }
  }

  // By model
  console.log("\nBy Model:");
  for (const [model, stats] of Object.entries(result.summary.byModel)) {
    const rate = ((stats.passed / (stats.passed + stats.failed)) * 100).toFixed(0);
    console.log(`  ${model}: ${stats.passed}/${stats.passed + stats.failed} (${rate}%) | ${stats.avgTime}ms avg | ${stats.avgQuality}% quality`);
  }

  console.log("");
}

/**
 * Save results to disk
 */
async function saveResults(result: TestSuiteResult, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  
  const filename = `regression-${result.suiteId}-${result.startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  const filepath = join(outputDir, filename);
  
  await writeFile(filepath, JSON.stringify(result, null, 2));
  console.log(`Results saved to: ${filepath}`);
}

/**
 * CLI entry point
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // Parse arguments
  const config: TestSuiteConfig = {
    models: [],
    scenarios: [],
    includeTags: [],
    excludeTags: [],
    iterations: 1,
    outputDir: join(process.cwd(), ".octopai", "regression-results"),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    
    if (arg === "--model" && nextArg) {
      const parts = nextArg.split("/");
      const provider = parts[0] || "anthropic";
      const model = parts[1] || "claude-sonnet-4-20250514";
      config.models.push({ provider, model });
      i++;
    } else if (arg === "--scenario" && nextArg) {
      config.scenarios!.push(nextArg);
      i++;
    } else if (arg === "--tag" && nextArg) {
      config.includeTags!.push(nextArg);
      i++;
    } else if (arg === "--exclude-tag" && nextArg) {
      config.excludeTags!.push(nextArg);
      i++;
    } else if (arg === "--iterations" && nextArg) {
      config.iterations = parseInt(nextArg, 10);
      i++;
    } else if (arg === "--output" && nextArg) {
      config.outputDir = nextArg;
      i++;
    } else if (arg === "--quick") {
      config.includeTags!.push("quick");
    } else if (arg === "--help") {
      console.log(`
Octopai Regression Test Runner

Usage: bun run src/regression/runner.ts [options]

Options:
  --model <provider/model>  Model to test (can be repeated)
  --scenario <name>         Specific scenario to run (can be repeated)
  --tag <tag>               Include scenarios with tag (can be repeated)
  --exclude-tag <tag>       Exclude scenarios with tag (can be repeated)
  --iterations <n>          Number of times to run each scenario
  --output <dir>            Directory to save results
  --quick                   Only run quick tests (shortcut for --tag quick)
  --help                    Show this help

Examples:
  # Run all core tests with default model
  bun run src/regression/runner.ts

  # Run quick tests only
  bun run src/regression/runner.ts --quick

  # Compare two models
  bun run src/regression/runner.ts --model anthropic/claude-sonnet-4-20250514 --model openai/gpt-4o

  # Run specific scenario 3 times
  bun run src/regression/runner.ts --scenario simple-task-completion --iterations 3

Available scenarios:
${coreScenarios.map(s => `  - ${s.name}: ${s.description} [${s.tags.join(", ")}]`).join("\n")}
`);
      process.exit(0);
    }
  }

  // Use default model if none specified
  if (config.models.length === 0) {
    config.models = DEFAULT_MODELS;
  }

  const result = await runTestSuite(config);
  
  // Exit with error code if any tests failed
  process.exit(result.summary.failed > 0 ? 1 : 0);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
