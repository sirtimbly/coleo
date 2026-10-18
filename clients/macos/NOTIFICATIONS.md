# Message notifications

Coleo monitors **Inbox → Messages → Inbox** by default (`inbox-triage`, messages
facet, inbox mailbox). On first launch, allow the native notification permission
prompt. Settings → Message notifications shows permission and monitoring status.

- New messages generate a macOS notification, with sound by default.
- When Coleo is in the background, a brief informational Dock bounce also requests
  attention. The Dock bounce works independently of notification permission.
- Settings lets you add/remove named Messaging views, choose Messages, Attention,
  or All collections, choose a mailbox for Messages, and disable sound/bouncing.
  Click **Save notification settings** to apply and persist the watches.
- Click a notification to bring Coleo to the foreground.

Monitoring is app-owned, not tab-owned. It runs every 15 seconds while the app is
running, regardless of which collection is visible, including when all document
windows are closed. It does not run after quitting the app. macOS notification
settings and Focus determine whether banners and sounds are presented.

The first complete snapshot establishes a silent baseline. Reply message IDs are
tracked individually, so a reply inside an existing thread counts as new; edits,
read-state changes, and messages leaving/reentering a collection do not. Sent-only
thread context does not notify an Inbox watch. Overlapping watched views are
deduplicated by profile and message identity. Restarting the app, reconnecting,
or saving settings starts a fresh baseline, without replaying existing messages.

Each watch resolves its named view through the API, retaining that view's profile
and search constraints, then applies the selected collection/mailbox. A snapshot
traverses all pages (up to 100 pages of 200 items). Unavailable mail sources,
incomplete thread hierarchies, repeated cursors, and scan-limit errors leave the
previous baseline intact and appear in Settings. No alert is generated from a
partially loaded snapshot. Watches refer to server named views, not module catalog
IDs; custom Messaging views can therefore be watched without opening a tab.

Implementation: `MessageNotifications.swift`; regression coverage:
`MessageNotificationTests.swift`. Preferences are stored under
`coleo.messageNotifications` in the app's UserDefaults.
