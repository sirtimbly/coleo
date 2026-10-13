import type { MailThreadMessageInput } from "../mail-thread-model";

function message(
	id: string, thread: string, title: string, body: string, minute: number,
	parent?: string, ancestors: readonly string[] = [], mailbox: "inbox" | "sent" = "inbox", seen = false,
): MailThreadMessageInput {
	return { id, mailbox, subject: title, body, from: mailbox === "sent" ? "East <east@example.test>" : `${id.includes("tui") ? "North" : "Tim"} <review@example.test>`,
		timestamp: `2026-10-01T12:${String(minute).padStart(2, "0")}:00.000Z`, seen,
		headers: { "Message-ID": `<${id}@example.test>`, "X-Coleo-Thread-Id": thread,
			...(parent ? { "In-Reply-To": `<${parent}@example.test>` } : {}),
			...(ancestors.length ? { References: ancestors.map((ancestor) => `<${ancestor}@example.test>`).join(" ") } : {}),
		},
	};
}

/** Branching and cross-mailbox fixture, written to a temporary Maildir and projected through the actual API. */
export const THREADED_MAIL_FIXTURE: readonly MailThreadMessageInput[] = [
	message("review-root", "review", "Can we review the delivery blueprint?", "Two branches need review: the API projection and terminal parity.", 20),
	message("review-api", "review", "API branch: scoped paging", "Keep the normalized query and per-source continuation boundaries together.", 21,
		"review-root", ["review-root"]),
	message("review-api-check", "review", "API branch: verify partial sources", "Confirm that a mail outage retains the loaded thread instead of making it disappear.", 22,
		"review-api", ["review-root", "review-api"]),
	message("review-terminal", "review", "Terminal branch: one named view", "The same groups and resource IDs should appear in the web, CLI, and TUI.", 23,
		"review-root", ["review-root"], "sent", true),
	message("review-tui", "review", "Terminal branch: TUI visibility", "Collapsing a branch should keep its selected descendants. Show how many selected messages are hidden.", 24,
		"review-terminal", ["review-root", "review-terminal"]),
	message("handoff-root", "handoff", "Handoff notes for the terminal rewrite", "Keep selection separate from keyboard focus and expansion state.", 10,
		undefined, [], "inbox", true),
	message("handoff-cli", "handoff", "CLI handoff: export the tree", "JSON needs parent IDs, visible IDs, and the explicit selected-member snapshot.", 11,
		"handoff-root", ["handoff-root"], "sent", true),
	message("handoff-tui", "handoff", "TUI handoff: keyboard groups", "Left and right fold branches; space selects the loaded branch. Incoming replies are not auto-selected.", 12,
		"handoff-cli", ["handoff-root", "handoff-cli"], "inbox", true),
];
