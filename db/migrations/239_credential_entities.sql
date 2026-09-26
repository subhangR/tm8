-- =============================================================================
-- 239 — credential entities, W10a (task 01a0d9fd, doc 13
-- 01a0da24 §4/§7, threat review 01a0db1c Part 2).
--
-- Placeholder 996 until handover, when it took its assigned number 239 (W10
-- order a, c, b); the sweep.test.ts pin was re-measured at that merge.
--
-- A 206 space credential becomes a graph entity of the RESTRICTED kind
-- `credential`, same id as its side-table row. The card (entity) is visible to
-- the space; the secret, the key hint and the vendor login stay in the side
-- table (§3a). What lands here:
--
--   1. `credential` registered as a core kind.
--   2. space_credentials gains owner_account_id (null = space-owned, RESTRICT),
--      visibility (private|public) and may_be_space_default, with doc 13 §7's
--      constraints. `is_default` IS the space default (§7's is_space_default);
--      it is not renamed — PR deviation.
--   3. member_defaults (space, account, provider) -> a credential the account
--      owns. Table and invariants only; its writer is W10b's setDefault(mine).
--   4. session_space_credentials gains the audit columns owner_account_id and
--      agent_session_id (§6c). Visibility of those columns is unchanged (R15).
--   5. SQL guards (§4.3, R4, R5): a BEFORE INSERT trigger refuses a credential
--      entity unless the transaction-local GUC tm8.credential_write is 'on'
--      (read INLINE with current_setting); the only setter is
--      internal.insert_credential_entity, which clears it again on return and
--      in its exception path. tm8_app still has no INSERT on entities (R4a).
--      A deferred link makes the entity and the side row exist together.
--      move/delete/restore refuse the kind (017 re-created), and an envelope
--      trigger (027 pattern) refuses parent/position/visibility/deleted_at/
--      space/kind changes.
--   6. key_hint and display_login leave tm8_app's column grant (R3). They are
--      read only through list_space_credentials / read_space_credential, which
--      mask them by visibility: private, owner only; public, every member
--      (206 picker contract).
--   7. The gate (§3f, R1, R6): the recorder's and repoint's locked predicates
--      gain `visibility = 'public' OR owner_account_id IS NULL OR
--      owner_account_id = <launcher>`; the recorder checks it BEFORE its
--      idempotent return. The reader and usable_space_credential_ids give the
--      same answer early and after commit, with reason `not_usable`.
--   8. set_space_credential_visibility: owner-only; private clears
--      may_be_space_default and is_default in the same statement, and returns
--      the live sessions (spawning included) the caller must kill (§3g).
--   9. Backstops (T10): an account that becomes disabled has its owned
--      credentials revoked in the same statement; a members row whose account
--      still owns a live credential in that space cannot be deleted (the real
--      revoke is G6 member removal, #841).
--  10. Data step: every existing 206 row gets a same-id entity. ADDITIVE ONLY —
--      no existing row is rewritten: the new columns arrive through their
--      defaults (owner null, public), which is today's D1/D3/D11/D12 contract.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The kind.
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('credential', 'core', null, 'key-round')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. space_credentials: ownership and visibility (doc 13 §7).
-- -----------------------------------------------------------------------------
alter table public.space_credentials
  add column owner_account_id uuid references public.accounts(id) on delete restrict,
  add column visibility text not null default 'public',
  add column may_be_space_default boolean not null default false,
  add constraint space_credentials_visibility_check
    check (visibility in ('private', 'public')),
  -- private => owned, and (contrapositive) space-owned => public.
  add constraint space_credentials_private_owned_check
    check (visibility <> 'private' or owner_account_id is not null),
  -- The space default is public, and owned only with the owner's consent (T9).
  add constraint space_credentials_space_default_check
    check (not is_default
           or (visibility = 'public'
               and (owner_account_id is null or may_be_space_default)));

create index space_credentials_owner_idx
  on public.space_credentials(owner_account_id)
  where owner_account_id is not null;

-- R3: the hint and the vendor login leave the column grant. 206 granted them
-- in one grant statement; revoking the two columns leaves the rest in place.
revoke select (key_hint, display_login) on public.space_credentials from tm8_app;
grant select (owner_account_id, visibility, may_be_space_default)
  on public.space_credentials to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. member_defaults: "my default in this space" (§3e). W10b writes it.
-- -----------------------------------------------------------------------------
create table public.member_defaults (
  space_id      uuid not null references public.spaces(id) on delete cascade,
  account_id    uuid not null references public.accounts(id) on delete cascade,
  provider      text not null,
  credential_id uuid not null,
  updated_at    timestamptz not null default now(),
  primary key (space_id, account_id, provider),
  constraint member_defaults_provider_check
    check (provider in ('anthropic', 'openai', 'github')),
  constraint member_defaults_credential_fk
    foreign key (credential_id, space_id)
    references public.space_credentials(id, space_id) on delete cascade
);

create index member_defaults_credential_idx on public.member_defaults(credential_id);

-- A default points at a live credential the account OWNS, for that provider.
create or replace function internal.guard_member_default() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if not exists (select 1 from public.space_credentials sc
                  where sc.id = new.credential_id
                    and sc.space_id = new.space_id
                    and sc.provider = new.provider
                    and sc.owner_account_id = new.account_id
                    and sc.status <> 'revoked') then
    raise exception 'a member default must be a live credential the member owns'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger member_defaults_owned_check
before insert or update on public.member_defaults
for each row execute function internal.guard_member_default();

alter table public.member_defaults enable row level security;
-- Own rows only, and under a pinned session (227) only the pinned space's:
-- the literal pin conjunct, as 227 inlines it, so an agent token minted in
-- space A cannot list its human's defaults in space B.
create policy member_defaults_own_select on public.member_defaults
  for select using (
    account_id = (select internal.current_account_id())
    and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
         or space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid));
grant select (space_id, account_id, provider, credential_id, updated_at)
  on public.member_defaults to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. session_space_credentials: the audit columns (§6c). R15 is recorded as an
--    open question in the PR: these stay member-visible like the rest.
-- -----------------------------------------------------------------------------
alter table public.session_space_credentials
  add column owner_account_id uuid references public.accounts(id) on delete set null,
  add column agent_session_id uuid references public.work_sessions(entity_id) on delete set null;

grant select (owner_account_id, agent_session_id)
  on public.session_space_credentials to tm8_app;

-- -----------------------------------------------------------------------------
-- 5. Entity guards.
-- -----------------------------------------------------------------------------

-- 5a. Only a named writer creates a credential entity. The GUC is read INLINE
-- (task rule; R4): no helper function to re-define underneath the check. Note
-- what actually holds this up (R4a): any role can set a tm8.* placeholder, so
-- the real guarantee is that tm8_app has no INSERT on entities and every
-- generic creation door is a definer function that never sets the flag.
create or replace function internal.guard_credential_entity_insert() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.kind = 'credential'
     and coalesce(current_setting('tm8.credential_write', true), '') <> 'on' then
    raise exception 'credential entities are created only by the credential writers'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger entities_credential_insert_guard
before insert on public.entities
for each row execute function internal.guard_credential_entity_insert();

-- 5b. The envelope is fixed (027:582-601 pattern, R5). A credential cannot
-- move, change visibility, be deleted or restored, change space (the AAD binds
-- the secret to it, §4.4) or change kind; nothing becomes a credential by
-- UPDATE either. The one sanctioned envelope write is the pending-login expiry
-- tombstone, made under the same flag.
create or replace function internal.guard_credential_entity_envelope() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if (old.kind = 'credential' or new.kind = 'credential') and (
       new.kind is distinct from old.kind
    or new.space_id is distinct from old.space_id
    or new.parent_id is distinct from old.parent_id
    or new.position is distinct from old.position
    or new.visibility is distinct from old.visibility
    or new.deleted_at is distinct from old.deleted_at
  ) and coalesce(current_setting('tm8.credential_write', true), '') <> 'on' then
    raise exception 'credential lifecycle is restricted to its named commands'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger entities_credential_restricted_envelope
before update of kind, space_id, parent_id, position, visibility, deleted_at on public.entities
for each row execute function internal.guard_credential_entity_envelope();

-- 5c. The deferred link, entity -> side row. (Side row -> entity is the
-- foreign key added in §10, after the backfill has given every row one.)
-- Checked at commit, so the writer may insert the entity first.
create or replace function internal.check_credential_entity_link() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if not exists (select 1 from public.space_credentials sc
                  where sc.id = new.id and sc.space_id = new.space_id) then
    raise exception 'a credential entity needs its space_credentials row (same id, same space)'
      using errcode = '23503';
  end if;
  return null;
end
$$;

create constraint trigger entities_credential_link
after insert on public.entities
deferrable initially deferred
for each row when (new.kind = 'credential')
execute function internal.check_credential_entity_link();

-- The side row names an entity of kind credential in the same space.
create or replace function internal.check_space_credential_entity() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  select * into e from public.entities where id = new.id;
  if e.id is null then
    return new;  -- the deferred foreign key answers a missing entity at commit
  end if;
  if e.kind <> 'credential' or e.space_id <> new.space_id then
    raise exception 'space credential % must share its id with a credential entity in its space', new.id
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger space_credentials_entity_envelope
before insert or update of id, space_id on public.space_credentials
for each row execute function internal.check_space_credential_entity();

-- 5d. The only setter of tm8.credential_write (R4b). Clears it on return AND
-- in the exception path, so a later statement in the same transaction — a
-- second RPC, a generic helper — never inherits it.
create or replace function internal.insert_credential_entity(
  p_credential_id uuid, p_space_id uuid, p_actor uuid, p_created_at timestamptz default null
) returns void
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform set_config('tm8.credential_write', 'on', true);
  begin
    insert into public.entities(id, space_id, kind, parent_id, position, created_by, created_at)
    values (p_credential_id, p_space_id, 'credential', null, null, p_actor,
            coalesce(p_created_at, now()))
    on conflict (id) do nothing;
  exception when others then
    perform set_config('tm8.credential_write', '', true);
    raise;
  end;
  perform set_config('tm8.credential_write', '', true);
end
$$;

revoke all on function internal.insert_credential_entity(uuid, uuid, uuid, timestamptz) from public;

-- The card follows its side row: a change a reader can see (label, status,
-- visibility, owner, default) bumps the entity, which is what emits the event
-- that refreshes lists. Never the secret columns, never last_used_at.
create or replace function internal.touch_credential_entity() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if (new.label, new.status, new.visibility, new.owner_account_id, new.is_default, new.may_be_space_default)
     is distinct from
     (old.label, old.status, old.visibility, old.owner_account_id, old.is_default, old.may_be_space_default) then
    update public.entities
       set version = version + 1, updated_at = now(), activity_at = now()
     where id = new.id;
  end if;
  -- Revoke deletes the member defaults pointing at it (§7); so does losing
  -- the owner the default belongs to.
  if new.status = 'revoked' or new.owner_account_id is distinct from old.owner_account_id then
    delete from public.member_defaults md
     where md.credential_id = new.id
       and (new.status = 'revoked' or md.account_id is distinct from new.owner_account_id);
  end if;
  return null;
end
$$;

create trigger space_credentials_touch_entity
after update on public.space_credentials
for each row execute function internal.touch_credential_entity();

-- -----------------------------------------------------------------------------
-- 6. Generic lifecycle refuses the kind. 017's bodies (the live definitions,
--    verified: nothing after 017 re-creates them), with 'credential' added to
--    each kind list and nothing else changed.
-- -----------------------------------------------------------------------------
create or replace function public.move_entity(
  p_entity_id uuid, p_parent_id uuid, p_position double precision, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.move'); if replay is not null then return replay; end if;
  select * into e from public.entities where id = p_entity_id and deleted_at is null for update;
  if e.id is null then raise exception 'entity not found' using errcode = 'P0002'; end if;
  perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','work_session','project','interaction_profile','credential') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.entities set parent_id = p_parent_id, position = p_position, version = version + 1,
    updated_at = now(), activity_at = now() where id = p_entity_id;
  insert into public.entity_versions(entity_id,version,snapshot,changed_by)
  select p_entity_id,current.version,internal.entity_snapshot(p_entity_id),actor
    from public.entities current where current.id=p_entity_id
  on conflict(entity_id,version) do nothing;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'moved', null,
    jsonb_build_object('fromParentId',e.parent_id,'toParentId',p_parent_id));
  return internal.ledger_record(p_client_mutation_id, 'entities.move',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id],
      internal.issue_undo_token(e.space_id, actor, 'Undo move', 'entities.move',
        jsonb_build_object('entityId',p_entity_id,'parentId',e.parent_id,'position',e.position,
                           'expectedVersion',e.version + 1))));
end
$$;

create or replace function public.delete_entity(
  p_entity_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; affected uuid[]; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.delete'); if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id); perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','work_session','project','interaction_profile','credential') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  with recursive subtree(id, path, depth) as (
    select p_entity_id, array[p_entity_id], 0
    union all
    select child.id, s.path || child.id, s.depth + 1
      from public.entities child join subtree s on child.parent_id = s.id
     where s.depth < 256 and not child.id = any(s.path)
  )
  select array_agg(distinct s.id) into affected from subtree s join public.entities e2 on e2.id=s.id
   where e2.deleted_at is null;
  update public.entities set deleted_at=now(), updated_at=now()
   where id = any(coalesce(affected,array[]::uuid[]));
  activity_id := internal.record_activity(e.space_id,p_entity_id,actor,'deleted',null,jsonb_build_object('kind',e.kind));
  return internal.ledger_record(p_client_mutation_id,'entities.delete',
    internal.command_result(p_entity_id,null,activity_id,coalesce(affected,array[p_entity_id]),
      internal.issue_undo_token(e.space_id,actor,'Undo delete','entities.restore',jsonb_build_object('entityId',p_entity_id))));
end
$$;

create or replace function public.restore_entity(
  p_entity_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; affected uuid[]; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.restore'); if replay is not null then return replay; end if;
  select * into e from public.entities where id=p_entity_id for update;
  if e.id is null then raise exception 'entity not found' using errcode='P0002'; end if;
  perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','work_session','project','interaction_profile','credential') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  actor := internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor);
  if e.parent_id is not null and exists(select 1 from public.entities p where p.id=e.parent_id and p.deleted_at is not null) then
    raise exception 'restore the parent first' using errcode='23514';
  end if;
  with recursive subtree(id,path,depth) as (
    select p_entity_id,array[p_entity_id],0
    union all
    select child.id,s.path||child.id,s.depth+1 from public.entities child join subtree s on child.parent_id=s.id
     where s.depth<256 and not child.id=any(s.path)
  )
  select array_agg(distinct id) into affected from subtree;
  update public.entities set deleted_at=null,updated_at=now()
   where id=any(coalesce(affected,array[p_entity_id])) and deleted_at is not null;
  activity_id := internal.record_activity(e.space_id,p_entity_id,actor,'restored',null,jsonb_build_object('kind',e.kind));
  return internal.ledger_record(p_client_mutation_id,'entities.restore',
    internal.command_result(p_entity_id,null,activity_id,coalesce(affected,array[p_entity_id])));
end
$$;

-- -----------------------------------------------------------------------------
-- 7. Content hydration. SHARED OBJECT: 209's body VERBATIM (verified: nothing
--    in 210..231 re-creates it) plus one `credential` arm. The card carries
--    the five §3a fields and the label as its title — never key_hint,
--    display_login or a secret column, so entity_versions and export cannot
--    keep them (T1, T34).
--
--    The arm reads a narrow view rather than building the object inline, so
--    it has the shape every other arm has (`to_jsonb(alias) - 'entity_id'
--    from public.<relation> alias`) and entity-content-all-kinds resolves it
--    like any other. The view's column list IS the card: no secret, hint or
--    login column exists in it to leak. Granted to nobody; entity_content
--    reads it as its owner only because its callers are security definer
--    (internal.command_entity, 007:33) — an invoker caller would be refused.
-- -----------------------------------------------------------------------------
create view public.credential_cards as
  select sc.id as entity_id,
         sc.label as title,
         sc.provider,
         sc.shape,
         sc.visibility,
         sc.status,
         sc.owner_account_id as "ownerAccountId"
    from public.space_credentials sc;
revoke all on public.credential_cards from public;

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
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 8. Masking (R3). tm8_app loses its column grant on the hint and the vendor
--    login; they leave SQL only through this predicate: a public row to any
--    member (206's picker contract), a private row to its owner alone.
--    Everyone else gets nulls. Every function that returns
--    space_credential_json now masks through this.
-- -----------------------------------------------------------------------------
create or replace function internal.may_see_space_credential_detail(p public.space_credentials)
returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  -- Public rows keep 206's picker contract (t6-2 / I5): every member sees
  -- the login and hint. A private row shows them to its owner alone.
  select p.visibility = 'public'
      or p.owner_account_id = internal.current_account_id()
$$;

-- 206's body plus the three new fields, with the hint and login masked.
-- STABLE now, not IMMUTABLE: the answer depends on the caller.
create or replace function internal.space_credential_json(p public.space_credentials)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'spaceId', p.space_id, 'provider', p.provider, 'shape', p.shape,
    'label', p.label, 'isDefault', p.is_default, 'status', p.status,
    'createdByAccountId', p.created_by_account_id,
    'ownerAccountId', p.owner_account_id, 'visibility', p.visibility,
    'mayBeSpaceDefault', p.may_be_space_default,
    'displayLogin', case when internal.may_see_space_credential_detail(p) then p.display_login end,
    'keyHint', case when internal.may_see_space_credential_detail(p) then p.key_hint end,
    'pendingExpiresAt', p.pending_expires_at,
    'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'lastUsedAt', p.last_used_at, 'lastProbeAt', p.last_probe_at)
$$;

-- credentials.list's reader (replaces the store's direct select).
create or replace function public.list_space_credentials(p_space_id uuid, p_include_revoked boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare rows jsonb;
begin
  perform internal.require_space_member(p_space_id);
  select coalesce(jsonb_agg(internal.space_credential_json(sc)
                            order by sc.provider, sc.is_default desc, sc.label), '[]'::jsonb)
    into rows
    from public.space_credentials sc
   where sc.space_id = p_space_id
     and (coalesce(p_include_revoked, false) or sc.status <> 'revoked');
  return rows;
end
$$;

-- One card by id, masked; null when absent or not the caller's space.
create or replace function public.read_space_credential(p_credential_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    return null;
  end if;
  return internal.space_credential_json(stored);
end
$$;

-- -----------------------------------------------------------------------------
-- 9. The gate (§3f). "Usable by the launcher" is, everywhere, the one inline
--    predicate:
--      status = 'active' and (visibility = 'public'
--                             or owner_account_id is null
--                             or owner_account_id = <launcher>)
--    where the launcher is internal.current_account_id(): the account that
--    minted the auth session, i.e. the root human (206 header, T3).
-- -----------------------------------------------------------------------------

-- R1: the spawn loop's re-check after commit, before the PTY starts and on
-- resume (replaces the port's bare `status = 'active'` select). Ids the caller
-- cannot see, or may not use, are simply absent from the answer.
create or replace function public.usable_space_credential_ids(p_credential_ids uuid[])
returns uuid[]
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_launcher uuid; ids uuid[];
begin
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    return array[]::uuid[];
  end if;
  select coalesce(array_agg(sc.id order by sc.id), array[]::uuid[]) into ids
    from public.space_credentials sc
   where sc.id = any(coalesce(p_credential_ids, array[]::uuid[]))
     and sc.space_id = any ((select internal.member_space_ids())::uuid[])
     and sc.status = 'active'
     and (sc.visibility = 'public' or sc.owner_account_id is null or sc.owner_account_id = v_launcher);
  return ids;
end
$$;

-- The reader (206 body) gives the error early; it decides nothing the
-- recorder does not decide again under lock.
create or replace function public.read_space_credential_for_spawn(
  p_launch_space_id uuid,
  p_provider text,
  p_credential_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_launcher uuid;
begin
  perform internal.require_space_member(p_launch_space_id);
  v_launcher := internal.current_account_id();

  if p_credential_id is null then
    select * into stored from public.space_credentials
     where space_id = p_launch_space_id and provider = p_provider
       and is_default and status = 'active';
    if stored.id is null then
      raise exception 'this space has no default % credential', p_provider using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'no_default', 'provider', p_provider)::text;
    end if;
  else
    select * into stored from public.space_credentials
     where id = p_credential_id and space_id = p_launch_space_id;
    if stored.id is null or stored.provider is distinct from p_provider then
      raise exception 'space credential not found in this space' using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'not_found', 'provider', p_provider)::text;
    end if;
    if stored.status <> 'active' then
      raise exception 'space credential "%" is %', stored.label, stored.status using errcode = '23514',
        detail = jsonb_build_object('reason', stored.status, 'provider', p_provider)::text;
    end if;
  end if;

  -- The space default is public by constraint, so this only ever refuses a
  -- pinned id; it is checked for both anyway.
  if not (stored.visibility = 'public' or stored.owner_account_id is null
          or stored.owner_account_id = v_launcher) then
    raise exception 'space credential "%" is private to its owner', stored.label using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'shape', stored.shape,
    'label', stored.label,
    'displayLogin', stored.display_login,
    'secretCiphertext', case when stored.shape = 'login' then null else encode(stored.secret_ciphertext, 'base64') end,
    'secretNonce', case when stored.shape = 'login' then null else encode(stored.secret_nonce, 'base64') end
  );
end
$$;

-- The recorder (206 body), with two changes:
--   R6: the credential's usability is checked, under its FOR SHARE lock,
--       BEFORE the idempotent early return — a retry after the owner made the
--       credential private is refused, not waved through.
--   §6c: the row carries the credential's owner and the agent session that
--       asked for the launch (the session's parent work_session, if any).
create or replace function internal.record_session_space_credential(
  p_work_session_id uuid,
  p_provider text,
  p_credential_id uuid
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_launcher uuid;
  inserted integer;
  v_session_space uuid;
  v_session_status text;
  v_credential public.space_credentials;
  v_usable uuid;
begin
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  select sc.id into v_usable
    from public.space_credentials sc
   where sc.id = p_credential_id
     and sc.provider = p_provider
     and sc.status = 'active'
     and (sc.visibility = 'public' or sc.owner_account_id is null or sc.owner_account_id = v_launcher)
     for share of sc;
  if v_usable is null then
    select e.space_id into v_session_space
      from public.entities e where e.id = p_work_session_id and e.deleted_at is null;
    select * into v_credential from public.space_credentials where id = p_credential_id;
    if v_credential.id is null or v_credential.space_id is distinct from v_session_space
       or v_credential.provider is distinct from p_provider then
      raise exception 'space credential is not in this session''s space' using errcode = '42501';
    end if;
    if v_credential.status <> 'active' then
      raise exception 'space credential is %', v_credential.status using errcode = '23514';
    end if;
    raise exception 'space credential "%" is private to its owner', v_credential.label
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;

  -- A2: a retried manifest write (a timed-out write may have committed)
  -- must not fail a spawn that succeeded. The identical row is a no-op;
  -- a DIFFERENT credential for the provider is refused below.
  if exists (select 1 from public.session_space_credentials
              where work_session_id = p_work_session_id and provider = p_provider
                and space_credential_id = p_credential_id) then
    return;
  end if;

  begin
    insert into public.session_space_credentials(
      work_session_id, provider, space_credential_id, space_id, launcher_account_id,
      owner_account_id, agent_session_id)
    select ws.entity_id, sc.provider, sc.id, sc.space_id, v_launcher,
           sc.owner_account_id,
           (select pws.entity_id from public.work_sessions pws
             where pws.entity_id = e.parent_id)
      from public.space_credentials sc
      join public.entities e on e.space_id = sc.space_id
      join public.work_sessions ws on ws.entity_id = e.id
     where sc.id = p_credential_id
       and sc.provider = p_provider
       and sc.status = 'active'
       and (sc.visibility = 'public' or sc.owner_account_id is null or sc.owner_account_id = v_launcher)
       and e.id = p_work_session_id
       and e.kind = 'work_session'
       and e.deleted_at is null
       and ws.status = 'spawning'
       and ws.session_kind = 'agent'
       for share of sc;
    get diagnostics inserted = row_count;
  exception when unique_violation then
    raise exception 'session already records a different % space credential', p_provider
      using errcode = '23505';
  end;

  if inserted = 1 then
    return;
  end if;

  -- Nothing inserted: say which condition failed. These reads only explain a
  -- refusal the insert above already made; they decide nothing.
  select e.space_id, ws.status into v_session_space, v_session_status
    from public.entities e join public.work_sessions ws on ws.entity_id = e.id
   where e.id = p_work_session_id and e.deleted_at is null;
  select * into v_credential from public.space_credentials where id = p_credential_id;
  if v_credential.id is null or v_credential.space_id is distinct from v_session_space
     or v_credential.provider is distinct from p_provider then
    raise exception 'space credential is not in this session''s space' using errcode = '42501';
  end if;
  if v_session_status is distinct from 'spawning' then
    raise exception 'a space credential is recorded only while a session is spawning'
      using errcode = '23514';
  end if;
  raise exception 'space credential is %', v_credential.status using errcode = '23514';
end
$$;

revoke all on function internal.record_session_space_credential(uuid, text, uuid) from public;

-- Resume (206 body): the resumer becomes the launcher, so every recorded
-- credential must be usable BY THE RESUMER, under the same FOR SHARE lock.
-- Inactive answers 23514 as before; active-but-private answers 42501 with
-- reason not_usable, so the spawn can say which.
create or replace function public.repoint_session_space_credentials(p_work_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_launcher uuid;
  v_recorded integer;
  v_active integer;
  v_usable integer;
  rows jsonb;
begin
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  select count(*) into v_recorded from public.session_space_credentials
   where work_session_id = p_work_session_id;
  select count(*),
         count(*) filter (where locked.visibility = 'public' or locked.owner_account_id is null
                                or locked.owner_account_id = v_launcher)
    into v_active, v_usable
    from (
    select sc.id, sc.visibility, sc.owner_account_id from public.space_credentials sc
      join public.session_space_credentials ssc on ssc.space_credential_id = sc.id
     where ssc.work_session_id = p_work_session_id
       and sc.status = 'active'
       and sc.space_id = e.space_id
     order by sc.id
       for share of sc
  ) locked;
  if v_active <> v_recorded then
    raise exception 'a space credential this session launched on is no longer active'
      using errcode = '23514';
  end if;
  if v_usable <> v_recorded then
    raise exception 'a space credential this session launched on is private to its owner'
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable')::text;
  end if;

  update public.session_space_credentials
     set launcher_account_id = v_launcher, updated_at = now()
   where work_session_id = p_work_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', provider, 'spaceCredentialId', space_credential_id)
           order by provider), '[]'::jsonb)
    into rows
    from public.session_space_credentials where work_session_id = p_work_session_id;
  return jsonb_build_object('workSessionId', p_work_session_id,
                            'launcherAccountId', v_launcher, 'credentials', rows);
end
$$;

-- -----------------------------------------------------------------------------
-- 10. The writers now create the entity (206 bodies; the entity insert, before
--     the side row, is the only change). New rows keep today's contract —
--     space-owned and public — until W10b's create takes a visibility.
-- -----------------------------------------------------------------------------
create or replace function public.create_space_credential(
  p_credential_id uuid,
  p_space_id uuid,
  p_provider text,
  p_shape text,
  p_label text,
  p_key_hint text,
  p_secret_ciphertext bytea,
  p_secret_nonce bytea,
  p_display_login text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_credential_id is null then
    raise exception 'a credential id is required: the seal is bound to it' using errcode = '22023';
  end if;
  -- A login is created by start_space_credential_login, never pasted.
  if p_shape is null or p_shape not in ('api_key', 'token') then
    raise exception 'create_space_credential takes an api_key or token; a login starts with start_space_credential_login'
      using errcode = '22023';
  end if;

  -- An id that is already an entity is a collision, not a card to adopt.
  if exists (select 1 from public.entities where id = p_credential_id) then
    raise exception 'credential id is already in use' using errcode = '23505';
  end if;
  perform internal.insert_credential_entity(p_credential_id, p_space_id,
                                            internal.current_member_id(p_space_id));

  insert into public.space_credentials(
    id, space_id, provider, shape, label, status,
    created_by_account_id, created_by_identity_id, display_login,
    key_hint, secret_ciphertext, secret_nonce, last_probe_at
  ) values (
    p_credential_id, p_space_id, p_provider, p_shape, internal.require_space_credential_label(p_label), 'active',
    v_account_id, internal.identity_id(), nullif(btrim(p_display_login), ''),
    p_key_hint, p_secret_ciphertext, p_secret_nonce, now()
  ) returning * into stored;

  perform internal.default_space_credential_if_none(stored.id);
  select * into stored from public.space_credentials where id = stored.id;
  return internal.space_credential_json(stored);
end
$$;

create or replace function public.start_space_credential_login(
  p_space_id uuid,
  p_provider text,
  p_label text default null,
  p_credential_id uuid default null,
  p_ttl_seconds integer default 900,
  p_session_cap integer default 2
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  v_actor uuid;
  v_ttl integer;
  v_session_id uuid;
  v_expires_at timestamptz;
  v_new_id uuid;
  target public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is null or p_provider not in ('anthropic', 'openai') then
    raise exception 'unsupported space login provider' using errcode = '22023';
  end if;

  v_ttl := least(greatest(coalesce(p_ttl_seconds, 900), 60), 1800);
  if internal.credential_session_count(null) >= greatest(coalesce(p_session_cap, 2), 1) then
    raise exception 'credential session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.credential_session_count(null))::text;
  end if;
  v_expires_at := now() + make_interval(secs => v_ttl);
  v_actor := internal.current_member_id(p_space_id);

  if p_credential_id is null then
    -- A NEW login credential (D1: any member). Pending until finish; the
    -- deadline leaves the finish step a margin past the terminal's own expiry.
    -- Its card is created with it, under the id the side row takes.
    v_new_id := internal.new_id();
    perform internal.insert_credential_entity(v_new_id, p_space_id, v_actor);
    insert into public.space_credentials(
      id, space_id, provider, shape, label, status, pending_expires_at,
      created_by_account_id, created_by_identity_id
    ) values (
      v_new_id, p_space_id, p_provider, 'login', internal.require_space_credential_label(p_label), 'pending',
      v_expires_at + interval '5 minutes', v_account_id, internal.identity_id()
    ) returning * into target;
  else
    -- A RE-LOGIN onto an existing credential: D11/M4, creator or admin.
    target := internal.lock_managed_space_credential(p_credential_id);
    if target.space_id <> p_space_id or target.provider <> p_provider then
      raise exception 'space credential not found' using errcode = 'P0002';
    end if;
    if target.shape <> 'login' then
      raise exception 'only a login credential can be logged into; rekey an api key instead'
        using errcode = '22023';
    end if;
    if target.status not in ('active', 'stale') then
      raise exception 'space credential is %', target.status using errcode = '23514';
    end if;
    -- The row lock above serialises re-logins onto this credential, so the
    -- one-live index is never the one to answer. An abandoned terminal is
    -- closed by its opener, or past expires_at by a manager (finish, p_ok
    -- false).
    select expires_at into v_expires_at from public.credential_sessions
     where space_credential_id = target.id and finished_at is null
     order by expires_at desc limit 1;
    if found then
      raise exception 'a login onto this credential is open until %', v_expires_at
        using errcode = '23514',
              detail = jsonb_build_object('reason', 'login_open', 'expiresAt', v_expires_at)::text;
    end if;
    v_expires_at := now() + make_interval(secs => v_ttl);
  end if;

  v_session_id := internal.create_envelope(p_space_id, 'work_session', v_actor, null, null);
  insert into public.work_sessions(entity_id, title, status, share_mode, session_kind)
  values (v_session_id, 'Connect ' || p_provider || ' for the space', 'spawning', 'none', 'credential');
  insert into public.credential_sessions(work_session_id, account_id, provider, expires_at, space_credential_id)
  values (v_session_id, v_account_id, p_provider, v_expires_at, target.id);

  return jsonb_build_object(
    'workSessionId', v_session_id,
    'spaceId', p_space_id,
    'provider', p_provider,
    'expiresAt', v_expires_at,
    'credential', internal.space_credential_json(target)
  );
end
$$;

-- 206 body; an expired pending login's card becomes a tombstone (entities are
-- never hard-deleted), under the flag the envelope guard admits.
create or replace function public.expire_pending_space_credentials()
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare removed integer; expired uuid[];
begin
  with gone as (
    delete from public.space_credentials sc
     where sc.status = 'pending'
       and sc.pending_expires_at < now()
       and not exists (select 1 from public.credential_sessions cs
                        where cs.space_credential_id = sc.id
                          and cs.finished_at is null)
    returning sc.id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into expired from gone;
  removed := coalesce(array_length(expired, 1), 0);
  if removed > 0 then
    perform set_config('tm8.credential_write', 'on', true);
    begin
      update public.entities set deleted_at = now(), updated_at = now()
       where id = any(expired) and kind = 'credential' and deleted_at is null;
    exception when others then
      perform set_config('tm8.credential_write', '', true);
      raise;
    end;
    perform set_config('tm8.credential_write', '', true);
  end if;
  return jsonb_build_object('expired', removed);
end
$$;

-- -----------------------------------------------------------------------------
-- 11. setVisibility (§3g). Owner only — a space-owned credential is always
--     public, and an admin never changes someone else's (§3c). FOR UPDATE, so
--     it serialises against the recorder's and repoint's FOR SHARE. Going
--     private clears may_be_space_default and is_default in the SAME
--     statement, and the answer lists every live session (spawning included,
--     R1) whose launcher is not the owner: the caller kills them after commit.
-- -----------------------------------------------------------------------------
create or replace function public.set_space_credential_visibility(p_credential_id uuid, p_visibility text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  v_account_id uuid;
  kill jsonb;
begin
  perform internal.require_human_auth_kind();
  if p_visibility is null or p_visibility not in ('private', 'public') then
    raise exception 'visibility is private or public' using errcode = '22023';
  end if;
  v_account_id := internal.current_account_id();
  select * into stored from public.space_credentials where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if stored.owner_account_id is null then
    raise exception 'a space-owned credential is always public' using errcode = '22023';
  end if;
  if v_account_id is null or stored.owner_account_id <> v_account_id then
    raise exception 'only the credential''s owner can change its visibility' using errcode = '42501';
  end if;
  if stored.status = 'revoked' then
    raise exception 'space credential is revoked' using errcode = '23514';
  end if;

  update public.space_credentials
     set visibility = p_visibility,
         may_be_space_default = case when p_visibility = 'private' then false else may_be_space_default end,
         is_default = case when p_visibility = 'private' then false else is_default end
   where id = stored.id
  returning * into stored;

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
           'launcherAccountId', ssc.launcher_account_id, 'status', ws.status)
           order by ssc.work_session_id), '[]'::jsonb)
    into kill
    from public.session_space_credentials ssc
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where ssc.space_credential_id = stored.id
     and ws.status in ('spawning', 'running', 'idle')
     and stored.visibility = 'private'
     and ssc.launcher_account_id is distinct from stored.owner_account_id;

  return internal.space_credential_json(stored) || jsonb_build_object('killSessions', kill);
end
$$;

-- -----------------------------------------------------------------------------
-- 12. Backstops (T10).
-- -----------------------------------------------------------------------------

-- An account that becomes disabled has its owned credentials revoked in the
-- same statement, BEFORE anything else observes the disabled account. The
-- revoke fields are delete_space_credential's.
create or replace function internal.revoke_disabled_owner_credentials() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if new.status = 'disabled' and old.status is distinct from 'disabled' then
    update public.space_credentials
       set status = 'revoked',
           is_default = false,
           may_be_space_default = false,
           pending_expires_at = null,
           secret_ciphertext = null,
           secret_nonce = null
     where owner_account_id = new.id
       and status <> 'revoked';
  end if;
  return null;
end
$$;

create trigger accounts_disable_revokes_owned_credentials
after update of status on public.accounts
for each row execute function internal.revoke_disabled_owner_credentials();

-- A member whose account still owns a live credential in the space cannot
-- stop being a member. G6 (232) ends a membership by TOMBSTONE, so the guard
-- sits on the status flip as well as on DELETE; internal.end_membership
-- (section 12b) revokes first, then tombstones. A DELETE cascade from
-- deleting the whole space is admitted — the space row is already gone when
-- the cascade reaches members, and its credentials go with it.
create or replace function internal.guard_member_owned_credentials() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if not (old.status = 'active' and new.status is distinct from 'active') then
      return new;
    end if;
  elsif not exists (select 1 from public.spaces s where s.id = old.space_id) then
    return old;
  end if;
  if exists (select 1 from public.space_credentials sc
               join public.accounts a on a.id = sc.owner_account_id
              where sc.space_id = old.space_id
                and a.identity_id = old.identity_id
                and sc.status <> 'revoked') then
    raise exception 'this member owns live credentials in the space; revoke them before removing the member'
      using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' then
    return new;
  end if;
  return old;
end
$$;

create trigger members_owned_credentials_backstop
before delete on public.members
for each row execute function internal.guard_member_owned_credentials();

create trigger members_owned_credentials_tombstone_backstop
before update of status on public.members
for each row execute function internal.guard_member_owned_credentials();

-- -----------------------------------------------------------------------------
-- 12b. G6 (232, #841): a membership that ends takes the member's owned
--      credentials in that space with it (T41b); an account disable reports
--      the sessions its trigger's revoke strands (section 12).
-- -----------------------------------------------------------------------------

-- Revoke every live credential the account owns in the space, with
-- delete_space_credential's revoke fields; space_credentials_touch_entity
-- drops the member defaults on each. Returns what the TS step after commit
-- must reach:
--   credentialSessionIds  live sessions ANOTHER launcher holds on a credential
--                         the account owns here, whatever its status, so a
--                         retry after a failed kill finds them again. The
--                         account's own launches are 232's stoppedSessionIds;
--   credentialHomes       the file home of each login credential revoked.
-- Ids and provider names only, never a secret column.
create or replace function internal.revoke_member_owned_credentials(p_space_id uuid, p_account_id uuid)
returns jsonb language plpgsql
set search_path = public, internal, pg_temp as $$
declare
  v_sessions uuid[];
  v_homes jsonb;
begin
  if p_account_id is null then
    return jsonb_build_object('credentialSessionIds', '[]'::jsonb, 'credentialHomes', '[]'::jsonb);
  end if;
  with revoked as (
    update public.space_credentials
       set status = 'revoked',
           is_default = false,
           may_be_space_default = false,
           pending_expires_at = null,
           secret_ciphertext = null,
           secret_nonce = null
     where space_id = p_space_id
       and owner_account_id = p_account_id
       and status <> 'revoked'
    returning id, provider, shape
  )
  select coalesce(jsonb_agg(jsonb_build_object('spaceId', p_space_id, 'credentialId', r.id, 'provider', r.provider)
                            order by r.id) filter (where r.shape = 'login'), '[]'::jsonb)
    into v_homes
    from revoked r;
  select coalesce(array_agg(distinct ssc.work_session_id), '{}'::uuid[]) into v_sessions
    from public.session_space_credentials ssc
    join public.space_credentials sc on sc.id = ssc.space_credential_id
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where sc.space_id = p_space_id
     and sc.owner_account_id = p_account_id
     and ssc.launcher_account_id is distinct from p_account_id
     and ws.status in ('spawning', 'running', 'idle');
  return jsonb_build_object('credentialSessionIds', to_jsonb(v_sessions), 'credentialHomes', v_homes);
end
$$;

-- 232's end_membership keeps its body under a new name; leave_space and
-- remove_space_member call this wrapper by the old name. It revokes BEFORE
-- the tombstone (so the backstop above passes) and adds the two lists to the
-- result, which the caller then records in the ledger: a replay returns them.
alter function internal.end_membership(uuid, text, uuid) rename to end_membership_tombstone;

create function internal.end_membership(p_member_id uuid, p_status text, p_actor uuid)
returns jsonb language plpgsql
set search_path = public, internal, pg_temp as $$
declare
  target public.members;
  v_account uuid;
  v_credentials jsonb := jsonb_build_object('credentialSessionIds', '[]'::jsonb, 'credentialHomes', '[]'::jsonb);
begin
  select * into target from public.members where entity_id = p_member_id for update;
  -- Anything else is refused by the tombstone body below, and this
  -- transaction's revoke goes with it.
  if target.entity_id is not null and target.status = 'active' and p_status in ('left', 'removed') then
    select a.id into v_account from public.accounts a where a.identity_id = target.identity_id;
    v_credentials := internal.revoke_member_owned_credentials(target.space_id, v_account);
  end if;
  return internal.end_membership_tombstone(p_member_id, p_status, p_actor) || v_credentials;
end
$$;

-- 232's disable_account likewise keeps its body, moved out of reach of
-- tm8_app. It authorises, replays, disables and revokes the account's auth
-- sessions; the accounts trigger (section 12) revokes every credential the
-- account owns, once, in that same statement. This wrapper runs it FIRST,
-- then lists the other launchers' live sessions on those credentials and the
-- login homes, so nothing is read before the caller is authorised.
-- Both lists are appended AFTER the core's ledger_record, so a replay
-- recomputes them rather than reading them from the ledger, and v_homes names
-- every revoked login the account has ever owned, not only this disable's.
-- Both are idempotent for the caller: a killed session stays stopped, and
-- removing an absent home is a no-op.
alter function public.disable_account(uuid, text) rename to disable_account_core;
alter function public.disable_account_core(uuid, text) set schema internal;

create function public.disable_account(p_account_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  result jsonb;
  v_sessions uuid[];
  v_homes jsonb;
begin
  result := internal.disable_account_core(p_account_id, p_client_mutation_id);
  select coalesce(array_agg(distinct ssc.work_session_id), '{}'::uuid[]) into v_sessions
    from public.session_space_credentials ssc
    join public.space_credentials sc on sc.id = ssc.space_credential_id
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where sc.owner_account_id = p_account_id
     and ssc.launcher_account_id is distinct from p_account_id
     and ws.status in ('spawning', 'running', 'idle');
  select coalesce(jsonb_agg(jsonb_build_object('spaceId', sc.space_id, 'credentialId', sc.id, 'provider', sc.provider)
                            order by sc.id), '[]'::jsonb)
    into v_homes
    from public.space_credentials sc
   where sc.owner_account_id = p_account_id and sc.shape = 'login' and sc.status = 'revoked';
  return result || jsonb_build_object('credentialSessionIds', to_jsonb(v_sessions), 'credentialHomes', v_homes);
end
$$;

-- -----------------------------------------------------------------------------
-- 13. Data step: every existing 206 row gets a same-id card (§7 step 1).
--     ADDITIVE: inserts only, `on conflict do nothing`, so a re-run is a no-op
--     (R11). The rows themselves are untouched — owner null and public came
--     from the column defaults above. The card's author is the creator's
--     member row in that space when there is one, else the space's owner,
--     then an admin, then any member (live before deleted); a space with no
--     member at all cannot hold a credential a member made, and is refused.
--     It ends by asserting that every side row has a same-id card of kind
--     credential in its own space, so an id collision cannot pass silently.
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
  v_actor uuid;
  v_missing bigint;
  v_example text;
begin
  for r in select sc.id, sc.space_id, sc.created_by_account_id, sc.created_at
             from public.space_credentials sc
            where not exists (select 1 from public.entities e where e.id = sc.id)
            order by sc.space_id, sc.id
  loop
    perform pg_advisory_xact_lock(hashtextextended(r.space_id::text, 999));
    v_actor := null;
    select m.entity_id into v_actor
      from public.members m
      join public.accounts a on a.identity_id = m.identity_id
      join public.entities me on me.id = m.entity_id
     where a.id = r.created_by_account_id and m.space_id = r.space_id
     order by me.deleted_at nulls first
     limit 1;
    if v_actor is null then
      select m.entity_id into v_actor
        from public.members m
        join public.entities me on me.id = m.entity_id
       where m.space_id = r.space_id
       order by me.deleted_at nulls first,
                case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
                m.joined_at, m.entity_id
       limit 1;
    end if;
    if v_actor is null then
      raise exception 'space % holds credential % but has no member to author its card', r.space_id, r.id;
    end if;
    perform internal.insert_credential_entity(r.id, r.space_id, v_actor, r.created_at);
  end loop;
  -- The flag is cleared by every insert; say so once more for the migration's
  -- own transaction (R11: "flag reset at end").
  perform set_config('tm8.credential_write', '', true);
  -- The loop skips a row whose id already names an entity, and the FK below
  -- checks only that SOME entity has the id. A pre-existing entity of another
  -- kind, or in another space, sharing a 206 row's id would therefore pass
  -- both silently. Refuse it here instead: every side row must end with a
  -- same-id card of kind credential in its own space. Ids only, never a
  -- secret column.
  select count(*), min(sc.id::text) into v_missing, v_example
    from public.space_credentials sc
   where not exists (select 1 from public.entities e
                      where e.id = sc.id and e.kind = 'credential' and e.space_id = sc.space_id);
  if v_missing > 0 then
    raise exception '% space credential row(s) lack a credential card in their own space (e.g. %)',
      v_missing, v_example;
  end if;
end
$$;

-- Every side row now has its card (pending ones included), so the
-- side -> entity half of the link can be declared; ADD validates it.
alter table public.space_credentials
  add constraint space_credentials_entity_fk
  foreign key (id) references public.entities(id)
  deferrable initially deferred;

-- -----------------------------------------------------------------------------
-- 14. Grants. Revoked from public; tm8_app gets exactly the new RPCs. The
--     internal helpers are granted to nobody.
-- -----------------------------------------------------------------------------
revoke all on function internal.guard_member_default() from public;
revoke all on function internal.guard_credential_entity_insert() from public;
revoke all on function internal.guard_credential_entity_envelope() from public;
revoke all on function internal.check_credential_entity_link() from public;
revoke all on function internal.check_space_credential_entity() from public;
revoke all on function internal.touch_credential_entity() from public;
revoke all on function internal.may_see_space_credential_detail(public.space_credentials) from public;
revoke all on function internal.space_credential_json(public.space_credentials) from public;
revoke all on function internal.revoke_disabled_owner_credentials() from public;
revoke all on function internal.guard_member_owned_credentials() from public;
revoke all on function internal.revoke_member_owned_credentials(uuid, uuid) from public;
revoke all on function internal.end_membership(uuid, text, uuid) from public;
revoke all on function internal.disable_account_core(uuid, text) from public, tm8_app;

revoke all on function public.list_space_credentials(uuid, boolean) from public;
revoke all on function public.read_space_credential(uuid) from public;
revoke all on function public.usable_space_credential_ids(uuid[]) from public;
revoke all on function public.set_space_credential_visibility(uuid, text) from public;
grant execute on function public.list_space_credentials(uuid, boolean) to tm8_app;
grant execute on function public.read_space_credential(uuid) to tm8_app;
grant execute on function public.usable_space_credential_ids(uuid[]) to tm8_app;
grant execute on function public.set_space_credential_visibility(uuid, text) to tm8_app;
revoke all on function public.disable_account(uuid, text) from public;
grant execute on function public.disable_account(uuid, text) to tm8_app;

-- A fresh table is estimated at 10 pages until analyzed (225); do it here.
analyze public.member_defaults;

reset role;
