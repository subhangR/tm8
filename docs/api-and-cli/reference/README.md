# API reference — every operation, request and response

One file per operation family, covering all **243** rows of the operation catalog
(`packages/contract/src/catalog.ts`). For each operation it gives the HTTP binding,
path/query params, request body, the response `data` shape with an example, errors
(`details.reason`), and idempotency/version notes, with `file:line` sources.

Everything was derived from source at `6d1f4c77`. Examples are marked **(captured)**
when they came from a live `tm8 … --format json` read, and **(illustrative, from
schema)** otherwise. Most are illustrative. Anything a writer could not trace is
marked `unverified:` in place. As with the rest of this directory, `packages/contract`
wins any disagreement.

Read [`00-conventions-and-non-catalog-routes.md`](00-conventions-and-non-catalog-routes.md)
first. It covers the envelope, auth, the error taxonomy, idempotency, cursors and rate
limits once, so the family files don't repeat them. It also documents the HTTP routes
that are not catalog operations (health, artifact preview, raw uploads, voice webhook,
relay proxy, static UI).

| File | Family | Ops |
|---|---|---:|
| [00-conventions-and-non-catalog-routes](00-conventions-and-non-catalog-routes.md) | Envelope, auth, errors, idempotency, pagination, non-catalog routes | — |
| [01-spaces-core](01-spaces-core.md) | `spaces.*` core: list/get/create/update, navigation, home, counts, settings, configs, menu, awards | 15 |
| [02-spaces-membership-workflows](02-spaces-membership-workflows.md) | `spaces.members/invites/taskAxes/taskWorkflows/workflows.*` | 16 |
| [03-containers](03-containers.md) | `containers.*` | 25 |
| [04-entities](04-entities.md) | `entities.*` | 24 |
| [05-execution](05-execution.md) | `execution.*` (work sessions, git) | 22 |
| [06-forms](06-forms.md) | `forms.*` | 15 |
| [07-credentials](07-credentials.md) | `credentials.*` | 15 |
| [08-auth-identity-node](08-auth-identity-node.md) | `auth.*`, `identity.*`, `serverConnections.*`, `node.*`, `teamMembers.*` | 19 |
| [09-skills-launch-profiles](09-skills-launch-profiles.md) | `skills.*`, `launch.*`, `interactionProfiles.*` | 17 |
| [10-messaging-attention](10-messaging-attention.md) | `messages.*`, `chat.*`, `inbox.*`, `readMarks.*`, `attentionRequests.*`, `handoffs.*`, `presence.*` | 19 |
| [11-projects-files](11-projects-files.md) | `projects.*`, `files.*` | 23 |
| [12-graph-edges-collections](12-graph-edges-collections.md) | `edges.*`, `edgeTypes.*`, `entityKinds.*`, `graph.*`, `collections.*`, `placements.*`, `savedViews.*` | 17 |
| [13-artifacts-tracking-voice-bridge](13-artifacts-tracking-voice-bridge.md) | `artifacts.*`, `tracking.*`, `voice.*`, `bridge.*` | 10 |
| [14-events-commands-actions-search](14-events-commands-actions-search.md) | `events.*` (incl. the WebSocket), `commands.*`, `actions.*`, `search.*` | 6 |

## What is not served today

- **`containers.*`**: the 24 non-stream ops always answer `501 not_implemented`, because no
  container service is wired (`TM8_CONTAINERS=off`). A malformed body still gets
  `400 invalid_input` first. `containers.stream` is the `events.subscribe` socket.
- **Reserved**: `search.query` and `bridge.fetchBlob` always answer 501.
- **Conditional**: `presence.get` (only with a presence source), `voice.token.create`
  (501 without the LiveKit env), `chat.start` (human sessions only),
  `execution.prompt` (the public HTTP path answers 403; delivery goes through an
  internal adapter), and all `credentials.*` (human sessions only).

## Behaviour the writers flagged as surprising

Each item is cited in its family file. These are observations from source, not changes.

- `forms.create` and `entityKinds.create` answer **200**, while other creates answer 201.
- `skills.preview` parses its query outside the central schema map, so a malformed
  query surfaces as 503 `upstream_unavailable` rather than 400.
- `skills.equip` returns the raw snake_case edge row, not `EdgeView`.
- `placements.apply` with `intent: depend` writes the edge reversed (`target` becomes the dependent).
- `spaces.list`, `spaces.members.list`, `spaces.invites.list`, `projects.list` and
  `savedViews.list` are unpaginated, although some CLI syntax advertises `--limit/--cursor`.
- `projects.files.attach` gates on a loopback-owner-only node-admin check.
