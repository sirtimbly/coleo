import { api } from "@/lib";
import { createCardRoute } from "./card-route";

import type { CardEnvelope } from "../../../types/adaptive-cards";

export async function createPersistedCardRoute(envelope: CardEnvelope) {
	const response = await api.saveWorkbenchCardInstance(envelope);
	return createCardRoute(
		response.instance.id,
		envelope.presentation.title ?? "Card",
	);
}
