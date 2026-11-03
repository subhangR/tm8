# Connect Apps release verification

Real account reads and representative writes have passed for GitHub, Slack, Notion, Atlassian, Gmail and the native Figma API adapter. Slack message, thread, reaction and file-upload checks below are complete. Figma full-design reads remain quota-limited, development links remain unverified on the available Starter file, and repository CI cannot start because of its billing/spending allowance. These limits are recorded separately from the verified connector behavior.

## Implementation

TM8 supplies branded app discovery and account management, deployment-owned OAuth clients, a reusable integration runtime, provider tool metadata compatibility, callback recovery and shared chat/session connector access. Provider artwork is bundled locally with attribution and sized to fill its tile while preserving its aspect ratio.

Any readable contextual entity can supply MCP defaults. Chats inherit their readable subjects and ancestors; sessions include their recorded subjects alongside task targets. Explicit selections override defaults, an empty selection disables all connectors, and another member’s private account is never inherited. Skills and spells retain their original equipment restrictions. See [entity access](../connect-apps-entity-access.md).

Codex chat and session runtimes disable inherited app/plugin connections and expose the TM8-selected MCP bridges. Google tools explicitly advertise read/write effects so the harness can apply its approval policy correctly. Write tools remain marked as writes.

Figma API (`figma.api`) is a separate TM8-hosted MCP adapter over Figma’s OAuth/REST API. It exposes 29 scope-filtered tools, including file/library/folder reads, comments, reactions and development links. The existing official remote Figma MCP entry remains separate and requires provider client approval. The API adapter does not claim canvas-editing or remote-MCP parity. Resource membership, seats, plans and quotas still apply.

## Live account evidence

| Provider | Discovery and permissions | Representative verified operations |
| --- | --- | --- |
| GitHub | All-toolset discovery: 111 tools; expanded account grant | Private disposable repository, branch and file creation; exact file readback; issue creation |
| Slack | 30 granted scopes; 27 tools | Public/private channel and DM/group-DM history, search; self-DM send/exact readback, thread reply/exact readback, reaction/readback; private file upload/finalization/exact content readback; disposable canvas create/edit/exact readback; list create/update/schema read |
| Notion | 71 tools through official MCP | Accessible page fetch; private disposable page creation/edit/exact readback |
| Atlassian | All requested 39 scopes granted; 26 tools | Disposable Jira issue creation, edit, exact readback and JQL search on the approved site after Jira Free activation |
| Gmail | Read and compose grants; sending explicitly enabled in acceptance | Search, message bodies, draft creation, one explicitly approved self-email and exact sent-message readback |
| Figma API | 13 granted scopes; 29 tools | Design-file reads before quota exhaustion; metadata; disposable-file comment/reaction writes and exact readback; comment write/readback also verified on the PR runtime |

These are representative functional checks, not a claim that every discovered tool has been invoked. Broad Atlassian permissions do not install missing products. GitHub organization access remains subject to organization policy. Gmail’s sending gate ships closed until the operator intentionally enables it.

## Entity and model execution

Real runtime credentials passed content reads across chat, work session and Craft-context chat, with matching human-root audit records and denial after deselection. Temporary verification credentials were revoked and disposable runtime fixtures soft-deleted.

Real model-driven chat and Craft turns executed GitHub, Jira, Notion, Gmail and Slack reads through TM8. The final native work-session rerun also passed all five after repairing session-context inheritance, Google tool annotations and Codex app/plugin isolation. Figma tools were discovered without repeating quota-blocked design calls. Separate Figma metadata reads passed through all three runtime types; a comment write and exact readback passed through a chat runtime on the PR code.

Final acceptance runs the PR worktree’s UI and server against a separate copy of the isolated acceptance database. The original acceptance database and stable application database remain intact. Account identifiers, fixture content, private client files and task-specific automation scripts are excluded from this PR.

## Code verification

Current local checks include server build and UI typecheck, 18 database binding/isolation tests, 11 database foundation/resource-identity tests, 109 UI domain tests, 38 MCP UI/catalog-phase tests, 50 Google/Figma adapter tests, 95 execution manifest/Codex harness tests, 48 execution MCP/resume/security tests, 14 catalog contract tests and 9 reusable integration tests. A further 25 account-resolution/credential tests pass, including distinct account coexistence, pinned account selection and reconnect behavior. Additional MCP/OAuth/security checks passed earlier; repeated runs are not added together as distinct coverage.

Fresh-database tests apply the complete migration set. Migrations 435/436 update curated identities and the bounded tool-catalog health cache; 437 preserves account identity and sharing during reconnect; 438 raises the bounded OAuth scope count to 64; 439 enables contextual MCP defaults while retaining credential and skill/spell guards; 440 adds the distinct Figma API identity. No production database was migrated.

GitHub Actions run 41341169419 did not execute any job steps because repository billing/spending allowance is blocked. It supplies no remote validation result.

## Deferred scope

Provider webhooks, event delivery, always-on agents and per-server public callback provisioning remain a separate iteration. Calendar, Drive and Linear account acceptance are outside the six-provider launch gate.

## Multiple accounts

Connect Apps exposes **+ Add another account** without replacing an existing account. Distinct provider account identities coexist; reconnecting the same identity updates that connection in place. Chat and session pickers allow explicit account selection. The Figma second-account form has been verified in the live UI; authorization and design reads for a second real Figma account require signing into that account.

## Slack message and file acceptance — 2026-11-02

Fresh checks used the TM8 MCP endpoint and the expanded Slack grant. A message was sent only to the connected user’s self-DM, read back exactly, followed by a thread reply and a reaction, both verified on readback. A small disposable text file was uploaded using the MCP-issued signed upload URL, finalized privately through MCP and read back with exact content through MCP. Temporary TM8 access tokens were revoked after each verification run. No provider account token or signed upload URL is committed. An additional actual TM8 chat with only Slack selected sent a self-DM and read it back through its native MCP tools; successful proxy audit rows confirm both operations.

The requested TM*-group could not be identified among the connected account’s channels/groups. No message or file was sent to an unrelated group; group delivery awaits the exact Slack link/workspace. This does not invalidate the verified message/file capabilities.

OAuth popup recovery also offers **Continue in this tab** when a popup was reported open but is hidden or unusable. It closes the popup before continuing the same pending authorization, without issuing another authorization request. The callback returns to Connect Apps. The dedicated connection suite passes 10 tests and UI typecheck passes.
