# Connect Apps PR scope

**Merge blocked:** production acceptance requires real content reads and supported writes, with granted permissions verified for GitHub, Slack, Notion, Figma, Atlassian and Gmail. The evidence below is partial and does not satisfy that gate. A connected account, a listed tool or passing fixture tests alone do not establish production readiness.

This change supplies TM8-native branded app discovery/account management, deployment-owned provider OAuth clients, a reusable integration runtime, provider tool metadata compatibility, OAuth callback recovery, and chat connector access for both supported harnesses.

## Verified account/runtime paths

Live isolated-node verification passed GitHub public profile reads, Slack custom emoji reads with its reviewed limited grant, Notion accessible-page listing and content fetch, and Gmail label reads. All four providers also passed tool discovery and reads through actual chat, work_session and Craft-context chat runtime bearers. Twelve matching successful audit rows retained the launching human's provenance. Removing each selection denied all twelve runtime/provider combinations. Temporary verification bearers were revoked and disposable fixtures soft-deleted.

This is runtime access evidence, not a model-driven conversation or universal per-entity default inheritance. Existing entity attachment limits remain unchanged. Provider accounts/grants remain specific to each installation; these checks do not imply broad write access or webhooks.

## Deliberate exclusions

- Provider webhooks, WebSocket/Socket Mode delivery, always-on event agents and their permissions belong to the next iteration.
- A separate Figma REST/native-MCP experiment authorized an account and read its profile, but design-file reads returned provider403. That host and its identity-changing migration are excluded here. Existing official Figma MCP remains catalogued with its pre-approved-client requirement; no live Figma design-read acceptance is claimed.
- Atlassian OAuth/tool discovery succeeded, but a Jira project read returned Site temporarily unavailable and the approved site's own UI was unavailable. No successful Jira data-read claim is made.
- Calendar, Drive and Linear account consent/read acceptance was not completed.
- No account credentials, private provider responses, task-specific acceptance scripts, account screenshots or live test identifiers are included in this PR.

## Operator configuration

Operators register their own provider clients when required and set TM8_MCP_CLIENT_ID_GITHUB / TM8_MCP_CLIENT_SECRET_GITHUB and equivalent SLACK variables. Figma remote MCP requires a provider-approved remote client; a Figma REST OAuth client is not interchangeable with it. Dynamic discovery/registration is used only where the provider supports it. Google retains the existing first-party client configuration.

The UI presents original provider artwork, bundled locally with source attribution under public/connector-logos/SOURCES.md. Original aspect ratios are retained; icon padding is removed and built-in asset whitespace is compensated so marks occupy their tiles.

Migrations434/435 update curated endpoint identities and permit bounded larger provider tool catalogs. They do not rewrite existing connector definitions or account ciphertext. Notion's actual71-tool catalog exceeded the old256KiB health-cache cap; the new4MiB cache cap retains the2MiB upstream transport limit and member isolation.

## Validation on current main

Reconciled against origin/main ee14112ca. Server/CLI builds and UI typecheck pass. Selected server OAuth, isolation, credential crypto and callback checks165pass; MCP bridge suite91pass; MCP/chat UI160pass; contract30pass; reusable integration core7pass; fresh-database MCP foundation/migration checks9pass. Total462checks passed. These are local code/fixture checks; live provider acceptance above remains separately scoped. No production database was migrated.

CI wiring includes the new package in the affected graph, explicit typecheck catalog and small-package test job. Local affected-graph checks98pass and the real stage/job consistency check passes. GitHub Actions run41334874586 did not start any steps because repository billing/spending allowance is blocked; it provides no remote code-validation result. The existing CI wiring script's final negative control uses GNU-sed syntax and emits a BSD-sed warning locally; the workflow runs on Linux.
