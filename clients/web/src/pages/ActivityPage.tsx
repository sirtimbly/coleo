/**
 * Compatibility redirect for saved Activity panels.
 *
 * Live events now appear as Brain, Arms, and History facets in the Inbox.
 */

import { Navigate } from "react-router-dom";

export function ActivityPage() {
	return <Navigate to="/messaging?facet=history" replace />;
}
