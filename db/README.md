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

Fixes found by `db/test/` once the schema was first exercised as `tm8_app` rather
than only through SECURITY DEFINER RPCs. 001-008 are applied and checksum-locked,
so each fix is a NEW file — forward-only, never an edit:
- 009 grant `internal.claim_text` to tm8_app. Without it, the eleven RLS policies
  naming `internal.identity_id()` / `is_node_admin()` raised 42501 instead of
  filtering: those accessors are SECURITY INVOKER wrappers, and a policy is
  evaluated as the querying role.
- 010 `public.mark_read` — a PL/pgSQL variable shadowed a column in its ON CONFLICT
  inference clause (42702). A runtime error, so 007 applied clean and the function
  was simply never callable.
- 011 `internal.entity_content` — added the missing branches for message,
  work_session, member, pull_request and commit. Without them `messages.post` and
  `execution.spawn` returned envelopes with an empty content block: valid jsonb,
  no error, no content.
- 012 `command_ledger` reserves the clientMutationId at the top of the RPC instead
  of recording it at the end, so a simultaneous duplicate submission waits on the
  primary key rather than running the body twice.

Crib freely from agent-maestro branch `feat/collab-v2-supabase-backend` supabase/
migrations; import none of them verbatim.

Naming: `NNN_description.sql`, applied in lexical order by the migration runner
(`tools/conformance` gate: migrations apply clean to a fresh sidecar PG on 5442).

## Tests

```bash
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_cygnus \
node db/test/run.mjs
```

`run.mjs` resets the target database, applies the whole sequence, then runs every
`db/test/*.test.mjs` serially (accounts are node-wide with a single owner, so
parallel suites would race on the bootstrap). `TM8_DATABASE_URL` is passed straight
through to both the migration runner and the suites, so they cannot disagree about
which database is under test. Zero npm dependencies: the harness drives `psql` and
node's built-in test runner.

The suites, and what each is for:
- `00_claim_guards` F1/F2 (STATE.md 'Claims contract'). Builds its OWN database via
  `helpers.freshDatabase`, because the zero-accounts branch of `ensure_account` is
  only observable on a virgin node. Also pins that `tm8.node_admin` is the literal
  string `'true'` and that node-admin has two sources on purpose: the claim for
  reads, `public.accounts` for writes.
- `rls_negatives` what the policies REFUSE. Three callers — a non-member, a plain
  member of the space, and a node-admin-by-claim-only — each denied what they must
  be. `invisible()` for policies (they return nothing), `denied()` for guards (they
  raise).
- `event_seq` `workspace_events.seq` as a poll cursor: no duplicates, no gaps, and
  seq order IS commit order (an open writer blocks a concurrent one in the same
  space, but not in another space). The last property is what makes a cursor safe.
- `ledger_replay` clientMutationId idempotency, including a genuinely concurrent
  double-submit.
- `triggers` the invariants that hold even for a writer that bypassed the catalog,
  so most of it runs as the schema owner.
- `loop_rpcs` the G1A loop end to end, asserting the CONTENT of every result. This
  is the guard for the 011 class of bug: a kind with no `entity_content` branch
  yields `{}`, which no success-only assertion can catch.

Writing a negative: `denied(label, sql, {expect})` and `invisible(label, sql)` both
take a label naming the policy or guard AND the caller who must be refused, so a
red run reads `space_invites_select: identity C is a MEMBER of space A but not an
admin` rather than `expected true`.
