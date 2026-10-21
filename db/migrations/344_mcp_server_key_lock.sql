-- =============================================================================
-- 344: the server-key guard takes a lock, and `tm8` stops being reachable as an
-- effective key. Plan §4.2, G8.
--
-- 1. THE RACE (review of #1312). internal.assert_mcp_server_key_free, added by
--    340, is a plain `exists` read with no lock, so two writers each read a
--    snapshot in which the other's row does not exist and both commit: the
--    uniqueness 340 promises is advisory under concurrency. It cannot be an
--    index (340 explains why at length: the key must be unique among LIVE
--    connectors only, and an index cannot read entities.deleted_at), so the
--    serialisation has to be explicit.
--
--    WHICH WRITER, MEASURED. On a scratch cluster with 340's body in place:
--      - two concurrent CREATEs do NOT both commit. The entity write ahead of
--        the guard already serialises per Space, so the second waits on
--        `transactionid` and then sees the first's row. The race is not
--        reachable here.
--      - two concurrent RENAMES (update_mcp_server_entity moving two existing
--        connectors' keys onto one value) BOTH COMMIT, and leave the Space with
--        two live connectors sharing one effective key — exactly the state 340
--        exists to prevent. With the lock below the second waits on `advisory`
--        and raises 23505.
--    The regression test is therefore on the rename path
--    (server/test/db/mcp-server-key-lock.pg.test.ts); a create-path test would
--    pass with this migration reverted.
--
--    pg_advisory_xact_lock over (space, 340) is that serialisation. It is held
--    to COMMIT, so the second writer blocks until the first is visible and then
--    re-reads under a fresh statement snapshot (the server runs every
--    transaction READ COMMITTED: `begin` with no isolation clause, db/client.ts)
--    and raises 23505 as intended. The lock is per Space, so two Spaces
--    registering connectors never wait on each other. The classifier `340` is
--    the migration that introduced the invariant, not this one: it must stay
--    stable forever, because changing it would silently stop serialising
--    against a session already holding the old key.
--
--    The function is redeclared VOLATILE. 340 marked it `stable`, which is a
--    promise it no longer keeps — taking a lock is a side effect, and the
--    planner is free to fold or skip calls to a stable function. Nothing else
--    about the body moves: the same `exists`, the same LIVE-only join on
--    entities.deleted_at, the same 23505 and the same message.
--
-- 2. `tm8` AS AN EFFECTIVE KEY. The explicit `serverKey` already refuses `tm8`
--    (340's validator, and Zod's `ServerKey`), and `name` refuses it too. But
--    the EFFECTIVE key of a connector with no `serverKey` is the NORMALISED
--    name, and normalisation can land on it anyway: `tm8--` and `Tm8_` both
--    pass the name rule and normalise to `tm8`.
--
--    That is not a cosmetic collision. `tm8` is the name of tm8's OWN entry in
--    every launcher's --mcp-config (server/chat/compose.ts,
--    chat/harness-composition.ts), so a connector keyed `tm8` would REPLACE it:
--    the lane loses every tm8 tool and the connector's own tools answer under
--    the prefix the model has been told is tm8's. Refused at the source here.
--
--    Launch-time naming does NOT rely on this, and deliberately so: rows
--    written before this migration can still carry such a key, so
--    `assignMcpServerKeys` (contract/mcp.ts) treats `tm8` as reserved and
--    renames the loser. This migration stops NEW ones appearing; that function
--    is what makes the ones already stored harmless.
--
-- VERIFIED SAFE ON EXISTING DATA: the validator runs on write only, so a stored
-- connector whose name normalises to `tm8` keeps working and is refused only at
-- its next edit — the same treatment 340 gave a pre-existing key collision.
-- =============================================================================
set role tm8_graph_owner;

-- 340's body, with the advisory lock and VOLATILE. Diff is the two added lines.
create or replace function internal.assert_mcp_server_key_free(p_space uuid, p_entity uuid, d jsonb)
returns void language plpgsql volatile set search_path=public,internal,pg_temp as $$
begin
 -- Held to commit: serialises concurrent registrations within ONE space.
 perform pg_advisory_xact_lock(hashtextextended(p_space::text, 340));
 if exists(select 1 from public.mcp_servers s join public.entities e on e.id=s.entity_id
           where s.space_id=p_space and s.entity_id<>p_entity and e.deleted_at is null
             and internal.mcp_effective_server_key(s.definition)=internal.mcp_effective_server_key(d)) then
   raise exception 'MCP server key is already used in this space: %', internal.mcp_effective_server_key(d) using errcode='23505';
 end if;
end $$;

-- 340's validator with ONE rule added: the effective key may not be `tm8`.
-- Checking the EFFECTIVE key covers the explicit field and the normalised name
-- in one line, so 340's `serverKey='tm8'` arm becomes redundant rather than
-- wrong, and is left in place as the specific message for the specific mistake.
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
 -- 344: and neither may the key a name NORMALISES to. `tm8` is the launcher's
 -- own bridge entry; a connector holding it replaces tm8's tools.
 if internal.mcp_effective_server_key(d)='tm8' then
   raise exception 'MCP server key tm8 is reserved' using errcode='22023'; end if;
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

-- No grant statements: CREATE OR REPLACE preserves a function's privileges, and
-- 340 left this one at the schema default, which is what the connector-write
-- path (guard_mcp_definition runs as the calling app role, not SECURITY
-- DEFINER) relies on. Narrowing it here would break every connector write.
reset role;
