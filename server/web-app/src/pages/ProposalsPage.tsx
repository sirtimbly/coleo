/**
 * Compatibility redirect for the former Proposals placeholder.
 *
 * Proposal events and attention signals now appear in Inbox history.
 */

import { Navigate } from "react-router-dom";

export function ProposalsPage() {
	return <Navigate to="/messaging?facet=history" replace />;
}
