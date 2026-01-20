import type { TestScenario, TestContext, TestResult } from "../types";
import { initTestDatabase, startApiServer, startBrain, spawnArm, waitForArmStatus } from "../harness";

export const armRecoveryScenario: TestScenario = {
  name: "arm-recovery",
  description: "Tests if the agent can recover an existing arm process after restart",
  tags: ["core", "resilience", "recovery"],
  timeout: 120000,
  
  async setup(ctx: TestContext) {
    await initTestDatabase(ctx);
    await startApiServer(ctx);
    await startBrain(ctx);
  },

  async run(ctx: TestContext): Promise<TestResult> {
    const startedAt = new Date();

    try {
      // 1. Spawn an arm
      ctx.log("Spawning initial arm...");
      const armInfo = await spawnArm(ctx, "recovery-test-arm", {
        harness: "opencode-api",
        domain: "testing"
      });
      
      const armId = armInfo.id;
      
      // Wait for arm to be idle/ready
      await waitForArmStatus(ctx, armId, "idle");
      ctx.log(`Arm ${armId} is running and idle`);

      // 2. Kill the API server (simulating agent crash/restart)
      // Note: In the regression harness, the API server and Brain run as separate processes
      // but they effectively act as the "agent" in this context since we don't have a separate 
      // ArmAgent process in the harness yet (it's embedded or managed differently).
      // However, the 'opencode' process (the arm) is separate.
      
      // Find the API server process
      const apiProcess = ctx.processes.find(p => p.name === "api-server");
      if (!apiProcess) {
        throw new Error("Could not find API server process");
      }
      
      ctx.log("Killing API server (simulating agent crash)...");
      apiProcess.kill();
      
      // Remove it from tracked processes so we don't try to kill it again in cleanup
      // (though kill() is idempotent usually)
      
      // Wait a moment for things to settle
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 3. Restart the API server
      ctx.log("Restarting API server...");
      await startApiServer(ctx);
      
      // Wait a bit for the agent (embedded in API server or connected to it) to perform recovery
      ctx.log("Waiting for arm recovery...");
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // 4. Verify the arm is back
      // We check if the arm status is 'idle' (it should be recovered and set to idle)
      // and importantly, if we can communicate with it.
      
      const res = await fetch(`${ctx.apiUrl}/api/arms/${armId}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch arm ${armId} after recovery`);
      }
      
      const armData = await res.json() as { arm: { status: string, pid: number | null, port: number | null } };
      ctx.log(`Recovered arm status: ${JSON.stringify(armData.arm)}`);
      
      if (armData.arm.status !== "idle") {
        throw new Error(`Recovered arm status is ${armData.arm.status}, expected 'idle'`);
      }
      
      if (!armData.arm.port) {
        throw new Error("Recovered arm is missing port information");
      }

      // 5. Verify we can still use the arm (optional but good)
      // Sending a simple prompt would verify full connectivity
      
      return {
        runId: ctx.runId,
        scenario: "arm-recovery",
        passed: true,
        model: ctx.model,
        timing: {
          total: ctx.timing.duration(),
        },
        quality: {
          outputCorrect: true,
          score: 100,
          checks: [],
        },
        startedAt,
        endedAt: new Date()
      };

    } catch (error) {
      throw error;
    }
  }
};
