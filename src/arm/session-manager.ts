/**
 * Session Manager
 *
 * Manages active harness sessions for spawned arms.
 */

import { harnessRegistry, type HarnessSession, type SendPromptOptions } from "../harness";

/**
 * Active harness sessions - maps arm ID to session
 */
const activeSessions = new Map<string, HarnessSession>();

/**
 * Get an active harness session by arm ID
 */
export function getHarnessSession(armId: string): HarnessSession | undefined {
  return activeSessions.get(armId);
}

/**
 * Store a harness session for an arm
 */
export function storeHarnessSession(armId: string, session: HarnessSession): void {
  activeSessions.set(armId, session);
}

/**
 * Send a prompt to an arm via its harness session
 * @param options.interrupt - If true, send escape key twice before prompt to cancel current work
 */
export async function sendPromptToArm(armId: string, prompt: string, options?: SendPromptOptions): Promise<void> {
  const session = activeSessions.get(armId);
  if (!session) {
    throw new Error(`No active harness session for arm ${armId}`);
  }

  const harness = harnessRegistry.get(session.harnessName);
  await harness.sendPrompt(session, prompt, options);
}

/**
 * Get the state of an arm via its harness session
 */
export async function getArmState(armId: string): Promise<string> {
  const session = activeSessions.get(armId);
  if (!session) {
    return "unknown";
  }

  const harness = harnessRegistry.get(session.harnessName);
  return harness.getState(session);
}
