# Slack import and sync

**Status:** designed, not built. Deferred from task `019fd744` item 8 by user
ruling 2026-08-07 ("Split into its own task, design doc first").

> "Ability to import and sync slack channels and messages with MCP and socket
> connections" — task `019fd744`, item 8

## The finding: this is greenfield, and larger than the rest of the ticket combined

Items 1–7 are a UI ticket. This is a subsystem. Searched at `7631e08`:

- **No MCP client.** `grep -rl 'modelcontextprotocol\|mcp' packages/*/src` →
  nothing. tm8 has no MCP client, server, or transport of any kind.
- **No Slack anything.** Every `slack` hit in the repo is the word "slack" in a
  scroll-margin constant or a design brief comparing tm8 to Slack.
- **No integration/adapter layer.** There is no place a third-party provider
  plugs in.
- **No credential store.** tm8 has no per-user secrets. This is the hardest
  blocker and is called out below.
- **No outbound network client** besides the UI's own fetch to its node.

`docs/history/collab-v2/GAPS-AND-EXTENSIONS.md:118` anticipated exactly this
and left it open: "C10. External integrations beyond GitHub (Linear, Slack
import…) → New provider values on `pull_request`-like tracking kinds, or new
kinds; writers are adapters."

## The blocking question, to be answered before any code

**Where does a Slack token live?**

tm8 has no per-user secret storage. A Slack bot token is a long-lived,
workspace-wide credential that can read every message in every channel it is
invited to. Putting one in `doc.body` (the only arbitrary-JSON field on this
node) or in an entity's `content` would make it readable by anything that can
read the entity, and `restricted` visibility on this node is not an ACL — it
means invisible to everyone.

So the first deliverable is a decision, not an adapter. The options, in the
order they should be considered:

1. **Node-local config, out of the graph** — `/etc/tm8/*.env`, read by the
   server, never returned by any read route. Smallest surface; one Slack
   workspace per tm8 node; no per-user tokens.
2. **A real secrets table with its own RLS and no client-readable projection.**
   Correct long-term, meaningfully more work, and it needs a security review
   that has not been scoped.
3. **OAuth per member.** Largest; needs a redirect endpoint tm8 does not have.

Option 1 is the recommendation for a first cut, explicitly labelled as such.

## Shape, once the credential question is settled

### Mapping

| Slack | tm8 |
|---|---|
| workspace | (the Space — one Slack workspace per Space) |
| channel | `channel` entity; `name` maps to `channels.name`, which is already the same slug grammar |
| channel topic/purpose | `channels.topic` |
| message | `message` entity anchored on the channel |
| thread reply | `message` with `root_message_id` — the anchor model already carries this |
| user | `member`, matched on email; unmatched authors need a decision |
| file | `file` entity, or a link — decide; downloading Slack files is a bandwidth and storage commitment |

The good news is that the target model needs **no new kinds**. Slack's shape
and tm8's shape already line up: `channels.name`'s
`^[a-z0-9][a-z0-9_-]{0,79}$` is very nearly Slack's own channel-name grammar,
and `messages` is already anchored-and-threaded.

### Import (one-shot, first)

1. `conversations.list` → create or match channel entities.
2. `conversations.history` + `conversations.replies` per channel, paged.
3. Author resolution: match Slack user → tm8 `member` by email; unmatched
   authors post as a single import actor rather than being invented as members.
4. **Idempotency is the requirement that shapes everything.** A re-import must
   not duplicate. Store the Slack `ts` (the per-channel message id) and
   `channel id` on the created entity and make the pair unique. `ts` is
   channel-local and stable, which is exactly what a durable cursor needs.
5. Rate limits are Slack's Tier 3 (~50/min) — the importer must be resumable,
   because a large workspace will not finish inside one run.

### Sync (second, and only after import is proven)

- Slack Socket Mode gives an events websocket without a public HTTP endpoint,
  which matters: tm8's nginx binds loopback + Tailscale only and explicitly
  must not grow a `0.0.0.0` listener, so a webhook-based integration is not
  available on this deployment.
- `message` events append; `message_changed` / `message_deleted` need a policy
  — tm8 messages are immutable-by-default (001 §11).
- **Direction is a decision, not a default.** Import-only (Slack → tm8) is
  strictly smaller and has no failure mode where tm8 posts something wrong into
  a real workspace. Two-way should be a separate ruling.

### Where MCP fits

The ticket names MCP. Worth being precise about what it would buy: MCP is how
an AGENT would reach Slack as a tool, which is a different thing from tm8
ingesting Slack into its graph. Both are reasonable; they are not the same
feature.

- **Ingest** (this document) is a server-side adapter writing entities.
- **MCP tool access** would let a teammate agent read/post to Slack during a
  session, and belongs with the execution layer's tool wiring.

Doing ingest first is the recommendation: it is the one that makes Slack
content visible in tm8, which is what the ticket's own wording asks for.

## Acceptance criteria (for the first slice — import only)

1. A written decision on credential storage, reviewed before any token is
   handled.
2. `conversations.list` import creates channel entities whose names pass the
   `channels.name` constraint.
3. History import creates anchored messages with threads preserved.
4. Re-running the import creates nothing new — proven by running it twice and
   comparing counts.
5. The importer resumes after interruption without duplicating.
6. Unmatched Slack authors are attributed honestly, not invented as members.
7. No Slack token is readable through any `/v2` read route.

## Deployment note

Server change; see the note in `CHANNEL-MEMBERS-DESIGN.md`. This one also needs
outbound network access from the tm8 host to `slack.com`, which has not been
verified on this box.
