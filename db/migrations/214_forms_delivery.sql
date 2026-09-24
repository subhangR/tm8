-- =============================================================================
-- 214  FORMS W2 — DELIVERY CORE: the form_deliveries drain (FORMS-DESIGN §7).
--
-- 211 leaves two things behind a submit or a cancel, and nothing delivers them:
--   * a `form_deliveries(pending)` row naming the response and the requesting
--     session (the OUTBOX), with the session copy of the response message on
--     `form_responses.message_id`;
--   * a `form_cancelled` message on [requesting session, form], batch
--     'form_cancelled:<formId>', with NO route and no outbox at all.
-- This file is the SQL half of the drain that closes both. TypeScript
-- (facade/services/w2/form-delivery.ts) renders the envelope and hands it to the
-- existing delivery loop; everything that decides WHO may be claimed, and when a
-- row is settled, lives here.
--
--   A. Claim state on form_deliveries: `claimed_at` (a lease) and `claimed_by`
--      (the acting identity, for provenance — coordinator ruling: the SERVER's
--      claims deliver, not the respondent's). An index on delivery_id for the
--      settlement trigger.
--   B. `form_notices` — the cancel notice's outbox, same shape, one row per
--      (cancel message, session). Enqueued by a trigger on the message insert,
--      so every door that posts the notice gets one, and 211 is not copied.
--   C. A session deleted BEFORE submit: 211's internal.form_requesting_session
--      filters deleted sessions, so the door writes no delivery row at all. A
--      trigger on the submit records it as `cancelled/session_deleted`, so the
--      response shows why it went nowhere (§7.3: "Send to a new session").
--   D. `claim_form_deliveries` — THE claim, used by the post-commit hook (one
--      response), the drain-on-live hook (one session) and the backstop tick
--      (everything). Reconcile, cancel the deleted, then claim with
--      `FOR UPDATE SKIP LOCKED`; `attempts + 1` becomes the delivery's
--      `attempt_no`, which session_message_deliveries keeps UNIQUE per
--      (message, target) — a second net under the lease.
--   E. `record_form_delivery_attempt` / `release_form_delivery` — the two
--      after-dispatch writes.
--   F. Settlement from session_message_deliveries, by trigger: a row becomes
--      `delivered` only when its delivery row settles `delivered`.
--
-- EXACTLY ONCE per (response, session). A row is claimable only while it is
-- pending, holds no delivery, has no live or expired-free lease, and no
-- session_message_deliveries row for (message, session) is in flight or
-- delivered. The last clause is what makes a crash between reserve() and
-- record_form_delivery_attempt safe: the next claim ADOPTS the reservation it
-- finds instead of reserving a second one.
--
-- LIVENESS IS CHECKED BEFORE RESERVING (advisor, point 2). reserve() against an
-- exited session writes failed_permanent/session_not_live and fires the
-- fallback notice, so this claim never hands out a row whose session is not
-- running or idle. Such a row simply stays pending (onSessionNotLive = queue)
-- until a drain-on-live hook or the tick finds the session live again.
--
-- THE SEAM (stacked Spawn-modes worker). A row whose session is not live and
-- whose mode is resume / spawn_new — or whose target is new_session — is
-- claimed only when its mode is named in `p_route_modes`, and comes back with
-- purpose 'route'. Today the server passes an empty list, so those rows behave
-- as `queue`; the next worker fills the handlers and widens the list.
--
-- WHY THE REPLY ROUTE IS WRITTEN HERE AND NOT BY w2_record_session_message_routes.
-- That door refuses a batch whose author is not the calling actor (42501), and
-- the drain runs under the server's claims while the message is authored by the
-- respondent. The route this drain needs is exactly 072's ANCHOR TARGET — the
-- session copy, answered on the form — so it is written directly with the same
-- conflict rule, and its interaction-pin facts are read the same way.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- A. Claim state.
-- -----------------------------------------------------------------------------
alter table public.form_deliveries
  add column if not exists claimed_at timestamptz,
  add column if not exists claimed_by text;

create index if not exists form_deliveries_delivery_idx
  on public.form_deliveries(delivery_id) where delivery_id is not null;

comment on column public.form_deliveries.claimed_at is
  'Drain lease (214). Set by claim_form_deliveries; cleared when the attempt settles.';
comment on column public.form_deliveries.claimed_by is
  'The identity whose claims made the last delivery attempt (214): the server, not the respondent.';

-- -----------------------------------------------------------------------------
-- B. The cancel notice outbox.
-- -----------------------------------------------------------------------------
create table if not exists public.form_notices (
  message_id      uuid primary key references public.messages(entity_id) on delete cascade,
  form_id         uuid not null references public.entities(id) on delete cascade,
  work_session_id uuid not null references public.entities(id) on delete cascade,
  kind            text not null default 'form_cancelled' check (kind in ('form_cancelled')),
  status          text not null default 'pending'
                  check (status in ('pending', 'delivered', 'cancelled')),
  attempts        int not null default 0 check (attempts >= 0),
  last_error      text,
  delivery_id     uuid,
  claimed_at      timestamptz,
  claimed_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists form_notices_pending_by_session
  on public.form_notices(work_session_id, created_at) where status = 'pending';
create index if not exists form_notices_session_idx on public.form_notices(work_session_id);
create index if not exists form_notices_form_idx on public.form_notices(form_id);
create index if not exists form_notices_delivery_idx
  on public.form_notices(delivery_id) where delivery_id is not null;

comment on table public.form_notices is
  'Outbox for form notices to the requesting session (214 B): today only form_cancelled.';

drop trigger if exists form_notices_touch_updated_at on public.form_notices;
create trigger form_notices_touch_updated_at before update on public.form_notices
for each row execute function internal.touch_updated_at();

alter table public.form_notices enable row level security;
drop policy if exists form_notices_select on public.form_notices;
create policy form_notices_select on public.form_notices for select to tm8_app
  using (internal.entity_readable(form_id));
revoke all on public.form_notices from public;
grant select on public.form_notices to tm8_app;

-- The session copy of 211's cancel notice. Only a copy anchored on a work
-- session is enqueued; the form's own copy is the timeline record. Guarded: a
-- notice bug must never fail the cancel that posted it.
create or replace function internal.form_notice_enqueue() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  form uuid;
begin
  begin
    if not exists (select 1 from public.entities a where a.id = new.anchor_id and a.kind = 'work_session') then
      return null;
    end if;
    form := substring(new.message_batch_id from length('form_cancelled:') + 1)::uuid;
    if not exists (select 1 from public.forms f where f.entity_id = form) then
      return null;
    end if;
    insert into public.form_notices(message_id, form_id, work_session_id, kind)
    values (new.entity_id, form, new.anchor_id, 'form_cancelled')
    on conflict (message_id) do nothing;
  exception when others then
    raise warning 'form notice enqueue failed for message %: % (%)', new.entity_id, sqlerrm, sqlstate;
  end;
  return null;
end
$$;
revoke all on function internal.form_notice_enqueue() from public;

drop trigger if exists messages_form_notice_enqueue on public.messages;
create trigger messages_form_notice_enqueue
after insert on public.messages
for each row
when (new.message_batch_id like 'form_cancelled:%')
execute function internal.form_notice_enqueue();

-- -----------------------------------------------------------------------------
-- C. A session deleted before submit. The door found no requesting session
--    (211 filters deleted ones), so no row exists; record why.
-- -----------------------------------------------------------------------------
create or replace function internal.form_delivery_deleted_session() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  deleted_session uuid;
begin
  if new.status <> 'submitted' then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'submitted' then return null; end if;
  if internal.form_requesting_session(new.form_id) is not null then return null; end if;
  select edge.dst_id into deleted_session
    from public.edges edge
    join public.entities ws on ws.id = edge.dst_id and ws.kind = 'work_session'
   where edge.src_id = new.form_id and edge.type = 'authored_from'
     and ws.deleted_at is not null
   limit 1;
  if deleted_session is not null then
    insert into public.form_deliveries(response_id, work_session_id, status, last_error)
    values (new.id, deleted_session, 'cancelled', 'session_deleted')
    on conflict (response_id, work_session_id) do nothing;
  end if;
  return null;
end
$$;
revoke all on function internal.form_delivery_deleted_session() from public;

drop trigger if exists form_responses_deleted_session_delivery on public.form_responses;
create trigger form_responses_deleted_session_delivery
after insert or update of status on public.form_responses
for each row
when (new.status = 'submitted')
execute function internal.form_delivery_deleted_session();

-- -----------------------------------------------------------------------------
-- Shared pieces.
-- -----------------------------------------------------------------------------

-- Reasons after which another attempt cannot succeed: the envelope itself, or
-- the target's profile, refuses. Everything else is a condition of the moment.
create or replace function internal.form_delivery_permanent_reason(p_reason text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select coalesce(p_reason, '') in (
    'delivery_envelope_budget_exceeded', 'delivery_envelope_render_failed', 'session_input_not_allowed')
$$;

-- The ceiling on attempts for one (response, session). A session that keeps
-- refusing is told nothing more; the response is still stored and visible.
create or replace function internal.form_delivery_max_attempts()
returns integer language sql immutable as $$ select 10 $$;

-- Apply one session_message_deliveries outcome to the outbox row that holds it.
-- `delivered` settles; anything else frees the row for the next live drain.
create or replace function internal.form_delivery_apply(
  p_delivery_id uuid, p_status text, p_reason text
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if p_status in ('pending', 'dispatching') then return; end if;
  if p_status = 'delivered' then
    update public.form_deliveries
       set status = 'delivered', claimed_at = null, last_error = null
     where delivery_id = p_delivery_id and status = 'pending';
    update public.form_notices
       set status = 'delivered', claimed_at = null, last_error = null
     where delivery_id = p_delivery_id and status = 'pending';
    return;
  end if;
  update public.form_deliveries
     set status = case when internal.form_delivery_permanent_reason(p_reason)
                         or attempts >= internal.form_delivery_max_attempts()
                       then 'cancelled' else 'pending' end,
         last_error = left(coalesce(p_reason, p_status), 200),
         delivery_id = null, claimed_at = null
   where delivery_id = p_delivery_id and status = 'pending';
  update public.form_notices
     set status = case when internal.form_delivery_permanent_reason(p_reason)
                         or attempts >= internal.form_delivery_max_attempts()
                       then 'cancelled' else 'pending' end,
         last_error = left(coalesce(p_reason, p_status), 200),
         delivery_id = null, claimed_at = null
   where delivery_id = p_delivery_id and status = 'pending';
end
$$;
revoke all on function internal.form_delivery_apply(uuid, text, text) from public;


-- -----------------------------------------------------------------------------
-- D. THE claim.
--
--   p_response_id      one response (the post-commit hook), or null
--   p_work_session_id  one session (drain-on-live), or null
--   p_limit            rows claimed per call
--   p_lease_seconds    how long a claim blocks a second claimer
--   p_route_modes      not-live modes the caller can act on: any of
--                      'resume', 'spawn_new', 'new_session' (the seam)
-- -----------------------------------------------------------------------------
create or replace function public.claim_form_deliveries(
  p_response_id uuid default null,
  p_work_session_id uuid default null,
  p_limit integer default 25,
  p_lease_seconds integer default 120,
  p_route_modes text[] default '{}'::text[]
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
  modes text[] := coalesce(p_route_modes, '{}'::text[]);
  who text := internal.identity_id();
  r record;
  n record;
  attempt integer;
  items jsonb := '[]'::jsonb;
  cancelled integer := 0;
  adopted integer := 0;
begin
  perform internal.require_identity();

  -- 1. RECONCILE: adopt what session_message_deliveries already knows, so a
  --    crash between reserve and record never produces a second reservation.
  for r in
    select d.response_id, d.work_session_id, s.delivery_id, s.status, s.failure_reason
      from public.form_deliveries d
      join public.form_responses fr on fr.id = d.response_id
      join lateral (
        select x.delivery_id, x.status, x.failure_reason
          from public.session_message_deliveries x
         where x.message_id = fr.message_id and x.target_work_session_id = d.work_session_id
         order by x.attempt_no desc limit 1
      ) s on true
     where d.status = 'pending'
       and internal.is_space_member(fr.space_id)
       and (p_response_id is null or d.response_id = p_response_id)
       and (p_work_session_id is null or d.work_session_id = p_work_session_id)
       and ((s.status in ('pending', 'dispatching', 'delivered')
             and d.delivery_id is distinct from s.delivery_id)
            or (d.delivery_id = s.delivery_id and s.status not in ('pending', 'dispatching')))
  loop
    if r.status in ('pending', 'dispatching', 'delivered') then
      update public.form_deliveries set delivery_id = r.delivery_id
       where response_id = r.response_id and work_session_id = r.work_session_id and status = 'pending';
      adopted := adopted + 1;
    end if;
    -- A terminal outcome on the row's own delivery: settle it now.
    if r.status not in ('pending', 'dispatching') then
      perform internal.form_delivery_apply(r.delivery_id, r.status, r.failure_reason);
    end if;
  end loop;
  for n in
    select fn.message_id, s.delivery_id, s.status, s.failure_reason
      from public.form_notices fn
      join public.entities fe on fe.id = fn.form_id
      join lateral (
        select x.delivery_id, x.status, x.failure_reason
          from public.session_message_deliveries x
         where x.message_id = fn.message_id and x.target_work_session_id = fn.work_session_id
         order by x.attempt_no desc limit 1
      ) s on true
     where fn.status = 'pending'
       and internal.is_space_member(fe.space_id)
       and p_response_id is null
       and (p_work_session_id is null or fn.work_session_id = p_work_session_id)
       and ((s.status in ('pending', 'dispatching', 'delivered')
             and fn.delivery_id is distinct from s.delivery_id)
            or (fn.delivery_id = s.delivery_id and s.status not in ('pending', 'dispatching')))
  loop
    if n.status in ('pending', 'dispatching', 'delivered') then
      update public.form_notices set delivery_id = n.delivery_id
       where message_id = n.message_id and status = 'pending';
    end if;
    if n.status not in ('pending', 'dispatching') then
      perform internal.form_delivery_apply(n.delivery_id, n.status, n.failure_reason);
    end if;
  end loop;

  -- 2. DELETED SESSIONS: a resume/queue delivery to the requesting session, and
  --    every notice, is cancelled. The response stays stored. Spawn modes are
  --    the seam's to decide (a deleted session can still get a new one).
  with gone as (
    update public.form_deliveries d
       set status = 'cancelled', last_error = 'session_deleted', claimed_at = null
      from public.form_responses fr, public.forms f, public.entities se
     where fr.id = d.response_id and f.entity_id = fr.form_id and se.id = d.work_session_id
       and d.status = 'pending' and d.delivery_id is null
       and se.deleted_at is not null
       and internal.is_space_member(fr.space_id)
       and (p_response_id is null or d.response_id = p_response_id)
       and (p_work_session_id is null or d.work_session_id = p_work_session_id)
       and internal.form_settings_effective(f.settings) #>> '{delivery,target}' = 'requesting_session'
       and internal.form_settings_effective(f.settings) #>> '{delivery,onSessionNotLive}' in ('resume', 'queue')
    returning 1
  )
  select count(*) into cancelled from gone;
  update public.form_notices fn
     set status = 'cancelled', last_error = 'session_deleted', claimed_at = null
    from public.entities se, public.entities fe
   where se.id = fn.work_session_id and fe.id = fn.form_id
     and fn.status = 'pending' and fn.delivery_id is null
     and se.deleted_at is not null
     and internal.is_space_member(fe.space_id)
     and p_response_id is null
     and (p_work_session_id is null or fn.work_session_id = p_work_session_id);

  -- 3. CLAIM. Responses first (a waiting agent asked for them), then notices.
  for r in
    select d.response_id, d.work_session_id, d.attempts, fr.message_id, fr.form_id,
           ws.status as session_status,
           internal.form_settings_effective(f.settings) -> 'delivery' as delivery,
           (ws.status in ('running', 'idle')) as live
      from public.form_deliveries d
      join public.form_responses fr on fr.id = d.response_id
      join public.forms f on f.entity_id = fr.form_id
      join public.entities se on se.id = d.work_session_id
      left join public.work_sessions ws on ws.entity_id = d.work_session_id
     where d.status = 'pending'
       and d.delivery_id is null
       and (d.claimed_at is null or d.claimed_at < now() - lease)
       and fr.message_id is not null
       and internal.is_space_member(fr.space_id)
       and (p_response_id is null or d.response_id = p_response_id)
       and (p_work_session_id is null or d.work_session_id = p_work_session_id)
       and (
         -- inject: the requesting session, live now
         ((internal.form_settings_effective(f.settings) #>> '{delivery,target}') = 'requesting_session'
          and se.deleted_at is null and ws.status in ('running', 'idle'))
         -- route (the seam): a mode the caller can act on
         or ((internal.form_settings_effective(f.settings) #>> '{delivery,target}') = 'new_session'
             and 'new_session' = any(modes))
         or ((internal.form_settings_effective(f.settings) #>> '{delivery,target}') = 'requesting_session'
             and (se.deleted_at is not null or ws.status is null or ws.status not in ('running', 'idle', 'spawning'))
             and (internal.form_settings_effective(f.settings) #>> '{delivery,onSessionNotLive}') = any(modes))
       )
     order by d.created_at
     limit lim
     for update of d skip locked
  loop
    select greatest(r.attempts, coalesce(max(x.attempt_no), 0)) + 1 into attempt
      from public.session_message_deliveries x
     where x.message_id = r.message_id and x.target_work_session_id = r.work_session_id;
    update public.form_deliveries
       set attempts = attempt, claimed_at = now(), claimed_by = who
     where response_id = r.response_id and work_session_id = r.work_session_id;
    items := items || jsonb_build_array(
      internal.form_delivery_item('response', r.response_id, r.message_id, r.form_id,
        r.work_session_id, attempt, r.session_status, r.delivery, r.live
          and (r.delivery ->> 'target') = 'requesting_session'));
  end loop;

  if p_response_id is null then
    for n in
      select fn.message_id, fn.form_id, fn.work_session_id, fn.attempts, ws.status as session_status
        from public.form_notices fn
        join public.entities fe on fe.id = fn.form_id
        join public.entities se on se.id = fn.work_session_id and se.deleted_at is null
        join public.work_sessions ws on ws.entity_id = fn.work_session_id
       where fn.status = 'pending'
         and fn.delivery_id is null
         and (fn.claimed_at is null or fn.claimed_at < now() - lease)
         and ws.status in ('running', 'idle')
         and internal.is_space_member(fe.space_id)
         and (p_work_session_id is null or fn.work_session_id = p_work_session_id)
       order by fn.created_at
       limit lim
       for update of fn skip locked
    loop
      select greatest(n.attempts, coalesce(max(x.attempt_no), 0)) + 1 into attempt
        from public.session_message_deliveries x
       where x.message_id = n.message_id and x.target_work_session_id = n.work_session_id;
      update public.form_notices
         set attempts = attempt, claimed_at = now(), claimed_by = who
       where message_id = n.message_id;
      items := items || jsonb_build_array(
        internal.form_delivery_item('notice', null, n.message_id, n.form_id,
          n.work_session_id, attempt, n.session_status, null, true));
    end loop;
  end if;

  return jsonb_build_object('items', items, 'cancelled', cancelled, 'adopted', adopted);
end
$$;

-- One claimed item: everything the envelope renders, read under the claim.
create or replace function internal.form_delivery_item(
  p_kind text, p_response_id uuid, p_message_id uuid, p_form_id uuid,
  p_work_session_id uuid, p_attempt integer, p_session_status text,
  p_delivery jsonb, p_inject boolean
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  f public.forms;
  fr public.form_responses;
  answered integer;
  total integer;
begin
  select * into f from public.forms where entity_id = p_form_id;
  if p_response_id is not null then
    select * into fr from public.form_responses where id = p_response_id;
    select count(*) filter (where fr.answers ? (q ->> 'key') and fr.answers -> (q ->> 'key') <> 'null'::jsonb),
           count(*)
      into answered, total
      from jsonb_array_elements(coalesce(fr.questions_snapshot -> 'questions', '[]'::jsonb)) q;
  end if;
  return jsonb_build_object(
    'kind', p_kind,
    'purpose', case when p_inject then 'inject' else 'route' end,
    'responseId', p_response_id,
    'messageId', p_message_id,
    'formId', p_form_id,
    'workSessionId', p_work_session_id,
    'attemptNo', p_attempt,
    'sessionStatus', p_session_status,
    'delivery', coalesce(p_delivery, internal.form_settings_effective(f.settings) -> 'delivery'),
    'form', jsonb_build_object('status', f.status, 'structureVersion', f.structure_version),
    'response', case when p_response_id is null then null else jsonb_build_object(
      'revision', fr.revision,
      'supersedesId', fr.supersedes_id,
      'submittedAt', fr.submitted_at,
      'answered', answered,
      'total', total) end,
    'route', case when p_inject
      then internal.form_delivery_route(p_message_id, p_work_session_id, p_form_id, p_attempt)
      else null end);
end
$$;
revoke all on function internal.form_delivery_item(text, uuid, uuid, uuid, uuid, integer, text, jsonb, boolean) from public;

-- -----------------------------------------------------------------------------
-- E1. After reserve(): the row holds this delivery. The delivery may already
--     have settled (dispatch is not awaited), so its row is read FOR SHARE —
--     which waits out a concurrent settlement — and applied here if terminal.
--     Without that, the trigger (F) and this write could each miss the other.
-- -----------------------------------------------------------------------------
create or replace function public.record_form_delivery_attempt(
  p_kind text, p_key uuid, p_work_session_id uuid, p_delivery_id uuid
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  s public.session_message_deliveries;
  held integer;
begin
  perform internal.require_identity();
  if p_kind = 'response' then
    update public.form_deliveries d set delivery_id = p_delivery_id
      from public.form_responses fr
     where fr.id = d.response_id and d.response_id = p_key and d.work_session_id = p_work_session_id
       and d.status = 'pending' and internal.is_space_member(fr.space_id);
  elsif p_kind = 'notice' then
    update public.form_notices fn set delivery_id = p_delivery_id
      from public.entities fe
     where fe.id = fn.form_id and fn.message_id = p_key and fn.work_session_id = p_work_session_id
       and fn.status = 'pending' and internal.is_space_member(fe.space_id);
  else
    raise exception 'unknown form delivery kind %', p_kind using errcode = '22023';
  end if;
  get diagnostics held = row_count;
  select * into s from public.session_message_deliveries where delivery_id = p_delivery_id for share;
  if held = 1 and s.delivery_id is not null then
    perform internal.form_delivery_apply(s.delivery_id, s.status, s.failure_reason);
  end if;
  return jsonb_build_object('recorded', held = 1, 'deliveryStatus', s.status);
end
$$;

-- -----------------------------------------------------------------------------
-- E2. Nothing was reserved (or the reservation was refused before a write):
--     free the claim. `p_final` settles it cancelled — the envelope or the
--     target's profile refuses, so another attempt cannot succeed.
-- -----------------------------------------------------------------------------
create or replace function public.release_form_delivery(
  p_kind text, p_key uuid, p_work_session_id uuid, p_error text default null, p_final boolean default false
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare held integer;
begin
  perform internal.require_identity();
  if p_kind = 'response' then
    update public.form_deliveries d
       set status = case when coalesce(p_final, false) then 'cancelled' else 'pending' end,
           claimed_at = null, last_error = left(p_error, 200)
      from public.form_responses fr
     where fr.id = d.response_id and d.response_id = p_key and d.work_session_id = p_work_session_id
       and d.status = 'pending' and d.delivery_id is null and internal.is_space_member(fr.space_id);
  elsif p_kind = 'notice' then
    update public.form_notices fn
       set status = case when coalesce(p_final, false) then 'cancelled' else 'pending' end,
           claimed_at = null, last_error = left(p_error, 200)
      from public.entities fe
     where fe.id = fn.form_id and fn.message_id = p_key and fn.work_session_id = p_work_session_id
       and fn.status = 'pending' and fn.delivery_id is null and internal.is_space_member(fe.space_id);
  else
    raise exception 'unknown form delivery kind %', p_kind using errcode = '22023';
  end if;
  get diagnostics held = row_count;
  return jsonb_build_object('released', held = 1);
end
$$;

-- -----------------------------------------------------------------------------
-- F. Settlement from session_message_deliveries. Guarded: a forms bug must
--    never fail the delivery settlement it observes.
-- -----------------------------------------------------------------------------
create or replace function internal.form_delivery_settle_trigger() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  begin
    perform internal.form_delivery_apply(new.delivery_id, new.status, new.failure_reason);
  exception when others then
    raise warning 'form delivery settlement failed for delivery %: % (%)', new.delivery_id, sqlerrm, sqlstate;
  end;
  return null;
end
$$;
revoke all on function internal.form_delivery_settle_trigger() from public;

drop trigger if exists session_message_deliveries_form_settle on public.session_message_deliveries;
create trigger session_message_deliveries_form_settle
after update of status on public.session_message_deliveries
for each row
when (new.status is distinct from old.status and new.status not in ('pending', 'dispatching'))
execute function internal.form_delivery_settle_trigger();

revoke all on function public.claim_form_deliveries(uuid, uuid, integer, integer, text[]) from public;
grant execute on function public.claim_form_deliveries(uuid, uuid, integer, integer, text[]) to tm8_app;
revoke all on function public.record_form_delivery_attempt(text, uuid, uuid, uuid) from public;
grant execute on function public.record_form_delivery_attempt(text, uuid, uuid, uuid) to tm8_app;
revoke all on function public.release_form_delivery(text, uuid, uuid, text, boolean) from public;
grant execute on function public.release_form_delivery(text, uuid, uuid, text, boolean) to tm8_app;

reset role;

-- -----------------------------------------------------------------------------
-- G. The route facts dispatch needs, for one (session copy, session, form), and
--    the reply route written on the way (see the header on why it is written
--    here). DEFINED AFTER `reset role`, as 121/163 are: session_message_reply_routes
--    is owned by the default migration role, and a SECURITY DEFINER body created
--    under tm8_graph_owner cannot write it. The claim (owned by tm8_graph_owner)
--    is granted EXECUTE on this one function and nothing else.
-- -----------------------------------------------------------------------------
create or replace function internal.form_delivery_route(
  p_message_id uuid, p_work_session_id uuid, p_form_id uuid, p_attempt_no integer
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  m public.messages;
  source_message uuid;
  kind text;
begin
  select * into m from public.messages where entity_id = p_message_id;
  select s.entity_id into source_message
    from public.messages s
   where s.message_batch_id = m.message_batch_id and s.anchor_id = p_form_id
   limit 1;
  source_message := coalesce(source_message, p_message_id);
  -- 076's internal.w2_addressing_kind for a source anchor that is neither a
  -- work session nor a channel: a form is always 'anchored_message'.
  kind := 'anchored_message';
  insert into public.session_message_reply_routes(
    target_message_id, target_work_session_id, source_anchor_id, source_message_id, addressing_kind)
  values (p_message_id, p_work_session_id, p_form_id, source_message, kind)
  on conflict do nothing;

  return jsonb_build_object(
    'targetMessageId', p_message_id,
    'targetWorkSessionId', p_work_session_id,
    'messageBatchId', m.message_batch_id,
    'senderActorId', m.author_id,
    'senderActorKind', (select e.kind from public.entities e where e.id = m.author_id),
    'sourceAnchorId', p_form_id,
    'sourceAnchorKind', 'form',
    'sourceMessageId', source_message,
    'threadParentMessageId', null,
    'threadRootMessageId', source_message,
    'body', m.body,
    'attachments', '[]'::jsonb,
    'addressingKind', kind,
    'contextAnchors', '[]'::jsonb,
    'attemptNo', p_attempt_no,
    -- Read for the TARGET session, exactly as 163 reads them.
    'rollingControlMaxBytes', coalesce((
      select (pin.resolved_snapshot #>> '{agentProjection,promptPolicy,rollingControlMaxBytes}')::integer
        from public.work_session_interaction_pins pin
       where pin.work_session_id = p_work_session_id
       order by pin.pin_revision desc limit 1
    ), 16384),
    'sessionInputAllowed', coalesce((
      select case
        when jsonb_array_length(coalesce(
          pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}', '[]'::jsonb
        )) = 0 then true
        else coalesce(
          (pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}')
            ? 'tm8.session-input', false)
      end
        from public.work_session_interaction_pins pin
       where pin.work_session_id = p_work_session_id
       order by pin.pin_revision desc limit 1
    ), true));
end
$$;
revoke all on function internal.form_delivery_route(uuid, uuid, uuid, integer) from public;
grant execute on function internal.form_delivery_route(uuid, uuid, uuid, integer) to tm8_graph_owner;
