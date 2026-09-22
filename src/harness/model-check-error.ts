/** Expected model-access failures are safe to show in the spawn form. */
export class ModelCheckError extends Error {
  readonly code = "MODEL_CHECK_FAILED";

  constructor(provider: string, model: string, detail: string) {
    super(`Model check failed for ${provider}/${model} on this Arm Host: ${detail} Choose another model or update this host's provider login.`);
    this.name = "ModelCheckError";
  }
}

export function isModelCheckFailure(response: { errorCode?: string; error?: string }): boolean {
  // Older arm hosts send only the message; retain useful errors during rolling restarts.
  return response.errorCode === "MODEL_CHECK_FAILED" || response.error?.startsWith("Model check failed for ") === true;
}
