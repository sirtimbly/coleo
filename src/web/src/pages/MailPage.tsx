/**
 * Compatibility redirect for saved layouts and legacy Project Mail links.
 *
 * All mailboxes and threaded actions now live in the unified Inbox.
 */

import { Navigate } from "react-router-dom";

export function MailPage() {
	return <Navigate to="/messaging?facet=messages&mailbox=inbox" replace />;
}
