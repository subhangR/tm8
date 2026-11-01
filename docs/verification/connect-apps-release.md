# Connect Apps PR scope

**Merge blocked:** production acceptance requires real content reads and supported writes, with granted permissions verified for GitHub, Slack, Notion, Figma, Atlassian and Gmail. The evidence below is partial and does not satisfy that gate. A connected account, a listed tool or passing fixture tests alone do not establish production readiness.

This change supplies TM8-native branded app discovery/account management, deployment-owned provider OAuth clients, a reusable integration runtime, provider tool metadata compatibility, OAuth callback recovery, and chat connector access for both supported harnesses.

## Verified account/runtime paths

Expanded acceptance now verifies GitHub private repository/branch/file writes with exact file readback and issue creation; all111 provider tools are discoverable using GitHub's all-toolset option. Slack's30-scope grant exposes27tools; public/private channel, DM and group-DM history and message search succeed, as do disposable canvas creation/edit/readback and list creation/update/schema reads. Notion private page creation, content insertion and exact readback pass. Gmail message search, body reads, draft creation, an explicitly approved self-email send and exact sent-message readback pass. These are representative functional checks, not proof that every listed tool has been invoked.

Content reads for all five of those providers pass through chat, work_session and Craft-context runtime credentials:15successful content reads with matching human-root audit records and15deselection denials. Temporary runtime credentials were revoked and fixture entities soft-deleted. This still does not establish model-driven UI processing.

Live isolated-node verification passed GitHub public profile reads, Slack custom emoji reads with its reviewed limited grant, Notion accessible-page listing and content fetch, and Gmail label reads. All four providers also passed tool discovery and reads through actual chat, work_session and Craft-context chat runtime bearers. Twelve matching successful audit rows retained the launching human's provenance. Removing each selection denied all twelve runtime/provider combinations. Temporary verification bearers were revoked and disposable fixtures soft-deleted.

This is runtime access evidence, not a model-driven conversation or universal per-entity default inheritance. Existing entity attachment limits remain unchanged. Provider accounts/grants remain specific to each installation; these checks do not imply broad write access or webhooks.

## Deliberate exclusions

- Provider webhooks, WebSocket/Socket Mode delivery, always-on event agents and their permissions belong to the next iteration.
- A separate Figma REST/native-MCP experiment now reads an own-team design after repairing OAuth reconnect. That host and its identity-changing migration remain excluded until its supported writes and permission coverage are verified. Existing official Figma MCP remains catalogued with its pre-approved-client requirement; REST credentials do not substitute for remote client approval.
- Atlassian OAuth/tool discovery succeeded, but Jira reads failed because the existing organization has no Jira product installed (its installed apps are Goals, Projects and Loom). Both known Jira site URLs show unavailable. Product provisioning and read/write acceptance remain incomplete.
- Calendar, Drive and Linear account consent/read acceptance was not completed.
- No account credentials, private provider responses, task-specific acceptance scripts, account screenshots or live test identifiers are included in this PR.

## Operator configuration

Operators register their own provider clients when required and set TM8_MCP_CLIENT_ID_GITHUB / TM8_MCP_CLIENT_SECRET_GITHUB and equivalent SLACK variables. Figma remote MCP requires a provider-approved remote client; a Figma REST OAuth client is not interchangeable with it. Dynamic discovery/registration is used only where the provider supports it. Google retains the existing first-party client configuration.

The UI presents original provider artwork, bundled locally with source attribution under public/connector-logos/SOURCES.md. Original aspect ratios are retained; icon padding is removed and built-in asset whitespace is compensated so marks occupy their tiles.

Migrations434/435 update curated endpoint identities and permit bounded larger provider tool catalogs. They do not rewrite existing connector definitions or account ciphertext. Notion's actual71-tool catalog exceeded the old256KiB health-cache cap; the new4MiB cache cap retains the2MiB upstream transport limit and member isolation.

Migration436 permits reconnecting the same provider account in place. The server seals replacement tokens against the existing account ID; SQL rechecks the human owner or Space administrator, resource binding and current definition revision. Existing sharing and selections survive, concurrent consent is serialized, and a revoked account is never revived. Real Figma reconnect exposed the original duplicate-account failure. Scratch-database regression checks cover recovery, ownership, concurrent reconnects, unchanged shares and stale revisions.

Migration437 raises the bounded OAuth scope count from32to64in SQL, matching the contract. Atlassian's39-scope set exposed the previous mismatch. Tests accept64scopes and reject65or an oversized scope string while retaining all other definition guards.

## Validation on current main

Reconciled against origin/main ee14112ca. Server/CLI builds and UI typecheck pass. Selected server OAuth, isolation, credential crypto and callback checks165pass; MCP bridge suite91pass; MCP/chat UI160pass; contract30pass; reusable integration core7pass; fresh-database MCP foundation/migration checks9pass. Total462checks passed. These are local code/fixture checks; live provider acceptance above remains separately scoped. No production database was migrated.

CI wiring includes the new package in the affected graph, explicit typecheck catalog and small-package test job. Local affected-graph checks98pass and the real stage/job consistency check passes. GitHub Actions run41334874586 did not start any steps because repository billing/spending allowance is blocked; it provides no remote code-validation result. The existing CI wiring script's final negative control uses GNU-sed syntax and emits a BSD-sed warning locally; the workflow runs on Linux.
