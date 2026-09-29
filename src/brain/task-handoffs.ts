type ApiRequest = <T>(path: string, options?: RequestInit) => Promise<T | null>;

/** The API owns dependency checks; unsuccessful handoffs stay queued for retry. */
export async function activatePreparedTaskHandoffs(
	request: ApiRequest,
	log: (message: string) => void,
): Promise<void> {
	const response = await request<{ handoffs: Array<{ id: string; taskId: string }> }>("/api/tasks/handoff");
	for (const handoff of response?.handoffs ?? []) {
		const activated = await request<{ handoff: { status: string } }>(
			`/api/tasks/handoff/${encodeURIComponent(handoff.id)}/activate`, { method: "POST" },
		);
		if (activated?.handoff.status === "activated") log(`Prepared task activated: ${handoff.taskId}`);
	}
}
