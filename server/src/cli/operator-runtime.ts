import { getColeoDir } from "../config";
import { registerServiceProcess, unregisterServiceProcess, getServiceStatus, saveLaunchArgs } from "../daemon";
import type { ServiceType } from "../daemon";
import type { OperatorValues } from "./operator-config";

export async function runOperatorService(service: ServiceType, values: OperatorValues, options: { cycles?: number; launchArgs?: string[] } = {}): Promise<void> {
  if ((await getServiceStatus(service)).running) throw new Error(`${service} is already running in ${getColeoDir()}`);
  if (service === "brain") {
    const { Brain } = await import("../brain");
    const brain = new Brain({ coleoDir: getColeoDir(), pollIntervalMs: Number(values.interval),
      verbose: values.verbose === "true", swarmEvaluationMode: values.swarmEvaluation as "off" | "shadow" | "execute",
      swarmWindowPolls: Number(values.swarmWindowPolls) });
    await brain.init();
    const stop = () => brain.stop();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      await registerServiceProcess(service);
      if (options.launchArgs) await saveLaunchArgs(service, options.launchArgs);
      if (options.cycles === 1) await brain.runOnce();
      else if (options.cycles) await brain.runCycles(options.cycles, Number(values.interval));
      else await brain.run();
    }
    finally { await brain.shutdown(); await unregisterServiceProcess(service); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    return;
  }
  let shutdown: () => Promise<void>;
  if (service === "agent") {
    const { ArmAgent } = await import("../agent");
    const agent = new ArmAgent({ agentId: values.id, coleoDir: getColeoDir(), workspaceRoot: values.workspace,
      natsUrl: values.natsUrl, natsToken: values.natsToken || undefined, maxArms: Number(values.maxArms),
      heartbeatIntervalMs: Number(values.heartbeatInterval), debug: values.verbose === "true" });
    shutdown = () => agent.stop();
    try { await agent.start(); } catch (error) { await shutdown(); throw error; }
  } else {
    const { ensureLocalNatsForServe } = await import("./local-nats");
    const { startServer } = await import("../api");
    await ensureLocalNatsForServe();
    const runtime = await startServer({ host: values.host, port: Number(values.port) });
    shutdown = async () => {
      await runtime.server.stop(true);
      await runtime.harnessManager.shutdown();
      await runtime.armClient?.disconnect();
      await runtime.nats?.disconnect();
      runtime.db.close();
    };
  }
  try {
    await registerServiceProcess(service);
    if (options.launchArgs) await saveLaunchArgs(service, options.launchArgs);
  } catch (error) { await shutdown(); await unregisterServiceProcess(service); throw error; }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await shutdown(); await unregisterServiceProcess(service); process.exit(0); }
    catch (error) { console.error(error); process.exit(1); }
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
