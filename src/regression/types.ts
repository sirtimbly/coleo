/**
 * Regression Test Types
 * 
 * Types for automated regression testing of Coleo scenarios.
 * Tracks timing, quality, and success metrics across different models.
 */

/**
 * Result of a single test run
 */
export interface TestResult {
  /** Unique test run ID */
  runId: string;
  /** Test scenario name */
  scenario: string;
  /** Whether the test passed */
  passed: boolean;
  /** Error message if failed */
  error?: string;
  /** Time metrics in milliseconds */
  timing: {
    /** Total test duration */
    total: number;
    /** Time to start infrastructure */
    infraStartup?: number;
    /** Time for brain to become healthy */
    brainHealthy?: number;
    /** Time to spawn arm */
    armSpawn?: number;
    /** Time for arm to claim task */
    taskClaimed?: number;
    /** Time to complete task */
    taskCompleted?: number;
  };
  /** Quality metrics */
  quality?: {
    /** Did the output match expected result */
    outputCorrect: boolean;
    /** Quality score 0-100 */
    score: number;
    /** Specific quality checks */
    checks: Array<{
      name: string;
      passed: boolean;
      details?: string;
    }>;
  };
  /** Model/provider used */
  model: {
    provider: string;
    model: string;
  };
  /** Timestamp when test started */
  startedAt: Date;
  /** Timestamp when test ended */
  endedAt: Date;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Test scenario definition
 */
export interface TestScenario {
  /** Unique scenario name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Tags for filtering */
  tags: string[];
  /** Timeout in milliseconds */
  timeout: number;
  /** Setup function - runs before test */
  setup?: (ctx: TestContext) => Promise<void>;
  /** The test function */
  run: (ctx: TestContext) => Promise<TestResult>;
  /** Teardown function - runs after test (always) */
  teardown?: (ctx: TestContext) => Promise<void>;
  /** Quality evaluation function */
  evaluate?: (ctx: TestContext, result: TestResult) => Promise<TestResult>;
}

/**
 * Test execution context
 */
export interface TestContext {
  /** Unique run ID */
  runId: string;
  /** Isolated coleo directory for this test */
  coleoDir: string;
  /** Working directory for test files */
  workDir: string;
  /** API server port (if running) */
  apiPort: number;
  /** API server URL */
  apiUrl: string;
  /** API key */
  apiKey: string;
  /** Model configuration */
  model: {
    provider: string;
    model: string;
  };
  /** Log function */
  log: (message: string) => void;
  /** Timing helper */
  timing: TimingHelper;
  /** Database connection (if available) */
  db?: import("bun:sqlite").Database;
  /** Subprocess handles for cleanup */
  processes: Array<{ pid: number; name: string; kill: () => void }>;
  /** Spawned arm info for cleanup */
  arms: Array<{ id: string; pid?: number; port?: number }>;
}

/**
 * Helper for tracking timing
 */
export interface TimingHelper {
  /** Mark a timing point */
  mark: (name: string) => void;
  /** Get duration between two marks (or from start) */
  duration: (from?: string, to?: string) => number;
  /** Get all timing data */
  all: () => Record<string, number>;
}

/**
 * Test suite configuration
 */
export interface TestSuiteConfig {
  /** Models to test against */
  models: Array<{
    provider: string;
    model: string;
    env?: Record<string, string>;
  }>;
  /** Scenarios to run (by name or tag) */
  scenarios?: string[];
  /** Tags to include */
  includeTags?: string[];
  /** Tags to exclude */
  excludeTags?: string[];
  /** Number of times to run each scenario (for reliability testing) */
  iterations?: number;
  /** Directory to store results */
  outputDir?: string;
  /** Whether to run scenarios in parallel */
  parallel?: boolean;
  /** Maximum concurrent tests */
  maxConcurrency?: number;
}

/**
 * Aggregated results from a test suite run
 */
export interface TestSuiteResult {
  /** Suite run ID */
  suiteId: string;
  /** When suite started */
  startedAt: Date;
  /** When suite ended */
  endedAt: Date;
  /** Total duration in ms */
  duration: number;
  /** Configuration used */
  config: TestSuiteConfig;
  /** Individual test results */
  results: TestResult[];
  /** Summary statistics */
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    /** Average timing by scenario */
    avgTiming: Record<string, Record<string, number>>;
    /** Average quality by scenario */
    avgQuality: Record<string, number>;
    /** Results grouped by model */
    byModel: Record<string, {
      passed: number;
      failed: number;
      avgTime: number;
      avgQuality: number;
    }>;
  };
}

/**
 * Infrastructure state for testing
 */
export interface InfrastructureState {
  database: boolean;
  apiServer: boolean;
  nats: boolean;
  brain: boolean;
}

/**
 * Task completion state
 */
export interface TaskState {
  id: string;
  status: "pending" | "claimed" | "in_progress" | "completed" | "blocked" | "cancelled";
  assignedTo?: string;
  result?: string;
}

/**
 * Arm state
 */
export interface ArmState {
  id: string;
  name: string;
  status: "starting" | "idle" | "busy" | "stopped";
  pid?: number;
  currentTask?: string;
}
