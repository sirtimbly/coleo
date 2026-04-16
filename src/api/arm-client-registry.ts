import type { ArmClient } from "../nats/arm-client";

let globalArmClient: ArmClient | null = null;

export function getArmClient(): ArmClient | null {
  return globalArmClient;
}

export function setArmClient(client: ArmClient): void {
  globalArmClient = client;
}
