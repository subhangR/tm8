-- Official provider grants can exceed32scopes (Atlassian uses39).
-- Preserve every definition guard and raise only the bounded OAuth scope count.
create or replace function internal.validate_mcp_definition(d jsonb) returns void
language plpgsql immutable set search_path=public,internal,pg_temp as $$
declare k text; a jsonb; c record;
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
 -- 344 tightens 340's shape: alphanumeric segments joined by SINGLE
 -- underscores, 32 characters. `__` is the field separator in
 -- `mcp__<server>__<tool>`, so `tm8__evil` presented as `mcp__tm8__evil__send`
 -- reads as tm8's OWN server with a tool called `evil__send`, and the
 -- `mcp__tm8__*` allow-list entry then denies every real tm8 tool. `tm8_` does
 -- it one character later. 32 rather than 64 because `mcp__` + key + `__` is
 -- carried by every tool name and clients cap those near 64.
 if d ? 'serverKey' and (jsonb_typeof(d->'serverKey')<>'string'
    or (d->>'serverKey') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' or length(d->>'serverKey')>32
    or d->>'serverKey'='tm8') then
   raise exception 'invalid MCP server key' using errcode='22023'; end if;
 -- 344: and neither may the key a name NORMALISES to be `tm8`. `tm8` is the
 -- launcher's own bridge entry; a connector holding it replaces tm8's tools.
 -- The normalised path needs no shape check: mcp_normalized_server_key collapses
 -- every run of non-alphanumerics to ONE underscore and trims the ends, so it
 -- cannot produce `__` or an edge underscore. It is not length-capped either,
 -- because a `name` may be 80 characters and capping the EFFECTIVE key here
 -- would silently move the keys of connectors already stored; the launcher
 -- truncates instead, through the same collision rule (`assignMcpServerKeys`).
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
   if jsonb_array_length(a->'scopes')>64 or exists(select 1 from jsonb_array_elements(a->'scopes') v where jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 256) then raise exception 'invalid MCP scopes' using errcode='22023'; end if;
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
 -- 345/B23. THE IDENTITY RULES. Everything above is shape; this is "are you who
 -- you say you are". It binds administrators too: the Connectors page renders a
 -- provider's name, logo and help text from `catalogId` alone, so a row that
 -- carried one dishonestly would wear that provider's face wherever it appears.
 if d ? 'catalogId' then
   select * into c from internal.mcp_catalog(d->>'catalogId');
   if c.catalog_id is null then
     raise exception 'unknown MCP catalog id: %', d->>'catalogId' using errcode='22023';
   end if;
   if c.url is null then
     raise exception 'MCP catalog connector % has no endpoint on this node yet', d->>'catalogId' using errcode='22023';
   end if;
   if d->>'url' is distinct from c.url then
     raise exception 'MCP catalog connector % must point at %', d->>'catalogId', c.url using errcode='22023';
   end if;
   if coalesce((d->>'firstParty')='true',false) <> c.first_party then
     raise exception 'MCP catalog connector % disagrees with firstParty', d->>'catalogId' using errcode='22023';
   end if;
 elsif coalesce((d->>'firstParty')='true',false) then
   -- firstParty means "tm8 serves this provider's tools in-process" (§8.1).
   -- Without a catalog id there is no provider to serve, so the flag would claim
   -- a hosting relationship that does not exist.
   raise exception 'firstParty requires a first-party MCP catalog id' using errcode='22023';
 end if;
end $$;
