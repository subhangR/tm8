-- Vault data is isolated from the graph and the application role.
-- Timestamps have no SQL clock defaults: every value comes from the broker clock.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'tm8_vault_owner') then
    create role tm8_vault_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tm8_vault_broker') then
    create role tm8_vault_broker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tm8_vault_audit_writer') then
    create role tm8_vault_audit_writer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  execute format('grant tm8_vault_owner, tm8_vault_audit_writer to %I', current_user);
end
$roles$;
create schema vault authorization tm8_vault_owner;
revoke all on schema vault from public, tm8_app;
grant usage on schema vault to tm8_vault_broker, tm8_vault_audit_writer;
set role tm8_vault_owner;
alter default privileges in schema vault revoke all on tables from public;
alter default privileges in schema vault revoke all on functions from public;
alter default privileges in schema vault revoke all on sequences from public;

create function vault.member_id() returns uuid language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('vault.member_id', true), '')::uuid
$$;
create function vault.space_id() returns uuid language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('vault.space_id', true), '')::uuid
$$;
create function vault.scope_time() returns timestamptz language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('vault.at', true), '')::timestamptz
$$;
create function vault.is_system() returns boolean language sql stable set search_path = pg_catalog as $$
  select coalesce(current_setting('vault.system_purpose', true) in ('reconcile','expire','audit','deletion_ledger','enrollment','cleanup'), false)
$$;

create table vault.items (
  id uuid primary key, space_id uuid not null, owner_member_id uuid not null,
  version integer not null check (version >= 1),
  type text not null check (type in ('login','api_key','card','note','identity')),
  name text not null, state text not null check (state in ('active','blocked_until_rotated','tombstoned')),
  exposure_tier text check (exposure_tier in ('a','b','c')), origins text[] not null,
  dev_mode boolean not null, username text, last4 text check (last4 ~ '^[0-9]{4}$'),
  exp_month integer check (exp_month between 1 and 12), exp_year integer check (exp_year between 1970 and 9999),
  connector text, has_totp boolean not null, has_notes boolean not null, field_names text[] not null,
  secret_version integer not null check (secret_version >= 1),
  created_at timestamptz(3) not null, updated_at timestamptz(3) not null,
  rotated_at timestamptz(3), tombstoned_at timestamptz(3), created_by jsonb not null,
  check ((state = 'tombstoned') = (tombstoned_at is not null)),
  check (type = 'login' or cardinality(origins) = 0)
);
create index items_owner on vault.items(space_id, owner_member_id, created_at desc, id desc);
create table vault.secret_versions (
  item_id uuid not null references vault.items(id) deferrable initially deferred,
  version integer not null check (version >= 1), suite text not null check (suite = 'A256GCM'),
  kek_id text not null, wrapped_dek bytea not null, nonce bytea not null, ciphertext bytea not null,
  created_at timestamptz(3) not null, primary key (item_id, version),
  check (octet_length(wrapped_dek) > 0 and octet_length(nonce) > 0 and octet_length(ciphertext) > 0)
);
create table vault.broker_policies (
  item_id uuid primary key references vault.items(id), version integer not null check (version >= 1),
  mode text not null check (mode in ('connector','generic')), connector text,
  hosts text[] not null, methods text[] not null, path_prefixes text[] not null,
  max_request_bytes integer not null check (max_request_bytes >= 0),
  max_response_bytes integer not null check (max_response_bytes >= 0), injection jsonb not null,
  created_at timestamptz(3) not null, created_by jsonb not null
);
create table vault.origin_bindings (
  item_id uuid not null references vault.items(id), origin text not null, primary key(item_id, origin)
);
create table vault.grants (
  id uuid primary key, item_id uuid not null references vault.items(id), space_id uuid not null,
  grantee_kind text not null check (grantee_kind in ('space','member')), grantee_id uuid not null,
  constraints jsonb not null, expires_at timestamptz(3), created_at timestamptz(3) not null,
  created_by jsonb not null, revoked_at timestamptz(3), revoked_by jsonb
);
create index grants_item on vault.grants(item_id);
create index grants_scope on vault.grants(space_id, grantee_kind, grantee_id);
create table vault.approvals (
  id uuid primary key, item_id uuid not null references vault.items(id), space_id uuid not null,
  owner_member_id uuid not null, kind text not null check (kind in ('use','new_origin','spend')),
  state text not null check (state in ('pending','approved','denied','expired','consumed')),
  one_use boolean not null, intent_hash text not null check (intent_hash ~ '^[0-9a-f]{64}$'),
  bound_params jsonb not null, requested_by jsonb not null, requester_member_id uuid not null,
  purpose text, lookalike jsonb not null, spend jsonb, operation_id uuid,
  created_at timestamptz(3) not null, expires_at timestamptz(3) not null,
  decided_at timestamptz(3), decided_by jsonb, standing boolean not null,
  consumed_at timestamptz(3), consumed_by_operation_id uuid,
  check ((kind = 'spend') = (spend is not null)),
  check (not standing or (kind = 'new_origin' and state = 'approved' and not one_use))
);
create index approvals_scope on vault.approvals(space_id, requester_member_id, item_id);
create table vault.operations (
  operation_id uuid not null, member_id uuid not null, space_id uuid not null,
  kind text not null check (kind in ('fill','call_api','spend')), item_id uuid not null,
  intent_hash text not null check (intent_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('in_progress','done','refused','approval_required','unknown')),
  result jsonb, approval_id uuid, actor jsonb not null,
  created_at timestamptz(3) not null, completed_at timestamptz(3), primary key(member_id, operation_id)
);
create table vault.spend_requests (
  approval_id uuid primary key references vault.approvals(id), item_id uuid not null references vault.items(id),
  merchant text not null, amount_minor bigint not null check (amount_minor > 0), currency text not null,
  item_summary text not null, instrument_tier text not null check (instrument_tier = 'tier1'),
  evidence jsonb, created_at timestamptz(3) not null, executed_at timestamptz(3), processor_ref text
);
create table vault.passkeys (
  id uuid primary key, member_id uuid not null, credential_id text not null unique, public_key text not null,
  counter bigint not null check (counter >= 0), transports text[] not null, backed_up boolean not null,
  device_type text not null check (device_type in ('singleDevice','multiDevice')), aaguid text, name text not null,
  created_at timestamptz(3) not null, last_used_at timestamptz(3), revoked_at timestamptz(3)
);
create table vault.vault_sessions (
  id uuid primary key, member_id uuid not null, passkey_id uuid not null references vault.passkeys(id),
  device_label text, token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  refresh_hash text not null unique check (refresh_hash ~ '^[0-9a-f]{64}$'),
  refresh_version integer not null check (refresh_version >= 1),
  created_at timestamptz(3) not null, last_used_at timestamptz(3) not null,
  expires_at timestamptz(3) not null, refresh_expires_at timestamptz(3) not null, family_expires_at timestamptz(3) not null,
  revoked_at timestamptz(3), revoked_reason text check (revoked_reason in ('ended','revoked','refresh_reuse','recovery','passkey_revoked','expired')),
  check (token_hash <> refresh_hash)
);
create table vault.superseded_refresh (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'), session_id uuid not null references vault.vault_sessions(id)
);
-- Global collision registry: hidden members' token hashes remain unique, too.
create table vault.session_hashes (hash text primary key, session_id uuid not null);
create table vault.challenges (
  id uuid primary key, member_id uuid not null,
  purpose text not null check (purpose in ('sign_in','step_up','registration')),
  action text, intent_hash text check (intent_hash ~ '^[0-9a-f]{64}$'), challenge text not null,
  registration jsonb, created_at timestamptz(3) not null, expires_at timestamptz(3) not null, consumed_at timestamptz(3),
  check ((purpose = 'step_up' and action is not null and intent_hash is not null and registration is null)
      or (purpose = 'registration' and action is null and intent_hash is null and registration is not null)
      or (purpose = 'sign_in' and action is null and intent_hash is null and registration is null))
);
create table vault.recovery_codes (
  id uuid primary key, member_id uuid not null, hash text not null check (hash like '$argon2id$%'),
  created_at timestamptz(3) not null, used_at timestamptz(3)
);
create table vault.enrollment_codes (
  id uuid primary key, member_id uuid not null, space_id uuid not null, hash text not null check (hash like '$argon2id$%'),
  expires_at timestamptz(3) not null, minted_by text not null, created_at timestamptz(3) not null, used_at timestamptz(3)
);
create table vault.capture_links (
  id uuid primary key, member_id uuid not null, space_id uuid not null,
  item_type text not null check (item_type in ('login','api_key','card','note','identity')),
  purpose text not null check (purpose in ('create','replace')), item_id uuid references vault.items(id), name text,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'), capture_kid text not null,
  created_at timestamptz(3) not null, expires_at timestamptz(3) not null,
  opened_at timestamptz(3), consumed_at timestamptz(3), created_by jsonb not null,
  check ((purpose = 'replace') = (item_id is not null))
);
create table vault.deletion_ledger (
  item_id uuid primary key, space_id uuid not null, owner_member_id uuid not null, tombstoned_at timestamptz(3) not null
);
create table vault.audit_head (
  singleton boolean primary key check (singleton), seq bigint not null check (seq >= 0),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'), at timestamptz(3)
);
insert into vault.audit_head values (true, 0, repeat('0',64), null);
create table vault.audit_events (
  seq bigint primary key check (seq > 0), at timestamptz(3) not null,
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'), entry_hash text not null check (entry_hash ~ '^[0-9a-f]{64}$'),
  body_text text not null, action text not null, actor jsonb not null, item_id uuid,
  subject_member_id uuid, space_id uuid, params jsonb not null
);
create index audit_subject on vault.audit_events(subject_member_id, seq desc);
create index audit_item on vault.audit_events(item_id, seq desc);
create table vault.checkpoints (
  ordinal bigint generated always as identity primary key, seq bigint not null check (seq >= 0),
  head_hash text not null check (head_hash ~ '^[0-9a-f]{64}$'), at timestamptz(3) not null,
  sink text not null check (sink in ('off','file','gcs')), anchored boolean not null, location text, key_id text, signature text
);

create function vault.owns_item(p_id uuid) returns boolean language sql stable security definer
set search_path = pg_catalog, vault as $$
  select vault.is_system() or exists (select 1 from vault.items i where i.id = p_id and i.owner_member_id = vault.member_id() and i.space_id = vault.space_id())
$$;
create function vault.sees_item(p_id uuid) returns boolean language sql stable security definer
set search_path = pg_catalog, vault as $$
  select vault.is_system() or exists (
    select 1 from vault.items i where i.id = p_id and i.space_id = vault.space_id() and
      (i.owner_member_id = vault.member_id() or exists (
        select 1 from vault.grants g where g.item_id = i.id and g.space_id = vault.space_id()
          and g.revoked_at is null and (g.expires_at is null or g.expires_at > vault.scope_time())
          and ((g.grantee_kind = 'member' and g.grantee_id = vault.member_id()) or (g.grantee_kind = 'space' and g.grantee_id = vault.space_id())))))
$$;
create function vault.sees_approval(p_id uuid) returns boolean language sql stable security definer
set search_path = pg_catalog, vault as $$
  select vault.is_system() or exists (select 1 from vault.approvals a where a.id = p_id and a.space_id = vault.space_id()
    and (a.owner_member_id = vault.member_id() or a.requester_member_id = vault.member_id()))
$$;
create function vault.hash_in_use(p_hash text) returns boolean language sql stable security definer
set search_path = pg_catalog, vault as $$ select exists (select 1 from vault.session_hashes where hash = p_hash) $$;
-- Count-only and global for the repeated-fill-failure alert. RLS shows a grantee
-- only its own audit events, so a read through it would let failures spread over
-- several requesters stay under the threshold. Only the integer leaves; an item
-- the caller cannot see counts 0.
create function vault.fill_failure_streak(p_item uuid, p_origin text) returns integer language sql stable security definer
set search_path = pg_catalog, vault as $$
  select case when not vault.sees_item(p_item) then 0 else (
    select count(*)::integer from vault.audit_events e
    where e.item_id = p_item and e.action = 'fill.refused'
      and e.params->>'origin' = p_origin and e.params->'attempted' = 'true'::jsonb
      and e.seq > coalesce((select max(d.seq) from vault.audit_events d
        where d.item_id = p_item and d.action = 'fill.done'
          and d.params->>'origin' = p_origin and d.params->'attempted' = 'true'::jsonb), 0)) end
$$;

create function vault.sync_session_hashes() returns trigger language plpgsql security definer
set search_path = pg_catalog, vault as $$
begin
  if tg_op = 'UPDATE' and new.token_hash = old.token_hash and new.refresh_hash = old.refresh_hash then return new; end if;
  if tg_op = 'UPDATE' then
    delete from vault.session_hashes where hash = old.token_hash and session_id = old.id;
  end if;
  insert into vault.session_hashes values (new.token_hash, new.id), (new.refresh_hash, new.id);
  return new;
end $$;
create trigger session_hashes before insert or update on vault.vault_sessions for each row execute function vault.sync_session_hashes();
create function vault.sync_origins() returns trigger language plpgsql security definer
set search_path = pg_catalog, vault as $$
begin
  delete from vault.origin_bindings where item_id = new.id;
  insert into vault.origin_bindings select new.id, unnest(new.origins);
  return new;
end $$;
create trigger item_origins after insert or update of origins on vault.items for each row execute function vault.sync_origins();

create function vault.terminal_state_guard() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_table_name = 'items' and old.state = 'tombstoned' and new.state <> old.state then
    raise exception 'vault: terminal item state' using errcode = '23514';
  elsif tg_table_name = 'approvals' and new.state <> old.state then
    if not ((old.state = 'pending' and new.state in ('approved','denied','expired'))
      or (old.state = 'approved' and old.one_use and new.state in ('consumed','expired'))) then
      raise exception 'vault: terminal approval state' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger item_state before update on vault.items for each row execute function vault.terminal_state_guard();
create trigger approval_state before update on vault.approvals for each row execute function vault.terminal_state_guard();

-- The schema owner cannot append directly: only the separate definer role can.
create function vault.audit_immutable() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'INSERT' and current_user = 'tm8_vault_audit_writer' then return new; end if;
  raise exception 'vault: audit is append only' using errcode = '42501';
end $$;
create trigger audit_append_only before insert or update or delete on vault.audit_events for each row execute function vault.audit_immutable();
create trigger audit_no_truncate before truncate on vault.audit_events for each statement execute function vault.audit_immutable();

create function vault.append_audit(p_body_text text, p_at timestamptz) returns vault.audit_events
language plpgsql security definer set search_path = pg_catalog, vault as $$
declare h vault.audit_head; e vault.audit_events; b jsonb; at_text text;
begin
  if p_at is null or not isfinite(p_at) then raise exception 'vault: invalid audit time'; end if;
  select * into strict h from vault.audit_head where singleton for update;
  b := p_body_text::jsonb;
  e.seq := h.seq + 1;
  e.at := greatest(date_trunc('milliseconds', p_at), h.at);
  at_text := to_char(e.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  e.prev_hash := h.hash;
  e.body_text := p_body_text;
  e.entry_hash := encode(sha256(convert_to('tm8-vault-audit|v1|' || e.seq::text || '|' || e.prev_hash || '|' || at_text || '|' || p_body_text, 'UTF8')), 'hex');
  e.action := b->>'action'; e.actor := b->'actor'; e.item_id := (b->>'itemId')::uuid;
  e.subject_member_id := (b->>'subjectMemberId')::uuid; e.space_id := (b->>'spaceId')::uuid; e.params := b->'params';
  insert into vault.audit_events select e.*;
  update vault.audit_head set seq = e.seq, hash = e.entry_hash, at = e.at where singleton;
  return e;
end $$;
reset role;
alter function vault.append_audit(text, timestamptz) owner to tm8_vault_audit_writer;
set role tm8_vault_owner;
grant select, update on vault.audit_head to tm8_vault_audit_writer;
grant insert on vault.audit_events to tm8_vault_audit_writer;

alter table vault.items enable row level security;
create policy items_read on vault.items for select to tm8_vault_broker using (vault.is_system() or (space_id = vault.space_id() and owner_member_id = vault.member_id()) or vault.sees_item(id));
create policy items_insert on vault.items for insert to tm8_vault_broker with check (vault.is_system() or (space_id = vault.space_id() and owner_member_id = vault.member_id()));
create policy items_update on vault.items for update to tm8_vault_broker using (vault.is_system() or (space_id = vault.space_id() and owner_member_id = vault.member_id())) with check (vault.is_system() or (space_id = vault.space_id() and owner_member_id = vault.member_id()));
create policy items_delete on vault.items for delete to tm8_vault_broker using (vault.is_system() or (space_id = vault.space_id() and owner_member_id = vault.member_id()));
grant select, insert, update, delete on vault.items to tm8_vault_broker;
alter table vault.secret_versions enable row level security;
create policy secret_versions_read on vault.secret_versions for select to tm8_vault_broker using (vault.sees_item(item_id));
create policy secret_versions_insert on vault.secret_versions for insert to tm8_vault_broker with check (vault.owns_item(item_id));
create policy secret_versions_update on vault.secret_versions for update to tm8_vault_broker using (vault.owns_item(item_id)) with check (vault.owns_item(item_id));
create policy secret_versions_delete on vault.secret_versions for delete to tm8_vault_broker using (vault.owns_item(item_id));
grant select, insert, update, delete on vault.secret_versions to tm8_vault_broker;
alter table vault.broker_policies enable row level security;
create policy broker_policies_read on vault.broker_policies for select to tm8_vault_broker using (vault.sees_item(item_id));
create policy broker_policies_insert on vault.broker_policies for insert to tm8_vault_broker with check (vault.owns_item(item_id));
create policy broker_policies_update on vault.broker_policies for update to tm8_vault_broker using (vault.owns_item(item_id)) with check (vault.owns_item(item_id));
create policy broker_policies_delete on vault.broker_policies for delete to tm8_vault_broker using (vault.owns_item(item_id));
grant select, insert, update, delete on vault.broker_policies to tm8_vault_broker;
alter table vault.origin_bindings enable row level security;
create policy origin_bindings_read on vault.origin_bindings for select to tm8_vault_broker using (vault.sees_item(item_id));
create policy origin_bindings_insert on vault.origin_bindings for insert to tm8_vault_broker with check (vault.owns_item(item_id));
create policy origin_bindings_update on vault.origin_bindings for update to tm8_vault_broker using (vault.owns_item(item_id)) with check (vault.owns_item(item_id));
create policy origin_bindings_delete on vault.origin_bindings for delete to tm8_vault_broker using (vault.owns_item(item_id));
grant select, insert, update, delete on vault.origin_bindings to tm8_vault_broker;
alter table vault.grants enable row level security;
create policy grants_read on vault.grants for select to tm8_vault_broker using (vault.is_system() or (space_id = vault.space_id() and (vault.owns_item(item_id) or (grantee_kind = 'member' and grantee_id = vault.member_id()) or (grantee_kind = 'space' and grantee_id = vault.space_id()))));
create policy grants_insert on vault.grants for insert to tm8_vault_broker with check (vault.owns_item(item_id));
create policy grants_update on vault.grants for update to tm8_vault_broker using (vault.owns_item(item_id)) with check (vault.owns_item(item_id));
create policy grants_delete on vault.grants for delete to tm8_vault_broker using (vault.owns_item(item_id));
grant select, insert, update, delete on vault.grants to tm8_vault_broker;
alter table vault.approvals enable row level security;
create policy approvals_read on vault.approvals for select to tm8_vault_broker using (vault.is_system() or (space_id = vault.space_id() and (owner_member_id = vault.member_id() or requester_member_id = vault.member_id())));
create policy approvals_insert on vault.approvals for insert to tm8_vault_broker with check (vault.is_system() or (space_id = vault.space_id() and (owner_member_id = vault.member_id() or requester_member_id = vault.member_id())));
create policy approvals_update on vault.approvals for update to tm8_vault_broker using (vault.is_system() or (space_id = vault.space_id() and (owner_member_id = vault.member_id() or requester_member_id = vault.member_id()))) with check (vault.is_system() or (space_id = vault.space_id() and (owner_member_id = vault.member_id() or requester_member_id = vault.member_id())));
create policy approvals_delete on vault.approvals for delete to tm8_vault_broker using (vault.is_system() or (space_id = vault.space_id() and (owner_member_id = vault.member_id() or requester_member_id = vault.member_id())));
grant select, insert, update, delete on vault.approvals to tm8_vault_broker;
alter table vault.operations enable row level security;
create policy operations_read on vault.operations for select to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
create policy operations_insert on vault.operations for insert to tm8_vault_broker with check (vault.is_system() or member_id = vault.member_id());
create policy operations_update on vault.operations for update to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id()) with check (vault.is_system() or member_id = vault.member_id());
create policy operations_delete on vault.operations for delete to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
grant select, insert, update, delete on vault.operations to tm8_vault_broker;
alter table vault.spend_requests enable row level security;
create policy spend_requests_read on vault.spend_requests for select to tm8_vault_broker using (vault.sees_approval(approval_id));
create policy spend_requests_insert on vault.spend_requests for insert to tm8_vault_broker with check (vault.sees_approval(approval_id));
create policy spend_requests_update on vault.spend_requests for update to tm8_vault_broker using (vault.sees_approval(approval_id)) with check (vault.sees_approval(approval_id));
create policy spend_requests_delete on vault.spend_requests for delete to tm8_vault_broker using (vault.sees_approval(approval_id));
grant select, insert, update, delete on vault.spend_requests to tm8_vault_broker;
alter table vault.passkeys enable row level security;
create policy passkeys_read on vault.passkeys for select to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
create policy passkeys_insert on vault.passkeys for insert to tm8_vault_broker with check (vault.is_system() or member_id = vault.member_id());
create policy passkeys_update on vault.passkeys for update to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id()) with check (vault.is_system() or member_id = vault.member_id());
create policy passkeys_delete on vault.passkeys for delete to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
grant select, insert, update, delete on vault.passkeys to tm8_vault_broker;
alter table vault.vault_sessions enable row level security;
create policy vault_sessions_read on vault.vault_sessions for select to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
create policy vault_sessions_insert on vault.vault_sessions for insert to tm8_vault_broker with check (vault.is_system() or member_id = vault.member_id());
create policy vault_sessions_update on vault.vault_sessions for update to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id()) with check (vault.is_system() or member_id = vault.member_id());
create policy vault_sessions_delete on vault.vault_sessions for delete to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
grant select, insert, update, delete on vault.vault_sessions to tm8_vault_broker;
alter table vault.superseded_refresh enable row level security;
create policy superseded_refresh_read on vault.superseded_refresh for select to tm8_vault_broker using (vault.is_system() or exists (select 1 from vault.vault_sessions s where s.id = session_id and s.member_id = vault.member_id()));
create policy superseded_refresh_insert on vault.superseded_refresh for insert to tm8_vault_broker with check (vault.is_system() or exists (select 1 from vault.vault_sessions s where s.id = session_id and s.member_id = vault.member_id()));
create policy superseded_refresh_update on vault.superseded_refresh for update to tm8_vault_broker using (vault.is_system() or exists (select 1 from vault.vault_sessions s where s.id = session_id and s.member_id = vault.member_id())) with check (vault.is_system() or exists (select 1 from vault.vault_sessions s where s.id = session_id and s.member_id = vault.member_id()));
create policy superseded_refresh_delete on vault.superseded_refresh for delete to tm8_vault_broker using (vault.is_system() or exists (select 1 from vault.vault_sessions s where s.id = session_id and s.member_id = vault.member_id()));
grant select, insert, update, delete on vault.superseded_refresh to tm8_vault_broker;
alter table vault.challenges enable row level security;
create policy challenges_read on vault.challenges for select to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
create policy challenges_insert on vault.challenges for insert to tm8_vault_broker with check (vault.is_system() or member_id = vault.member_id());
create policy challenges_update on vault.challenges for update to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id()) with check (vault.is_system() or member_id = vault.member_id());
create policy challenges_delete on vault.challenges for delete to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
grant select, insert, update, delete on vault.challenges to tm8_vault_broker;
alter table vault.recovery_codes enable row level security;
create policy recovery_codes_read on vault.recovery_codes for select to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
create policy recovery_codes_insert on vault.recovery_codes for insert to tm8_vault_broker with check (vault.is_system() or member_id = vault.member_id());
create policy recovery_codes_update on vault.recovery_codes for update to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id()) with check (vault.is_system() or member_id = vault.member_id());
create policy recovery_codes_delete on vault.recovery_codes for delete to tm8_vault_broker using (vault.is_system() or member_id = vault.member_id());
grant select, insert, update, delete on vault.recovery_codes to tm8_vault_broker;
alter table vault.enrollment_codes enable row level security;
create policy enrollment_codes_read on vault.enrollment_codes for select to tm8_vault_broker using (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id()));
create policy enrollment_codes_insert on vault.enrollment_codes for insert to tm8_vault_broker with check (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id()));
create policy enrollment_codes_update on vault.enrollment_codes for update to tm8_vault_broker using (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id())) with check (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id()));
create policy enrollment_codes_delete on vault.enrollment_codes for delete to tm8_vault_broker using (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id()));
grant select, insert, update, delete on vault.enrollment_codes to tm8_vault_broker;
alter table vault.capture_links enable row level security;
create policy capture_links_read on vault.capture_links for select to tm8_vault_broker using (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id()));
create policy capture_links_insert on vault.capture_links for insert to tm8_vault_broker with check (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id()));
create policy capture_links_update on vault.capture_links for update to tm8_vault_broker using (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id())) with check (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id()));
create policy capture_links_delete on vault.capture_links for delete to tm8_vault_broker using (vault.is_system() or (member_id = vault.member_id() and space_id = vault.space_id()));
grant select, insert, update, delete on vault.capture_links to tm8_vault_broker;
alter table vault.deletion_ledger enable row level security;
create policy deletion_ledger_read on vault.deletion_ledger for select to tm8_vault_broker using (vault.is_system() or (space_id = vault.space_id() and owner_member_id = vault.member_id()));
create policy deletion_ledger_insert on vault.deletion_ledger for insert to tm8_vault_broker with check (vault.is_system() or vault.owns_item(item_id));
create policy deletion_ledger_update on vault.deletion_ledger for update to tm8_vault_broker using (vault.is_system() or vault.owns_item(item_id)) with check (vault.is_system() or vault.owns_item(item_id));
create policy deletion_ledger_delete on vault.deletion_ledger for delete to tm8_vault_broker using (vault.is_system() or vault.owns_item(item_id));
grant select, insert, update, delete on vault.deletion_ledger to tm8_vault_broker;
alter table vault.checkpoints enable row level security;
create policy checkpoints_read on vault.checkpoints for select to tm8_vault_broker using (true);
create policy checkpoints_insert on vault.checkpoints for insert to tm8_vault_broker with check (vault.is_system());
create policy checkpoints_update on vault.checkpoints for update to tm8_vault_broker using (vault.is_system()) with check (vault.is_system());
create policy checkpoints_delete on vault.checkpoints for delete to tm8_vault_broker using (vault.is_system());
grant select, insert, update, delete on vault.checkpoints to tm8_vault_broker;
alter table vault.audit_events enable row level security;
create policy audit_events_read on vault.audit_events for select to tm8_vault_broker using (vault.is_system() or subject_member_id = vault.member_id() or (vault.sees_item(item_id) and (vault.owns_item(item_id) or actor->>'memberId' = vault.member_id()::text)));
grant select on vault.audit_events to tm8_vault_broker;
grant select on vault.audit_head to tm8_vault_broker;
grant usage on sequence vault.checkpoints_ordinal_seq to tm8_vault_broker;
revoke all on all functions in schema vault from public, tm8_app;
grant execute on function vault.member_id(), vault.space_id(), vault.scope_time(), vault.is_system(), vault.owns_item(uuid), vault.sees_item(uuid), vault.sees_approval(uuid), vault.hash_in_use(text), vault.fill_failure_streak(uuid, text) to tm8_vault_broker;
-- Audit writer needs no RLS bypass: its insert policy is narrow and has no read grant.
create policy audit_writer_insert on vault.audit_events for insert to tm8_vault_audit_writer with check (true);
reset role;

set role tm8_vault_audit_writer;
revoke all on function vault.append_audit(text,timestamptz) from public, tm8_app;
grant execute on function vault.append_audit(text,timestamptz) to tm8_vault_broker;
reset role;
