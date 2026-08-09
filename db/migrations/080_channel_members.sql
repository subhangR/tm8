-- =============================================================================
-- 080 — `has_member`: channel membership as a graph edge.
--
-- Task 019fdbfe-214b-727d-89aa-f009f52349bc ("feature/Channels — channel
-- members"), item 4 of the parent ticket: "Channel has members. Should be able
-- to add members while creating or updating a channel."
--
-- Design: docs/features/channels/CHANNEL-MEMBERS-DESIGN.md. This file DEPARTS
-- from that document in two places; both departures are recorded below with the
-- measurement that forced them, because the doc is otherwise still the
-- reference and a silent divergence would strand the next reader.
--
-- THE FINDING. Before this file there is no membership anywhere on this node —
-- not a UI gap, an absence:
--   * no edge type. `member_of` (001:922) is team_member -> team_member,
--     "Secondary team affiliation", a different concept. `pulled` (001:903) is
--     member -> channel but means "Local projection/adoption" and already means
--     something in the UI; overloading it is how the next reader gets it wrong.
--   * no column. public.channels is (entity_id, space_id, name, topic,
--     created_at, updated_at) (001:500-508) and has never been altered.
--   * no contract projection, on either the detail or the summary arm.
--
-- -----------------------------------------------------------------------------
-- DEPARTURE 1 — DIRECTION. The design specifies `member_of_channel`, src
-- {member, team_member} -> dst {channel}. This file registers the REVERSE:
-- `has_member`, src {channel} -> dst {member, team_member}. User ruling
-- 2026-08-07, on this evidence:
--
--   * `attachInitialConnections`
--     (packages/server/src/facade/services/w2/entities-commands-tracking.ts:922-924)
--     calls write_edge with src_id = THE ENTITY JUST CREATED and dst_id =
--     connection.targetId. The direction is hard-coded. So a channel created
--     with connections:[{type, targetId:<member>}] can only ever write
--     channel -> member. In the designed direction the create-with-members path
--     — the ticket's actual ask — could not work at all; internal.validate_edge
--     would refuse it at 001:800-801 for the destination kind.
--   * entity -> person is the house idiom: `assigned_to` (001:901),
--     `completed_by`, `approval_requested_from`, `approved_by`, `visible_to`.
--     `pulled` is the person -> entity exception, and it is the one we are told
--     not to overload.
--
-- The alternative was teaching a generic path shared by EVERY create kind a
-- per-type direction flag, to serve one edge type facing the wrong way.
--
-- CONSEQUENCE, and it is the point: this file is the WHOLE server change.
-- Create-with-members needs no new code, and idempotency needs none either —
-- see the note on the absent unique index below.
--
-- -----------------------------------------------------------------------------
-- DEPARTURE 2 — `role` IS NOT DB-CONSTRAINED, AND THE SCHEMA MUST NOT PRETEND
-- IT IS. The design's props_schema is {"role":{"enum":["owner","member"]}}.
-- internal.validate_edge_props_schema (018:94-137) implements exactly three
-- things: a `type` check per property (018:113), `required` (018:119-125) and
-- `additionalProperties:false` (018:127-134). It has NO enum support, and
-- internal.edge_json_type_matches (018:62-88) matches type NAMES only. An
-- `enum` key would therefore be read, matched against nothing, and silently
-- ignored — a constraint that appears in the registry and enforces nothing.
--
-- So `role` is registered as a string, which IS enforced, and the owner/member
-- vocabulary is an application-layer concern. Better an honest string than a
-- decorative enum that the next reader trusts.
--
-- -----------------------------------------------------------------------------
-- NO UNIQUE INDEX, DELIBERATELY. The design (doc lines 56-58) calls for a
-- partial unique index on (src_id, dst_id) where type = 'has_member'.
-- public.edges ALREADY carries `unique (src_id, dst_id, type)` at 001:772, so
-- that index would duplicate an existing constraint. A double-add is already a
-- no-op: write_edge upserts on that triple, and attachInitialConnections
-- additionally pre-checks and skips (…entities-commands-tracking.ts:917-921).
-- This confirms amendment A2 on the task.
--
-- NOT ACYCLIC. A channel and a person are different kinds; there is no cycle to
-- prevent, and `acyclic` costs a recursive check on every write.
--
-- `team_member` IS A LEGAL DESTINATION. Agents belong to channels the way
-- people do — the channel summary already publishes `workingAgentCount`
-- (contract.ts:109), so a membership model admitting only humans would
-- contradict a badge that already ships.
--
-- NOT AN ACL. Membership answers "who is in this channel", never "who may read
-- it". `restricted` visibility on this node means invisible to everyone and is
-- not an access-control list, so wiring membership to visibility needs its own
-- explicit ruling and is out of scope here.
--
-- internal.guard_w1_edge needs NO change: it acts only on the named types in
-- its branches (065:114, replaced 066:89) and `has_member` is in none of them,
-- so it passes through untouched.
-- =============================================================================
set role tm8_graph_owner;

insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic, props_schema) values
  ('has_member', array['channel'], array['member','team_member'],
   'Channel membership: this channel has that person or teammate as a member. '
   || 'props {role, joinedAt}; role is advisory (owner|member) and not DB-constrained. '
   || 'A roster, not an ACL and not a subscription.',
   false,
   jsonb_build_object(
     'type', 'object',
     'properties', jsonb_build_object(
       'role', jsonb_build_object('type', 'string'),
       'joinedAt', jsonb_build_object('type', 'string'),
       'origin', jsonb_build_object('type', 'string')),
     'additionalProperties', true))
on conflict (type) do nothing;

reset role;
