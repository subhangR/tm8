-- =============================================================================
-- W2.I04 BATCH — four forward-only repairs to 001/007/015/019-era RPCs.
--
-- NO MIGRATION NUMBER APPEARS IN THIS FILE, by name or in its text. The
-- coordinator assigns it at landing.
--
-- CONTENTS
--   1. public.set_work_state                              absent-means-merge
--   2. public.w2_edit_message                             absent-means-merge
--   3. public.reset_session_wake_budget_for_member_reply  unauthenticated write
--   4. internal.claim_text                                blank-claim normalisation
--
-- Fixes 1 and 2 are the same defect class. Fixes 3 and 4 are unrelated to each
-- other and to 1-2; they are batched only to spend one landing window.
--
-- =============================================================================
-- 1. public.set_work_state — A WRITE THAT DOES NOT MENTION A FIELD DESTROYS IT
-- =============================================================================
-- MEASURED, with the positive control that proves there was something to lose:
--
--   props BEFORE transition: {"note": "handover: waiting on review",
--                             "status": "working",  "startedAt": "...009275"}
--   props AFTER  transition: {"note": null,
--                             "status": "in_review","startedAt": "...064249"}
--
-- The cause is `on conflict ... do update set props = excluded.props`, a
-- WHOLESALE REPLACEMENT. `excluded.props` is rebuilt from the arguments, so any
-- field the caller did not mention is written as null over the stored value.
--
-- NOT INERT: entity-read.ts:665-676 surfaces it as badges.workingActors[].note.
-- AND THERE IS NO FLAG TO PASS: WorkInputSchema declares note? optional and the
-- frozen CLI grammar names it nowhere, so an agent running an ordinary
-- transition destroys a note left by the UI or an MCP client, unavoidably, at
-- exit 0.
--
-- THE RULE THIS ESTABLISHES, and it must hold in BOTH directions:
--     ABSENT means LEAVE ALONE.   EXPLICIT CLEAR means CLEAR.
-- Merge-on-absent must not become cannot-ever-null, which would trade a
-- silent-destroy for a silent-cannot-erase — the same disease facing the other
-- way. The shape is copied from public.update_task (007:952, 007:980), which
-- already does exactly this: a nullable field gets per-field coalesce PLUS a
-- separate boolean clear flag.
--
-- WHAT THIS DOES TO startedAt, stated because a reader will ask and because it
-- is the one thing here that is deliberately NOT changed. startedAt is left on
-- its existing semantics: every transition resets it to
-- coalesce(p_started_at, now()). That is visible in the measurement above
-- (.009275 -> .064249) and it is NOT filed as a defect — "when did the CURRENT
-- state start" is a defensible reading of the field, and the wave that measured
-- the note loss declined to call it one. Changing it would be scope this
-- migration was not given. It is recorded here so nobody later reads the note
-- fix as having also settled startedAt.
--
-- WHY THIS FUNCTION IS DROPPED AND RECREATED RATHER THAN REPLACED. Adding
-- p_clear_note changes the signature, and `create or replace` with a new
-- argument list creates an OVERLOAD rather than replacing. Both would then
-- exist, the six-argument call the server issues (commands.ts:33) would become
-- ambiguous, and the destructive body would still be reachable. The old
-- signature is therefore dropped explicitly and the grant restored below —
-- dropping a function discards its ACL, which is why the grant is not optional
-- housekeeping here.
--
-- REACHABILITY OF THE CLEAR HALF, stated so it is not over-read: the clear flag
-- makes deliberate clearing possible AT THE DATABASE BOUNDARY. No caller can
-- reach it yet — the server passes six positional arguments and the CLI grammar
-- has no such flag — so "a caller may clear deliberately" is true of SQL today
-- and becomes true of the API only when a client is taught to pass it. That is
-- a handoff item, not something a migration can close.
-- =============================================================================

set role tm8_graph_owner;

drop function if exists public.set_work_state(uuid, text, uuid, timestamptz, text, text);

create or replace function public.set_work_state(
  p_task_id uuid,
  p_status text,
  p_actor_id uuid default null,
  p_started_at timestamptz default null,
  p_note text default null,
  p_client_mutation_id text default null,
  p_clear_note boolean default false
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  edge_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.work');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_task_id, 'task');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if p_status not in ('open','pulled','working','in_review','blocked','cancelled') then
    if p_status = 'done' then
      raise exception 'completion goes through complete_task' using errcode = '23514';
    end if;
    raise exception 'invalid work status: %', p_status using errcode = '22023';
  end if;

  if p_status in ('open','cancelled') then
    delete from public.edges
     where src_id = actor and dst_id = p_task_id and type = 'working_on';
  else
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (e.space_id, actor, p_task_id, 'working_on',
            jsonb_build_object(
              'status', p_status,
              'startedAt', coalesce(p_started_at, now()),
              'note', case when p_clear_note then null else p_note end),
            actor)
    on conflict (src_id, dst_id, type) do update
      -- The merge. `note` is the only field a caller cannot express, so it is
      -- the only one that falls back to the stored value; `edges.props` is the
      -- PRE-UPDATE row. An explicit p_clear_note wins over both.
      set props = jsonb_build_object(
            'status', p_status,
            'startedAt', coalesce(p_started_at, now()),
            'note', case
                      when p_clear_note then null
                      else coalesce(p_note, edges.props->>'note')
                    end),
          updated_at = now()
    returning id into edge_id;
  end if;

  update public.tasks set work_status = p_status, updated_at = now() where entity_id = p_task_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.work',
           internal.command_result(p_task_id, edge_id,
             internal.record_activity(e.space_id, p_task_id, actor, 'work.changed', edge_id,
               jsonb_build_object('status', p_status)), array[p_task_id]));
end
$$;

-- DROP discarded the ACL. Restore it exactly as measured before the drop:
-- proacl was tm8_graph_owner=X/tm8_graph_owner | tm8_app=X/tm8_graph_owner,
-- and PUBLIC held no EXECUTE. Re-granting to PUBLIC would widen the surface.
revoke all on function public.set_work_state(uuid, text, uuid, timestamptz, text, text, boolean) from public;
grant execute on function public.set_work_state(uuid, text, uuid, timestamptz, text, text, boolean) to tm8_app;

comment on function public.set_work_state(uuid, text, uuid, timestamptz, text, text, boolean) is
  'Task work-state transition. ABSENT MEANS LEAVE ALONE: a transition that does '
  'not mention `note` preserves the stored note rather than nulling it. Pass '
  'p_clear_note => true to clear it deliberately. startedAt deliberately keeps '
  'its prior semantics and is reset to coalesce(p_started_at, now()) on every '
  'transition -- "when did the CURRENT state start" -- which is NOT a defect '
  'and was not changed here.';

-- =============================================================================
-- 2. public.w2_edit_message — THE SAME CLASS, ON mentions
-- =============================================================================
-- MEASURED, again with its positive control:
--
--   mentions BEFORE edit: [{"kind":"member","display":"WK Owner","entityId":"..."}]
--   mentions AFTER  edit: []
--
-- The cause is `coalesce(p_mention_ids, '{}'::uuid[])`: an ABSENT mention list
-- is coerced to an EMPTY list and resolved to `[]`, which then overwrites the
-- stored mentions wholesale. Same defect as fix 1 in a different disguise —
-- there the absent field became null, here it becomes empty.
--
-- NO NEW FLAG IS NEEDED, and that is why this one keeps its signature. uuid[]
-- can already express the distinction the boolean flag had to carry above:
--     NULL array  -> absent    -> leave the stored mentions alone
--     '{}' array  -> explicit  -> clear the mentions
--     non-empty   -> explicit  -> replace with the resolved list
-- So both halves are expressible by every existing caller today, with no
-- signature change, no drop, and no ACL to restore.
--
-- Everything else in this function is reproduced verbatim from the live
-- definition, including 032's require_replay_subject binding and 033's
-- principal pin on the replay path. This migration does not touch either.
-- =============================================================================

create or replace function public.w2_edit_message(
  p_message_id uuid,
  p_body text,
  p_mention_ids uuid[],
  p_expected_version integer,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; envelope public.entities; message public.messages; actor uuid; resolved_mentions jsonb; result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay:=internal.ledger_replay(p_client_mutation_id,'messages.edit');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{messageId}', p_message_id::text, 'message');
    return replay;
  end if;
  select * into envelope from public.entities where id=p_message_id and kind='message' for update;
  select * into message from public.messages where entity_id=p_message_id for update;
  if envelope.id is null or envelope.deleted_at is not null or message.redacted_at is not null then
    raise exception 'message not found' using errcode='P0002';
  end if;
  perform internal.require_space_member(envelope.space_id);
  actor:=internal.resolve_actor(p_actor_id,envelope.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_message_id,p_expected_version);
  if message.author_id<>actor and not internal.can_act_as(message.author_id,envelope.space_id) then
    raise exception 'only the author may edit this message' using errcode='42501';
  end if;
  -- ABSENT MEANS LEAVE ALONE. A NULL array is "the caller said nothing about
  -- mentions"; an empty array is "the caller said: none".
  resolved_mentions := case
    when p_mention_ids is null then message.mentions
    else internal.w2_resolve_mentions(p_mention_ids, envelope.space_id)
  end;
  update public.messages set body=p_body,mentions=resolved_mentions where entity_id=p_message_id;
  result:=jsonb_build_object('messageId',p_message_id);
  return internal.ledger_record(p_client_mutation_id,'messages.edit',result);
end
$$;

comment on function public.w2_edit_message(uuid, text, uuid[], integer, uuid, text) is
  'Edit a message body and mentions. ABSENT MEANS LEAVE ALONE: a NULL '
  'p_mention_ids preserves the stored mentions; an EMPTY array clears them; a '
  'non-empty array replaces them. Retains 032''s require_replay_subject binding '
  'and 033''s principal pin on the replay path.';

-- =============================================================================
-- 3. public.reset_session_wake_budget_for_member_reply — UNAUTHENTICATED WRITE
-- =============================================================================
-- The first branch -- reply not found, or author not kind='member' -- returns
-- internal.ledger_record BEFORE internal.require_space_member, which is on the
-- following line. Authorization is therefore never reached on that path, and an
-- identity-less tm8_app caller passing any unknown uuid commits a
-- command_ledger row with identity_id NULL.
--
-- SEVERITY RE-DERIVED AFTER 033, not inherited from the pre-033 framing:
--   * THE DISCLOSURE HALF IS CLOSED. 033 put the principal comparison inside
--     internal.ledger_replay with both NULL cells fail-closed, so that row is
--     now unreplayable by ANYONE, including its own writer. The cmid-poisoning
--     path that made this urgent this morning no longer exists.
--   * THE WRITE IS STILL OPEN, and that is what this fixes. command_ledger is
--     the execution audit trail (DEV-9/S10). An unauthenticated caller can
--     still commit rows into it at will -- unbounded, attributable to no one,
--     and indistinguishable from real entries to anything reading the trail.
--     Reduced severity, not fixed.
--
-- THE FIX is to establish the principal before anything is written, not to move
-- the ledger_record call. internal.require_identity() raises 28000 when no
-- identity is bound, so an unauthenticated caller is refused before it can
-- reach any branch. It is placed at the top rather than inside the first branch
-- because the SECOND ledger_record (the pair_count branch) is only accidentally
-- safe -- it happens to sit after require_space_member -- and a guard that
-- depends on statement order is one edit away from being wrong again.
--
-- FAIL-CLOSED COST, already ruled on: an unauthenticated caller LOSES the
-- ability to write a committed audit row. That is the desired outcome. A prior
-- enumeration of every ledgered RPC in the chain found no LEGITIMATE unbound
-- caller of this function -- no packages/server/src caller reaches it and it has
-- no facade route -- and I re-derived that independently from pg_catalog:
-- comparing first-ledger_record position against first-guard position across
-- every function containing ledger_record, this is the ONLY record-before-guard
-- site in the chain.
-- =============================================================================

create or replace function public.reset_session_wake_budget_for_member_reply(
  p_reply_message_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; parent_id uuid; author_id uuid; pair record; pair_count integer; author public.entities;
declare result jsonb;
begin
  -- Establish the principal BEFORE any branch can write to command_ledger.
  perform internal.require_identity();
  replay := internal.ledger_replay(p_client_mutation_id, 'messages.delivery.memberReset');
  if replay is not null then return replay; end if;
  select e.parent_id, m.author_id into parent_id, author_id
    from public.entities e
    join public.messages m on m.entity_id = e.id
   where e.id = p_reply_message_id;
  select * into author from public.entities where id = author_id;
  if parent_id is null or author.kind <> 'member' then
    result := jsonb_build_object('reset', false, 'patches', '[]'::jsonb);
    return internal.ledger_record(p_client_mutation_id,
      'messages.delivery.memberReset', result);
  end if;
  perform internal.require_space_member(author.space_id);
  select count(distinct (d.pair_low_session_id, d.pair_high_session_id))::integer
    into pair_count
    from public.session_message_deliveries d
   where d.message_id = parent_id and d.pair_low_session_id is not null;
  if pair_count <> 1 then
    result := jsonb_build_object('reset', false, 'patches', '[]'::jsonb);
    return internal.ledger_record(p_client_mutation_id,
      'messages.delivery.memberReset', result);
  end if;
  select d.pair_low_session_id as low_id, d.pair_high_session_id as high_id into pair
    from public.session_message_deliveries d
   where d.message_id = parent_id and d.pair_low_session_id is not null limit 1;
  perform 1 from public.session_wake_budgets
   where low_work_session_id = pair.low_id and high_work_session_id = pair.high_id for update;
  update public.session_wake_budgets
     set consecutive_agent_wakes = 0, version = version + 1
   where low_work_session_id = pair.low_id and high_work_session_id = pair.high_id;
  result := jsonb_build_object('reset', true, 'lowWorkSessionId', pair.low_id,
    'highWorkSessionId', pair.high_id, 'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id,
    'messages.delivery.memberReset', result);
end
$$;

-- =============================================================================
-- 4. internal.claim_text — A BLANK-LOOKING CLAIM DOES NOT FAIL CLOSED
-- =============================================================================
-- btrim(x) with no second argument strips SPACES ONLY. A tm8.identity_id claim
-- consisting of a tab or a newline therefore survives normalisation and is
-- returned as a non-null identity.
--
-- PRESERVE THIS DISTINCTION EXACTLY, because it had been running as one claim:
--   "an unset claim fails closed everywhere" is TRUE.
--   "a blank-looking claim fails closed"     is FALSE.
-- And this is NOT the same defect as fix 3. It does not yield a NULL principal:
-- it yields a non-null one, E'\t', which is why require_identity() -- which
-- tests only for NULL -- lets it through, and why public.create_space succeeds
-- for it, minting a Space with created_by_identity E'\t' and a member row.
--
-- The fix normalises the full ASCII whitespace set rather than only U+0020, so
-- tab, newline, carriage return, form feed and vertical tab all reduce to NULL
-- and rejoin the unset case. Deliberately NOT widened to Unicode whitespace:
-- the claim arrives from set_config on a server-controlled path, the measured
-- defect is ASCII, and a regexp-class rewrite here would change the normalising
-- behaviour of every claim read in the system on top of an unmeasured premise.
-- =============================================================================

create or replace function internal.claim_text(claim_name text)
returns text language plpgsql stable as $$
declare v text;
begin
  -- btrim with an EXPLICIT character set: the single-argument form strips only
  -- spaces, which let a tab-only or newline-only claim through as a non-null
  -- identity.
  v := nullif(btrim(coalesce(current_setting(claim_name, true), ''), E' \t\n\r\f\v'), '');
  return v;
exception when others then
  return null;
end
$$;

comment on function internal.claim_text(text) is
  'Read a session claim, normalising blank to NULL. Trims the full ASCII '
  'whitespace set, not only U+0020: the single-argument btrim it replaced let a '
  'tab-only or newline-only tm8.identity_id through as a NON-NULL identity, '
  'which require_identity() -- testing only for NULL -- then accepted.';

reset role;
