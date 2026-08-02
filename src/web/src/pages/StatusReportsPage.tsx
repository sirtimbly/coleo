/**
 * Route adapter for the reusable operational History projection.
 *
 * History also appears as an Inbox facet; this route remains available for
 * saved layouts and deep links while navigation converges on the Inbox.
 */

import { usePageTitle } from "@/hooks/usePageTitle";
import { HistoryProjection } from "@/workbench/HistoryProjection";

export function StatusReportsPage() {
	usePageTitle("Coleo Observatory - History");
	return <HistoryProjection />;
}
