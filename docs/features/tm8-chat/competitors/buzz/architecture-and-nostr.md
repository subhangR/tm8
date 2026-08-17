# Buzz — architecture and the Nostr decision

## Shape

Rust workspace, **28 crates**. Load-bearing ones:

| Crate | LOC | Role |
|---|---|---|
| `buzz-acp` | 41k | ACP harness — spawns external agent CLIs, drives them over stdio |
| `buzz-agent` | 29k | Their **own** from-scratch ACP agent (API-key auth) |
| `buzz-core` | 9.4k | Event kinds, crypto, shared types |
| `buzz-persona` | 5.2k | Agent persona/config packs |
| `buzz-workflow` | 4.8k | YAML workflow engine |
| `buzz-relay` / `buzz-db` | — | Nostr relay + Postgres projections + git Smart-HTTP |

Plus `buzz-voice`, `buzz-search`, `buzz-media`, `buzz-pubsub`, `buzz-relay-mesh`,
`buzz-push-gateway`, `buzz-backend-kubernetes`, `git-credential-nostr`, `git-sign-nostr`, `sprig`.

Clients: **Tauri desktop** (React 18, TanStack Router+Query, TipTap composer, Radix,
`virtua` virtualization) and a web client. Admin web app separate.

## How deep does Nostr go? Deep — but Postgres does the querying

**Genuinely signed events, not a veneer.** Channels, DMs, messages, git and workflows are all
signed Nostr events ingested over a relay WebSocket. A chat send is a signed **kind:9** event with
an `#h` channel tag.

**But the relay projects events into Postgres and queries there.** So Nostr is the *wire, identity
and signing* layer; Postgres is the *query engine*. Both load-bearing — it is neither "pure event
log" nor "sync over a real DB".

### Storage

- **Raw**: `events` table — `(id, pubkey, created_at, kind, tags JSONB, content TEXT, sig,
  channel_id, d_tag, …)`, **range-partitioned by month**, with a `GENERATED STORED` FTS tsvector
  (`migrations/0001_initial_schema.sql:190-235`).
- **Projections/sidecars**: `thread_metadata` (parent/root/depth/reply_count/descendant_count),
  `reactions`, `event_mentions`, `channels`, `channel_members`.
- **"Messages in channel X since T" is a direct indexed btree scan — no read-time replay**:
  `idx_events_community_channel_created (community_id, channel_id, created_at DESC, id)`.
- Ephemeral kinds (20000–29999) and DM/notification kinds are **never stored** and never
  searchable (NULL tsvector).
- Multi-tenant: `community_id` on every row.
- **Client store**: TanStack Query is the source of truth over a custom `ChannelWindowStore`
  projection; live relay events reconcile into the query cache via `setQueryData`. Zustand only for
  ancillary live stores (observer frames, drafts, terminal).

## Event kinds

Authoritative registry in one file, `crates/buzz-core/src/kind.rs` — **~130 kinds**. The ones that
matter:

| Kind | Meaning |
|---|---|
| **9** | `STREAM_MESSAGE` — the chat message (NIP-29 group chat) |
| **40002** | `STREAM_MESSAGE_V2` — a second message kind, still a flat content string |
| 40003 / 40004 / 40005 / 40006 | edit / pinned / bookmarked / scheduled |
| **40008** | `STREAM_MESSAGE_DIFF` — unified diff (gets a dedicated UI card) |
| 40099 / 40100 | system / canvas |
| **24200** | `AGENT_OBSERVER_FRAME` — **ephemeral** agent telemetry |
| **44200** | `AGENT_TURN_METRIC` — **durable** per-turn tokens/cost |
| 43001–43006 | agent job protocol (request/accepted/progress/result/cancel/error) |
| 46001–46012, 46020, 46030-31 | workflow lifecycle / trigger / approval |
| 30617/30618/1617/1618/1621/1630-1633/30621 | NIP-34 git |
| 9000–9022, 9030-33, 39000–39002 | NIP-29 admin, NIP-43 membership, group state |

## They authored their own NIPs

**18 in-repo extension specs** under `docs/nips/` (NIP-AA, AE, AM, AO, AP, CW, DV, ER, GS, IA, MP,
OA, PL, PMA, RS, WP…). These are Buzz's own drafts (`draft`/`optional`), **not upstream-merged**.
Notable: NIP-AM (turn metrics), NIP-AO (agent observability), NIP-GS (git Schnorr signing).

They **deliberately rejected NIP-90** for agent jobs, rolling their own 43000-range because
*"Buzz requires auth chains (depth ≤ 3, breadth ≤ 10)"*.

## What tm8 should take from this

- ✅ **Raw events + projections is the right split** — and it's what tm8 already does.
- ✅ **Counts computed at ingest** (`thread_metadata`) so a roots feed never counts rows.
- ✅ **Partition the high-volume table by time** if turn items get their own table.
- ⚠️ **Nostr itself is not for us.** Its wins here are identity, signing and federation — tm8
  already has identity/auth, and federation is not a goal. We would pay the cost without the
  benefit.
- ⚠️ **Two message kinds (9 and 40002) doing the same job** is schema drift already visible in a
  three-week-old product. Pick one shape.
