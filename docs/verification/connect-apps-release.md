# Connect Apps release verification

**Merge blocked pending final acceptance.** Real account reads and representative writes have passed for GitHub, Slack, Notion, Atlassian, Gmail and the native Figma API adapter. Figma full-design reads currently return a provider quota error, development links remain unverified on the available Starter file, and repository CI cannot start because of its billing/spending allowance. These are unresolved release gates, not passing tests.

## Implementation

TM8 supplies branded app discovery and account management, deployment-owned OAuth clients, a reusable integration runtime, provider tool metadata compatibility, callback recovery and shared chat/session connector access. Provider artwork is bundled locally with attribution and sized to fill its tile while preserving its aspect ratio.

Any readable contextual entity can supply MCP defaults. Chats inherit their readable subjects and ancestors; sessions include their recorded subjects alongside task targets. Explicit selections override defaults, an empty selection disables all connectors, and another member’s private account is never inherited. Skills and spells retain their original equipment restrictions. See [entity access](../connect-apps-entity-access.md).

Codex chat and session runtimes disable inherited app/plugin connections and expose the TM8-selected MCP bridges. Google tools explicitly advertise read/write effects so the harness can apply its approval policy correctly. Write tools remain marked as writes.

Figma API (`figma.api`) is a separate TM8-hosted MCP adapter over Figma’s OAuth/REST API. It exposes 29 scope-filtered tools, including file/library/folder reads, comments, reactions and development links. The existing official remote Figma MCP entry remains separate and requires provider client approval. The API adapter does not claim canvas-editing or remote-MCP parity. Resource membership, seats, plans and quotas still apply.

## Live account evidence

| Provider | Discovery and permissions | Representative verified operations |
| --- | --- | --- |
| GitHub | All-toolset discovery: 111 tools; expanded account grant | Private disposable repository, branch and file creation; exact file readback; issue creation |
| Slack | 30 granted scopes; 27 tools | Public/private channel and DM/group-DM history, search; disposable canvas create/edit/exact readback; list create/update/schema read |
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

Current local checks include server build and UI typecheck, 18 database binding/isolation tests, 11 database foundation/resource-identity tests, 109 UI domain tests, 38 MCP UI/catalog-phase tests, 50 Google/Figma adapter tests, 95 execution manifest/Codex harness tests, 48 execution MCP/resume/security tests, 14 catalog contract tests and 9 reusable integration tests. Additional MCP/OAuth/security checks passed earlier; repeated runs are not added together as distinct coverage.

Fresh-database tests apply the complete migration set. Migrations 434/435 update curated identities and the bounded tool-catalog health cache; 436 preserves account identity and sharing during reconnect; 437 raises the bounded OAuth scope count to 64; 438 enables contextual MCP defaults while retaining credential and skill/spell guards; 439 adds the distinct Figma API identity. No production database was migrated.

GitHub Actions run 41341169419 did not execute any job steps because repository billing/spending allowance is blocked. It supplies no remote validation result.

## Deferred scope

Provider webhooks, event delivery, always-on agents and per-server public callback provisioning remain a separate iteration. Calendar, Drive and Linear account acceptance are outside the six-provider launch gate.
