# db/migrations

ONE clean migration sequence — no legacy history, zero Firebase/Supabase
references, zero UID-bypass machinery (T-D3).

Groups per 09 §3.1:
- 001 core graph (spaces, entities envelope+triggers, detail tables, edges, messages, counters, versions, task_axes)
- 002 identity (accounts, auth_sessions, user_profiles, members, team_members; SET LOCAL claim helpers, low-priv app role — R2)
- 003 read model (activity, read_marks/unread_counts, notifications + transport-agnostic outbox, workspace_events + capture trigger, saved_views)
- 004 ledgers (point_events, command_ledger w/ 24h TTL)
- 005 custom kinds (entity_kinds R7, custom_entities + scalar-schema validation R8/R9)
- 006 execution side (session_manifests, session_modals, stream_grants)
- 007 RPC catalog (api-design 01 §6 + tm8 additions; views entity_tree, leaderboard, ready_to_work)
- 008 RLS policies (SELECT-only + SECURITY-DEFINER writes, claim-keyed)

Crib freely from agent-maestro branch `feat/collab-v2-supabase-backend` supabase/
migrations; import none of them verbatim.

Naming: `NNN_description.sql`, applied in lexical order by the migration runner
(`tools/conformance` gate: migrations apply clean to a fresh sidecar PG on 5442).
