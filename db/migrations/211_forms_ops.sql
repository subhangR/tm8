-- =============================================================================
-- 211 — Forms W1: the public SECURITY DEFINER doors for the twelve forms.*
-- operations (task 01a0d356; FORMS-DESIGN v6 §5-§7, commit c25b68a8; W0
-- rulings on 01a0d32e; advisor rulings W1-R1/W1-R2).
--
-- NUMBERED 211, NOT 210: 210 exists only as 210_forms_yesno_dryrun.sql on the
-- closed, unmerged #726 branch (the W0 additivity dry run). Skipping it keeps
-- that branch replayable; db/migrations already has gaps (108->111, 187->194).
--
-- WHAT IS HERE
--   Ten command doors, one per forms.* command (13 ops: §6's twelve plus
--   responses.discard, coordinator ruling on W1-R3). The three reads are plain
--   SELECTs under RLS (209's policies: drafts are private to their respondent).
--     create_form                forms.create
--     update_form                forms.update
--     add_form_question          forms.questions.add
--     update_form_question       forms.questions.update
--     remove_form_question       forms.questions.remove
--     move_form_question         forms.questions.move
--     transition_form            forms.transition
--     save_form_response         forms.responses.save   (wraps internal.form_save_draft)
--     submit_form_response       forms.responses.submit (wraps internal.form_submit)
--     discard_form_response      forms.responses.discard
--   Every door: the ledger (clientMutationId, bound to its subject), space
--   membership, the resolved actor. Form doors: author-or-space-admin, then the
--   form row FOR NO KEY UPDATE (the lock submit takes; see LOCK ORDER), then
--   expectedVersion.
--
-- LOCK ORDER: forms row (FOR NO KEY UPDATE) BEFORE the entities row. Submit
--   locks the form first (the W0 core) and then writes the envelope through
--   closeOnSubmit's snapshot trigger; the editor doors take the same order, so
--   an edit and a closing submit cannot deadlock.
--
-- STRUCTURE EDITS (W0 carry-over): every question and section edit bumps
--   forms.structure_version and PRUNES each draft to the answers that still
--   validate (internal.form_structure_changed). The freeze (first SUBMITTED
--   response) is 209's trigger for questions; sections are checked here.
--
-- ERRORS: no raw 23505/23503/23514/22023 from a direct structure write reaches
--   a client. internal.form_raise_structure_error maps them:
--     duplicate key/position        -> TFC01 (409 conflict, details.reason)
--     bad config / section / field  -> TFA01 (422, details.issues[{key,code,message}])
--   TFC01 is new here (server/src/http/errors.ts maps it to `conflict`).
--
-- SUBMIT (§7.1): ONE transaction under the form lock. The message body is
--   rendered in TypeScript by the registry's generic renderer (the only place
--   per-type text rendering exists), BEFORE the door runs; the door then proves
--   the body describes what it stores: the structure_version, the superseded
--   revision and the exact answers must match the render basis, or 40001
--   (version_conflict, retry). Inside the door, in order: the W0 core
--   (validate final, freeze questions_snapshot, the revision flip), the message
--   authored by the respondent on [requesting session, form], form_deliveries
--   (pending), closeOnSubmit, attention resolved. NO PTY injection here.
--
-- W2 SEAM: delivery drains form_deliveries(status = 'pending'). The row names
--   the response and the requesting session; form_responses.message_id is the
--   session-anchored message to inject (conversation anchor = the form).
--
-- SHARED-OBJECT NOTICE: §1 REPLACES internal.guard_w1_edge. Body copied
--   VERBATIM from 066 (the latest definition on every remote ref, verified)
--   plus one recorder token, `form_recorder`, for form -> work_session
--   `authored_from`.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Edge guard: `form_recorder` may write authored_from (form -> session).
-- -----------------------------------------------------------------------------
create or replace function internal.guard_w1_edge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  row_value public.edges;
  writer text := internal.w1_writer();
  src public.entities;
  dst public.entities;
  project_resource uuid;
  live_associations integer;
  session_state text;
begin
  if tg_op = 'DELETE' then row_value := old; else row_value := new; end if;
  select * into src from public.entities where id = row_value.src_id;
  select * into dst from public.entities where id = row_value.dst_id;

  -- A file->attached_to->message edge is message-owned even though attached_to
  -- remains generic for every other permitted endpoint pair.
  if row_value.type = 'attached_to' and src.kind = 'file' and dst.kind = 'message'
     and coalesce(writer, '') <> 'message_attachment' then
    raise exception 'message attachment edges are owned by message attachment commands'
      using errcode = '42501', detail = 'attachment_edge_owned';
  end if;

  -- 052 (a): `authored_from` is written by exactly one recorder per source
  -- kind — message_recorder (messages), memory_recorder (memories),
  -- artifact_publisher (artifacts), form_recorder (forms, 211). A per-type SET, not equalities, so
  -- the three recorders coexist in one branch that is declared once.
  --
  -- `in_worktree` is DELIBERATELY ABSENT from this recorder-owned list: it is
  -- an ordinarily mutable association (like `in_project`), correctable through
  -- generic edges.create/edges.delete. Putting it here would freeze filing
  -- errors into permanent facts. It appears only in the origin-stamping branch
  -- below, so a spawn-created association is distinguishable from a hand-drawn
  -- one without becoming immutable.
  if row_value.type in ('shared_into','authored_from','selected_profile','defaults_to_profile')
     and not (tg_op = 'DELETE' and coalesce(writer, '') = 'forward_compensation') then
    if (row_value.type = 'shared_into' and coalesce(writer, '') <> 'handoff_recorder')
       or (row_value.type = 'authored_from'
           and coalesce(writer, '') not in ('message_recorder','memory_recorder','artifact_publisher','form_recorder'))
       or (row_value.type = 'selected_profile' and coalesce(writer, '') <> 'profile_pin')
       or (row_value.type = 'defaults_to_profile' and coalesce(writer, '') <> 'profile_default') then
      raise exception 'edge type % is recorder/configuration owned', row_value.type
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.props ? 'origin' and coalesce(writer, '') = '' then
      raise exception 'edge props.origin is Server-owned' using errcode = '42501';
    end if;
    -- 052 (b): `in_worktree` joins the stamping list (the worktrees lane's
    -- entire ask on this function). The registry row for `in_worktree` lands in
    -- the worktrees feature migration; until then this branch simply never
    -- matches that type.
    if new.type in ('in_project','participates_in','in_worktree',
                    'anchored_to','messaged') then
      new.props := new.props || jsonb_build_object('origin', coalesce(nullif(writer, ''), 'user'));
    -- 066: `created_in` defaults to 'client_claim', NOT 'user'. The CLI asserts
    -- it from TM8_SESSION_ID with no writer token, and nothing verifies the
    -- claim, so the tag must say so rather than implying a human drew it. When a
    -- server-side recorder eventually writes this (from a session-scoped token),
    -- its token lands here instead and the edge becomes self-describing.
    elsif new.type = 'created_in' then
      new.props := new.props || jsonb_build_object('origin', coalesce(nullif(writer, ''), 'client_claim'));
    elsif new.type in ('shared_into','authored_from','selected_profile','defaults_to_profile') then
      new.props := new.props || jsonb_build_object('origin', 'materialized');
    end if;
  elsif tg_op = 'UPDATE' then
    -- ⚠ KNOWN, DELIBERATE GAP (flagged, not fixed): this allowlist for
    -- CHANGING props.origin contains none of the three new tokens
    -- (memory_recorder, worktree_manager, artifact_publisher). Harmless today —
    -- all three features write their edges once and never update them — but any
    -- future correction/compensation path that rewrites an existing edge's
    -- origin under a new token will fail 42501 until its token is added here.
    -- That addition is a policy decision for the feature that needs it, not a
    -- side effect of this migration.
    if new.props -> 'origin' is distinct from old.props -> 'origin'
       and coalesce(writer, '') not in ('project_correction','handoff_recorder','message_recorder','profile_pin','profile_default') then
      raise exception 'edge props.origin is Server-owned' using errcode = '42501';
    end if;
  end if;

  -- PR/commit materialized associations are repair-command owned.  Task and
  -- work_session user/backfill associations remain ordinarily mutable.
  if tg_op in ('UPDATE','DELETE') and old.type = 'in_project'
     and src.kind in ('pull_request','commit') and old.props ->> 'origin' = 'materialized'
     and coalesce(writer, '') not in ('project_correction','forward_compensation') then
    raise exception 'materialized Project association requires correction command'
      using errcode = '42501';
  end if;

  -- Removing a participant serializes on the session and every participant edge.
  if tg_op in ('UPDATE','DELETE') and old.type = 'participates_in'
     and (tg_op = 'DELETE' or new.type <> old.type or new.dst_id <> old.dst_id) then
    perform 1 from public.work_sessions where entity_id = old.dst_id for update;
    perform 1 from public.edges
      where type = 'participates_in' and dst_id = old.dst_id
      order by id for update;
    select status into session_state from public.work_sessions where entity_id = old.dst_id;
    if session_state in ('spawning','running','idle')
       and (select count(*) from public.edges
             where type = 'participates_in' and dst_id = old.dst_id) <= 1 then
      raise exception 'a live work session must retain one participant'
        using errcode = '23514';
    end if;
  end if;

  if tg_op in ('INSERT','UPDATE') and new.type = 'in_project'
     and (tg_op = 'INSERT' or new.src_id <> old.src_id or new.dst_id <> old.dst_id
          or new.type <> old.type) then
    select project_id into project_resource
      from public.project_projection_details where entity_id = new.dst_id;
    if project_resource is null then
      raise exception 'Project projection has no resource mapping'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    perform 1 from public.projects where id = project_resource for update;
    perform 1 from public.spaces where id = new.space_id for update;
    if not exists (select 1 from public.space_projects
                    where space_id = new.space_id and project_id = project_resource)
       or dst.deleted_at is not null
       or not exists (select 1 from public.project_links
                       where space_id = new.space_id and project_id = project_resource
                         and project_entity_id = new.dst_id) then
      raise exception 'Project is not actively linked to this Space'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    if src.kind = 'work_session' and src.deleted_at is null then
      select count(*) into live_associations
        from public.edges edge
        join public.entities projection on projection.id = edge.dst_id
       where edge.src_id = new.src_id and edge.type = 'in_project'
         and projection.deleted_at is null and edge.id is distinct from new.id;
      if live_associations >= 16 then
        raise exception 'work session Project association cap reached'
          using errcode = '53400', detail = 'project_association_cap';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. Helpers. None names a question type.
-- -----------------------------------------------------------------------------

-- A live, readable form, else not_found (a non-form id is not_found too).
create or replace function internal.form_entity(p_form_id uuid)
returns public.entities language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  select * into e from public.entities
   where id = p_form_id and kind = 'form' and deleted_at is null;
  if e.id is null or not internal.entity_readable(e.id) then
    raise exception 'form % not found', p_form_id using errcode = 'P0002';
  end if;
  return e;
end
$$;

-- Map an error raised by a direct write to forms / form_sections /
-- form_questions (constraints, FKs, 209's guard triggers) into the taxonomy.
-- Everything else (TFS01, P0002, ...) is re-raised by the caller untouched.
create or replace function internal.form_raise_structure_error(
  p_state text, p_constraint text, p_message text, p_detail text, p_key text
) returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare
  d jsonb;
  issues jsonb;
begin
  if p_state in ('23505', '21000') then
    raise exception 'a form key or position is already taken (%)', coalesce(p_constraint, 'duplicate')
      using errcode = 'TFC01',
            detail = jsonb_build_object('reason', 'form_key_taken', 'key', p_key,
                                        'constraint', p_constraint)::text;
  end if;
  begin
    d := p_detail::jsonb;
  exception when others then
    d := null;
  end;
  if p_state = '22023' and jsonb_typeof(d->'issues') = 'array' then
    -- 209's question guard: DETAIL {reason, key, issues[{code, message}]}.
    select coalesce(jsonb_agg(jsonb_build_object('key', coalesce(d->>'key', p_key)) || i), '[]'::jsonb)
      into issues from jsonb_array_elements(d->'issues') i;
    raise exception 'question %: invalid config', coalesce(d->>'key', p_key)
      using errcode = 'TFA01',
            detail = jsonb_build_object('reason', 'form_config_invalid', 'issues', issues)::text;
  end if;
  issues := jsonb_build_array(jsonb_build_object(
    'key', coalesce(p_key, '$'),
    'code', case
              when p_constraint = 'form_questions_section_fk' then 'unknown_section'
              when p_state = '22023' then 'invalid_settings'
              else 'invalid' end,
    'message', p_message));
  raise exception '%', p_message
    using errcode = 'TFA01',
          detail = jsonb_build_object('reason', 'form_config_invalid', 'issues', issues)::text;
end
$$;

create or replace function internal.form_insert_question(p_form_id uuid, p_q jsonb, p_position int)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare s text; c text; m text; d text;
begin
  if p_q is null or jsonb_typeof(p_q) <> 'object' then
    raise exception 'a question must be an object' using errcode = 'TFA01',
      detail = jsonb_build_object('reason', 'form_config_invalid', 'issues',
        jsonb_build_array(jsonb_build_object('key', '$', 'code', 'invalid_shape',
                                             'message', 'a question must be an object')))::text;
  end if;
  insert into public.form_questions(form_id, key, position, section, type, title, help, required, config)
  values (p_form_id, p_q->>'key', p_position, p_q->>'section', p_q->>'type', p_q->>'title', p_q->>'help',
          coalesce((p_q->>'required')::boolean, true), coalesce(p_q->'config', '{}'::jsonb));
exception when unique_violation or foreign_key_violation or check_violation
            or not_null_violation or invalid_parameter_value then
  get stacked diagnostics s = returned_sqlstate, c = constraint_name, m = message_text, d = pg_exception_detail;
  perform internal.form_raise_structure_error(s, c, m, d, p_q->>'key');
end
$$;

-- Renumber questions to p_order (every key, in order). ONE statement: the
-- position key is DEFERRABLE, so uniqueness is checked at its end.
create or replace function internal.form_renumber_questions(p_form_id uuid, p_order text[])
returns void language sql set search_path = public, internal, pg_temp as $$
  update public.form_questions q
     set position = o.ord - 1
    from unnest(p_order) with ordinality as o(k, ord)
   where q.form_id = p_form_id and q.key = o.k and q.position <> o.ord - 1
$$;

create or replace function internal.form_question_order(p_form_id uuid)
returns text[] language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(array_agg(key order by position), '{}'::text[])
    from public.form_questions where form_id = p_form_id
$$;

-- Replace the section list (order = array order). Kept sections keep their
-- questions; a dropped section's questions fall back to none (FK set null).
create or replace function internal.form_replace_sections(p_form_id uuid, p_sections jsonb)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare s text; c text; m text; d text;
begin
  if p_sections is null or jsonb_typeof(p_sections) <> 'array' then
    raise exception 'sections must be an array' using errcode = '22023';
  end if;
  delete from public.form_sections fs
   where fs.form_id = p_form_id
     and not exists (select 1 from jsonb_array_elements(p_sections) x where x->>'key' = fs.key);
  update public.form_sections set position = position + 100000 where form_id = p_form_id;
  insert into public.form_sections(form_id, key, position, title, help)
  select p_form_id, x->>'key', t.ord - 1, x->>'title', x->>'help'
    from jsonb_array_elements(p_sections) with ordinality as t(x, ord)
  on conflict (form_id, key) do update
     set position = excluded.position, title = excluded.title, help = excluded.help;
exception when unique_violation or foreign_key_violation or check_violation
            or not_null_violation or cardinality_violation then
  get stacked diagnostics s = returned_sqlstate, c = constraint_name, m = message_text, d = pg_exception_detail;
  perform internal.form_raise_structure_error(s, c, m, d, 'sections');
end
$$;

-- §5: a structure edit bumps structure_version and keeps only the draft
-- answers that still validate (partial validation, the save rule).
create or replace function internal.form_structure_changed(p_form_id uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare
  d record;
  bad text[];
  next_version int;
begin
  update public.forms set structure_version = structure_version + 1
   where entity_id = p_form_id
  returning structure_version into next_version;
  for d in select id, answers from public.form_responses
            where form_id = p_form_id and status = 'draft' order by id for update loop
    select coalesce(array_agg(distinct i->>'key'), '{}'::text[]) into bad
      from jsonb_array_elements(internal.validate_form_answers(p_form_id, d.answers, false)) i
     where i->>'key' <> '$';
    update public.form_responses
       set answers = answers - bad, structure_version = next_version
     where id = d.id;
  end loop;
end
$$;

-- The author (the entity's creator) or a space admin; then THE form lock;
-- then the version guard. Returns the locked row.
create or replace function internal.form_lock_for_edit(p_form_id uuid, p_actor_id uuid, p_expected_version int)
returns public.forms language plpgsql set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  f public.forms;
  actor uuid;
begin
  e := internal.form_entity(p_form_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if actor is distinct from e.created_by and not internal.is_space_admin(e.space_id) then
    raise exception 'only the form''s author or a space admin may change it' using errcode = '42501';
  end if;
  select * into f from public.forms where entity_id = p_form_id for no key update;
  perform internal.assert_version(p_form_id, p_expected_version);
  return f;
end
$$;

create or replace function internal.form_assert_not_cancelled(p_form public.forms)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
begin
  if p_form.status = 'cancelled' then
    raise exception 'form is cancelled' using errcode = 'TFN01';
  end if;
end
$$;

-- The requesting session (authored_from), when it is still live.
create or replace function internal.form_requesting_session(p_form_id uuid)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select edge.dst_id
    from public.edges edge
    join public.entities ws on ws.id = edge.dst_id and ws.deleted_at is null
   where edge.src_id = p_form_id and edge.type = 'authored_from'
   limit 1
$$;

-- Opening raises ONE attention request ("Form: <title>", settings.attentionPoints).
create or replace function internal.form_raise_attention(p_form public.forms, p_actor uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare space uuid := (select space_id from public.entities where id = p_form.entity_id);
begin
  if exists (select 1 from public.attention_requests
              where entity_id = p_form.entity_id and status in ('open', 'acknowledged')) then
    return;
  end if;
  insert into public.attention_requests(space_id, entity_id, reason, points, requested_by)
  values (space, p_form.entity_id, left('Form: ' || p_form.title, 500),
          (internal.form_settings_effective(p_form.settings)->>'attentionPoints')::int, p_actor);
  update public.entities set activity_at = now(), updated_at = now() where id = p_form.entity_id;
end
$$;

create or replace function internal.form_resolve_attention(p_form_id uuid, p_actor uuid, p_note text)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  update public.attention_requests
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(),
         resolution_note = left(p_note, 1000), version = version + 1
   where entity_id = p_form_id and status in ('open', 'acknowledged');
  if found then
    update public.entities set activity_at = now(), updated_at = now() where id = p_form_id;
  end if;
end
$$;

-- One message per anchor, authored by p_author, in anchor order. The same
-- rows w2_post_message_batch writes (entities + messages), without its
-- routes: delivery is the W2 outbox's job, not this transaction's.
create or replace function internal.form_post_message(
  p_space_id uuid, p_anchors uuid[], p_author uuid, p_body text, p_batch text
) returns uuid[] language plpgsql set search_path = public, internal, pg_temp as $$
declare
  anchor public.entities;
  anchor_id uuid;
  mid uuid;
  ids uuid[] := '{}'::uuid[];
begin
  foreach anchor_id in array p_anchors loop
    select * into anchor from public.entities where id = anchor_id;
    mid := internal.new_id();
    insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
    values (mid, p_space_id, 'message', null, null, p_author, anchor.visibility);
    insert into public.messages(entity_id, anchor_id, author_id, body, message_batch_id)
    values (mid, anchor.id, p_author, p_body, p_batch);
    ids := ids || mid;
  end loop;
  return ids;
end
$$;

-- settings is sparse: a patch overwrites the keys it names; `delivery` merges.
create or replace function internal.form_settings_merge(p_settings jsonb, p_patch jsonb)
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select coalesce(p_settings, '{}'::jsonb) || (coalesce(p_patch, '{}'::jsonb) - 'delivery')
      || case when jsonb_typeof(p_patch->'delivery') = 'object'
              then jsonb_build_object('delivery', coalesce(p_settings->'delivery', '{}'::jsonb) || (p_patch->'delivery'))
              else '{}'::jsonb end
$$;

-- -----------------------------------------------------------------------------
-- 3. forms.create — the full spec in one call (§6).
-- -----------------------------------------------------------------------------
create or replace function public.create_form(
  p_space_id uuid, p_title text, p_description text,
  p_sections jsonb, p_questions jsonb, p_settings jsonb, p_open boolean,
  p_work_session_id uuid default null, p_for_session_id uuid default null,
  p_attach_to uuid[] default null,
  p_actor_id uuid default null, p_parent_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  actor_kind text;
  requesting uuid;
  attribution text;
  form_id uuid;
  f public.forms;
  q jsonb;
  ord bigint;
  targets uuid[] := '{}'::uuid[];
  target uuid;
  activity_id uuid;
  s text; c text; m text; d text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.create');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);
  select kind into actor_kind from public.entities where id = actor;

  if jsonb_typeof(coalesce(p_questions, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_sections, '[]'::jsonb)) <> 'array' then
    raise exception 'questions and sections must be arrays' using errcode = '22023';
  end if;

  -- The requesting session (§3.2). The bearer's verified session wins and is
  -- authorised like message provenance; a named session (--for-session) is
  -- recorded_only and needs only the right to message it.
  if p_work_session_id is not null and p_for_session_id is not null
     and p_work_session_id <> p_for_session_id then
    raise exception 'a session-bound caller cannot name another session for its form' using errcode = '22023';
  end if;
  if p_work_session_id is not null then
    perform 1 from public.entities e join public.work_sessions ws on ws.entity_id = e.id
     where e.id = p_work_session_id and e.space_id = p_space_id and e.deleted_at is null
       and exists (select 1 from public.edges edge where edge.src_id = actor
                    and edge.dst_id = p_work_session_id and edge.type = 'participates_in');
    if not found then
      raise exception 'authored_from provenance does not match the resolved author session' using errcode = '42501';
    end if;
    requesting := p_work_session_id;
    attribution := 'verified';
  elsif p_for_session_id is not null then
    perform 1 from public.entities e
     where e.id = p_for_session_id and e.kind = 'work_session' and e.space_id = p_space_id
       and e.deleted_at is null and internal.entity_readable(e.id);
    if not found then
      raise exception 'session % not found', p_for_session_id using errcode = 'P0002';
    end if;
    requesting := p_for_session_id;
    attribution := 'recorded_only';
  end if;

  form_id := internal.create_envelope(p_space_id, 'form', actor, p_parent_id, null);
  begin
    insert into public.forms(entity_id, title, description, status, settings, opened_at)
    values (form_id, btrim(p_title), p_description,
            -- Agents create forms open, humans draft (§5).
            case when coalesce(p_open, actor_kind = 'team_member') then 'open' else 'draft' end,
            coalesce(p_settings, '{}'::jsonb),
            case when coalesce(p_open, actor_kind = 'team_member') then now() end)
    returning * into f;
  exception when check_violation or invalid_parameter_value or not_null_violation then
    get stacked diagnostics s = returned_sqlstate, c = constraint_name, m = message_text, d = pg_exception_detail;
    perform internal.form_raise_structure_error(s, c, m, d, 'settings');
  end;

  perform internal.form_replace_sections(form_id, coalesce(p_sections, '[]'::jsonb));
  for q, ord in select value, o from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) with ordinality t(value, o) loop
    perform internal.form_insert_question(form_id, q, (ord - 1)::int);
  end loop;
  perform internal.record_initial_version(form_id, actor);

  if requesting is not null then
    perform internal.w1_set_writer('form_recorder');
    insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
    values (p_space_id, form_id, requesting, 'authored_from', actor,
            jsonb_build_object('attribution', attribution));
    perform internal.w1_set_writer('');
  end if;

  -- attached_to: every task the requesting session is working_on, plus the
  -- explicit list.
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into targets from (
    select edge.dst_id as x
      from public.edges edge
      join public.entities t on t.id = edge.dst_id and t.deleted_at is null and t.kind = 'task'
     where requesting is not null and edge.src_id = requesting and edge.type = 'working_on'
    union
    select unnest(coalesce(p_attach_to, '{}'::uuid[]))
  ) u;
  foreach target in array targets loop
    perform 1 from public.entities e
     where e.id = target and e.space_id = p_space_id and e.deleted_at is null
       and internal.entity_readable(e.id);
    if not found then
      raise exception 'attach target % not found', target using errcode = 'P0002';
    end if;
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    select p_space_id, form_id, target, 'attached_to', actor
     where not exists (select 1 from public.edges
                        where src_id = form_id and dst_id = target and type = 'attached_to');
  end loop;

  if f.status = 'open' then
    perform internal.form_raise_attention(f, actor);
  end if;

  activity_id := internal.record_activity(p_space_id, form_id, actor, 'created', null,
                   jsonb_build_object('kind', 'form', 'status', f.status));
  return internal.ledger_record(p_client_mutation_id, 'forms.create',
           internal.command_result(form_id, null, activity_id, array[form_id] || targets)
           || jsonb_build_object('requestingSessionId', requesting, 'attachedTo', to_jsonb(targets)));
end
$$;

-- -----------------------------------------------------------------------------
-- 4. forms.update — title, description, settings (sparse merge), sections.
--    p_patch carries only the keys it changes; description: null clears.
-- -----------------------------------------------------------------------------
create or replace function public.update_form(
  p_form_id uuid, p_expected_version integer, p_patch jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  f public.forms;
  activity_id uuid;
  s text; c text; m text; d text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.update');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_form_id::text, 'entity');
    return replay;
  end if;
  f := internal.form_lock_for_edit(p_form_id, p_actor_id, p_expected_version);
  perform internal.form_assert_not_cancelled(f);
  p_patch := coalesce(p_patch, '{}'::jsonb);
  if p_patch ? 'sections' and internal.form_structure_frozen(p_form_id) then
    raise exception 'form structure is frozen: sections cannot change after the first submitted response'
      using errcode = 'TFS01';
  end if;

  if p_patch ?| array['title', 'description', 'settings'] then
    begin
      update public.forms
         set title = case when p_patch ? 'title' then btrim(p_patch->>'title') else title end,
             description = case when p_patch ? 'description' then p_patch->>'description' else description end,
             settings = case when p_patch ? 'settings'
                             then internal.form_settings_merge(settings, p_patch->'settings') else settings end
       where entity_id = p_form_id;
    exception when check_violation or invalid_parameter_value or not_null_violation then
      get stacked diagnostics s = returned_sqlstate, c = constraint_name, m = message_text, d = pg_exception_detail;
      perform internal.form_raise_structure_error(s, c, m, d,
        case when p_patch ? 'settings' and s = '22023' then 'settings' else null end);
    end;
  end if;
  if p_patch ? 'sections' then
    perform internal.form_replace_sections(p_form_id, p_patch->'sections');
    perform internal.form_structure_changed(p_form_id);
  end if;

  activity_id := internal.record_activity((select space_id from public.entities where id = p_form_id),
                   p_form_id, internal.actor_id(), 'updated', null,
                   jsonb_build_object('kind', 'form', 'changed', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));
  return internal.ledger_record(p_client_mutation_id, 'forms.update',
           internal.command_result(p_form_id, null, activity_id, array[p_form_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Questions: add / update / remove / move. Each is a structure edit.
-- -----------------------------------------------------------------------------
create or replace function internal.form_question_result(
  p_form_id uuid, p_cmid text, p_operation text, p_change text, p_key text
) returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare activity_id uuid;
begin
  activity_id := internal.record_activity((select space_id from public.entities where id = p_form_id),
                   p_form_id, internal.actor_id(), 'updated', null,
                   jsonb_build_object('kind', 'form', 'change', p_change, 'questionKey', p_key));
  return internal.ledger_record(p_cmid, p_operation,
           internal.command_result(p_form_id, null, activity_id, array[p_form_id]));
end
$$;

create or replace function public.add_form_question(
  p_form_id uuid, p_expected_version integer, p_question jsonb,
  p_after text default null, p_after_set boolean default false,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  f public.forms;
  current_order text[];
  new_key text := p_question->>'key';
  idx int;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.questions.add');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_form_id::text, 'entity');
    return replay;
  end if;
  f := internal.form_lock_for_edit(p_form_id, p_actor_id, p_expected_version);
  perform internal.form_assert_not_cancelled(f);
  current_order := internal.form_question_order(p_form_id);
  if p_after_set and p_after is not null then
    idx := array_position(current_order, p_after);
    if idx is null then
      raise exception 'no question % on this form', p_after using errcode = 'P0002';
    end if;
  end if;
  perform internal.form_insert_question(p_form_id, p_question, coalesce(array_length(current_order, 1), 0));
  perform internal.form_renumber_questions(p_form_id,
    case when not p_after_set then current_order || new_key
         when p_after is null then new_key || current_order
         else current_order[1:idx] || new_key || current_order[idx + 1:] end);
  perform internal.form_structure_changed(p_form_id);
  return internal.form_question_result(p_form_id, p_client_mutation_id, 'forms.questions.add', 'question_added', new_key);
end
$$;

create or replace function public.update_form_question(
  p_form_id uuid, p_expected_version integer, p_key text, p_patch jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  f public.forms;
  s text; c text; m text; d text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.questions.update');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_form_id::text, 'entity');
    return replay;
  end if;
  f := internal.form_lock_for_edit(p_form_id, p_actor_id, p_expected_version);
  perform internal.form_assert_not_cancelled(f);
  if not exists (select 1 from public.form_questions where form_id = p_form_id and key = p_key) then
    raise exception 'no question % on this form', p_key using errcode = 'P0002';
  end if;
  p_patch := coalesce(p_patch, '{}'::jsonb);
  begin
    update public.form_questions
       set type = case when p_patch ? 'type' then p_patch->>'type' else type end,
           title = case when p_patch ? 'title' then p_patch->>'title' else title end,
           help = case when p_patch ? 'help' then p_patch->>'help' else help end,
           required = case when p_patch ? 'required' then (p_patch->>'required')::boolean else required end,
           section = case when p_patch ? 'section' then p_patch->>'section' else section end,
           config = case when p_patch ? 'config' then p_patch->'config' else config end
     where form_id = p_form_id and key = p_key;
  exception when unique_violation or foreign_key_violation or check_violation
              or not_null_violation or invalid_parameter_value then
    get stacked diagnostics s = returned_sqlstate, c = constraint_name, m = message_text, d = pg_exception_detail;
    perform internal.form_raise_structure_error(s, c, m, d, p_key);
  end;
  perform internal.form_structure_changed(p_form_id);
  return internal.form_question_result(p_form_id, p_client_mutation_id, 'forms.questions.update', 'question_updated', p_key);
end
$$;

create or replace function public.remove_form_question(
  p_form_id uuid, p_expected_version integer, p_key text,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  f public.forms;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.questions.remove');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_form_id::text, 'entity');
    return replay;
  end if;
  f := internal.form_lock_for_edit(p_form_id, p_actor_id, p_expected_version);
  perform internal.form_assert_not_cancelled(f);
  delete from public.form_questions where form_id = p_form_id and key = p_key;
  if not found then
    raise exception 'no question % on this form', p_key using errcode = 'P0002';
  end if;
  perform internal.form_renumber_questions(p_form_id, internal.form_question_order(p_form_id));
  perform internal.form_structure_changed(p_form_id);
  return internal.form_question_result(p_form_id, p_client_mutation_id, 'forms.questions.remove', 'question_removed', p_key);
end
$$;

create or replace function public.move_form_question(
  p_form_id uuid, p_expected_version integer, p_key text, p_after text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  f public.forms;
  rest text[];
  idx int;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.questions.move');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_form_id::text, 'entity');
    return replay;
  end if;
  f := internal.form_lock_for_edit(p_form_id, p_actor_id, p_expected_version);
  perform internal.form_assert_not_cancelled(f);
  if not (p_key = any(internal.form_question_order(p_form_id))) then
    raise exception 'no question % on this form', p_key using errcode = 'P0002';
  end if;
  if p_after = p_key then
    raise exception 'a question cannot move after itself' using errcode = '22023';
  end if;
  rest := array_remove(internal.form_question_order(p_form_id), p_key);
  if p_after is not null then
    idx := array_position(rest, p_after);
    if idx is null then
      raise exception 'no question % on this form', p_after using errcode = 'P0002';
    end if;
  end if;
  perform internal.form_renumber_questions(p_form_id,
    case when p_after is null then p_key || rest
         else rest[1:idx] || p_key || rest[idx + 1:] end);
  perform internal.form_structure_changed(p_form_id);
  return internal.form_question_result(p_form_id, p_client_mutation_id, 'forms.questions.move', 'question_moved', p_key);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. forms.transition — §5:
--      draft -> open | cancelled;  open -> closed | cancelled;  closed -> open.
--    Opening raises the attention request; closing/cancelling resolves it.
--    Cancel posts a `form_cancelled` message to the requester, so a waiting
--    agent never hangs.
-- -----------------------------------------------------------------------------
create or replace function public.transition_form(
  p_form_id uuid, p_expected_version integer, p_to text, p_reason text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  f public.forms;
  space uuid;
  actor uuid;
  requesting uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.transition');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_form_id::text, 'entity');
    return replay;
  end if;
  f := internal.form_lock_for_edit(p_form_id, p_actor_id, p_expected_version);
  actor := internal.actor_id();
  select space_id into space from public.entities where id = p_form_id;
  if (f.status, p_to) not in (('draft', 'open'), ('draft', 'cancelled'), ('open', 'closed'),
                              ('open', 'cancelled'), ('closed', 'open')) then
    raise exception 'a % form cannot become %', f.status, coalesce(p_to, 'null')
      using errcode = 'TFC01',
            detail = jsonb_build_object('reason', 'form_transition_invalid', 'from', f.status, 'to', p_to)::text;
  end if;

  update public.forms
     set status = p_to,
         opened_at = case when p_to = 'open' then now() else opened_at end,
         closed_at = case when p_to = 'open' then null else now() end
   where entity_id = p_form_id
  returning * into f;

  if p_to = 'open' then
    perform internal.form_raise_attention(f, actor);
  else
    perform internal.form_resolve_attention(p_form_id, actor, coalesce(p_reason, 'form ' || p_to));
  end if;

  if p_to = 'cancelled' then
    requesting := internal.form_requesting_session(p_form_id);
    perform internal.form_post_message(space,
      case when requesting is null then array[p_form_id] else array[requesting, p_form_id] end,
      actor,
      left('form_cancelled: ' || f.title || E'\nform: ' || p_form_id::text
           || coalesce(E'\nreason: ' || p_reason, ''), 10000),
      'form_cancelled:' || p_form_id::text);
  end if;

  activity_id := internal.record_activity(space, p_form_id, actor, 'updated', null,
                   jsonb_build_object('kind', 'form', 'change', 'status', 'to', p_to, 'reason', p_reason));
  return internal.ledger_record(p_client_mutation_id, 'forms.transition',
           internal.command_result(p_form_id, null, activity_id, array[p_form_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 7. forms.responses.save — the caller's draft (wraps internal.form_save_draft).
--    Versioned against the RESPONSE (responseVersion), never the form (W1-R2).
-- -----------------------------------------------------------------------------
create or replace function public.save_form_response(
  p_form_id uuid, p_answers jsonb, p_amend_of uuid default null,
  p_response_version integer default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  current_version int;
  r public.form_responses;
  s text; c text; m text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.responses.save');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'formId', p_form_id::text, 'entity');
    return replay;
  end if;
  e := internal.form_entity(p_form_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if p_response_version is not null then
    select version into current_version from public.form_responses
     where form_id = p_form_id and respondent_id = actor and status = 'draft' for update;
    if current_version is distinct from p_response_version then
      raise exception 'the draft is at version %, not %', coalesce(current_version, 0), p_response_version
        using errcode = '40001',
              detail = jsonb_build_object('reason', 'form_response_version',
                                          'currentVersion', current_version)::text;
    end if;
  end if;
  begin
    r := internal.form_save_draft(p_form_id, actor, coalesce(p_answers, '{}'::jsonb), p_amend_of);
  exception when unique_violation then
    get stacked diagnostics s = returned_sqlstate, c = constraint_name, m = message_text;
    perform internal.form_raise_unique(c, m);
  end;
  return internal.ledger_record(p_client_mutation_id, 'forms.responses.save',
           jsonb_build_object('formId', p_form_id, 'responseId', r.id, 'status', r.status,
                              'version', r.version));
end
$$;

-- -----------------------------------------------------------------------------
-- 8. forms.responses.submit — §7.1, ONE transaction under the form lock.
--    p_basis = {structureVersion, supersedesId} is what p_body was rendered
--    from; p_answers is the exact answer set it rendered. The door refuses
--    (40001) rather than store a response its message misdescribes.
--    p_truncated: the renderer cut the body; the door appends the fetch
--    pointer, which needs the response id only the core knows.
-- -----------------------------------------------------------------------------
create or replace function public.submit_form_response(
  p_form_id uuid, p_answers jsonb, p_amend_of uuid, p_response_version integer,
  p_basis jsonb, p_body text, p_truncated boolean default false,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  f public.forms;
  actor uuid;
  current_version int;
  r public.form_responses;
  requesting uuid;
  message_ids uuid[];
  closed boolean := false;
  body text;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.responses.submit');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'formId', p_form_id::text, 'entity');
    return replay;
  end if;
  e := internal.form_entity(p_form_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  -- THE submit lock, the one internal.form_submit takes (re-entrant): taken
  -- first so the basis and version checks below are decided under it.
  select * into f from public.forms where entity_id = p_form_id for no key update;
  if p_response_version is not null then
    select version into current_version from public.form_responses
     where form_id = p_form_id and respondent_id = actor and status = 'draft' for update;
    if current_version is distinct from p_response_version then
      raise exception 'the draft is at version %, not %', coalesce(current_version, 0), p_response_version
        using errcode = '40001',
              detail = jsonb_build_object('reason', 'form_response_version',
                                          'currentVersion', current_version)::text;
    end if;
  end if;
  if f.structure_version is distinct from (p_basis->>'structureVersion')::int then
    raise exception 'the form changed while the response was prepared; retry' using errcode = '40001',
      detail = jsonb_build_object('reason', 'form_structure_changed',
                                  'structureVersion', f.structure_version)::text;
  end if;

  r := internal.form_submit(p_form_id, actor, p_answers, p_amend_of);

  if r.supersedes_id is distinct from nullif(p_basis->>'supersedesId', '')::uuid
     or r.answers is distinct from p_answers then
    raise exception 'the response changed while it was prepared; retry' using errcode = '40001',
      detail = jsonb_build_object('reason', 'form_revision_changed')::text;
  end if;

  -- The message (§7.1 step 3), authored by the respondent, on
  -- [requesting session, form]. The session copy is the delivery message.
  requesting := internal.form_requesting_session(p_form_id);
  body := p_body;
  if p_truncated then
    body := body || E'\n… truncated. Full response: tm8 form response get ' || r.id::text || ' --format json';
  end if;
  message_ids := internal.form_post_message(e.space_id,
    case when requesting is null then array[p_form_id] else array[requesting, p_form_id] end,
    actor, body, 'form_response:' || r.id::text);
  update public.form_responses set message_id = message_ids[1] where id = r.id;

  -- The outbox row W2 drains (§7.1 step 4).
  if requesting is not null then
    insert into public.form_deliveries(response_id, work_session_id) values (r.id, requesting);
  end if;

  -- §7.1 step 5.
  if (internal.form_settings_effective(f.settings)->>'closeOnSubmit')::boolean then
    update public.forms set status = 'closed', closed_at = now() where entity_id = p_form_id;
    closed := true;
  end if;
  perform internal.form_resolve_attention(p_form_id, actor, 'form response submitted');

  activity_id := internal.record_activity(e.space_id, p_form_id, actor, 'updated', null,
                   jsonb_build_object('kind', 'form', 'change', 'response_submitted',
                                      'responseId', r.id, 'revision', r.revision));
  return internal.ledger_record(p_client_mutation_id, 'forms.responses.submit',
           jsonb_build_object('formId', p_form_id, 'responseId', r.id, 'revision', r.revision,
                              'messageId', message_ids[1], 'deliveryWorkSessionId', requesting,
                              'closed', closed));
end
$$;

-- -----------------------------------------------------------------------------
-- 8b. forms.responses.discard (the 13th op; coordinator ruling on W1-R3):
--     delete the CALLER's own draft. Idempotent: no draft -> discarded false.
--     A responseVersion guards a draft that exists. Submitted rows are never
--     touched (209's delete trigger refuses them anyway).
-- -----------------------------------------------------------------------------
create or replace function public.discard_form_response(
  p_form_id uuid, p_response_version integer default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  d public.form_responses;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.responses.discard');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'formId', p_form_id::text, 'entity');
    return replay;
  end if;
  e := internal.form_entity(p_form_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  select * into d from public.form_responses
   where form_id = p_form_id and respondent_id = actor and status = 'draft' for update;
  if d.id is not null and p_response_version is not null and d.version <> p_response_version then
    raise exception 'the draft is at version %, not %', d.version, p_response_version
      using errcode = '40001',
            detail = jsonb_build_object('reason', 'form_response_version', 'currentVersion', d.version)::text;
  end if;
  if d.id is not null then
    delete from public.form_responses where id = d.id;
  end if;
  return internal.ledger_record(p_client_mutation_id, 'forms.responses.discard',
           jsonb_build_object('formId', p_form_id, 'discarded', d.id is not null, 'responseId', d.id));
end
$$;

-- -----------------------------------------------------------------------------
-- 9. Grants. Full signatures; new functions start with PUBLIC EXECUTE.
-- -----------------------------------------------------------------------------
revoke all on function public.create_form(uuid,text,text,jsonb,jsonb,jsonb,boolean,uuid,uuid,uuid[],uuid,uuid,text) from public;
grant execute on function public.create_form(uuid,text,text,jsonb,jsonb,jsonb,boolean,uuid,uuid,uuid[],uuid,uuid,text) to tm8_app;
revoke all on function public.update_form(uuid,integer,jsonb,uuid,text) from public;
grant execute on function public.update_form(uuid,integer,jsonb,uuid,text) to tm8_app;
revoke all on function public.add_form_question(uuid,integer,jsonb,text,boolean,uuid,text) from public;
grant execute on function public.add_form_question(uuid,integer,jsonb,text,boolean,uuid,text) to tm8_app;
revoke all on function public.update_form_question(uuid,integer,text,jsonb,uuid,text) from public;
grant execute on function public.update_form_question(uuid,integer,text,jsonb,uuid,text) to tm8_app;
revoke all on function public.remove_form_question(uuid,integer,text,uuid,text) from public;
grant execute on function public.remove_form_question(uuid,integer,text,uuid,text) to tm8_app;
revoke all on function public.move_form_question(uuid,integer,text,text,uuid,text) from public;
grant execute on function public.move_form_question(uuid,integer,text,text,uuid,text) to tm8_app;
revoke all on function public.transition_form(uuid,integer,text,text,uuid,text) from public;
grant execute on function public.transition_form(uuid,integer,text,text,uuid,text) to tm8_app;
revoke all on function public.save_form_response(uuid,jsonb,uuid,integer,uuid,text) from public;
grant execute on function public.save_form_response(uuid,jsonb,uuid,integer,uuid,text) to tm8_app;
revoke all on function public.submit_form_response(uuid,jsonb,uuid,integer,jsonb,text,boolean,uuid,text) from public;
grant execute on function public.submit_form_response(uuid,jsonb,uuid,integer,jsonb,text,boolean,uuid,text) to tm8_app;
revoke all on function public.discard_form_response(uuid,integer,uuid,text) from public;
grant execute on function public.discard_form_response(uuid,integer,uuid,text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 10. VERIFY — only what this file creates.
-- -----------------------------------------------------------------------------
do $verify$
declare missing text;
begin
  select string_agg(needed, ', ') into missing
    from unnest(array[
      'public.create_form(uuid,text,text,jsonb,jsonb,jsonb,boolean,uuid,uuid,uuid[],uuid,uuid,text)',
      'public.update_form(uuid,integer,jsonb,uuid,text)',
      'public.add_form_question(uuid,integer,jsonb,text,boolean,uuid,text)',
      'public.update_form_question(uuid,integer,text,jsonb,uuid,text)',
      'public.remove_form_question(uuid,integer,text,uuid,text)',
      'public.move_form_question(uuid,integer,text,text,uuid,text)',
      'public.transition_form(uuid,integer,text,text,uuid,text)',
      'public.save_form_response(uuid,jsonb,uuid,integer,uuid,text)',
      'public.submit_form_response(uuid,jsonb,uuid,integer,jsonb,text,boolean,uuid,text)',
      'public.discard_form_response(uuid,integer,uuid,text)'
    ]) needed
   where to_regprocedure(needed) is null
      or has_function_privilege('public', to_regprocedure(needed), 'EXECUTE')
      or not has_function_privilege('tm8_app', to_regprocedure(needed), 'EXECUTE');
  if missing is not null then
    raise exception 'VERIFY 211: missing door or wrong grant on %', missing;
  end if;
  if position('form_recorder' in pg_get_functiondef('internal.guard_w1_edge()'::regprocedure)) = 0 then
    raise exception 'VERIFY 211: guard_w1_edge does not admit form_recorder';
  end if;
end
$verify$;

reset role;
