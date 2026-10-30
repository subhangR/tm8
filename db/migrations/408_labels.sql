-- =============================================================================
-- 408 — LABELS (Bridges B0b; BRIDGE-ENTITY-DESIGN v4 §3.8, D27).
-- (Authored as 391, then 397; renumbered to 408 at merge by the bridges merger: next free above main's 406 and #1434's 407.)
--
-- A label is a flat, space-level entity: a name (unique per space, case-
-- insensitive), a colour and a description. Bugs are tasks labelled `bug`
-- (D29), so every space has one: seeded here for every existing space, and by
-- trigger for every space born after this migration.
--
-- D1: IDS ON THE ENVELOPE, NOT EDGES. `entities.labels uuid[]` holds label
-- ids, so a rename never touches a labelled entity and a label filter is one
-- GIN-indexed predicate (`labels @> …` / `labels && …`), with no edge fan-out.
-- `internal.guard_entity_labels` checks each id is a live `label` entity in the
-- SAME space, de-duplicates in first-seen order and caps the list at 32.
--
-- D2: DELETE MEANS ARCHIVE. A label's entity row is never soft-deleted (the
-- guard below refuses it): `archived_at` on the detail row hides it from
-- pickers and `labels.list`, while its id stays valid on every entity that
-- already carries it. An archived label cannot be ADDED (set_entity_labels
-- refuses it); it can still be removed, and restored with update_label.
--
-- D3: NAMES ARE UNIQUE ACROSS LIVE AND ARCHIVED LABELS. Two `bug`s, one
-- archived, would make `--label bug` ambiguous to anyone reading history, so a
-- name taken by an archived label is refused with the restore door named.
--
-- D4: ONE WRITE DOOR FOR AN ENTITY'S LABELS. `public.set_entity_labels` adds
-- and removes under `expectedVersion` and is the only writer the app role has:
-- `entities.patch` calls it for `labels: {add, remove}`. A real change bumps
-- `entities.version` once (288's posture: no detail-table snapshot trigger
-- sees an envelope column) — and not again when this same command already
-- moved it. A patch carrying a title AND labels runs the body edit first, then
-- this door with the expectedVersion THE CALLER SENT: the current version is
-- then sent + 1, and the explicit evidence that this command made that version
-- is its `entity_versions` row, written in this transaction (`changed_at =
-- now()`). Only then is the label change folded into it: ONE new version, two
-- activity rows. Any other mismatch is a version conflict, and a version moved
-- without a snapshot (288's status bump) simply gets a second bump — the
-- fallible direction is an extra version, never a missing one. `p_expected_version` may be NULL
-- only for an entity created in this same transaction (`entities.create …
-- labels`), which is labelled as part of its birth and so is not a new version.
--
-- D5: `bug` IS SEEDED WITH NO ACTIVITY. A migration and a space's birth are not
-- an actor's act (304 D4's posture), so the seed writes the entity, its detail
-- row and its initial version, and nothing in anyone's feed. The creator is
-- the space's owner member.
--
-- SHARED-OBJECT NOTICE (…/304/318/322/325/395): §4 REPLACES
-- `internal.entity_content`. Its body is 395's VERBATIM (325's plus B0a's
-- `bridge` arm) plus one `label` arm.
-- Omitting an arm is SILENT: that kind's content resolves to '{}'.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry.
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('label', 'core', null, 'tag')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. Detail table. `entity_id` and `updated_at` are load-bearing:
--    snapshot_entity_version() reads both unqualified. `space_id` is carried
--    for the per-space name index and must equal the envelope's.
-- -----------------------------------------------------------------------------
create table public.labels (
  entity_id   uuid primary key references public.entities(id) on delete cascade,
  space_id    uuid not null references public.spaces(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 64 and name = btrim(name)),
  colour      text not null default '#6b7280' check (colour ~ '^#[0-9a-f]{6}$'),
  description text not null default '' check (length(description) <= 500),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index labels_space_name_key on public.labels(space_id, lower(name));

create trigger labels_validate_kind
before insert or update of entity_id on public.labels
for each row execute function internal.validate_detail_envelope('label');

create or replace function internal.guard_label_space() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if not exists (select 1 from public.entities e where e.id = new.entity_id and e.space_id = new.space_id) then
    raise exception 'label space must match its entity''s space' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function internal.guard_label_space() from public;

create trigger labels_guard_space
before insert or update of entity_id, space_id on public.labels
for each row execute function internal.guard_label_space();

create trigger labels_touch_updated_at before update on public.labels
for each row execute function internal.touch_updated_at();

create trigger labels_w2_snapshot_version after update on public.labels
for each row execute function internal.snapshot_entity_version();

alter table public.labels enable row level security;

-- 218 §4's shape: readable when the entity is.
create policy labels_select on public.labels for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = labels.entity_id and readable_entity.deleted_at is null offset 0)));

grant select on public.labels to tm8_app;

-- A label is archived, never deleted (D2). Restore has nothing to restore.
create or replace function internal.guard_label_entity() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    raise exception 'a label is archived, not deleted: use labels.archive (tm8 label archive)'
      using errcode = '22023';
  end if;
  if new.space_id <> old.space_id then
    raise exception 'a label cannot move between spaces' using errcode = '22023';
  end if;
  return new;
end
$$;
revoke all on function internal.guard_label_entity() from public;

create trigger entities_label_lifecycle
before update of deleted_at, space_id on public.entities
for each row when (old.kind = 'label')
execute function internal.guard_label_entity();

-- -----------------------------------------------------------------------------
-- 3. `entities.labels` (D1).
-- -----------------------------------------------------------------------------
alter table public.entities add column labels uuid[] not null default '{}';

create index entities_labels_gin on public.entities using gin (labels);

create or replace function internal.guard_entity_labels() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  bad uuid;
begin
  if cardinality(new.labels) = 0 then
    return new;
  end if;
  new.labels := array(
    select l from unnest(new.labels) with ordinality u(l, o)
     where l is not null
     group by l order by min(o));
  if cardinality(new.labels) > 32 then
    raise exception 'an entity carries at most 32 labels (% given)', cardinality(new.labels)
      using errcode = '22023';
  end if;
  select l into bad
    from unnest(new.labels) l
   where not exists (
     select 1 from public.entities x
      where x.id = l and x.kind = 'label' and x.space_id = new.space_id and x.deleted_at is null)
   limit 1;
  if bad is not null then
    raise exception 'label % is not a label in this space', bad
      using errcode = '22023',
            detail = jsonb_build_object('reason', 'unknown_label', 'labelId', bad)::text;
  end if;
  return new;
end
$$;
revoke all on function internal.guard_entity_labels() from public;

create trigger entities_labels_guard
before insert or update of labels, space_id on public.entities
for each row execute function internal.guard_entity_labels();

-- -----------------------------------------------------------------------------
-- 4. Content hydration. See the SHARED-OBJECT NOTICE above. Body copied from
--    395 verbatim (the latest definer on main: 325's body plus B0a's `bridge`
--    arm); the `label` arm is the only addition.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      -- An allow-list, never to_jsonb(sc): the row holds the sealed secret,
      -- the hint and the vendor login (§3a).
      when 'credential' then select to_jsonb(cc) - 'entity_id' into content from public.credential_cards cc where cc.entity_id = target;
      -- 250 (W6): the shared link's metadata. `space_links` holds no secret; the
      -- sealed per-member token is `space_link_tokens` (251) and has no arm.
      when 'space_link' then select to_jsonb(sl) - 'entity_id' into content from public.space_links sl where sl.entity_id = target;
      -- W8: the server's metadata. `servers` holds no secret; the sealed
      -- per-member gate session is `server_gate_tokens` and has no arm.
      when 'server' then select to_jsonb(sv) - 'entity_id' into content from public.servers sv where sv.entity_id = target;
      -- 283: the story's title and description. Its roots are `contains`
      -- edges and its trail is computed (story_trail), never embedded here.
      when 'story' then select to_jsonb(st) - 'entity_id' into content from public.stories st where st.entity_id = target;
      -- 284: a space style's detail row. The row holds nothing secret (the
      -- document, tags and attribution), so the house form applies; the
      -- contract's camelCase shape is the read facade's job (`contentOf`).
      when 'style' then select to_jsonb(sty) - 'entity_id' into content from public.styles sty where sty.entity_id = target;
      when 'mcp_server' then select to_jsonb(m) - 'entity_id' into content from public.mcp_servers m where m.entity_id=target;
      -- 304/322: the craft's title and description. Its pages are `contains`
      -- edges ordered by props.position, never embedded here.
      when 'craft' then select to_jsonb(dsg) - 'entity_id' into content from public.crafts dsg where dsg.entity_id = target;
      when 'tool' then select to_jsonb(tl) - 'entity_id'
        || jsonb_build_object('config', coalesce((select jsonb_object_agg(c.input_name,c.value) from public.tool_config c where c.tool_id=target),'{}'::jsonb),
          'secretBindings', coalesce((select jsonb_agg(jsonb_build_object('inputName',b.input_name,'credentialId',b.credential_id,'boundBy',b.bound_by,'boundAt',b.bound_at)) from public.tool_secret_bindings b where b.tool_id=target),'[]'::jsonb))
        into content from public.tools tl where tl.entity_id=target;
      -- 395 (Bridges B0a): the detail row. No secret lives on it.
      when 'bridge' then select to_jsonb(br) - 'entity_id' into content from public.bridges br where br.entity_id = target;
      -- 408: the label's name, colour, description and archive mark.
      when 'label' then select to_jsonb(lb) - 'entity_id' - 'space_id' into content from public.labels lb where lb.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Shared checks.
-- -----------------------------------------------------------------------------
create or replace function internal.label_colour(p_colour text) returns text
language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare c text := lower(btrim(coalesce(p_colour, '')));
begin
  if c !~ '^#?[0-9a-f]{6}$' then
    raise exception 'label colour must be a hex colour like #d73a4a (got %)', p_colour using errcode = '22023';
  end if;
  return case when left(c, 1) = '#' then c else '#' || c end;
end
$$;

create or replace function internal.label_name(p_name text) returns text
language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare n text := btrim(coalesce(p_name, ''));
begin
  if length(n) not between 1 and 64 then
    raise exception 'label name is required (1..64 chars after trim)' using errcode = '22023';
  end if;
  return n;
end
$$;

-- The name index answers 23505; say which label holds the name, and whether
-- it is archived, so the caller knows to rename or restore (D3).
create or replace function internal.assert_label_name_free(p_space uuid, p_name text, p_except uuid)
returns void language plpgsql stable set search_path = public, internal, pg_temp as $$
declare holder public.labels;
begin
  select * into holder from public.labels l
   where l.space_id = p_space and lower(l.name) = lower(p_name)
     and l.entity_id is distinct from p_except;
  if holder.entity_id is not null then
    raise exception '%', case when holder.archived_at is null
        then format('a label named %s already exists in this space', holder.name)
        else format('an archived label named %s exists in this space; restore it (labels.update archived=false) or pick another name', holder.name)
      end
      using errcode = '23505',
            detail = jsonb_build_object('reason', 'label_name_taken', 'labelId', holder.entity_id,
                                        'archived', holder.archived_at is not null)::text;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 6. The doors: create, update (incl. archive/restore), archive.
-- -----------------------------------------------------------------------------
create or replace function public.create_label(
  p_space_id uuid, p_name text, p_colour text default null, p_description text default '',
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  label_id uuid;
  clean_name text;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'labels.create');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  clean_name := internal.label_name(p_name);
  if length(coalesce(p_description, '')) > 500 then
    raise exception 'label description is too long (% chars; limit 500)', length(p_description) using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tm8.label_name:' || p_space_id::text || ':' || lower(clean_name), 0));
  perform internal.assert_label_name_free(p_space_id, clean_name, null);

  label_id := internal.create_envelope(p_space_id, 'label', actor, null, null);
  insert into public.labels(entity_id, space_id, name, colour, description)
  values (label_id, p_space_id, clean_name,
          case when p_colour is null then '#6b7280' else internal.label_colour(p_colour) end,
          coalesce(p_description, ''));
  perform internal.record_initial_version(label_id, actor);

  activity_id := internal.record_activity(p_space_id, label_id, actor, 'created',
                   null, jsonb_build_object('kind', 'label'));
  return internal.ledger_record(p_client_mutation_id, 'labels.create',
           internal.command_result(label_id, null, activity_id, array[label_id]));
end
$$;

create or replace function internal.write_label(
  p_operation text, p_label_id uuid, p_expected_version integer, p_actor_id uuid,
  p_name text, p_colour text, p_description text, p_archived boolean, p_client_mutation_id text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  prior public.labels;
  actor uuid;
  clean_name text;
  action text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, p_operation);
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_label_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_label_id, 'label');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_label_id, p_expected_version);
  select * into prior from public.labels where entity_id = p_label_id;

  if p_name is not null then
    clean_name := internal.label_name(p_name);
    perform pg_advisory_xact_lock(hashtextextended('tm8.label_name:' || e.space_id::text || ':' || lower(clean_name), 0));
    perform internal.assert_label_name_free(e.space_id, clean_name, p_label_id);
  end if;
  if p_description is not null and length(p_description) > 500 then
    raise exception 'label description is too long (% chars; limit 500)', length(p_description) using errcode = '22023';
  end if;

  update public.labels
     set name        = coalesce(clean_name, name),
         colour      = case when p_colour is null then colour else internal.label_colour(p_colour) end,
         description = coalesce(p_description, description),
         archived_at = case
                         when p_archived is null then archived_at
                         when p_archived then coalesce(archived_at, now())
                         else null
                       end,
         updated_at  = now()
   where entity_id = p_label_id;

  action := case
              when p_archived is true and prior.archived_at is null then 'archived'
              when p_archived is false and prior.archived_at is not null then 'restored'
            end;
  return internal.ledger_record(p_client_mutation_id, p_operation,
           internal.command_result(p_label_id, null,
             internal.record_activity(e.space_id, p_label_id, actor, 'updated', null,
               case when action is null then jsonb_build_object('kind', 'label')
                    else jsonb_build_object('kind', 'label', 'action', action) end),
             array[p_label_id]));
end
$$;
revoke all on function internal.write_label(text, uuid, integer, uuid, text, text, text, boolean, text) from public;

create or replace function public.update_label(
  p_label_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_name text default null, p_colour text default null, p_description text default null,
  p_archived boolean default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if p_name is null and p_colour is null and p_description is null and p_archived is null then
    raise exception 'label update names nothing to change (name, colour, description or archived)'
      using errcode = '22023';
  end if;
  return internal.write_label('labels.update', p_label_id, p_expected_version, p_actor_id,
           p_name, p_colour, p_description, p_archived, p_client_mutation_id);
end
$$;

create or replace function public.archive_label(
  p_label_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  return internal.write_label('labels.archive', p_label_id, p_expected_version, p_actor_id,
           null, null, null, true, p_client_mutation_id);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. An entity's labels (D4).
-- -----------------------------------------------------------------------------
create or replace function public.set_entity_labels(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_add uuid[] default '{}', p_remove uuid[] default '{}', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  archived uuid;
  next_labels uuid[];
  added uuid[];
  removed uuid[];
  born_here boolean;
  moved_here boolean;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  if not internal.entity_readable(p_entity_id) then
    raise exception 'entity % not found', p_entity_id using errcode = 'P0002';
  end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  -- Born in this transaction (`entities.create … labels`): part of the birth.
  born_here := e.version = 1 and e.created_at = now();
  moved_here := false;
  perform 1 from public.entities where id = p_entity_id for update;
  select * into e from public.entities where id = p_entity_id;
  if p_expected_version is null then
    if not born_here then
      raise exception 'expectedVersion is required to change an entity''s labels' using errcode = '22023';
    end if;
  elsif e.version = p_expected_version + 1 and exists (
          select 1 from public.entity_versions v
           where v.entity_id = p_entity_id and v.version = e.version and v.changed_at = now()) then
    -- This command's body edit made the current version (D4): fold into it.
    moved_here := true;
  else
    perform internal.assert_version(p_entity_id, p_expected_version);
  end if;

  -- Adding an archived label is refused (D2); removing one is always allowed.
  select a into archived
    from unnest(coalesce(p_add, '{}')) a
    join public.labels l on l.entity_id = a and l.archived_at is not null
   where not (a = any(e.labels))
   limit 1;
  if archived is not null then
    raise exception 'label % is archived and cannot be added', archived
      using errcode = '22023',
            detail = jsonb_build_object('reason', 'label_archived', 'labelId', archived)::text;
  end if;

  next_labels := array(
    select l from unnest(e.labels || coalesce(p_add, '{}')) with ordinality u(l, o)
     where l is not null and not (l = any(coalesce(p_remove, '{}')))
     group by l order by min(o));
  added := array(select l from unnest(next_labels) l where not (l = any(e.labels)));
  removed := array(select l from unnest(e.labels) l where not (l = any(next_labels)));

  if cardinality(added) = 0 and cardinality(removed) = 0 then
    return internal.ledger_record(p_client_mutation_id, 'entities.patch',
             internal.command_result(p_entity_id, null, null, array[p_entity_id]));
  end if;

  if born_here then
    update public.entities set labels = next_labels where id = p_entity_id;
    return internal.ledger_record(p_client_mutation_id, 'entities.patch',
             internal.command_result(p_entity_id, null, null, array[p_entity_id]));
  end if;

  update public.entities
     set labels = next_labels,
         version = case when moved_here then version else version + 1 end,
         updated_at = now(), activity_at = now()
   where id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null,
                   jsonb_build_object('kind', e.kind, 'fields', jsonb_build_array('labels'),
                                      'labelsAdded', to_jsonb(added), 'labelsRemoved', to_jsonb(removed)));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$$;

revoke all on function public.create_label(uuid, text, text, text, uuid, text) from public;
grant execute on function public.create_label(uuid, text, text, text, uuid, text) to tm8_app;
revoke all on function public.update_label(uuid, integer, uuid, text, text, text, boolean, text) from public;
grant execute on function public.update_label(uuid, integer, uuid, text, text, text, boolean, text) to tm8_app;
revoke all on function public.archive_label(uuid, integer, uuid, text) from public;
grant execute on function public.archive_label(uuid, integer, uuid, text) to tm8_app;
revoke all on function public.set_entity_labels(uuid, integer, uuid, uuid[], uuid[], text) from public;
grant execute on function public.set_entity_labels(uuid, integer, uuid, uuid[], uuid[], text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 8. `bug` in every space (D5): existing spaces now, new ones on their
--    owner's arrival (create_space inserts the owner member first).
-- -----------------------------------------------------------------------------
create or replace function internal.seed_space_labels(p_space uuid, p_creator uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare label_id uuid;
begin
  if p_creator is null or exists (
    select 1 from public.labels l where l.space_id = p_space and lower(l.name) = 'bug'
  ) then
    return;
  end if;
  label_id := internal.create_envelope(p_space, 'label', p_creator, null, null);
  insert into public.labels(entity_id, space_id, name, colour, description)
  values (label_id, p_space, 'bug', '#d73a4a', 'Something is not working');
  perform internal.record_initial_version(label_id, p_creator);
end
$$;
revoke all on function internal.seed_space_labels(uuid, uuid) from public;

create or replace function internal.seed_labels_on_owner() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.seed_space_labels(new.space_id, new.entity_id);
  return new;
end
$$;
revoke all on function internal.seed_labels_on_owner() from public;

create trigger members_seed_labels
after insert on public.members
for each row when (new.role = 'owner')
execute function internal.seed_labels_on_owner();

-- Existing spaces: the creator is the owner, else the earliest member. A
-- space with no member at all has no creator to name; it is counted aloud.
do $$
declare s record; memberless integer;
begin
  select count(*) into memberless from public.spaces sp
   where not exists (select 1 from public.members m where m.space_id = sp.id);
  if memberless > 0 then
    raise notice '408: % space(s) have no member and get no bug label', memberless;
  end if;
  for s in select id from public.spaces loop
    perform internal.seed_space_labels(s.id, (
      select m.entity_id from public.members m
       where m.space_id = s.id
       order by (m.role = 'owner') desc, m.entity_id
       limit 1));
  end loop;
end
$$;

-- A new table the wide entity read joins: give the planner real numbers.
analyze public.labels;

reset role;
