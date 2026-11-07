import { instructionPanel, instructionCommands } from "./ops-style";
import type { SetupFailure, SetupResult } from "./ops-setup";
import type { OpsHealth } from "./ops-health";

export function reportHealthProgress(result: OpsHealth): void {
  const blockers = result.checks.filter(check => check.status === "unknown" || check.status === "fail");
  const healthy = result.checks.filter(check => check.status === "pass").length;
  const skipped = result.checks.filter(check => check.status === "skipped").length;
  process.stderr.write(instructionPanel(blockers.length ? "Waiting for central readiness" : "Confirming service readiness", [
    `${healthy} healthy · ${skipped} skipped · ${blockers.length} pending`, "",
    ...blockers.map(check => `${check.name}: ${check.detail}`),
    blockers.length ? "Status changes will appear here. Ctrl-C saves setup progress." : "Waiting for a second green snapshot…",
  ], blockers.length ? "warning" : "success") + "\n");
}

export function formatSetupFailure(error: SetupFailure): string {
  const { result } = error;
  const attemptedStartup = ["api", "brain", "host"].some(step => step in (result.steps ?? {}));
  const lines = [
    ...(result.failedStep ? [`Stopped at: ${result.failedStep.replaceAll("_", " ")}`] : []),
    error.message,
    ...result.checks.filter(check => check.status === "unknown" || check.status === "fail")
      .map(check => `${check.name}: ${check.detail}`),
    "",
    !attemptedStartup ? "Service startup was not reached."
      : result.startedServices?.length ? `Services started by this run: ${result.startedServices.join(", ")}. They were left running.`
      : "No services were confirmed started by this run. Inspect diagnostics before retrying.",
    ...(result.runtime ? [`Progress saved in ${result.runtime}/setup.json.`] : []),
  ];
  return instructionPanel(error.cancelled ? "Setup cancelled." : "Setup incomplete.", lines, "warning")
    + "\n" + instructionCommands("After resolving the issue:", [...new Set(result.nextCommands)]);
}
export function formatSetupSuccess(result: SetupResult): string {
  return instructionPanel("Setup complete — central services are ready.", [
    `API: ${result.server}`,
    `Clients: ${result.clients?.join(", ")}`,
    `Runtime: ${result.runtime}`,
  ], "success", process.stdout) + "\n"
    + instructionCommands("Check status at any time:", result.nextCommands, process.stdout);
}
