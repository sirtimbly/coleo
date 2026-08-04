# Adaptive Cards in the Workbench

Adaptive Cards are a presentation and lightweight interaction boundary for
Coleo's Inbox, semantic event streams, singleton details, and docked panels.
They do not replace the task, bug, mail, Arm, event, or layout data models.

## Architecture

Every rendered card is a `CardEnvelope`. The envelope selects an immutable
host-owned template version, supplies JSON data, identifies the underlying
resource and creator, and records the target surface. The web host expands the
template and renders Adaptive Cards schema 1.5 with Coleo's host configuration.

Creator identities are host-rendered rather than template-provided:

- Brain uses the Coleo octopus mark.
- The local user uses the brass diving-helmet operator portrait.
- Arms use mirrored pixel identicons derived deterministically from their IDs.

This keeps identities stable without allowing card producers to inject image
URLs. Cards without a meaningful author can omit `creator`.

Templates cannot select arbitrary URLs, HTTP methods, or service calls.
`Action.Execute` verbs are dispatched through an allowlist. The server
re-authorizes every mutation against the referenced domain resource and treats
all card input as untrusted.

The catalog contains:

- `workbench.event@1` for Inbox and semantic Arm/event streams
- `workbench.message@1` for message summaries
- `workbench.resource-detail@1` and `workbench.resource-editor@1` for persisted
  compatibility
- `workbench.resource-detail@2` for structured singleton details with a table
  and progressive disclosure
- `workbench.resource-editor@2` for typed, allowlisted edits

Developers can open `/card-catalog` to preview every trusted template and
inspect the action payload it produces without executing a mutation. Set
`VITE_ADAPTIVE_CARDS=false` to exercise the readable fallback path.

Every non-editor card exposes a settings icon in its creator bar. Compact and
full-detail modes can be applied to one card or to all cards. The global choice
is saved locally; "Use surface defaults" restores compact streams and detailed
singleton views. Item overrides stay session-local. Editor cards always use
full detail so inputs cannot be hidden accidentally.

Mail thread panels treat "Full details for all cards" as their shared default,
so every message body is readable on entry unless the user has explicitly
chosen another saved presentation mode.

Raw Arm logs, diffs, threaded discussions, charts, tabular sheets, and plan
editors remain specialized Workbench projections.

## Inbox projection

The Inbox uses Tabulator as a read-only, virtualized scan surface rather than
rendering every item as a card. Each row shows only the fields needed to triage
the queue: state, source, subject and summary, item type, and received time.
Sorting, facets, search, responsive column hiding, and bulk read state remain
host-owned behaviors.

Inbox facets use one compact, keyboard-accessible dropdown pattern for view,
mailbox, and Brain activity category filters. The selected values are reflected
in the panel route so a filtered Inbox can be restored, deep-linked, or popped
out without losing its context. The table header deliberately remains dark with
high-contrast labels and sort indicators in both application themes.

Activating a row expander mounts that item's full Adaptive Card immediately
below the scan row. Collapsing the row disposes the React and Adaptive Cards
roots. Consequently a large Inbox keeps only visible table rows and explicitly
expanded cards alive; it never creates one Adaptive Cards SDK instance per
record. Double-clicking a row or using its card-header open control sends the
same item to a Golden Layout panel. Semantic buttons inside the card continue
to use the normal allowlisted card action flow.

The table is not an editable resource sheet. Inbox cells never mutate domain
data, and the dedicated `ResourceSheet` column/editor contract is not reused.
Messages retain their full threaded detail view; operational events retain
their target navigation and attention actions.

## Task projection

Task cards derive their hierarchy from the task API instead of printing the
database record or imported plan prose verbatim:

| Task contract | Presentation |
| --- | --- |
| `subject` | One card title; lightweight Markdown markers are removed |
| `description` | Readable body with repeated subject, plan phase, and task objective paragraphs removed |
| `status` | State label and semantic color beside the resource kind |
| `priority`, assignment, progress, due date, checklist | Compact two-column table |
| blocker and dependency state | One semantic notice inside the card |
| phase, classification, domain, source, timestamps | Collapsed record-details section |
| `id` and source reference | Record-details section only |

The Golden Layout tab uses the task subject when opened from a data surface and
retains that title when the route's selected detail tab changes. A dedicated
task panel has one toolbar and one card; it does not add a second page header or
metadata surface around the card.

Task edit cards preserve the raw subject and description. Priority uses
`Input.ChoiceSet`, due date uses `Input.Date`, progress uses `Input.Number`, and
phase/domain use bounded `Input.Text`. Workflow state and Arm assignment remain
host-owned controls because they require queue and lifecycle validation beyond
a scalar card submission.

## Schema 1.5 element policy

The host supports the full schema 1.5 parser, but trusted templates deliberately
use each element only where it improves comprehension:

| Schema family | Workbench policy |
| --- | --- |
| `TextBlock`, `RichTextBlock`, `TextRun` | Titles, prose, and semantic inline state |
| `Container`, `ColumnSet`, `Column` | Visual hierarchy and responsive metadata |
| `FactSet`, `Fact` | Secondary record details |
| `Table`, `TableCell` | Aligned primary resource facts |
| `Image`, `ImageSet` | Reserved for host-approved attachments; creator avatars remain host-rendered |
| `Media`, `MediaSource`, `CaptionSource` | Disabled until content is served through a trusted media policy |
| `Action.Execute` | Allowlisted host and API commands |
| `Action.ToggleVisibility` | Local progressive disclosure without a server call |
| `Action.OpenUrl` | Blocked; Workbench navigation uses structured host routes |
| `Action.Submit`, `Action.ShowCard` | Not used; execute actions and dedicated editor cards keep audit behavior explicit |
| `Input.Text`, `Input.Number`, `Input.Date`, `Input.ChoiceSet` | Typed resource editing |
| `Input.Time`, `Input.Toggle` | Available to future templates when backed by domain fields |
| `Data.Query`, refresh, authentication | Excluded from schema 1.5 envelopes and the producer contract |

## Rendering flow

1. A presenter converts a domain value or event into a `CardEnvelope`.
2. The host resolves the exact template ID and version from its trusted catalog.
3. The renderer lazily loads the Adaptive Cards runtime and expands the template.
4. The host intercepts actions and creates a `CardActionRequest`.
5. Navigation actions are handled by the Golden Layout route host. Mutating
   actions are sent to `/api/workbench/cards/actions`.
6. The response can return a replacement envelope or a host navigation target.

Unsupported template or schema versions render a readable fallback instead of
attempting best-effort execution.

## Security and compatibility

- The supported schema is pinned to 1.5.
- Template versions are append-only once released.
- Retire a template by adding a new version and an explicit envelope migration;
  never change the meaning or verb allowlist of a released version in place.
- External URLs are blocked by default; host navigation uses route data, not
  template-provided URLs.
- Inputs and action payloads are size-limited and validated on the server.
- Card content must not include secrets. Existing API redaction remains in
  force before presentation.
- The web client dynamically imports the renderer so list and sheet routes do
  not load it until a card surface is opened.

## Rollout

1. Contracts, catalog, host renderer, and Golden Layout card route.
2. Durable `workbench_attention` endpoints and Inbox state.
3. Inbox event/message cards and semantic Arm activity cards.
4. Singleton task/bug detail and edit cards.
5. Unified attention views, browser pop-outs, catalog tooling, accessibility,
   performance, and compatibility tests.

Card panels persist an opaque server-side instance ID in Golden Layout. The
envelope remains behind the authenticated Workbench API and is never embedded
in route or layout JSON. The card's creator bar owns view settings and pop-out
controls, so the viewer does not repeat the card title and template identity in
a second panel header.

## Validation baseline

The production build keeps the renderer runtime out of the initial route chunk:

- `adaptivecards` runtime: 365.70 kB minified, 88.17 kB gzip

Coleo expands only the small interpolation, conditional, and repeated-data
subset used by its trusted catalog. It deliberately does not ship a general
expression runtime or accept template expressions from producers.

The Inbox virtualizes its scan rows and creates SDK instances only for expanded
items. Other stream cards use an Intersection Observer with a 400 px pre-render
margin, so the retained 200-item ARM window creates SDK instances only near the
viewport. Malformed or retired templates render a readable fallback and
dispose their DOM on replacement.

Released template checksums:

| Template | SHA-256 |
| --- | --- |
| `workbench.event@1` | `05ccc7be833de03af0c84abd401af17330a3fc00c8b20ddc79259d460efc6407` |
| `workbench.message@1` | `f04d5c24858953b78eb50ba6c9740355bfa3b1a5ac1fd7eae574bc8a5a31471f` |
| `workbench.resource-detail@1` | `a21a0e56244ed6da9bb3d189498ede3fff4f79927235fa58aadff33998b16958` |
| `workbench.resource-editor@1` | `1189e94c00d3272f857931af3f5fec75a9afa1a8397e4acc7a6ec3e3e8f01422` |
| `workbench.resource-detail@2` | `53b7cdb39667c2cad4bad80cd8417dd15c6316bae839f99ddb3144d7360c2161` |
| `workbench.resource-editor@2` | `43c770c71e9b22b5e5c23a7990193b891da79ded8829dcbe9ad9bbbce3c18868` |

When a template changes before release, update its checksum. After release,
create a new version instead.
