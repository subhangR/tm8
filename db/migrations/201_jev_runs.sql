-- =============================================================================
-- 201 — what Jev cost: `jev_runs` and `jev_calls` (design 01a0cb80 §6).
--
-- Jev is an advisor the launch UI calls when a person presses "Ask Jev"
-- (`launch.suggest`). It never runs at spawn. Every HTTP call to Jev is costed
-- here, INCLUDING FAILURES, and every Ask Jev run is summed and linked to the
-- session it launched:
--
--   · jev_runs  — one row per open sheet or popup (`id` is the UI's `runId`).
--                 `session_id` is set on Launch; a run that ended in Cancel
--                 keeps it null and its cost still counts.
--   · jev_calls — one row per Jev HTTP call. `unique (run_id, request_id, grp,
--                 chunk)` is what makes a retried `requestId` never
--                 double-count.
--
-- NOTHING SENSITIVE IS STORED: no prompts, statements, descriptions, response
-- bodies or keys. `suggestions` holds entity ids, scores, levels and the model
-- verdict — enough to measure acceptance against the launched manifest later.
--
-- ONE DEVIATION FROM §6, and why. §6 types `requested_by` as `uuid`. The
-- caller's identity in this schema is `internal.identity_id()`, which is TEXT
-- (`user_profiles.identity_id`, "opaque, immutable", 002) and is not a uuid for
-- every identity. A uuid column would refuse those callers outright. So it is
-- `text`, references `user_profiles`, and DEFAULTS to the caller — the writer
-- does not have to pass it and cannot usefully pass anything else (RLS below).
--
-- ACCESS. Space members read their space's rows. `launch.suggest` writes them
-- inside the caller's own transaction as `tm8_app` (the role every facade
-- transaction runs as, db/client.ts), so writes are plain INSERT/UPDATE under
-- RLS rather than a security-definer door: a row can only be written into a
-- space the caller is a member of, and only as the caller. No DELETE grant —
-- cost history is append-only from the app's side; a run's calls go with it
-- only when the run itself is removed (`on delete cascade`).
-- =============================================================================
set role tm8_graph_owner;

create table public.jev_runs (
  id            uuid primary key,                -- runId from the UI
  space_id      uuid not null references public.spaces(id),
  subject_id    uuid not null references public.entities(id),
  requested_by  text not null default internal.identity_id()
                  references public.user_profiles(identity_id),  -- who pressed Ask Jev
  session_id    uuid null references public.work_sessions(entity_id),   -- set on Launch
  suggestions   jsonb not null default '{}',     -- latest result per group: ids, scores, verdict. NO text.
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index jev_runs_space_created_idx on public.jev_runs(space_id, created_at desc);
create index jev_runs_session_idx on public.jev_runs(session_id) where session_id is not null;

create trigger jev_runs_touch_updated_at before update on public.jev_runs
for each row execute function internal.touch_updated_at();

create table public.jev_calls (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.jev_runs(id) on delete cascade,
  request_id    uuid not null,
  grp           text not null check (grp in ('model','teammates','memories','skills')),
  chunk         int  not null default 0,
  jev_model     text null,                       -- a concrete version echoed by the API, never an alias
  input_tokens  int  not null,
  output_tokens int  not null,
  cost_usd      numeric(12,8) not null,
  latency_ms    int  not null,
  outcome       text not null,                   -- 'ok' | JevFailure
  created_at    timestamptz not null default now(),
  unique (run_id, request_id, grp, chunk)        -- a retried request never double-counts
);

comment on table public.jev_runs is
  'One Ask Jev run per open launch sheet or popup: its latest suggestions (ids and scores only) and the session it launched.';
comment on table public.jev_calls is
  'One row per Jev HTTP call, failures included, priced at input tokens only. Summed per run for the run total.';

-- -----------------------------------------------------------------------------
-- RLS. Membership is read through the same security-definer helper every
-- space-scoped policy uses (002), so a stranger sees and writes nothing.
-- -----------------------------------------------------------------------------
alter table public.jev_runs enable row level security;
alter table public.jev_calls enable row level security;

create policy jev_runs_select on public.jev_runs for select to tm8_app
  using (internal.is_space_member(space_id));

create policy jev_runs_insert on public.jev_runs for insert to tm8_app
  with check (
    internal.is_space_member(space_id)
    and requested_by = internal.identity_id()
  );

-- An update may only touch the caller's own run, and may not move it to
-- another space or another requester.
create policy jev_runs_update on public.jev_runs for update to tm8_app
  using (
    internal.is_space_member(space_id)
    and requested_by = internal.identity_id()
  )
  with check (
    internal.is_space_member(space_id)
    and requested_by = internal.identity_id()
  );

create policy jev_calls_select on public.jev_calls for select to tm8_app
  using (exists (
    select 1 from public.jev_runs r
     where r.id = jev_calls.run_id
       and internal.is_space_member(r.space_id)
  ));

-- A call row joins a run only when that run is the caller's, in a space they
-- are a member of. The run's own RLS already hides a stranger's run, and the
-- explicit predicate keeps that true even if the select policy ever widens.
create policy jev_calls_insert on public.jev_calls for insert to tm8_app
  with check (exists (
    select 1 from public.jev_runs r
     where r.id = jev_calls.run_id
       and internal.is_space_member(r.space_id)
       and r.requested_by = internal.identity_id()
  ));

grant select, insert, update on public.jev_runs to tm8_app;
grant select, insert on public.jev_calls to tm8_app;

-- -----------------------------------------------------------------------------
-- Verify: a missing grant or a disabled RLS flag is invisible in a table diff
-- and silent in production (a grant to the wrong role reads as "no rows").
-- -----------------------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.jev_runs'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.jev_calls'::regclass) then
    raise exception 'VERIFY 201: row level security is not enabled on jev_runs/jev_calls';
  end if;
  if not has_table_privilege('tm8_app', 'public.jev_runs', 'select, insert, update')
     or not has_table_privilege('tm8_app', 'public.jev_calls', 'select, insert') then
    raise exception 'VERIFY 201: tm8_app is missing its grants on jev_runs/jev_calls';
  end if;
  if has_table_privilege('tm8_app', 'public.jev_calls', 'update')
     or has_table_privilege('tm8_app', 'public.jev_runs', 'delete')
     or has_table_privilege('tm8_app', 'public.jev_calls', 'delete') then
    raise exception 'VERIFY 201: tm8_app holds a write it must not (jev_calls update, any delete)';
  end if;
end
$$;

reset role;
