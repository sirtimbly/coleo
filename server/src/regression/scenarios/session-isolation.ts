import type { TestScenario, TestContext, TestResult } from "../types";
import { initTestDatabase, startApiServer, startBrain, spawnArm, waitForArmStatus } from "../harness";

const SESSION_ISOLATION_MODEL = {
  provider: "opencode",
  model: "gpt-5.1-codex-mini",
} as const;

/**
 * Session Isolation Test
 * 
 * Verifies that multiple arms get unique OpenCode sessions and don't
 * cross-contaminate each other's conversation history.
 *
 * This regression talks to the OpenCode API harness directly and
 * identifies each arm's session by the generated session title.
 */
export const sessionIsolationScenario: TestScenario = {
  name: "session-isolation",
  description: "Verifies that multiple arms get unique OpenCode sessions",
  tags: ["core", "isolation", "session", "quick"],
  models: [SESSION_ISOLATION_MODEL],
  timeout: 180000, // 3 minutes - spawning multiple arms takes time
  
  async setup(ctx: TestContext) {
    await initTestDatabase(ctx);
    await startApiServer(ctx);
    await startBrain(ctx);
  },

  async run(ctx: TestContext): Promise<TestResult> {
    const startedAt = new Date();
    const armSessions: Map<string, string> = new Map();

    try {
      // 1. Spawn first arm
      ctx.log("Spawning first arm (arm-alpha)...");
      const arm1 = await spawnArm(ctx, "arm-alpha", {
        harness: "opencode-api",
        ...SESSION_ISOLATION_MODEL,
      });
      await waitForArmStatus(ctx, arm1.id, "idle");
      ctx.log(`First arm spawned: ${arm1.id} on port ${arm1.port}`);

      // Get session ID for first arm
      if (arm1.port) {
        const session1 = await getOpenCodeSession(arm1.port, arm1.id);
        if (session1) {
          armSessions.set(arm1.id, session1);
          ctx.log(`Arm ${arm1.id} has session: ${session1}`);
        }
      }

      // 2. Spawn second arm
      ctx.log("Spawning second arm (arm-beta)...");
      const arm2 = await spawnArm(ctx, "arm-beta", {
        harness: "opencode-api",
        ...SESSION_ISOLATION_MODEL,
      });
      await waitForArmStatus(ctx, arm2.id, "idle");
      ctx.log(`Second arm spawned: ${arm2.id} on port ${arm2.port}`);

      // Get session ID for second arm
      if (arm2.port) {
        const session2 = await getOpenCodeSession(arm2.port, arm2.id);
        if (session2) {
          armSessions.set(arm2.id, session2);
          ctx.log(`Arm ${arm2.id} has session: ${session2}`);
        }
      }

      // 3. Verify session isolation
      const sessions = Array.from(armSessions.values());
      
      if (sessions.length < 2) {
        throw new Error(`Expected 2 sessions, got ${sessions.length}. Could not retrieve session IDs.`);
      }

      const [session1, session2] = sessions;
      
      if (session1 === session2) {
        throw new Error(
          `Session isolation FAILED: Both arms share session ${session1}. ` +
          `This indicates the fix in opencode-tui.ts is not working.`
        );
      }

      ctx.log(`Session isolation PASSED:`);
      ctx.log(`  - arm-alpha: ${session1}`);
      ctx.log(`  - arm-beta: ${session2}`);

      // 4. Optionally verify sessions have different titles (if API supports it)
      // This would further confirm the fix includes arm ID in session title

      return {
        runId: ctx.runId,
        scenario: "session-isolation",
        passed: true,
        model: ctx.model,
        timing: {
          total: ctx.timing.duration(),
        },
        quality: {
          outputCorrect: true,
          score: 100,
          checks: [
            { name: "unique_sessions", passed: true, details: `Sessions are unique: ${session1} vs ${session2}` },
          ],
        },
        startedAt,
        endedAt: new Date()
      };

    } catch (error) {
      ctx.log(`Session isolation test failed: ${error}`);
      throw error;
    }
  }
};

/**
 * Get the current session ID from an OpenCode server
 */
async function getOpenCodeSession(port: number, armId: string): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      signal: AbortSignal.timeout(5000),
    });
    
    if (!response.ok) {
      return null;
    }

    const sessions = await response.json() as Array<{ id: string; title?: string }>;
    
    if (sessions.length === 0) {
      return null;
    }

    // OpenCode can expose a shared session catalog. Pick the session that
    // belongs to this arm instead of assuming the first row is local.
    const matchingSession = sessions.find((session) =>
      session.title?.startsWith(`Coleo Arm: ${armId}`),
    );

    return matchingSession?.id || sessions[0]?.id || null;
  } catch {
    return null;
  }
}
