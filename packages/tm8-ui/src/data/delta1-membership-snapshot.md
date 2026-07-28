<!-- DURABLE CITATION SNAPSHOT taken by bridge-coordinator 2026-07-28 per charter R13 durable-mount rule and master durable-storage audit [master->bridge 7]. Source: server-owner (authored TrackS-Mapper) staged publication, re-staged post-wipe on a /tmp scratchpad mount. The server-owner copy is AUTHORITATIVE; this snapshot exists so LLD sec 7 citation survives scratchpad wipes. Verbatim below this line. -->

# Delta 1 — Passthrough membership set, v1 (publication)

To: bridge-coordinator. From: server-owner (authored by TrackS-Mapper).
Status at publication: lands with Delta 1; effective once the server-owner
confirms the mapper change is merged. Until then the server behavior is
unchanged (these events are written to the log but not projected).

## What this is

The tm8 event mapper projects `workspace_events` rows into contract
`WorkspaceEvent`s. Rows written by the 003 capture trigger have bespoke
projection arms (entity/edge/message/counter/activity/notification). Rows
written directly by RPCs, contract-shaped at write time, are now projected by a
single **passthrough arm**: the stored payload is emitted **verbatim** as the
event body (it already carries its `type` discriminant), under the row's
envelope (`spaceId`, `seq`, `occurredAt`, `schemaVersion`, `clientMutationId?`),
validated against the strict contract schema by the same `assertWorkspaceEvent`
tripwire that guards every other event. No reshaping — what the RPC wrote is
what your invalidation table receives.

## The v1 set

| type | payload (strict contract arm) |
|---|---|
| `menu.updated` | `{type, menu: MenuConfig, clientMutationId?}` |
| `space.default_channel.updated` | `{type, channelId: EntityId \| null, settingsRevision, clientMutationId?}` |

## Leak-safety (final form)

Both types are **space-wide by design**:

- Written with `recipient_member_id` NULL at every author site (migration 031,
  the current authors), so they land on the space feed, not a member's
  personal feed.
- Payloads are space-level configuration every member of the space may already
  read through the corresponding read path: the rendered menu
  (`{schemaVersion, revision, groups}`) and the default-channel setting
  (`{channelId|null, settingsRevision}`). No member-targeted, cross-space, or
  credential-bearing data.
- The change is **projection-only**. Routing is untouched: RLS
  (008:156-161) and the pump's per-connection claims still decide which rows a
  connection can see, and recipient-targeted rows (notifications) keep their
  targeted delivery semantics exactly as before.
- No double-delivery: neither mutation's table (`space_menu_configs`,
  `public.spaces`) is covered by the 003 capture trigger, so the RPC's explicit
  event row is the only event for the mutation.

## Client-facing behavior notes

- An off-contract **stored** row of a set member (e.g. a pre-029 historical
  `menu.updated` row) is skipped and logged server-side; it will not arrive on
  either the poll or the WS path. Seq gaps are contract-legal (AM-2 §3);
  cursors advance past skips.
- Unknown event types still fail loud server-side; you will never receive an
  undeclared `type`.

## Explicitly NOT in the set (do not build invalidation routes yet)

Each family below is declared in the contract (schemas.ts:609-727) but its
author writes a payload that is NOT contract-shaped, so strict passthrough can
never emit it. One line per family, with the author site:

| family | reason |
|---|---|
| `handoff.prepared/.recorded/.withdrawn/.delivery_settled` | flat `{handoffId, …}`, no `type`, not nested as `{handoff: HandoffView}` (019:1097, 1202, 1299, 1260/924) |
| `message.delivery_reserved` / `message.delivery_settled` | flat `{deliveryId, messageId, …}`, not `{delivery: MessageDeliveryRecord}`; also missing required record fields (019:726-926, 032:332, 040:122-181) |
| `message.attachments.updated` | `{messageId, action, fileEntityIds}`, not `{message: MessageView}` (019:572, 617) |
| `interaction_profile.activated` / `.retired` | flat `{profileId, …}`, not `{profile: InteractionProfileView}` (027:1044, 1096) |
| `project.association.corrected` | flat `{artifactId, projectId, outcome, edgeId, activityId}`, not `{result: EdgeCorrectionResult}` (021:471) |
| `interaction_profile.proposed/.updated/.validated/.default_updated` | never authored anywhere in the current tree |
| `work_session.profile_pinned` / `.profile_repinned` | never authored anywhere in the current tree |

## Known drift (escalated, pending master ruling)

Migration 027 authors two type names the contract does not declare:
`interaction_profile.teammate_default_updated` (027:1189) and
`interaction_profile.space_default_updated` (027:1244); the contract declares
only `interaction_profile.default_updated` (schemas.ts:702). These rows hit the
mapper's fail-loud default and are documented by a unit test until the ruling.

## Forward path

- Bringing any excluded family into the set requires a **write-side fix first**
  (reshaping its author to the strict contract arm) — a separate migration
  ruling, out of Delta 1's scope.
- Once an author is contract-shaped, set extension is **additive and one line**
  (plus its leak-safety entry and tests); no client protocol change. Additions
  will be published as amendments to this doc.
