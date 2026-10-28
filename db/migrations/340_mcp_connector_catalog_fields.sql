-- =============================================================================
-- 340: MCP connector definition fields for the Connectors programme (plan §5.1).
--
-- Six new definition keys, all optional so every definition already stored stays
-- valid:
--
--   catalogId            the Discover preset the connector came from
--   serverKey            the readable tool prefix (§4.2); `mcp__gmail__search`
--                        instead of `mcp__connector_<32 hex>__search`
--   defaultOn            new chats and launches start with it on (§7.3)
--   allowExternalClients external MCP tokens may see it (D8/D9, P4)
--   firstParty           served by tm8's own connector host
--   gates                per-connector tool gates, e.g. {"gmailSend": false}
--
-- SECURITY REVISION (§5.1). `firstParty` and `gates` change what a connection
-- is consent for, so both enter internal.mcp_security_fingerprint_json: editing
-- either bumps mcp_security_revision and forces a reconnect. The other four are
-- presentation and routing, and are deliberately NOT in the fingerprint — a
-- rename of the tool prefix must not revoke everybody's Gmail connection.
--
-- WHY THE RE-STAMP. Redefining mcp_security_fingerprint_json changes the hash of
-- EVERY definition, including ones nobody edited, so every
-- space_credentials.mcp_definition_fingerprint stamped before this migration
-- would stop matching and every live MCP connection would read as
-- `credential_definition_changed`.
--
-- The re-stamp is in two halves around the redefinition, so it can never bless a
-- row that was already stale for ANY reason, not just a fingerprint mismatch:
-- the first half records the ids that are valid under the OLD function (both the
-- fingerprint AND the revision match), and the last statement re-stamps exactly
-- those. A row that was stale going in stays stale coming out.
--
-- SERVER KEY UNIQUENESS. The effective key is the explicit serverKey or, absent
-- one, the normalised name — nothing is backfilled into the stored jsonb, so
-- `internal.mcp_effective_server_key` is the single definition of the key and
-- TS mirrors it (`mcpServerKey` in contract/mcp.ts).
--
-- It is enforced by TRIGGER, not by a unique index, and deliberately. The key
-- must be unique among LIVE connectors only: `mcp_servers` keeps its row when an
-- entity is soft-deleted, so an index could not tell a deleted Gmail from a live
-- one and `delete Gmail; re-add Gmail` would fail with 23505 forever. An index
-- cannot read `entities.deleted_at` — indexes do not join — so excluding deleted
-- rows is only possible in a trigger. Two triggers cover the two ways a live key
-- can appear: `guard_mcp_definition` on an insert or definition edit, and
-- `guard_mcp_entity` on a RESTORE, which brings a key back without touching
-- `mcp_servers` at all. Keeping it out of the index also means two connectors
-- whose names already normalise alike cannot make this migration fail on
-- existing data; they are refused the next time either one's key changes.
-- =============================================================================
set role tm8_graph_owner;

-- Half one of the re-stamp (see WHY THE RE-STAMP above): the MCP connections
-- that are valid under the OLD fingerprint function, captured before it changes.
-- A temp table, so it cannot outlive this migration's session.
create temp table mcp_fingerprint_restamp_340 as
select sc.id
  from public.space_credentials sc
  join public.mcp_servers ms on ms.entity_id = sc.mcp_server_id
 where sc.provider = 'mcp'
   and sc.mcp_definition_fingerprint = internal.mcp_security_fingerprint(sc.mcp_server_id)
   and sc.mcp_definition_version = ms.mcp_security_revision;

-- `_` for every run of characters a tool prefix cannot carry; a leading digit
-- would make an invalid prefix, so it gets the `c` guard.
create or replace function internal.mcp_normalized_server_key(p_name text) returns text
language sql immutable as $$
  select case when v ~ '^[a-z]' then v else 'c' || v end
  from (select btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '_', 'g'), '_') as v) s
$$;

create or replace function internal.mcp_effective_server_key(d jsonb) returns text
language sql immutable as $$
  select coalesce(nullif(lower(d->>'serverKey'), ''), internal.mcp_normalized_server_key(d->>'name'))
$$;

-- LIVE connectors only (see SERVER KEY UNIQUENESS above): a soft-deleted
-- connector holds no key, so re-adding one it used to own is allowed.
create or replace function internal.assert_mcp_server_key_free(p_space uuid, p_entity uuid, d jsonb)
returns void language plpgsql stable set search_path=public,internal,pg_temp as $$
begin
 if exists(select 1 from public.mcp_servers s join public.entities e on e.id=s.entity_id
           where s.space_id=p_space and s.entity_id<>p_entity and e.deleted_at is null
             and internal.mcp_effective_server_key(s.definition)=internal.mcp_effective_server_key(d)) then
   raise exception 'MCP server key is already used in this space: %', internal.mcp_effective_server_key(d) using errcode='23505';
 end if;
end $$;

-- 297's body with firstParty and gates added. Every other key is unchanged.
create or replace function internal.mcp_security_fingerprint_json(d jsonb) returns text
language sql immutable as $$
 select internal.w2_sha256(jsonb_build_object(
   'transport',d->'transport','url',d->'url','command',d->'command','args',d->'args',
   'envKeys',d->'envKeys','headerKeys',d->'headerKeys','auth',d->'auth',
   'stdioTrusted',d->'stdioTrusted','allowPrivateNetwork',d->'allowPrivateNetwork',
   'firstParty',d->'firstParty','gates',d->'gates'));
$$;

-- 336's body with the six keys admitted and checked. Every other rule is unchanged.
create or replace function internal.validate_mcp_definition(d jsonb) returns void
language plpgsql immutable set search_path=public,internal,pg_temp as $$
declare k text; a jsonb;
begin
 if jsonb_typeof(d) is distinct from 'object' or not (d ?& array['name','transport','envKeys','headerKeys','auth','approved']) then
   raise exception 'incomplete MCP definition' using errcode='22023'; end if;
 for k in select jsonb_object_keys(d) loop
   if not k=any(array['name','transport','command','args','url','envKeys','headerKeys','auth','approved','enabled','provenance','stdioTrusted','allowPrivateNetwork',
                      'catalogId','serverKey','defaultOn','allowExternalClients','firstParty','gates']) then
     raise exception 'unknown MCP field (literal env/header values are forbidden)' using errcode='22023'; end if;
 end loop;
 if jsonb_typeof(d->'name')<>'string' or jsonb_typeof(d->'transport')<>'string' or (d->>'name') !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$' or lower(d->>'name')='tm8' or d->>'transport' not in ('stdio','http')
    or jsonb_typeof(d->'approved')<>'boolean' or jsonb_typeof(d->'envKeys')<>'array' or jsonb_typeof(d->'headerKeys')<>'array' then
   raise exception 'invalid MCP name, transport or key declarations' using errcode='22023'; end if;
 if (d ? 'enabled' and jsonb_typeof(d->'enabled')<>'boolean') or (d ? 'stdioTrusted' and jsonb_typeof(d->'stdioTrusted')<>'boolean') or (d ? 'allowPrivateNetwork' and jsonb_typeof(d->'allowPrivateNetwork')<>'boolean')
 or (d ? 'defaultOn' and jsonb_typeof(d->'defaultOn')<>'boolean') or (d ? 'allowExternalClients' and jsonb_typeof(d->'allowExternalClients')<>'boolean') or (d ? 'firstParty' and jsonb_typeof(d->'firstParty')<>'boolean') then
   raise exception 'MCP trust flags must be boolean' using errcode='22023'; end if;
 -- A catalog id names a Discover preset; a server key becomes a tool prefix the
 -- model reads, so it is confined to what `mcp__<key>__<tool>` admits and may
 -- not shadow tm8's own tools.
 if d ? 'catalogId' and (jsonb_typeof(d->'catalogId')<>'string' or (d->>'catalogId') !~ '^[a-z0-9][a-z0-9._-]{0,63}$') then
   raise exception 'invalid MCP catalog id' using errcode='22023'; end if;
 if d ? 'serverKey' and (jsonb_typeof(d->'serverKey')<>'string' or (d->>'serverKey') !~ '^[a-z][a-z0-9_]{0,63}$' or d->>'serverKey'='tm8') then
   raise exception 'invalid MCP server key' using errcode='22023'; end if;
 -- Gates are names to booleans and nothing else: no nested object can smuggle a
 -- literal value into a definition.
 if d ? 'gates' then
   if jsonb_typeof(d->'gates')<>'object' then raise exception 'MCP gates must be an object' using errcode='22023'; end if;
   if (select count(*) from jsonb_object_keys(d->'gates'))>32 then raise exception 'too many MCP gates' using errcode='22023'; end if;
   if exists(select 1 from jsonb_each(d->'gates') g where jsonb_typeof(g.value)<>'boolean' or g.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$') then
     raise exception 'MCP gates map tool names to booleans' using errcode='22023'; end if;
 end if;
 if jsonb_array_length(d->'envKeys')>32 or jsonb_array_length(d->'headerKeys')>32 then raise exception 'too many MCP keys' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(d->'envKeys') v where jsonb_typeof(v)<>'string' or (v#>>'{}') !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$')
 or exists(select 1 from jsonb_array_elements(d->'headerKeys') v where jsonb_typeof(v)<>'string' or (v#>>'{}') !~ '^[A-Za-z][A-Za-z0-9-]{0,127}$') then
   raise exception 'MCP keys must be names, never values' using errcode='22023'; end if;
 if d->>'transport'='http' and (not d ? 'url' or d ?| array['command','args'] or jsonb_array_length(d->'envKeys')<>0) then
   raise exception 'HTTP MCP requires URL and forbids subprocess fields' using errcode='22023'; end if;
 if d->>'transport'='stdio' and (not d ? 'command' or length(d->>'command') not between 1 and 1024 or d ? 'url' or jsonb_array_length(d->'headerKeys')<>0) then
   raise exception 'stdio MCP requires command and forbids HTTP fields' using errcode='22023'; end if;
 if d ? 'provenance' and (jsonb_typeof(d->'provenance')<>'string' or length(d->>'provenance')>2048) then raise exception 'invalid MCP provenance' using errcode='22023'; end if;
 if d ? 'command' and jsonb_typeof(d->'command')<>'string' then raise exception 'invalid MCP command' using errcode='22023'; end if;
 if d ? 'url' and jsonb_typeof(d->'url')<>'string' then raise exception 'invalid MCP URL' using errcode='22023'; end if;
 if d ? 'url' and (d->>'url' !~ '^https?://[^/@?#]+(/[^?#]*)?$' or length(d->>'url')>2048) then
   raise exception 'MCP URL must be HTTP(S), without credentials or query' using errcode='22023'; end if;
 if d ? 'args' then
   if jsonb_typeof(d->'args')<>'array' then raise exception 'MCP args must be an array' using errcode='22023'; end if;
   if jsonb_array_length(d->'args')>64 or exists(select 1 from jsonb_array_elements(d->'args') v where jsonb_typeof(v)<>'string' or length(v#>>'{}')>4096) then
     raise exception 'invalid MCP args' using errcode='22023'; end if;
 end if;
 if (select count(distinct v) from jsonb_array_elements_text(d->'envKeys') v)<>jsonb_array_length(d->'envKeys') or (select count(distinct lower(v)) from jsonb_array_elements_text(d->'headerKeys') v)<>jsonb_array_length(d->'headerKeys') then raise exception 'duplicate MCP keys' using errcode='22023'; end if;
 a:=d->'auth';
 if jsonb_typeof(a)<>'object' or coalesce(a->>'type','') not in ('none','api_key','oauth2') then raise exception 'invalid MCP auth' using errcode='22023'; end if;
 for k in select jsonb_object_keys(a) loop
   if k<>'scopes' and jsonb_typeof(a->k)<>'string' then raise exception 'MCP auth metadata must be strings' using errcode='22023'; end if;
   if not k=any(case a->>'type' when 'none' then array['type'] when 'api_key' then array['type','headerName','envKey','prefix'] else array['type','issuer','authorizationUrl','tokenUrl','clientId','clientSecretEnv','scopes'] end) then
     raise exception 'literal MCP authentication values are forbidden' using errcode='22023'; end if;
 end loop;
 if a->>'type'<>'api_key' and jsonb_array_length(d->'envKeys')+jsonb_array_length(d->'headerKeys')<>0 then raise exception 'only API key auth declares a secret slot' using errcode='22023'; end if;
 if a->>'type'='api_key' then
   if jsonb_array_length(d->'envKeys')+jsonb_array_length(d->'headerKeys')<>1 then raise exception 'API key auth requires exactly one slot' using errcode='22023'; end if;
   if (d->>'transport'='http' and (not a ? 'headerName' or a ? 'envKey' or not (d->'headerKeys' ? (a->>'headerName'))))
   or (d->>'transport'='stdio' and (not a ? 'envKey' or a ? 'headerName' or not (d->'envKeys' ? (a->>'envKey'))))
   or (a ? 'prefix' and a->>'prefix' not in ('Bearer','none')) then raise exception 'MCP API key destination must be declared' using errcode='22023'; end if;
 end if;
 if a ? 'scopes' and jsonb_typeof(a->'scopes')='array' then
   if jsonb_array_length(a->'scopes')>32 or exists(select 1 from jsonb_array_elements(a->'scopes') v where jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 256) then raise exception 'invalid MCP scopes' using errcode='22023'; end if;
 end if;
 if a ? 'clientId' and length(a->>'clientId') not between 1 and 512 then raise exception 'invalid MCP client id' using errcode='22023'; end if;
 if a ? 'clientSecretEnv' and (a->>'clientSecretEnv' !~ '^TM8_MCP_CLIENT_SECRET_[A-Z0-9_]+$' or length(a->>'clientSecretEnv')>128) then
   raise exception 'invalid MCP client secret variable' using errcode='22023'; end if;
 if a ? 'clientSecretEnv' and not a ? 'clientId' then raise exception 'MCP client secret requires a client id' using errcode='22023'; end if;
 if a->>'type'='oauth2' then
   if d->>'transport'<>'http'
   or (a ? 'issuer' and a->>'issuer' !~ '^https?://[^/@?#]+(/[^?#]*)?$')
   or (a ? 'authorizationUrl' and a->>'authorizationUrl' !~ '^https?://[^/@?#]+(/[^?#]*)?$') or (a ? 'tokenUrl' and a->>'tokenUrl' !~ '^https?://[^/@?#]+(/[^?#]*)?$')
   or (a ? 'scopes' and jsonb_typeof(a->'scopes')<>'array') then raise exception 'invalid MCP OAuth metadata' using errcode='22023'; end if;
 end if;
end $$;

-- 296's body plus the effective-key collision check. The admin gate, the space
-- match and the title projection are unchanged.
--
-- The check runs on an INSERT, and on an UPDATE only when the effective key
-- actually MOVES. Checking every update would mean a pre-existing colliding pair
-- (`my-api` and `my_api`, legal before this migration) could not be touched at
-- all — not even to set `enabled: false` to get out of the collision.
create or replace function internal.guard_mcp_definition() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
begin
 perform internal.require_space_admin(new.space_id);
 if not exists(select 1 from public.entities where id=new.entity_id and space_id=new.space_id) then raise exception 'MCP space mismatch' using errcode='22023'; end if;
 perform internal.validate_mcp_definition(new.definition);
 new.title:=lower(new.definition->>'name');
 if TG_OP='INSERT' or internal.mcp_effective_server_key(new.definition)
                      is distinct from internal.mcp_effective_server_key(OLD.definition) then
   perform internal.assert_mcp_server_key_free(new.space_id,new.entity_id,new.definition);
 end if;
 return new;
end $$;

-- 296's body plus the same check on RESTORE. An undelete brings a key back into
-- play without touching mcp_servers, so the definition guard never sees it.
create or replace function internal.guard_mcp_entity() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
begin
 perform internal.require_space_admin(old.space_id);
 if new.space_id<>old.space_id then raise exception 'MCP servers cannot move between spaces' using errcode='42501'; end if;
 if old.deleted_at is not null and new.deleted_at is null then
   perform internal.assert_mcp_server_key_free(new.space_id,new.id,
     (select definition from public.mcp_servers where entity_id=new.id));
 end if;
 return new;
end $$;

-- Half two of the re-stamp. Must come after every function above is in place.
update public.space_credentials sc
   set mcp_definition_fingerprint = internal.mcp_security_fingerprint(sc.mcp_server_id)
 where sc.id in (select id from mcp_fingerprint_restamp_340);
drop table mcp_fingerprint_restamp_340;

reset role;
