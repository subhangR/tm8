-- =============================================================================
-- 176 — CHAT BECOMES AN ENTITY (Wave 1 spine).
--
-- Design + owner rulings: doc `01a0632a-e64e-701b-a13e-43ad8dbcc276`.
-- Implementation spec (binding): doc `01a064ed-201a-721f-8e2a-e4e58dd785a9`.
--
-- WHAT WAS WRONG. A chat was not an entity. It was a message THREAD: a root
-- `message` anchored on the seeded default channel, plus a `chat_threads`
-- binding row keyed by that root message id, plus a `chat_turns` queue. Because
-- it had no kind, nothing that makes a work session addressable could reach it:
-- it could not be a routing target, could not be an `authored_from` destination,
-- could not be a spawn parent, and its turn trigger fired for HUMAN authors
-- only (115:58-82). A worker's completion report landed in the thread as inert
-- context and the chat runtime never woke. That is the defect this closes.
--
-- WHAT THIS FILE DOES.
--   1. registers the core kind `chat` and creates `public.chats` (every column
--      `chat_threads` carried, minus `anchor_id` — the chat IS the anchor now);
--   2. re-keys `chat_turns` from `root_message_id` onto `chat_id` and gives a
--      turn the provenance of WHO asked for it (member, session, or chat);
--   3. re-anchors the 15 live chats' 109 messages onto their new chat entities,
--      FLAT: every turn is a root message, the user->agent pairing is
--      `chat_turns`, not threading;
--   4. re-issues the nine chat doors on the new key, drops `chat_threads`;
--   5. widens `authored_from` to chats and `about` to chat sources, so a chat
--      post carries provenance and "this chat is about X" is an edge;
--   6. lets a chat be the PARENT of a work session (the one ruled exception to
--      the homogeneous-hierarchy law) and the parent argument of
--      `execution_spawn`;
--   7. queues a chat turn from inside `w2_post_message_batch` for EVERY author
--      — human, session, or another chat — with exactly one guard: a chat is
--      never handed its own message (ruling R-A: no caps, no wake flags).
--
-- NUMBERED 176. Measured across every remote ref on 2026-09-03: main's max is
-- 173, `fix/observer-uses-stored-credential` holds 174 and
-- `calm/workspace-dashboard-unseen` holds 175. Previous+1 is not the measure;
-- the union of every branch is. A stolen prefix surfaces only as a chain-count
-- pin conflict, and `tools/ci/migrations-check.sh:69` asserts uniqueness.
--
-- NOT HERE, AND DELIBERATELY (ruled by the coordinator 2026-09-03): the default
-- MENU is untouched. The spec asked for the `chats` group's `dashboard` view to
-- become `{"type":"kind","ref":"chat"}`, but since 134 that group IS the Home
-- tab (`{"id":"chats","label":"Home","items":[{"type":"view","ref":"dashboard"}]}`
-- — the id stayed `chats` because ids are the wire-stable half). Making the edit
-- would delete Home from every space's default menu and point the tab at a
-- Chats surface Wave 1 is explicitly forbidden to build. Wave 2's UI lane seats
-- the Chats tab together with the surface it points at, the way 130/137/164/173
-- each did.
--
-- ALSO CORRECTED AGAINST THE TREE: `about` is NOT a new edge type — 056:200
-- registered it (`{memory} -> {*}`); this WIDENS its sources to
-- `{memory,chat}`. And `chats.project_id` references `public.projects(id)`:
-- projects are not entities and have no `entity_id` (001:247), which is what
-- 167 already keys `chat_threads.project_id` on.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The kind. `entity_kinds_guard_core` (005) fires on UPDATE/DELETE only, so
--    the seed is an ordinary insert (053/056/091/135 precedent).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('chat', 'core', null, 'message-square')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. The detail table.
--
--    `chat_threads.anchor_id` has no successor here. That column recorded where
--    the thread's root message was posted — the default channel for 10 of the
--    15 live chats, a Craft blueprint row for 3 — and it is exactly the fact
--    that made a chat unaddressable: its transcript lived on somebody else's
--    anchor. A chat now anchors its own messages. Where it was opened FROM
--    becomes an `about` edge (§7), which is a relation a human can see, correct
--    and follow, rather than a hidden binding column.
--
--    `node_id` is new (blocker B7). Sessions have always carried one; the chat
--    runtime was an in-process map with no record of which node owned it, so
--    the remote/multi-node work would have had to retrofit it. NULL means "no
--    node has claimed this runtime", which is the honest state for every legacy
--    row and for every cold chat.
-- -----------------------------------------------------------------------------
create table public.chats (
  entity_id                 uuid primary key references public.entities(id) on delete cascade,
  space_id                  uuid not null references public.spaces(id) on delete cascade,
  title                     text not null default '' check (char_length(title) <= 240),
  teammate_id               uuid not null references public.team_members(entity_id) on delete restrict,
  model                     text not null check (char_length(btrim(model)) between 1 and 200),
  provider                  text not null check (char_length(btrim(provider)) between 1 and 100),
  agent_tool                text not null check (char_length(btrim(agent_tool)) between 1 and 100),
  chat_mode                 text not null
    check (chat_mode in ('ask', 'explain', 'plan', 'build', 'orchestrate', 'craft')),
  workdir_mode              text not null check (workdir_mode in ('project', 'scratch')),
  project_id                uuid references public.projects(id) on delete restrict,
  cwd                       text not null
    check (char_length(cwd) between 1 and 4096 and left(cwd, 1) = '/'),
  native_session_id         uuid not null unique,
  runtime_state             text not null default 'cold'
    check (runtime_state in ('cold', 'live', 'stopped')),
  node_id                   text,
  configured_by_identity_id text not null references public.user_profiles(identity_id) on delete restrict,
  configured_by_member_id   uuid not null references public.members(entity_id) on delete restrict,
  requester_auth_kind       text,
  client_mutation_id        text not null unique
    check (char_length(btrim(client_mutation_id)) between 1 and 200),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  -- 167's invariant, carried over verbatim: the two workdir facts must agree. A
  -- `project` chat without a project id could not name its directory, and a
  -- `scratch` chat WITH one would claim a binding it does not have.
  constraint chats_project_binding_check check (
    (workdir_mode = 'project' and project_id is not null)
    or (workdir_mode = 'scratch' and project_id is null)
  )
);

create index chats_space_created_idx
  on public.chats(space_id, created_at desc, entity_id desc);
create index chats_teammate_idx on public.chats(teammate_id);

create trigger chats_validate_kind
before insert or update of entity_id on public.chats
for each row execute function internal.validate_detail_envelope('chat');

create trigger chats_touch_updated_at before update on public.chats
for each row execute function internal.touch_updated_at();

comment on table public.chats is
  'A chat conversation as a first-class entity: the anchor of its own transcript, '
  'a spawn parent, and an authored_from destination.';
comment on column public.chats.node_id is
  'Which node owns this chat''s runtime; NULL when nothing has claimed it (B7).';

alter table public.chats enable row level security;

create policy chats_select on public.chats for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.chats to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. Content hydration. SHARED-OBJECT NOTICE, same as 053/055/056/057/091/135:
--    this REPLACES `internal.entity_content`. The body below is 135's verbatim
--    (the latest definition at write time) plus one `chat` arm. Omitting an arm
--    is SILENT — content resolves to '{}'::jsonb forever.
--
--    ⚠ A CONCURRENT LANE REPLACES THIS SAME FUNCTION. `177_container_kind.sql`
--    (Containers program, lane A) is 135's body plus a `container` arm. Both are
--    `create or replace` in different files, so there is NO git conflict, NO
--    error and NO red test: whichever migration APPLIES SECOND silently wins and
--    the other kind's content resolves to '{}' forever. This is the shared-body
--    hazard 135's own header warns about, in its worst form — two lanes, same
--    object, no signal.
--
--    THE RULE, agreed with lane A on 2026-09-03 and symmetric: THE SECOND ONE
--    TO MERGE COPIES THE BODY FROM `origin/main` AT MERGE TIME, not from 135.
--    If 177 lands first, this file's body is re-copied from 177 (135 + the
--    container arm) with the chat arm appended; if this lands first, 177 copies
--    from here. Re-check `origin/main` for a newer body immediately before
--    merging either way — a third lane could join.
--
--    The guard that would have caught it: resolve `internal.entity_content` for
--    one entity of EVERY core kind and assert none answers '{}'. Cheap, and it
--    fails loudly for whichever arm was dropped.
--
--    THE CHAT ARM SUBTRACTS THREE COLUMNS. Every other arm returns its whole
--    detail row, but `internal.command_entity` (007:36) puts this object in the
--    command result a client receives, and R5 keeps the working directory and
--    the native runtime identifiers server-side. `cwd`, `native_session_id` and
--    `client_mutation_id` are therefore stripped here rather than relied on to
--    be dropped by some later projection.
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
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. `chat_turns` is re-keyed onto the chat, and learns who asked.
--
--    `requested_by_member_id` (115) stays and keeps its meaning: the HUMAN
--    member who queued this turn, NULL when nobody human did. The three new
--    columns are what R-A needs — an agent-authored turn has no member, and
--    "who asked" is then a session or another chat. `requested_by_actor_id` is
--    the actor either way, so the audit answer never depends on which of the
--    three columns is populated.
--
--    No FK on `requested_by_actor_id`: it is a member OR a team_member and a
--    column cannot reference two tables. `requested_by_session_id` and
--    `requested_by_chat_id` do carry FKs, because each names exactly one kind.
-- -----------------------------------------------------------------------------
alter table public.chat_turns
  add column chat_id uuid references public.chats(entity_id) on delete cascade,
  add column requested_by_actor_id uuid,
  add column requested_by_session_id uuid references public.work_sessions(entity_id) on delete set null,
  add column requested_by_chat_id uuid references public.chats(entity_id) on delete set null;

comment on column public.chat_turns.chat_id is
  'The chat entity this turn belongs to. Replaces root_message_id as the key.';
comment on column public.chat_turns.requested_by_actor_id is
  'The actor whose message queued this turn — a member or a team_member. '
  'Provenance only; the turn still runs on the chat''s configured authority (R-C).';
comment on column public.chat_turns.requested_by_session_id is
  'Set when the queueing message was authored from a work session.';
comment on column public.chat_turns.requested_by_chat_id is
  'Set when the queueing message was authored from another chat.';

alter table public.auth_sessions
  add column runtime_chat_id uuid references public.chats(entity_id) on delete cascade;

comment on column public.auth_sessions.runtime_chat_id is
  'For agent_runtime sessions, the chat entity whose hot runtime owns this '
  'short-lived credential. Supersedes runtime_thread_root_id, which stays '
  'nullable so pre-176 rows remain readable.';

-- -----------------------------------------------------------------------------
-- 5. Edge vocabulary. Both of these must land BEFORE the backfill, which writes
--    `about` edges for the chats that were opened about something.
--
--    `authored_from` gains chats as a DESTINATION. 052 widened its SOURCES to
--    {message, memory, artifact} and never touched destinations, so today a
--    chat-agent post carries no provenance at all and a reply to one cannot
--    route back. The UNIQUE index `edges_authored_from_source_idx` (one
--    authored_from per source entity) is deliberately left alone: it is what
--    makes "a message has exactly ONE source" enforceable, which is why
--    `w2_post_message_batch` refuses a message that names both a source session
--    and a source chat.
--
--    `about` is NOT new — 056:200 registered it for memories. This widens its
--    sources so a chat can say what it was opened about. Its destinations are
--    already `{*}` and its props_schema is already closed, so nothing else
--    changes; in particular it stays MUTABLE and un-gated, because "this chat
--    is about X" is a filing decision a human must be able to correct.
-- -----------------------------------------------------------------------------
update public.edge_types
   set dst_kinds = array['work_session', 'chat'],
       description = 'Immutable Server-recorded work-session or chat provenance'
 where type = 'authored_from';

update public.edge_types
   set src_kinds = array['memory', 'chat'],
       description = 'Subject routing: this memory or chat concerns X. '
                     'Mutable and unpinned — filing errors must be correctable.'
 where type = 'about';

-- -----------------------------------------------------------------------------
-- 6. THE BACKFILL. One `chat` entity per `chat_threads` row, its messages
--    re-anchored onto it, FLAT.
--
--    WHY RE-ANCHOR RATHER THAN KEEP TWO MODELS. A chat that is an entity on the
--    write path and a message thread on the read path is two chats. The live
--    graph is one node and the history is young (15 chats / 109 messages), so
--    the rewrite is small and the alternative — a compat view forever — is not.
--
--    THE ANCHOR REWRITE NEEDS TWO GUARDS OFF, AND THAT IS THE POINT. 001:1009's
--    `messages_validate` declares a message's anchor, author, root and client id
--    immutable; 015:525's `entities_message_identity_immutable` declares the
--    envelope's parent immutable. Both are correct and both stay correct: they
--    are disabled for exactly these two statements and re-enabled immediately,
--    rather than weakened.
--
--    Every message of a chat becomes a ROOT message: `root_message_id` null and
--    `entities.parent_id` null. The user->agent pairing that threading used to
--    express is `chat_turns(user_message_id, agent_message_id)`, which is where
--    it always actually lived.
-- -----------------------------------------------------------------------------
do $backfill$
declare
  thread record;
  new_chat_id uuid;
  root_body text;
  moved uuid[];
  touched_anchors uuid[] := '{}'::uuid[];
begin
  -- TWO guards refuse this rewrite, and both are correct: 001:1009 declares a
  -- message's anchor and root immutable, and 015:525 declares its ENVELOPE's
  -- parent immutable. Each is disabled for exactly the statements below and
  -- re-enabled immediately after, rather than weakened.
  alter table public.messages disable trigger messages_validate;
  alter table public.entities disable trigger entities_message_identity_immutable;

  for thread in
    select ct.*, e.space_id as envelope_space
      from public.chat_threads ct
      join public.entities e on e.id = ct.root_message_id
     order by ct.created_at, ct.root_message_id
  loop
    select left(coalesce(m.body, ''), 240) into root_body
      from public.messages m where m.entity_id = thread.root_message_id;

    new_chat_id := internal.create_envelope(
      thread.space_id, 'chat', thread.configured_by_member_id, null, null);

    insert into public.chats(
      entity_id, space_id, title, teammate_id, model, provider, agent_tool,
      chat_mode, workdir_mode, project_id, cwd, native_session_id, runtime_state,
      node_id, configured_by_identity_id, configured_by_member_id,
      requester_auth_kind, client_mutation_id, created_at, updated_at
    ) values (
      new_chat_id, thread.space_id, coalesce(root_body, ''), thread.teammate_id,
      thread.model, thread.provider, thread.agent_tool,
      thread.chat_mode, thread.workdir_mode, thread.project_id, thread.cwd,
      thread.native_session_id,
      -- No hot child survives a node restart, so a durable 'live' claim is
      -- always stale by the time this migration runs. 'stopped' routes the next
      -- turn through the ruled lazy resume; 'cold' is preserved as itself.
      case when thread.runtime_state = 'live' then 'stopped' else thread.runtime_state end,
      null, thread.configured_by_identity_id, thread.configured_by_member_id,
      thread.requester_auth_kind, thread.client_mutation_id,
      thread.created_at, thread.updated_at
    );

    select coalesce(array_agg(m.entity_id), '{}'::uuid[]) into moved
      from public.messages m
     where m.entity_id = thread.root_message_id
        or m.root_message_id = thread.root_message_id;

    touched_anchors := touched_anchors || thread.anchor_id || new_chat_id;

    update public.entities set parent_id = null where id = any(moved);
    update public.messages
       set anchor_id = new_chat_id, root_message_id = null
     where entity_id = any(moved);

    update public.chat_turns set chat_id = new_chat_id
     where root_message_id = thread.root_message_id;

    update public.auth_sessions set runtime_chat_id = new_chat_id
     where runtime_thread_root_id = thread.root_message_id;

    -- Where the chat was opened FROM becomes a relation. A default channel is
    -- not a subject — it was only ever the place the composer had to post into
    -- (GateApp substituted it) — so only a contextual anchor, such as the Craft
    -- blueprint row 3 of the live chats were opened on, earns an edge.
    if not exists (
      select 1 from public.entities a
       where a.id = thread.anchor_id and a.kind = 'channel'
    ) then
      insert into public.edges(space_id, src_id, dst_id, type, created_by)
      values (thread.space_id, new_chat_id, thread.anchor_id, 'about',
              thread.configured_by_member_id)
      on conflict do nothing;
    end if;

    -- The teammate binding, mirroring `execution_spawn` (150:821).
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (thread.space_id, new_chat_id, thread.teammate_id, 'relates_to',
            thread.configured_by_member_id)
    on conflict do nothing;
  end loop;

  -- `entities.parent_id` is a DEFERRABLE INITIALLY DEFERRED self-reference
  -- (001:334), so every envelope this block wrote leaves a pending trigger
  -- event and `ALTER TABLE` refuses while any exist. Flushing them here also
  -- means the re-enabled guards protect a table whose constraints have already
  -- been checked, rather than at commit when there is nothing left to refuse.
  set constraints all immediate;
  alter table public.entities enable trigger entities_message_identity_immutable;
  alter table public.messages enable trigger messages_validate;

  -- `maintain_message_counter` (001:1036) is an INSERT/DELETE trigger, so an
  -- anchor rewrite leaves both the old channel and the new chat with a wrong
  -- count. Recompute from the rows themselves for every anchor this touched —
  -- 112:54's repair pattern, scoped to what moved.
  if cardinality(touched_anchors) > 0 then
    update public.entity_counters ec
       set messages = counts.total,
           human_messages = counts.human,
           agent_messages = counts.agent,
           updated_at = now()
      from (
        select a.id as entity_id,
               count(m.entity_id) as total,
               count(*) filter (where author.kind = 'member') as human,
               count(*) filter (where author.kind = 'team_member') as agent
          from unnest(touched_anchors) a(id)
          left join public.messages m on m.anchor_id = a.id
          left join public.entities author on author.id = m.author_id
         group by a.id
      ) counts
     where ec.entity_id = counts.entity_id;
  end if;
end
$backfill$;

-- -----------------------------------------------------------------------------
-- 7. Finish the re-key. `chat_id` becomes the required key; `root_message_id`
--    keeps its column (turn rows are audit history) but loses its NOT NULL and
--    its FK, because the table it pointed at is about to stop existing.
-- -----------------------------------------------------------------------------
alter table public.chat_turns
  alter column chat_id set not null,
  alter column root_message_id drop not null,
  drop constraint chat_turns_root_message_id_fkey;

drop index if exists public.chat_turns_root_queue_idx;
create index chat_turns_chat_queue_idx
  on public.chat_turns(chat_id, state, queued_at, user_message_id);
create index chat_turns_requested_by_chat_idx
  on public.chat_turns(requested_by_chat_id) where requested_by_chat_id is not null;
create index chat_turns_requested_by_session_idx
  on public.chat_turns(requested_by_session_id) where requested_by_session_id is not null;

comment on column public.chat_turns.root_message_id is
  'Vestigial after 176: the pre-entity chat key, kept so a turn''s audit row '
  'still names the thread root it was queued under. Read chat_id instead.';

-- 133's read, re-keyed: a turn is readable exactly when its CHAT is.
drop policy chat_turns_select on public.chat_turns;
create policy chat_turns_select on public.chat_turns for select to tm8_app
  using (internal.entity_readable(chat_id));

-- The human-author gate (104:236, re-issued at 115 and 153) is the second half
-- of the reported defect, and R-A removes it outright: from here a turn is
-- queued by `w2_post_message_batch` for EVERY author, with one guard (a chat is
-- never handed its own message). Dropping the trigger before the function so a
-- stale trigger can never outlive its body.
drop trigger messages_queue_chat_human_reply on public.messages;
drop function internal.queue_chat_human_reply();

drop function public.start_chat_thread(uuid,uuid,text,text,text,text,uuid,text,text,uuid,text);

drop table public.chat_threads;

-- The agent_runtime credential now binds to a chat. `runtime_thread_root_id`
-- survives as a nullable audit column for pre-176 rows; the SHAPE constraint
-- accepts either, so a legacy row stays valid and every new row carries a chat.
alter table public.auth_sessions
  drop constraint auth_sessions_agent_runtime_shape;
alter table public.auth_sessions
  add constraint auth_sessions_agent_runtime_shape check (
    (
      kind = 'agent_runtime'
      and acting_as_team_member_id is not null
      and runtime_member_id is not null
      and (runtime_chat_id is not null or runtime_thread_root_id is not null)
      and work_session_id is null
    )
    or (
      kind <> 'agent_runtime'
      and runtime_member_id is null
      and runtime_thread_root_id is null
      and runtime_chat_id is null
    )
  );

drop index public.auth_sessions_one_live_runtime_per_thread;
create unique index auth_sessions_one_live_runtime_per_chat
  on public.auth_sessions(runtime_chat_id)
  where kind = 'agent_runtime' and revoked_at is null;

-- -----------------------------------------------------------------------------
-- 8. THE HIERARCHY EXCEPTION (ruled: design doc §7 Q5).
--
--    001:397 raises 'parent must be the same kind'. A chat that spawns a worker
--    must be that worker's PARENT, because that is what makes the worker's
--    `<reply_address>` and `coordinator_session_id` point back at the chat with
--    no new derivation — `manifest.ts` reads `parent_id` regardless of kind. The
--    alternative (a `spawned_by` edge) keeps the law intact and changes the
--    shape of every coordinator derivation for one relation.
--
--    Exactly one pair is admitted: parent `chat` -> child `work_session`.
--    Everything else in this function is 001's body verbatim.
-- -----------------------------------------------------------------------------
create or replace function internal.validate_entity_parent() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare parent public.entities;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'entity cannot be its own parent' using errcode = '23514';
  end if;

  select * into parent from public.entities where id = new.parent_id;
  if not found then
    raise exception 'parent entity does not exist' using errcode = '23503';
  end if;
  if parent.space_id <> new.space_id then
    raise exception 'parent must be in the same space' using errcode = '23514';
  end if;
  -- The one ruled exception to homogeneous hierarchy (doc 01a0632a…c276 §7 Q5):
  -- a chat is the root of the session chain it spawns.
  if parent.kind <> new.kind
     and not (parent.kind = 'chat' and new.kind = 'work_session') then
    raise exception 'parent must be the same kind (% <> %)', parent.kind, new.kind
      using errcode = '23514';
  end if;

  if exists (
    with recursive ancestors(id, depth) as (
      select parent.id, 1
      union all
      select e.parent_id, a.depth + 1
        from public.entities e
        join ancestors a on e.id = a.id
       where e.parent_id is not null
         and a.depth < 1024
    )
    select 1 from ancestors where id = new.id
  ) then
    raise exception 'hierarchy cycle refused' using errcode = '23514';
  end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- 9. `execution_spawn` accepts a chat as the parent.
--
--    ⚠ `reset role`, AND IT IS NOT COSMETIC — 150:700's note, still true. None
--    of the six migrations that have written this function issues `set role
--    tm8_graph_owner`, so `public.execution_spawn` is owned by the APPLIER and
--    the revoke/grant pair below fails with "must be owner of function" under
--    the role this file otherwise runs as. Reproducing 150's posture is the fix.
--
--    150's body VERBATIM save the parent guard: `internal.live_entity` is called
--    without a kind pin and the kind is then checked against the two that may
--    parent a session. The space check is unchanged, and so is everything else —
--    the envelope still takes `p_parent_session_id` as `parent_id`, which the
--    §8 exception now admits.
-- -----------------------------------------------------------------------------
reset role;
create or replace function public.execution_spawn(
  p_space_id uuid, p_team_member_id uuid, p_task_ids uuid[] default '{}'::uuid[],
  p_project_id uuid default null, p_workdir_mode text default 'project',
  p_workdir_path text default null, p_base_ref text default null,
  p_mode text default null, p_model text default null, p_agent_tool text default null,
  p_title text default null, p_node_id text default null,
  p_confirm_untrusted boolean default false, p_session_cap integer default 8,
  p_actor_id uuid default null, p_client_mutation_id text default null,
  p_parent_session_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  persona public.entities;
  project public.projects;
  parent_session public.entities;
  session_id uuid;
  task_id uuid;
  patches uuid[];
  started_status text;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.spawn');
  if replay is not null then
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  persona := internal.live_entity(p_team_member_id, 'team_member');
  if persona.space_id <> p_space_id then
    raise exception 'persona belongs to another space' using errcode = '22023';
  end if;
  if not internal.can_act_as(p_team_member_id, p_space_id) then
    raise exception 'not permitted to spawn this persona' using errcode = '42501';
  end if;

  if p_parent_session_id is not null then
    -- 176: a chat is as legitimate a coordinator as a session (ruling R-B), so
    -- the kind is checked here rather than pinned in the lookup. Anything else
    -- is still refused — this is a two-kind allowance, not an open parent.
    parent_session := internal.live_entity(p_parent_session_id);
    if parent_session.kind not in ('work_session', 'chat') then
      raise exception 'a spawn parent must be a work_session or a chat (got %)',
        parent_session.kind using errcode = '22023';
    end if;
    if parent_session.space_id <> p_space_id then
      raise exception 'parent session belongs to another space' using errcode = '22023';
    end if;
  end if;

  if internal.live_work_session_count(null) >= greatest(coalesce(p_session_cap, 8), 1) then
    raise exception 'session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.live_work_session_count(null))::text;
  end if;

  if p_project_id is not null then
    select * into project from public.projects where id = p_project_id;
    if project.id is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    if not exists (select 1 from public.space_projects
                    where space_id = p_space_id and project_id = p_project_id) then
      raise exception 'project is not linked to this space' using errcode = '42501';
    end if;
    if project.trust = 'untrusted' and not coalesce(p_confirm_untrusted, false) then
      raise exception 'spawning into an untrusted project requires explicit confirmation'
        using errcode = '42501',
              detail = jsonb_build_object('projectId', p_project_id, 'trust', project.trust)::text;
    end if;
  elsif coalesce(p_workdir_mode, 'project') = 'worktree' then
    raise exception 'worktree mode requires a project' using errcode = '22023';
  end if;

  session_id := internal.create_envelope(
    p_space_id, 'work_session', actor, p_parent_session_id, null
  );
  insert into public.work_sessions(entity_id, title, node_id, project_id, workdir_mode,
                                   workdir_path, base_ref, status, agent_tool, model, mode)
  values (session_id, coalesce(p_title, ''), p_node_id, p_project_id,
          coalesce(p_workdir_mode, 'project'), p_workdir_path, p_base_ref,
          'spawning', p_agent_tool, p_model, p_mode);

  patches := array[session_id];
  foreach task_id in array coalesce(p_task_ids, '{}'::uuid[]) loop
    perform internal.live_entity(task_id, 'task');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, session_id, task_id, 'working_on', actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- ADDED IN 111. The durable half of the same fact. Inside the loop and
    -- inside this transaction, so a task cannot end up naming an assignee for a
    -- session that was rolled back.
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (p_space_id, task_id, p_team_member_id, 'assigned_to',
            jsonb_build_object('via', 'spawn'), actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- ADDED IN 131, REKEYED IN 150. The task has started. The `where` is still
    -- the whole rule — only a task that has not started yet can be started — but
    -- "has not started" is now the CATEGORY, not a list of two literals, and the
    -- status written is the workflow's own `in_progress` state.
    update public.tasks t
       set work_status = internal.work_status_for_state(
             internal.workflow_state_for_category(t.entity_id, 'in_progress')),
           updated_at = now()
     where t.entity_id = task_id
       and exists (select 1 from public.entities e
                    where e.id = t.entity_id and e.status_category = 'to_do')
    returning t.work_status into started_status;
    -- ⚠ KEEP THIS ADJACENT TO THE UPDATE ABOVE. `FOUND` reflects the LAST
    -- statement executed, not the last UPDATE. The two edge inserts above both
    -- set it, so a statement inserted between the UPDATE and this `if` turns
    -- the honesty gate into a lie that no test would catch: the cases below
    -- assert the count of `work.changed` rows, and a gate reading a preceding
    -- insert's FOUND would still satisfy most of them.
    if found then
      perform internal.record_activity(p_space_id, task_id, actor, 'work.changed', null,
        jsonb_build_object('status', started_status, 'via', 'spawn'));
    end if;
    patches := patches || task_id;
  end loop;
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, session_id, p_team_member_id, 'relates_to', actor)
  on conflict (src_id, dst_id, type) do nothing;

  return internal.ledger_record(p_client_mutation_id, 'execution.spawn',
           internal.command_result(session_id, null,
             internal.record_activity(p_space_id, session_id, actor, 'created', null,
               jsonb_build_object(
                 'kind', 'work_session',
                 'teamMemberId', p_team_member_id,
                 'parentSessionId', p_parent_session_id
               )),
             patches)) || jsonb_build_object('__tm8_replayed', false);
end
$$;

-- `create or replace` keeps the grants; restated so a reader of this file alone
-- does not have to go and check that it did. Same pair 131 restated, verbatim.
revoke all on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
) from public;

grant execute on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
) to tm8_app;

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 10. `public.start_chat` — the door that replaces `chat.threads.start`.
--
--     THE CHAT ID IS MINTED BY THE CALLER, and it has to be. The handler creates
--     the scratch working directory named after the chat, and a directory named
--     after an id the RPC has not returned yet cannot be created after the fact
--     without a second write. So the id comes IN, and this function is the only
--     writer of that row — the ledger's unique `client_mutation_id` plus the
--     primary key make a replay or a collision a refusal, not a second chat.
--
--     THE ENVELOPE IS INSERTED HERE rather than through `internal.create_
--     envelope`, for exactly that reason: that helper mints its own id. The
--     insert is otherwise identical to it (150:581).
--
--     TURN ONE IS NOT INSERTED HERE EITHER. It rides `w2_post_message_batch`,
--     whose chat arm (§11) queues a turn for any message landing on a chat. One
--     queueing path, so the first turn and the hundredth are queued by the same
--     code — 104 had two, and the second one (the human-only trigger) is what
--     silently dropped every agent-authored message.
--
--     THE RESULT IS ids, NOT A RENDERED SUMMARY. The spec asked for "the chat as
--     entities.get renders it", and SQL cannot produce that — an EntitySummary
--     is assembled in `facade/entity-read.ts` from titles, badges and
--     capabilities that do not exist in this function. The handler reads the
--     entity back through the ordinary read path and returns the real summary,
--     so the contract shape is unchanged and a replay re-reads rather than
--     replaying a stale copy of a row that has since moved.
-- -----------------------------------------------------------------------------
create or replace function public.start_chat(
  p_chat_id uuid,
  p_space_id uuid,
  p_teammate_id uuid,
  p_model text,
  p_provider text,
  p_agent_tool text,
  p_chat_mode text,
  p_workdir_mode text,
  p_project_id uuid,
  p_native_session_id uuid,
  p_cwd text,
  p_title text,
  p_body text,
  p_attachment_ids uuid[],
  p_about_id uuid,
  p_client_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  member_id uuid;
  request_hash text;
  stored_hash text;
  resolved_cwd text;
  resolved_title text;
  about_entity public.entities;
  posted jsonb;
  message_id uuid;
  result jsonb;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;
  if p_chat_id is null then
    raise exception 'chat id is required' using errcode = '22023';
  end if;
  if p_model is null or btrim(p_model) = ''
     or p_provider is null or btrim(p_provider) = ''
     or p_agent_tool is null or btrim(p_agent_tool) = '' then
    raise exception 'model, provider, and agent tool are required' using errcode = '22023';
  end if;
  if p_chat_mode not in ('ask', 'explain', 'plan', 'build', 'orchestrate', 'craft') then
    raise exception 'invalid chat mode' using errcode = '22023';
  end if;
  if p_workdir_mode is null or p_workdir_mode not in ('project', 'scratch') then
    raise exception 'workdir mode must be project or scratch' using errcode = '22023';
  end if;
  if p_native_session_id is null then
    raise exception 'native session id is required' using errcode = '22023';
  end if;
  if p_body is null or char_length(p_body) not between 1 and 10000 then
    raise exception 'the opening message must contain 1..10000 characters' using errcode = '22023';
  end if;

  request_hash := internal.w2_sha256(jsonb_build_object(
    'identityId', internal.identity_id(),
    'chatId', p_chat_id,
    'spaceId', p_space_id,
    'teammateId', p_teammate_id,
    'model', p_model,
    'provider', p_provider,
    'agentTool', p_agent_tool,
    'mode', p_chat_mode,
    'projectId', p_project_id,
    'workdirMode', p_workdir_mode,
    'aboutId', p_about_id
  ));
  replay := internal.ledger_replay(p_client_mutation_id, 'chat.start');
  if replay is not null then
    stored_hash := replay ->> '_requestHash';
    if stored_hash is distinct from request_hash then
      raise exception 'chat start replay does not match the original request'
        using errcode = '23514', detail = 'chat_start_identity_mismatch';
    end if;
    return replay;
  end if;

  perform internal.require_space_member(p_space_id);
  member_id := internal.current_member_id(p_space_id);
  if member_id is null then
    raise exception 'requesting identity is not a member of this space' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.team_members tm
    join public.entities teammate on teammate.id = tm.entity_id
    where tm.entity_id = p_teammate_id
      and teammate.space_id = p_space_id
      and teammate.deleted_at is null
  ) then
    raise exception 'chat teammate not found in this space' using errcode = 'P0002';
  end if;

  -- 167's resolution rule, unchanged: for `project` the path is READ from the
  -- linked project inside this function and `p_cwd` is ignored, so a caller can
  -- never pair a linked project id with somebody else's directory. The Space
  -- link is checked explicitly because SECURITY DEFINER does not evaluate RLS
  -- on `space_projects`.
  if p_workdir_mode = 'project' then
    if p_project_id is null then
      raise exception 'project mode requires a project id' using errcode = '22023';
    end if;
    select p.working_dir into resolved_cwd
      from public.projects p
      join public.space_projects sp on sp.project_id = p.id
     where p.id = p_project_id and sp.space_id = p_space_id;
    if resolved_cwd is null then
      raise exception 'project is not linked to this space' using errcode = 'P0002';
    end if;
  else
    if p_project_id is not null then
      raise exception 'scratch mode does not take a project id' using errcode = '22023';
    end if;
    if p_cwd is null or left(p_cwd, 1) <> '/' then
      raise exception 'scratch mode requires an absolute cwd' using errcode = '22023';
    end if;
    resolved_cwd := p_cwd;
  end if;

  if p_about_id is not null then
    about_entity := internal.live_entity(p_about_id);
    if about_entity.space_id <> p_space_id then
      raise exception 'the subject of a chat must live in the same space' using errcode = '22023';
    end if;
  end if;

  resolved_title := left(coalesce(nullif(btrim(coalesce(p_title, '')), ''), p_body), 240);

  perform internal.bind_actor(member_id);
  insert into public.entities(id, space_id, kind, parent_id, position, created_by)
  values (p_chat_id, p_space_id, 'chat', null, null, member_id);

  insert into public.chats(
    entity_id, space_id, title, teammate_id, model, provider, agent_tool,
    chat_mode, workdir_mode, project_id, cwd, native_session_id,
    configured_by_identity_id, configured_by_member_id, requester_auth_kind,
    client_mutation_id
  ) values (
    p_chat_id, p_space_id, resolved_title, p_teammate_id, p_model, p_provider, p_agent_tool,
    p_chat_mode, p_workdir_mode, p_project_id, resolved_cwd, p_native_session_id,
    internal.identity_id(), member_id, internal.claim_text('tm8.auth_kind'),
    p_client_mutation_id
  );

  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, p_chat_id, p_teammate_id, 'relates_to', member_id);

  if p_about_id is not null then
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, p_chat_id, p_about_id, 'about', member_id);
  end if;

  perform internal.record_activity(p_space_id, p_chat_id, member_id, 'created',
            null, jsonb_build_object('kind', 'chat'));

  posted := public.w2_post_message_batch(
    array[p_chat_id], p_body, null, '{}'::uuid[],
    coalesce(p_attachment_ids, '{}'::uuid[]), null, null,
    p_client_mutation_id || ':m0', p_chat_mode, null);
  message_id := (posted -> 'messageIds' ->> 0)::uuid;
  if message_id is null then
    raise exception 'chat opening message was not stored' using errcode = 'P0002';
  end if;

  result := jsonb_build_object(
    'chatId', p_chat_id,
    'messageId', message_id,
    '_requestHash', request_hash
  );
  return internal.ledger_record(p_client_mutation_id, 'chat.start', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 11. The six re-keyed runtime doors. 153/144's bodies, with `chat_threads`
--     replaced by `chats` and `root_message_id` by `chat_id`.
-- -----------------------------------------------------------------------------
drop function public.claim_next_chat_turn(uuid);

create function public.claim_next_chat_turn(p_chat_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  chat_row public.chats;
  turn_row public.chat_turns;
  user_message public.messages;
  requester public.members;
  requested_kind text;
begin
  perform internal.require_identity();
  select * into chat_row from public.chats where entity_id = p_chat_id for update;
  if chat_row.entity_id is null or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat not found for this identity' using errcode = 'P0002';
  end if;
  select * into turn_row from public.chat_turns
   where chat_id = p_chat_id
     and (state = 'queued' or (state = 'running' and lease_expires_at < now()))
   order by queued_at, user_message_id for update skip locked limit 1;
  if turn_row.turn_id is null then return null; end if;
  update public.chat_turns
     set state = 'running', attempt_no = attempt_no + 1,
         started_at = coalesce(started_at, now()), lease_expires_at = now() + interval '10 minutes',
         updated_at = now()
   where turn_id = turn_row.turn_id returning * into turn_row;
  select * into user_message from public.messages where entity_id = turn_row.user_message_id;
  -- The human requester, when there IS one. 153 coalesced an absent requester to
  -- the configuring member; that is right for a legacy row (which could not
  -- record one) and WRONG for an agent-authored turn, where it would name a
  -- human who did not speak. The coalesce therefore applies only when no actor
  -- was recorded at all.
  select * into requester from public.members
   where entity_id = coalesce(
     turn_row.requested_by_member_id,
     case when turn_row.requested_by_actor_id is null
          then chat_row.configured_by_member_id end);
  select e.kind into requested_kind from public.entities e
   where e.id = turn_row.requested_by_actor_id;
  return jsonb_build_object(
    'turnId', turn_row.turn_id,
    'chatId', chat_row.entity_id,
    'spaceId', chat_row.space_id,
    'userMessageId', turn_row.user_message_id,
    'agentMessageId', turn_row.agent_message_id,
    'body', user_message.body,
    'attachments', coalesce(user_message.attachments, '[]'::jsonb),
    'requesterIdentityId', chat_row.configured_by_identity_id,
    'requesterAuthKind', chat_row.requester_auth_kind,
    'requestedByMemberId', requester.entity_id,
    'requestedByIdentityId', requester.identity_id,
    'requestedByAuthKind', case
      when turn_row.requested_by_auth_kind is not null then turn_row.requested_by_auth_kind
      when requester.entity_id = chat_row.configured_by_member_id then chat_row.requester_auth_kind
      else null
    end,
    'requestedByDisplayName', requester.display_name,
    -- R-C provenance: who spent the configurer's authority on this turn, and
    -- from where. Never claims — the turn still runs on requesterIdentityId.
    'requestedByActorId', turn_row.requested_by_actor_id,
    'requestedByActorKind', requested_kind,
    'requestedBySessionId', turn_row.requested_by_session_id,
    'requestedByChatId', turn_row.requested_by_chat_id,
    'teammateId', chat_row.teammate_id,
    'model', chat_row.model,
    'provider', chat_row.provider,
    'agentTool', chat_row.agent_tool,
    'chatMode', coalesce(turn_row.mode, chat_row.chat_mode),
    'mode', turn_row.mode,
    'nativeSessionId', chat_row.native_session_id,
    'cwd', chat_row.cwd,
    'runtimeState', chat_row.runtime_state,
    'nextSeq', case when turn_row.agent_message_id is null then 0 else
      (select coalesce(max(seq) + 1, 0) from public.message_parts
        where message_id = turn_row.agent_message_id) end
  );
end
$$;

drop function public.mark_chat_runtime_state(uuid, text);

create function public.mark_chat_runtime_state(p_chat_id uuid, p_state text)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  chat_row public.chats;
  claimed_node text;
begin
  perform internal.require_identity();
  if p_state not in ('live', 'stopped') then
    raise exception 'invalid chat runtime state' using errcode = '22023';
  end if;
  select * into chat_row from public.chats where entity_id = p_chat_id for update;
  if chat_row.entity_id is null or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat not found for this identity' using errcode = 'P0002';
  end if;
  -- B7 node affinity. The node stamps itself when it takes the runtime live; a
  -- node that does not set the GUC leaves the previous value rather than
  -- writing NULL, so "which node owns this" is never erased by a node that
  -- simply does not know its own name.
  claimed_node := nullif(btrim(coalesce(current_setting('tm8.node_id', true), '')), '');
  update public.chats
     set runtime_state = p_state,
         node_id = case when p_state = 'live' then coalesce(claimed_node, node_id) else node_id end,
         updated_at = now()
   where entity_id = p_chat_id;
end
$$;

create or replace function public.bind_chat_agent_message(
  p_turn_id uuid, p_agent_message_id uuid
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare turn_row public.chat_turns; chat_row public.chats; agent_message public.messages;
begin
  perform internal.require_identity();
  select * into turn_row from public.chat_turns where turn_id = p_turn_id for update;
  select * into chat_row from public.chats where entity_id = turn_row.chat_id;
  if turn_row.turn_id is null or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat turn not found for this identity' using errcode = 'P0002';
  end if;
  select * into agent_message from public.messages where entity_id = p_agent_message_id;
  -- A chat is FLAT: the agent's message is ANCHORED on the chat, not threaded
  -- under the human's. The pairing this function writes is the only record that
  -- the two belong together, which is precisely why threading is not needed.
  if agent_message.entity_id is null
     or agent_message.anchor_id <> chat_row.entity_id
     or agent_message.author_id <> chat_row.teammate_id then
    raise exception 'agent message does not belong to this chat turn' using errcode = '23514';
  end if;
  if turn_row.agent_message_id is not null and turn_row.agent_message_id <> p_agent_message_id then
    raise exception 'chat turn already has a different agent message' using errcode = '23505';
  end if;
  update public.chat_turns set agent_message_id = p_agent_message_id, updated_at = now()
   where turn_id = p_turn_id;
end
$$;

create or replace function public.append_chat_message_part(
  p_message_id uuid, p_seq integer, p_kind text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare turn_row public.chat_turns; chat_row public.chats; stored public.message_parts;
begin
  perform internal.require_identity();
  if p_seq < 0 or p_kind not in ('thinking','text','tool_call','tool_result','usage','error','done')
     or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid chat message part' using errcode = '22023';
  end if;
  select * into turn_row from public.chat_turns where agent_message_id = p_message_id;
  select * into chat_row from public.chats where entity_id = turn_row.chat_id;
  if turn_row.turn_id is null or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat agent message not found for this identity' using errcode = 'P0002';
  end if;
  insert into public.message_parts(message_id, seq, kind, payload)
  values (p_message_id, p_seq, p_kind, p_payload)
  on conflict (message_id, seq) do nothing;
  select * into stored from public.message_parts where message_id = p_message_id and seq = p_seq;
  if stored.kind <> p_kind or stored.payload is distinct from p_payload then
    raise exception 'chat message part sequence already has different content' using errcode = '23514';
  end if;
  return jsonb_build_object(
    'seq', stored.seq,
    'kind', stored.kind,
    'payload', stored.payload,
    'createdAt', internal.w2_iso(stored.created_at)
  );
end
$$;

create or replace function public.complete_chat_turn(
  p_turn_id uuid,
  p_state text,
  p_body text,
  p_usage jsonb default null,
  p_total_cost_usd numeric default null,
  p_failure jsonb default null
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare turn_row public.chat_turns; chat_row public.chats; final_body text;
begin
  perform internal.require_identity();
  if p_state not in ('completed', 'error')
     or (p_usage is not null and jsonb_typeof(p_usage) <> 'object')
     or (p_failure is not null and jsonb_typeof(p_failure) <> 'object')
     or p_total_cost_usd < 0 then
    raise exception 'invalid chat turn completion' using errcode = '22023';
  end if;
  select * into turn_row from public.chat_turns where turn_id = p_turn_id for update;
  select * into chat_row from public.chats where entity_id = turn_row.chat_id;
  if turn_row.turn_id is null or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat turn not found for this identity' using errcode = 'P0002';
  end if;
  final_body := left(coalesce(nullif(btrim(p_body), ''),
    case when p_state = 'completed' then 'Agent turn completed.' else 'Agent turn failed.' end), 10000);
  if turn_row.agent_message_id is not null then
    update public.messages set body = final_body where entity_id = turn_row.agent_message_id;
  end if;
  update public.chat_turns
     set state = p_state, usage = p_usage,
         usage_source = case when p_usage is null then null else 'c1_usage_item' end,
         total_cost_usd = p_total_cost_usd,
         failure = p_failure, completed_at = now(), lease_expires_at = null, updated_at = now()
   where turn_id = p_turn_id;
end
$$;

-- 123's audit trigger, keyed on the chat. The event payload names `chatId`; a
-- consumer that was reading `threadRootId` is reading a fact that no longer
-- exists, which is the point of renaming it rather than aliasing it.
create or replace function internal.audit_chat_tool_call() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare chat_row public.chats; call_id text;
begin
  if new.kind <> 'tool_call' then return new; end if;
  call_id := coalesce(new.payload ->> 'id', 'unknown');
  select c.* into chat_row
    from public.chat_turns turn_row
    join public.chats c on c.entity_id = turn_row.chat_id
   where turn_row.agent_message_id = new.message_id
   limit 1;
  if chat_row.entity_id is null then return new; end if;
  if exists (
    select 1 from public.activity a
     where a.entity_id = new.message_id and a.verb = 'chat.tool_called'
       and a.summary ->> 'toolCallId' = call_id
       and a.summary ->> 'state' = coalesce(new.payload ->> 'state', 'unknown')
  ) then return new; end if;
  perform internal.record_activity(
    chat_row.space_id, new.message_id, chat_row.teammate_id, 'chat.tool_called',
    chat_row.entity_id,
    jsonb_build_object(
      'chatId', chat_row.entity_id,
      'toolCallId', call_id,
      'tool', coalesce(new.payload ->> 'name', 'unknown'),
      'state', coalesce(new.payload ->> 'state', 'unknown'),
      'mode', chat_row.chat_mode
    )
  );
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- 12. The agent_runtime credential binds to a chat entity.
--
--     105's bodies, with the thread-root lookup replaced by a chat lookup. The
--     <=24h window, the human-only mint (an agent_runtime token still cannot
--     extend its own life by minting a successor) and the atomic revoke-then-
--     issue are all unchanged.
--
--     `resolve_auth_session` gains `runtimeChatId`. It keeps returning
--     `runtimeThreadRootId` so a pre-176 row still resolves rather than
--     silently reading as an unbound credential.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_auth_session(p_token_hash text)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'sessionId', s.id, 'accountId', a.id, 'identityId', a.identity_id,
    'username', a.username, 'displayName', a.display_name,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner,
    'kind', s.kind, 'actingAsTeamMemberId', s.acting_as_team_member_id,
    'workSessionId', s.work_session_id,
    'runtimeMemberId', s.runtime_member_id,
    'runtimeThreadRootId', s.runtime_thread_root_id,
    'runtimeChatId', s.runtime_chat_id,
    'expiresAt', s.expires_at, 'label', s.label)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
$$;

drop function public.issue_agent_runtime_session(uuid, uuid, text, timestamptz, text);

create function public.issue_agent_runtime_session(
  p_chat_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
  target_space uuid;
  requester_member uuid;
  account public.accounts;
  issued public.auth_sessions;
begin
  perform internal.require_human_auth_kind();

  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid agent runtime token hash' using errcode = '22023';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '24 hours' then
    raise exception 'agent runtime expiry must be within the next 24 hours' using errcode = '22023';
  end if;

  -- Locking the chat serializes two concurrent turn starts before the old live
  -- token is revoked.
  select e.space_id into target_space
    from public.chats c
    join public.entities e on e.id = c.entity_id
   where c.entity_id = p_chat_id and e.deleted_at is null
   for update of c;
  if target_space is null then
    raise exception 'chat not found' using errcode = 'P0002';
  end if;

  requester_member := internal.current_member_id(target_space);
  if requester_member is null then
    raise exception 'requesting identity is not a member of this chat space' using errcode = '42501';
  end if;
  if not internal.can_act_as(p_team_member_id, target_space) then
    raise exception 'requesting member cannot use this teammate in the chat space' using errcode = '42501';
  end if;

  select * into account
    from public.accounts account_row
   where account_row.identity_id = identity and account_row.status = 'active';
  if account.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  update public.auth_sessions
     set revoked_at = now()
   where runtime_chat_id = p_chat_id
     and kind = 'agent_runtime'
     and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id,
    runtime_member_id, runtime_chat_id,
    token_hash, label, expires_at
  ) values (
    account.id, 'agent_runtime', p_team_member_id,
    requester_member, p_chat_id,
    p_token_hash, p_label, p_expires_at
  ) returning * into issued;

  return to_jsonb(issued) - 'token_hash';
end
$$;

drop function public.revoke_agent_runtime_session(uuid);

create function public.revoke_agent_runtime_session(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  target_space uuid;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  select e.space_id into target_space
    from public.chats c
    join public.entities e on e.id = c.entity_id
   where c.entity_id = p_chat_id;
  if target_space is null then return; end if;
  if not internal.is_space_member(target_space) then
    raise exception 'not permitted to revoke this chat runtime' using errcode = '42501';
  end if;

  update public.auth_sessions
     set revoked_at = now()
   where runtime_chat_id = p_chat_id
     and kind = 'agent_runtime'
     and revoked_at is null;
end
$$;

-- -----------------------------------------------------------------------------
-- 13. `w2_post_message_batch` learns the chat.
--
--     154's body VERBATIM save four additions, each marked `176` below: the
--     `p_source_chat_id` parameter, the one-source refusal, the chat arm inside
--     the anchor loop (which is where the turn queue moved to), and the
--     `authored_from` write for a chat source.
--
--     The 9-argument overload is DROPPED rather than left beside this one, as
--     154 dropped 019's 8-argument form: a stale signature that silently writes
--     no chat provenance is the trap that outlives whoever left it.
-- -----------------------------------------------------------------------------
drop function public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text);

create function public.w2_post_message_batch(
  p_anchor_ids uuid[], p_body text, p_parent_message_id uuid default null,
  p_mention_ids uuid[] default '{}'::uuid[], p_attachment_ids uuid[] default '{}'::uuid[],
  p_source_work_session_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null, p_chat_turn_mode text default null,
  p_source_chat_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; anchors uuid[]; mentions uuid[]; files uuid[]; anchor_count integer;
  first_anchor public.entities; anchor public.entities; parent public.messages;
  parent_envelope public.entities; target_space uuid; actor uuid; thread_root uuid;
  mention_json jsonb; attachment_json jsonb; message_ids uuid[]:='{}'::uuid[];
  message_id uuid; stable_hash text; replay_hash text; replay_author uuid; replay_space uuid;
  delivery_intents jsonb:='[]'::jsonb; require_space_files boolean:=false; result jsonb;
  turn_mode text;
  -- 176. A message may name at most one source, and a chat anchor queues a turn
  -- for whoever wrote it.
  source_chat public.chats; chat_anchor public.chats;
  queued_turn_id uuid; actor_kind text; queue_auth_kind text;
begin
  if p_client_mutation_id is null or btrim(p_client_mutation_id)='' then
    raise exception 'clientMutationId is required' using errcode='22023';
  end if;
  if p_body is null or char_length(p_body) not between 1 and 10000 then
    raise exception 'message body must contain 1..10000 characters' using errcode='22023';
  end if;
  -- The per-turn chat mode. NULL is legal and means "no request" (the thread
  -- default resolves at claim time). A non-NULL value that is NOT one of the six
  -- modes FAILS LOUD, exactly like the clientMutationId and body guards above —
  -- so a seventh mode added to the ChatMode enum and the composer but missed in
  -- this list surfaces as an error instead of every send silently falling back
  -- to the thread default. Only meaningful for a chat-thread anchor; harmless
  -- (but still validated) on any other message.
  if p_chat_turn_mode is not null
     and p_chat_turn_mode not in ('ask','explain','plan','build','orchestrate','craft') then
    raise exception 'unknown chat turn mode: %', p_chat_turn_mode using errcode='22023';
  end if;
  -- ONE SOURCE PER MESSAGE, refused here rather than resolved by precedence.
  -- `edges_authored_from_source_idx` already makes one authored_from per source
  -- entity a hard rule; a batch naming two sources would either violate it or
  -- silently drop one, and "silently drop one" is how provenance becomes a
  -- guess. 42501-worthy? No: this is a malformed request, not a denied one.
  if p_source_work_session_id is not null and p_source_chat_id is not null then
    raise exception 'a message has one source: name a work session or a chat, not both'
      using errcode='22023';
  end if;
  turn_mode := p_chat_turn_mode;
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into anchors
    from unnest(coalesce(p_anchor_ids,'{}'::uuid[])) item(value);
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into mentions
    from unnest(coalesce(p_mention_ids,'{}'::uuid[])) item(value);
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into files
    from unnest(coalesce(p_attachment_ids,'{}'::uuid[])) item(value);
  anchor_count:=cardinality(anchors);
  if anchor_count not between 1 and 16 or anchor_count<>cardinality(coalesce(p_anchor_ids,'{}'::uuid[]))
     or cardinality(mentions)>16 or cardinality(mentions)<>cardinality(coalesce(p_mention_ids,'{}'::uuid[]))
     or cardinality(files)>16 or cardinality(files)<>cardinality(coalesce(p_attachment_ids,'{}'::uuid[])) then
    raise exception 'message batch requires bounded unique anchors, mentions, and files' using errcode='22023';
  end if;
  if anchor_count*cardinality(files)>64 then
    raise exception 'anchor by attachment pair limit exceeded' using errcode='54000';
  end if;
  if octet_length(convert_to(jsonb_build_object(
      'anchorIds',anchors,'body',p_body,'parentMessageId',p_parent_message_id,
      'mentionIds',mentions,'attachmentIds',files,'actorId',p_actor_id
    )::text,'UTF8'))>262144 then
    raise exception 'canonical message request exceeds 256 KiB' using errcode='54000';
  end if;

  replay:=internal.ledger_replay(p_client_mutation_id,'messages.post');
  if replay is not null then
    replay_author:=nullif(replay#>>'{_audit,authorId}','')::uuid;
    replay_space:=nullif(replay#>>'{_audit,spaceId}','')::uuid;
    replay_hash:=internal.w2_message_batch_hash(
      internal.identity_id(),p_actor_id,replay_author,replay_space,
      anchors,p_body,p_parent_message_id,mentions,files);
    if replay_hash is distinct from replay->>'_stableHash' then
      raise exception 'message batch identity mismatch' using errcode='23514',
        detail='message_batch_identity_mismatch';
    end if;
    return replay;
  end if;

  perform 1 from public.entities e where e.id=any(anchors) order by e.id for update;
  if (select count(*) from public.entities e
       where e.id=any(anchors) and e.deleted_at is null and internal.entity_readable(e.id))<>anchor_count then
    raise exception 'message anchor not found' using errcode='P0002';
  end if;
  select * into first_anchor from public.entities where id=anchors[1];
  target_space:=first_anchor.space_id;
  if exists(select 1 from public.entities e where e.id=any(anchors) and e.space_id<>target_space) then
    raise exception 'message anchors must share one Space' using errcode='23514';
  end if;
  require_space_files:=exists(select 1 from public.entities e where e.id=any(anchors) and e.visibility='space');
  perform internal.require_space_member(target_space);
  actor:=internal.resolve_actor(p_actor_id,target_space);
  perform internal.bind_actor(actor);

  if p_parent_message_id is not null then
    if anchor_count<>1 then raise exception 'a reply has exactly one anchor' using errcode='22023'; end if;
    perform 1 from public.entities where id=p_parent_message_id for update;
    select * into parent from public.messages where entity_id=p_parent_message_id;
    select * into parent_envelope from public.entities where id=p_parent_message_id;
    if parent.entity_id is null or not internal.entity_readable(parent.entity_id) then
      raise exception 'parent message not found' using errcode='P0002';
    end if;
    if parent.anchor_id<>anchors[1] then
      raise exception 'reply anchor must equal parent anchor' using errcode='23514';
    end if;
    thread_root:=coalesce(parent.root_message_id,parent.entity_id);
  end if;

  perform 1 from public.entities e where e.id=any(files) order by e.id for update;
  mention_json:=internal.w2_resolve_mentions(mentions,target_space);
  attachment_json:=internal.w2_validate_attachment_files(files,target_space,require_space_files);

  if p_source_work_session_id is not null then
    perform 1 from public.entities e join public.work_sessions ws on ws.entity_id=e.id
     where e.id=p_source_work_session_id and e.space_id=target_space and e.deleted_at is null
       and exists(select 1 from public.edges edge where edge.src_id=actor
                   and edge.dst_id=p_source_work_session_id and edge.type='participates_in')
     for update;
    if not found then
      raise exception 'authored_from provenance does not match the resolved author session'
        using errcode='42501';
    end if;
  end if;

  -- The chat analogue of the check above. A session proves provenance with a
  -- `participates_in` edge from the author; a chat's author IS its bound
  -- teammate, so the binding edge is the same proof in the shape chat has. The
  -- server never takes this id from request input — it comes off the bearer's
  -- own `runtime_chat_id` row — but the door is authorized independently, so a
  -- future caller cannot claim a chat it does not run.
  if p_source_chat_id is not null then
    select c.* into source_chat
      from public.chats c
      join public.entities e on e.id=c.entity_id
     where c.entity_id=p_source_chat_id and e.space_id=target_space and e.deleted_at is null
     for update of c;
    if source_chat.entity_id is null or source_chat.teammate_id<>actor then
      raise exception 'authored_from provenance does not match the resolved author chat'
        using errcode='42501';
    end if;
  end if;

  stable_hash:=internal.w2_message_batch_hash(
    internal.identity_id(),p_actor_id,actor,target_space,
    anchors,p_body,p_parent_message_id,mentions,files);

  foreach message_id in array anchors loop
    select * into anchor from public.entities where id=message_id;
    message_id:=internal.new_id();
    insert into public.entities(id,space_id,kind,parent_id,position,created_by,visibility)
    values(message_id,target_space,'message',p_parent_message_id,null,actor,anchor.visibility);
    insert into public.messages(
      entity_id,anchor_id,root_message_id,author_id,body,mentions,attachments,
      client_msg_id,message_batch_id,requested_chat_mode
    ) values(
      message_id,anchor.id,thread_root,actor,p_body,mention_json,attachment_json,null,p_client_mutation_id,turn_mode
    );
    message_ids:=array_append(message_ids,message_id);
    if anchor.kind='work_session' then
      delivery_intents:=delivery_intents||jsonb_build_array(jsonb_build_object(
        'messageId',message_id,'targetWorkSessionId',anchor.id,
        'content',p_body,'mode','send'));
    end if;
    -- 176 — THE CHAT ARM. This replaces `internal.queue_chat_human_reply`
    -- (104/115/153), whose author test was the second half of the reported
    -- defect: a team_member author had no `members` row, found no turn to queue,
    -- and the message stayed inert context. Ruling R-A removes every gate that
    -- was there — no author-kind test, no auth-kind test, no cap, no per-chat
    -- wake flag — and keeps exactly one, which sessions already have:
    --
    --   A CHAT IS NEVER HANDED ITS OWN MESSAGE.
    --
    -- The guard is keyed on the SOURCE, not on the author. Keying it on the
    -- author (`actor = chat.teammate_id`) would also suppress a message the
    -- teammate wrote from a DIFFERENT chat or session, which is precisely the
    -- traffic this feature exists to carry. It is keyed on the source because
    -- the orchestrator's own `Agent turn in progress.` placeholder is posted
    -- with the chat as both anchor and source — that post is the reason the
    -- guard exists and the reason it has this shape.
    if anchor.kind='chat' and p_source_chat_id is distinct from anchor.id then
      select * into chat_anchor from public.chats where entity_id=anchor.id;
      if chat_anchor.entity_id is not null then
        select e.kind into actor_kind from public.entities e where e.id=actor;
        -- The turn's auth kind is PROVENANCE and must stay unforgeable: only the
        -- two human kinds the column admits are recorded, and an agent-authored
        -- turn records none rather than inheriting the configurer's.
        queue_auth_kind := case
          when internal.claim_text('tm8.auth_kind') in ('browser','cli')
            then internal.claim_text('tm8.auth_kind') else null end;
        insert into public.chat_turns(
          chat_id, root_message_id, user_message_id,
          requested_by_member_id, requested_by_actor_id,
          requested_by_session_id, requested_by_chat_id,
          requested_by_auth_kind, mode, pricing_provider, pricing_model, queued_at
        ) values (
          chat_anchor.entity_id, null, message_id,
          case when actor_kind='member' then actor else null end, actor,
          p_source_work_session_id, p_source_chat_id,
          queue_auth_kind, coalesce(turn_mode, chat_anchor.chat_mode),
          chat_anchor.provider, chat_anchor.model, now()
        ) returning turn_id into queued_turn_id;
        delivery_intents:=delivery_intents||jsonb_build_array(jsonb_build_object(
          'kind','chat_turn','messageId',message_id,
          'chatId',chat_anchor.entity_id,'turnId',queued_turn_id));
      end if;
    end if;
  end loop;

  if p_source_work_session_id is not null then
    perform internal.w1_set_writer('message_recorder');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,id,p_source_work_session_id,'authored_from',actor
        from unnest(message_ids) item(id);
    perform internal.w1_set_writer('');
  end if;
  -- 176: the same provenance write, to a chat. Without it a reply to a chat
  -- agent's post has nothing to resolve and 168's `recorded_only` fallback is
  -- the best a chat could get.
  if p_source_chat_id is not null then
    perform internal.w1_set_writer('message_recorder');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,id,p_source_chat_id,'authored_from',actor
        from unnest(message_ids) item(id);
    perform internal.w1_set_writer('');
  end if;
  if cardinality(files)>0 then
    perform internal.w1_set_writer('message_attachment');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,file_id,message_ref,'attached_to',actor
        from unnest(files) f(file_id) cross join unnest(message_ids) m(message_ref);
    perform internal.w1_set_writer('');
  end if;

  if parent.entity_id is not null then
    perform internal.w2_notify_actor(
      target_space,parent.author_id,'message_reply',parent.anchor_id,actor,
      jsonb_build_object('messageId',message_ids[1],'parentMessageId',parent.entity_id,
                         'anchorId',parent.anchor_id));
  end if;

  result:=jsonb_build_object(
    'messageBatchId',p_client_mutation_id,
    'messageIds',to_jsonb(message_ids),
    'deliveryIntents',delivery_intents,
    '_stableHash',stable_hash,
    '_audit',jsonb_build_object('authorId',actor,'spaceId',target_space)
  );
  return internal.ledger_record(p_client_mutation_id,'messages.post',result);
end
$$;

revoke all on function public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text, uuid) from public;
grant execute on function public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text, uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 14. Grants. `create or replace` keeps them, but every signature that CHANGED
--     is a new function as far as the catalog is concerned and starts with the
--     default PUBLIC EXECUTE. Restated in full for the replaced ones too, so a
--     reader of this file alone does not have to go and check.
-- -----------------------------------------------------------------------------
revoke all on function public.start_chat(
  uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,uuid[],uuid,text) from public;
grant execute on function public.start_chat(
  uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,uuid[],uuid,text) to tm8_app;

revoke all on function public.claim_next_chat_turn(uuid) from public;
grant execute on function public.claim_next_chat_turn(uuid) to tm8_app;

revoke all on function public.mark_chat_runtime_state(uuid,text) from public;
grant execute on function public.mark_chat_runtime_state(uuid,text) to tm8_app;

revoke all on function public.bind_chat_agent_message(uuid,uuid) from public;
grant execute on function public.bind_chat_agent_message(uuid,uuid) to tm8_app;

revoke all on function public.append_chat_message_part(uuid,integer,text,jsonb) from public;
grant execute on function public.append_chat_message_part(uuid,integer,text,jsonb) to tm8_app;

revoke all on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) from public;
grant execute on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) to tm8_app;

revoke all on function public.resolve_auth_session(text) from public;
grant execute on function public.resolve_auth_session(text) to tm8_app;

revoke all on function public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text) from public;
grant execute on function public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text) to tm8_app;

revoke all on function public.revoke_agent_runtime_session(uuid) from public;
grant execute on function public.revoke_agent_runtime_session(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 15. VERIFY — and ONLY what this file creates. The tranche suites replay this
--     migration mid-chain, so an assertion about anything else would be an
--     assertion about a database state this file does not own.
-- -----------------------------------------------------------------------------
do $verify$
declare
  missing text;
begin
  if not exists (select 1 from public.entity_kinds where kind='chat' and space_id is null) then
    raise exception 'VERIFY 176: the chat kind was not registered';
  end if;
  if to_regclass('public.chats') is null then
    raise exception 'VERIFY 176: public.chats was not created';
  end if;
  if to_regclass('public.chat_threads') is not null then
    raise exception 'VERIFY 176: public.chat_threads survived the re-key';
  end if;

  select string_agg(needed, ', ') into missing
    from unnest(array[
      'entity_id','space_id','title','teammate_id','model','provider','agent_tool',
      'chat_mode','workdir_mode','project_id','cwd','native_session_id','runtime_state',
      'node_id','configured_by_identity_id','configured_by_member_id',
      'requester_auth_kind','client_mutation_id'
    ]) needed
   where not exists (
     select 1 from information_schema.columns
      where table_schema='public' and table_name='chats' and column_name=needed);
  if missing is not null then
    raise exception 'VERIFY 176: public.chats is missing %', missing;
  end if;

  select string_agg(needed, ', ') into missing
    from unnest(array['chat_id','requested_by_actor_id','requested_by_session_id',
                      'requested_by_chat_id']) needed
   where not exists (
     select 1 from information_schema.columns
      where table_schema='public' and table_name='chat_turns' and column_name=needed);
  if missing is not null then
    raise exception 'VERIFY 176: public.chat_turns is missing %', missing;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='chat_turns'
       and column_name='chat_id' and is_nullable='YES'
  ) then
    raise exception 'VERIFY 176: chat_turns.chat_id must be the required key';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='auth_sessions'
       and column_name='runtime_chat_id'
  ) then
    raise exception 'VERIFY 176: auth_sessions.runtime_chat_id was not added';
  end if;

  if to_regprocedure('public.start_chat_thread(uuid,uuid,text,text,text,text,uuid,text,text,uuid,text)')
     is not null then
    raise exception 'VERIFY 176: start_chat_thread was not dropped';
  end if;
  select string_agg(needed, ', ') into missing
    from unnest(array[
      'public.start_chat(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,uuid[],uuid,text)',
      'public.claim_next_chat_turn(uuid)',
      'public.mark_chat_runtime_state(uuid,text)',
      'public.bind_chat_agent_message(uuid,uuid)',
      'public.append_chat_message_part(uuid,integer,text,jsonb)',
      'public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb)',
      'public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text)',
      'public.revoke_agent_runtime_session(uuid)',
      'public.w2_post_message_batch(uuid[],text,uuid,uuid[],uuid[],uuid,uuid,text,text,uuid)'
    ]) needed
   where to_regprocedure(needed) is null;
  if missing is not null then
    raise exception 'VERIFY 176: missing door(s) %', missing;
  end if;

  -- A missing `revoke ... from public` is invisible in a function diff and reds
  -- every PR that follows (the 156 -> 160 lesson), so it is asserted here.
  select string_agg(needed, ', ') into missing
    from unnest(array[
      'public.start_chat(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,uuid[],uuid,text)',
      'public.claim_next_chat_turn(uuid)',
      'public.mark_chat_runtime_state(uuid,text)',
      'public.bind_chat_agent_message(uuid,uuid)',
      'public.append_chat_message_part(uuid,integer,text,jsonb)',
      'public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb)',
      'public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text)',
      'public.revoke_agent_runtime_session(uuid)',
      'public.w2_post_message_batch(uuid[],text,uuid,uuid[],uuid[],uuid,uuid,text,text,uuid)'
    ]) needed
   where has_function_privilege('public', to_regprocedure(needed), 'EXECUTE')
      or not has_function_privilege('tm8_app', to_regprocedure(needed), 'EXECUTE');
  if missing is not null then
    raise exception 'VERIFY 176: grant/revoke wrong on %', missing;
  end if;

  if not (select 'chat' = any(dst_kinds) from public.edge_types where type='authored_from') then
    raise exception 'VERIFY 176: authored_from does not accept a chat destination';
  end if;
  if not (select 'chat' = any(src_kinds) from public.edge_types where type='about') then
    raise exception 'VERIFY 176: about does not accept a chat source';
  end if;

  if exists (
    select 1 from pg_trigger
     where tgname='messages_queue_chat_human_reply' and not tgisinternal
  ) then
    raise exception 'VERIFY 176: the human-only enqueue trigger survived';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname='public' and tablename='chat_turns' and policyname='chat_turns_select'
       and qual like '%chat_id%'
  ) then
    raise exception 'VERIFY 176: chat_turns_select was not re-keyed onto chat_id';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname='public' and tablename='chats' and policyname='chats_select'
  ) then
    raise exception 'VERIFY 176: chats_select is missing';
  end if;

  -- Every backfilled chat kept its turns and its transcript.
  if exists (select 1 from public.chat_turns where chat_id is null) then
    raise exception 'VERIFY 176: a chat turn was left without a chat';
  end if;
  if exists (
    select 1 from public.messages m
    join public.entities a on a.id=m.anchor_id
   where a.kind='chat' and m.root_message_id is not null
  ) then
    raise exception 'VERIFY 176: a chat message is still threaded; a chat is flat';
  end if;
end
$verify$;

reset role;
