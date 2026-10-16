/**
 * Compatibility redirect for saved History panels.
 *
 * Operational history now appears as a facet in the unified Inbox.
 */

import { Navigate } from "react-router-dom";

export function StatusReportsPage() {
	return <Navigate to="/messaging?facet=history" replace />;
}
