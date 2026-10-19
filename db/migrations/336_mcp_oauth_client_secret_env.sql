-- =============================================================================
-- 336: MCP OAuth connectors may name a preregistered client's secret.
--
-- Some providers admit only preregistered confidential clients: Slack's MCP
-- server has no dynamic client registration and its token endpoint accepts only
-- client_secret_post. 296 allowed a clientId but no secret, so such a provider
-- could not be connected at all.
--
-- The secret stays out of the graph. auth.clientSecretEnv NAMES a variable in
-- the server's environment, confined to TM8_MCP_CLIENT_SECRET_*, which the
-- operator sets. This re-creates 296's validator with that one key admitted and
-- checked; every other rule is unchanged.
-- =============================================================================
set role tm8_graph_owner;

create or replace function internal.validate_mcp_definition(d jsonb) returns void
language plpgsql immutable set search_path=public,internal,pg_temp as $$
declare k text; a jsonb;
begin
 if jsonb_typeof(d) is distinct from 'object' or not (d ?& array['name','transport','envKeys','headerKeys','auth','approved']) then
   raise exception 'incomplete MCP definition' using errcode='22023'; end if;
 for k in select jsonb_object_keys(d) loop
   if not k=any(array['name','transport','command','args','url','envKeys','headerKeys','auth','approved','enabled','provenance','stdioTrusted','allowPrivateNetwork']) then
     raise exception 'unknown MCP field (literal env/header values are forbidden)' using errcode='22023'; end if;
 end loop;
 if jsonb_typeof(d->'name')<>'string' or jsonb_typeof(d->'transport')<>'string' or (d->>'name') !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$' or lower(d->>'name')='tm8' or d->>'transport' not in ('stdio','http')
    or jsonb_typeof(d->'approved')<>'boolean' or jsonb_typeof(d->'envKeys')<>'array' or jsonb_typeof(d->'headerKeys')<>'array' then
   raise exception 'invalid MCP name, transport or key declarations' using errcode='22023'; end if;
 if (d ? 'enabled' and jsonb_typeof(d->'enabled')<>'boolean') or (d ? 'stdioTrusted' and jsonb_typeof(d->'stdioTrusted')<>'boolean') or (d ? 'allowPrivateNetwork' and jsonb_typeof(d->'allowPrivateNetwork')<>'boolean') then
   raise exception 'MCP trust flags must be boolean' using errcode='22023'; end if;
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
 -- The secret itself never enters the definition: clientSecretEnv names a server
 -- environment variable, and only the TM8_MCP_CLIENT_SECRET_ namespace, so a
 -- definition cannot point a token request at any other server variable.
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

reset role;
