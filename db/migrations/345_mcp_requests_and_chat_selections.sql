-- 345: MCP contract surface — the connector CATALOG as an identity, connector
-- REQUESTS from members, live-name uniqueness, and changing a LIVE chat's
-- connectors. Plan §11, §10.1, §8.2, §5.3; gaps G4 and the request half of
-- §10.1. Backend rulings B13, B14, B22, B23, B25.
--
-- WHAT CHANGES, AND THE RULE BEHIND EACH
--
-- 0. A catalogId IS AN IDENTITY CLAIM (B23). The Connectors page shows a
--    provider's name, logo, help text and scope list for whatever `catalogId` a
--    definition carries, so a connector claiming `figma` while pointing at an
--    arbitrary server wears Figma's badge — and once an admin approves it, every
--    member's OAuth and every tool call go there. `internal.mcp_catalog` is the
--    catalog in SQL, and a definition carrying a catalogId must now name a real
--    entry, match that entry's URL, and agree with it about `firstParty`. This
--    binds EVERY write, administrators' included: the spoof does not need a
--    member to perform it. An entry with no URL yet (the three Google cards,
--    which tm8 will serve itself) cannot be claimed at all — there is no
--    endpoint, so any URL offered for it is the wrong one.
--
-- 0b. NAME UNIQUENESS APPLIES TO LIVE ROWS ONLY (B22). 296's
--    `unique(space_id,title)` outlives a soft delete, because the `mcp_servers`
--    row does: deleting a connector reserved its name in that Space for ever,
--    and a withdrawn request could squat on `notion` permanently. One rule for
--    every case, not a special path for withdrawal: 296's constraint goes, and
--    the name is checked over LIVE rows wherever the SERVER KEY already is (on
--    insert, on rename, and on restore). A restore whose name was taken
--    meanwhile raises 23505 — it is never silently renamed. Section 2 explains
--    why this is a trigger check rather than a partial unique index.
--
-- 1. CONNECTOR REQUESTS (§11 `mcp.servers.request`, §10.1 "members get
--    Request"). Only admins could register a connector (296), so a member who
--    needed Figma had nothing to click. A request is now the SAME mcp_server
--    entity an admin would create, created UNAPPROVED, plus an attention
--    request on it. That is deliberately not a second table:
--      * §10.1's Yours tab already lists "connectors you requested", and the
--        §10.0 status vocabulary already has not_approved -> "Awaiting
--        approval", so the row the member sees afterwards is the real one;
--      * approving is the EXISTING `mcp.servers.update` with approved=true, and
--        rejecting is a delete — no accept path to write, and no second shape
--        of the truth to keep in step;
--      * an unapproved connector is INERT. resolve and bind refuse it, and
--        `mcp.servers.test` and `mcp.oauth.begin` both pass through the
--        handler's `approved()` check first, so nothing in tm8 fetches a
--        requested URL before an admin says yes.
--
--    The relaxation is confined by the DATA, not by a flag. 296's triggers
--    demanded a space admin for any write to mcp_servers; they now demand one
--    unless the row IS a request — `internal.mcp_definition_is_request`: HTTPS
--    http-transport, approved=false, no OAuth clientSecretEnv (a member must not
--    name a server env secret for an admin to approve by eye), and none of the
--    trust/reach flags or tool gates. There is no claim to forge and no window
--    where a looser rule applies to an ordinary write: any insert that satisfies
--    the predicate is exactly the inert shape, and tm8_app has only SELECT on
--    mcp_servers, so every write still arrives through a function here.
--
--    Caps: 10 open requests per member per Space and 50 per Space, taken under
--    an advisory lock so two concurrent requests cannot both see 9.
--
--    The requester may WITHDRAW their own request while it is still unapproved
--    (the generic `delete_entity`, which needs only space membership); update
--    stays admin-only, so a request cannot be edited into something else after
--    an admin has looked at it.
--
-- 2. CHANGING A LIVE CHAT'S CONNECTORS (G4, §5.3). 298's
--    `save_chat_mcp_selections` is insert-`on conflict do nothing`, so the list
--    stored when the thread was created always won and a thread's connectors
--    could never be changed. `update_chat_mcp_selections` upserts, and NULL
--    deletes the row — "back to defaults", resolved fresh at each turn.
--
--    It validates STRUCTURE at the write (each serverId a live connector in the
--    chat's own Space, no duplicates) so a typo fails here with a clear error,
--    and deliberately does NOT check approval, readiness or credential
--    usability: those change over time, compose and bind re-check them on every
--    turn, and an explicit pin that stops being usable must refuse loudly there
--    rather than be silently dropped at write time (B9's rule).
--
--    `updated_at` is added to the row so the next compose can tell "changed
--    since the last bind" and rebind instead of resuming the stored list. Both
--    existing inserts into this table pass a positional VALUES list shorter
--    than the column count, which Postgres fills from the defaults, so the
--    column is appended LAST and neither function needs rewriting here.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The catalog, in SQL (B23).
-- -----------------------------------------------------------------------------
-- IMMUTABLE and table-free on purpose: `internal.validate_mcp_definition` is
-- immutable, and a table read would make it stable and unusable there.
--
-- IT IS A SECOND COPY of `MCP_CATALOG` (contract/src/mcp-catalog.ts) and that is
-- accepted for one reason: this is the authority an attacker meets, and the
-- facade cannot be it. The copy is held honest by a DRIFT TEST comparing this
-- function with the TS catalog entry by entry, so adding a provider in one place
-- and not the other fails a test rather than opening a hole.
--
-- `url is null` means "announced, no endpoint yet" (§8.2's Google cards, which
-- tm8 serves itself once `server/mcp/first-party/` exists). Claiming such an id
-- is refused outright: whatever URL is offered for it cannot be the right one.
create or replace function internal.mcp_catalog(p_catalog_id text)
returns table(catalog_id text, url text, first_party boolean)
language sql immutable set search_path=pg_temp as $$
  select c.catalog_id, c.url, c.first_party
    from (values
      ('google.gmail',    null::text,                   true),
      ('google.calendar', null::text,                   true),
      ('google.drive',    null::text,                   true),
      ('notion',          'https://mcp.notion.com/mcp', false),
      ('slack',           'https://mcp.slack.com/mcp',  false),
      ('figma',           'https://mcp.figma.com/mcp',  false)
    ) as c(catalog_id, url, first_party)
   where c.catalog_id = p_catalog_id;
$$;

-- 340's body with ONE section appended: the catalogId identity rules. Every
-- other check is 340's, unchanged — this is the only place a definition is
-- validated, so the identity rule has to live here to bind every writer.
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

-- -----------------------------------------------------------------------------
-- 2. Name uniqueness over LIVE rows only (B22).
-- -----------------------------------------------------------------------------
-- 296's `unique(space_id,title)` is the squat: the `mcp_servers` row outlives
-- `entities.deleted_at`, so deleting a connector reserved its name in that Space
-- for ever and a withdrawn request could hold `notion` permanently.
--
-- WHY A TRIGGER CHECK AND NOT A PARTIAL UNIQUE INDEX. The index form needs a
-- `deleted_at` mirror column on `mcp_servers`, and the only place to maintain it
-- is the entities lifecycle trigger — a BEFORE UPDATE on the very row being
-- soft-deleted. Writing `mcp_servers` from there fires `mcp_servers_snapshot` ->
-- `internal.snapshot_entity_version`, which updates `public.entities` again, and
-- Postgres refuses: "tuple to be updated was already modified by an operation
-- triggered by the current command". MEASURED on this branch, not reasoned about.
--
-- So the name follows the idiom 340 already uses for the SERVER KEY, which has
-- exactly this liveness requirement: `assert_mcp_server_key_free` joins
-- `entities` and filters `deleted_at is null`, and runs on INSERT and on
-- RESTORE. The name check is its twin, called from the same two places, so one
-- rule covers "a deleted connector frees its name" and "a restore must find its
-- name free" with no column anything has to remember to maintain.
alter table public.mcp_servers drop constraint if exists mcp_servers_space_id_title_key;

-- Who asked for this connector, and when it first became approved. `approved_at`
-- is what "never approved" means for withdrawal, and the definition guard stamps
-- it rather than a caller, so no write path can forget it.
alter table public.mcp_servers add column if not exists requested_by uuid references public.entities(id) on delete set null;
alter table public.mcp_servers add column if not exists approved_at timestamptz;
-- The backfill writes a COLUMN, not a definition, and a migration has no
-- identity bound — so `mcp_servers_guard` would refuse it outright
-- (require_space_admin -> "no identity bound to this transaction", MEASURED
-- against test/db/mcp-connector-fields.pg.test.ts, which applies 340-onwards to
-- a database that already holds connectors). `mcp_servers_snapshot` is off for
-- the same statement so stamping a column does not mint an entity version for
-- every connector on the node. Both are restored immediately afterwards.
alter table public.mcp_servers disable trigger mcp_servers_guard;
alter table public.mcp_servers disable trigger mcp_servers_snapshot;
update public.mcp_servers set approved_at=coalesce(created_at,now())
 where (definition->>'approved')='true' and approved_at is null;
alter table public.mcp_servers enable trigger mcp_servers_snapshot;
alter table public.mcp_servers enable trigger mcp_servers_guard;

-- `lower()` matches the resolver's own collision rule (definitions.ts compares
-- `d.name.toLowerCase()`), so SQL and the resolver refuse the same pairs.
create or replace function internal.assert_mcp_server_name_free(p_space uuid, p_entity uuid, d jsonb)
returns void language plpgsql stable set search_path=public,internal,pg_temp as $$
begin
 if exists(select 1 from public.mcp_servers s join public.entities e on e.id=s.entity_id
           where s.space_id=p_space and s.entity_id<>p_entity and e.deleted_at is null
             and lower(s.title)=lower(d->>'name')) then
   raise exception 'MCP connector name is already used in this space: %', d->>'name' using errcode='23505';
 end if;
end $$;

-- 340's body, plus the request branch, the approved_at stamp, and an early exit
-- for the lifecycle mirror.
create or replace function internal.guard_mcp_definition() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
begin
 -- A request (B13) is admitted to a MEMBER; everything else is still admin-only.
 -- On an UPDATE the admin check never lifts: a member may withdraw a request,
 -- never edit one.
 --
 -- THE BRANCH IS CHOSEN BY `requested_by`, NOT BY THE DEFINITION'S SHAPE. An
 -- admin staging a connector unapproved is a normal thing to do and its
 -- definition is indistinguishable from a request's, so selecting on the shape
 -- refused `create_mcp_server_entity` with `approved:false` — MEASURED against
 -- test/db/mcp-foundation.pg.test.ts. Only `request_mcp_server_entity` sets
 -- `requested_by`, so it marks the path, and the shape is then ENFORCED for it
 -- rather than used to detect it.
 if TG_OP='INSERT' and new.requested_by is not null then
   perform internal.require_space_member(new.space_id);
   -- Attribution is not a caller's to choose: a request records the member who
   -- made it, and withdrawal reads this column back.
   if new.requested_by is distinct from internal.current_member_id(new.space_id) then
     raise exception 'a connector request records the requesting member' using errcode='42501';
   end if;
   if not internal.mcp_definition_is_request(new.definition) then
     raise exception 'a connector request must be an unapproved https connector with no administrator-only settings' using errcode='22023';
   end if;
 else
   perform internal.require_space_admin(new.space_id);
 end if;
 if not exists(select 1 from public.entities where id=new.entity_id and space_id=new.space_id) then raise exception 'MCP space mismatch' using errcode='22023'; end if;
 perform internal.validate_mcp_definition(new.definition);
 new.title:=lower(new.definition->>'name');
 -- Stamped ONCE, by the only path every definition write passes through.
 if (new.definition->>'approved')='true' and new.approved_at is null then
   new.approved_at:=now();
 end if;
 if TG_OP='INSERT' or internal.mcp_effective_server_key(new.definition)
                      is distinct from internal.mcp_effective_server_key(OLD.definition) then
   perform internal.assert_mcp_server_key_free(new.space_id,new.entity_id,new.definition);
 end if;
 -- B22. The NAME, over live rows, checked exactly where the server key is.
 if TG_OP='INSERT' or lower(new.definition->>'name') is distinct from lower(OLD.definition->>'name') then
   perform internal.assert_mcp_server_name_free(new.space_id,new.entity_id,new.definition);
 end if;
 return new;
end $$;

-- 340's body, plus the withdrawal branch and the mirror.
--
-- THE RESTORE BRANCH IS 340'S, VERBATIM. An earlier draft of this migration
-- rewrote this function around withdrawal and lost it, which would have let an
-- undeleted connector collide with a live one on its tool prefix (lead review,
-- finding 1). A member's withdrawal is a narrow extra branch here, never a
-- replacement for what was already true.
create or replace function internal.guard_mcp_entity() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
declare m public.mcp_servers; me uuid;
begin
 select * into m from public.mcp_servers where entity_id=new.id;
 me := internal.current_member_id(old.space_id);
 -- A member may SOFT-DELETE their own NEVER-APPROVED request, and nothing else:
 -- not a reparent, not a reposition, not a move, not a restore (that keeps
 -- old.deleted_at non-null and falls to the admin check), and never another
 -- member's request or a connector an admin has ever approved.
 if old.deleted_at is null and new.deleted_at is not null
    and new.parent_id is not distinct from old.parent_id
    and new.position is not distinct from old.position
    and new.space_id=old.space_id
    and m.approved_at is null and (m.definition->>'approved')='false'
    and m.requested_by is not null and me is not null and m.requested_by=me then
   perform internal.require_space_member(old.space_id);
 else
   perform internal.require_space_admin(old.space_id);
 end if;
 if new.space_id<>old.space_id then raise exception 'MCP servers cannot move between spaces' using errcode='42501'; end if;
 -- An undelete brings a key AND a name back into play without touching
 -- mcp_servers, so the definition guard never sees it (340's reasoning, now true
 -- of the name too, since a soft delete releases it).
 if old.deleted_at is not null and new.deleted_at is null then
   perform internal.assert_mcp_server_key_free(new.space_id,new.id,m.definition);
   perform internal.assert_mcp_server_name_free(new.space_id,new.id,m.definition);
 end if;
 return new;
end $$;

-- -----------------------------------------------------------------------------
-- 3. The request shape: what a non-admin may put in front of an admin.
-- -----------------------------------------------------------------------------
-- Mirrors `McpRequestedServerDefinitionSchema` (contract/mcp.ts). The contract
-- gives the member a readable message per rule; this is the authority.
--
-- Note what is NOT restated here: the rest of the URL shape (no userinfo, query
-- or fragment) and the catalogId-to-URL identity rule are both
-- `validate_mcp_definition`'s, enforced on the same row by the same trigger.
create or replace function internal.mcp_definition_is_request(d jsonb) returns boolean
language sql immutable set search_path=public,internal,pg_temp as $$
  select jsonb_typeof(d)='object'
     and d->>'transport'='http'
     and (d->>'approved')='false'
     and d->>'url' like 'https://%'
     -- Only an administrator arms a connector: trust, reach, default-on,
     -- external clients, first-party hosting and tool gates are all theirs.
     and not (d ?| array['stdioTrusted','allowPrivateNetwork','defaultOn','allowExternalClients','firstParty','gates'])
     and d->'auth'->>'clientSecretEnv' is null
     -- B23. A CUSTOM request claims no identity at all: no catalogId (the
     -- provider's face in Discover), no serverKey (the tool prefix the model
     -- reads) and no provenance (the line an administrator reads before
     -- approving). A CATALOG request carries its entry's id, and
     -- validate_mcp_definition then pins the URL to that entry — the server,
     -- not the member, chose both.
     and (case when d ? 'catalogId'
               then not (d ? 'serverKey')
               else not (d ?| array['catalogId','serverKey','provenance'])
          end);
$$;

-- -----------------------------------------------------------------------------
-- 4. The request door.
-- -----------------------------------------------------------------------------
-- `p_definition` is whole and server-trusted for a catalog request: the handler
-- looks the entry up in MCP_CATALOG by catalogId and the member never gets to
-- send the URL or auth of a catalog connector. A custom request carries the
-- member's own definition, which the predicate above confines.
create or replace function public.request_mcp_server_entity(
  p_space_id uuid, p_definition jsonb, p_note text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare replay jsonb; actor uuid; target uuid; me uuid; mine integer; here integer; reason text; existing uuid;
begin
  perform internal.require_human_auth_kind();
  -- Off the human gate's other half: a link session is a human, but not THIS
  -- Space's human (§6.5, B11). It may not put a connector in front of admins.
  if coalesce(internal.claim_text('tm8.via_link'),'') <> '' or coalesce(internal.claim_text('tm8.auth_kind'),'') = 'link' then
    raise exception 'MCP connector requests are unavailable to a linked session' using errcode='42501';
  end if;
  perform internal.require_space_member(p_space_id);
  me := internal.current_member_id(p_space_id);
  if me is null then
    raise exception 'MCP connector requests need a member of this space' using errcode='42501';
  end if;
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id,'mcp.servers.request');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay#>>'{entity,space_id}',p_space_id::text,'space'); return replay;
  end if;
  if not internal.mcp_definition_is_request(p_definition) then
    raise exception 'a connector request must be an unapproved https connector with no administrator-only settings' using errcode='22023';
  end if;
  if p_note is not null and char_length(btrim(p_note)) not between 1 and 500 then
    raise exception 'a connector request note must be between 1 and 500 characters' using errcode='22023';
  end if;
  actor := internal.resolve_actor(p_actor_id,p_space_id); perform internal.bind_actor(actor);
  -- Serialise per Space so two concurrent requests cannot both read the count
  -- below the cap, and so the idempotent read below cannot race a second insert.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('mcp_server_requests:'||p_space_id::text,0));
  -- B22. A second ask for the same CATALOG connector returns the OPEN request
  -- rather than a second row: two members wanting Notion is one decision for an
  -- admin, and a per-member row would collide on the connector's name anyway.
  if p_definition ? 'catalogId' then
    existing := public.open_mcp_catalog_request(p_space_id,p_definition->>'catalogId');
    if existing is not null then
      return internal.ledger_record(p_client_mutation_id,'mcp.servers.request',
        internal.command_result(existing,null,null,array[existing]));
    end if;
  end if;
  select count(*) into here from public.mcp_servers m
   join public.entities e on e.id=m.entity_id and e.deleted_at is null
   where m.space_id=p_space_id and m.approved_at is null and (m.definition->>'approved')='false';
  -- Keyed on the MEMBER, not the resolved actor: resolve_actor admits a member's
  -- own teammates, and an actor-keyed cap is really ten per teammate (finding 5).
  select count(*) into mine from public.mcp_servers m
   join public.entities e on e.id=m.entity_id and e.deleted_at is null
   where m.space_id=p_space_id and m.approved_at is null
     and (m.definition->>'approved')='false' and m.requested_by=me;
  if mine >= 10 then
    raise exception 'you already have 10 connector requests awaiting approval in this space' using errcode='53400';
  end if;
  if here >= 50 then
    raise exception 'this space already has 50 connector requests awaiting approval' using errcode='53400';
  end if;
  target := internal.create_envelope(p_space_id,'mcp_server',actor,null,null);
  insert into public.mcp_servers(entity_id,space_id,title,definition,requested_by)
    values(target,p_space_id,p_definition->>'name',p_definition,me);
  perform internal.record_initial_version(target,actor);
  -- The admins' lever is attention, not a message: an 'approve' request on the
  -- connector itself puts it in the inbox next to everything else awaiting a
  -- decision, and resolving it is the approval.
  reason := 'Connector requested: '||coalesce(p_definition->>'name','connector')
         || case when p_note is null then '' else ' — '||btrim(p_note) end;
  perform public.create_attention_request(target,left(reason,500),null,actor,
    case when p_client_mutation_id is null then null else p_client_mutation_id||':attention' end,
    null,'normal','approve',null);
  return internal.ledger_record(p_client_mutation_id,'mcp.servers.request',internal.command_result(target,null,
    internal.record_activity(p_space_id,target,actor,'created',null,
      jsonb_build_object('kind','mcp_server','change','requested')),array[target]));
end $$;

revoke all on function public.request_mcp_server_entity(uuid,jsonb,text,uuid,text) from public;
grant execute on function public.request_mcp_server_entity(uuid,jsonb,text,uuid,text) to tm8_app;

-- B25's read, which the facade turns into a `conflict` naming the connector to
-- APPROVE. Without it, an admin adding a catalog connector a member has already
-- requested meets a bare unique-index violation and no id to act on. Declared
-- before request_mcp_server_entity needs it at run time (plpgsql resolves on
-- first call, so the order in this file is for readers).
create or replace function public.open_mcp_catalog_request(p_space_id uuid, p_catalog_id text)
returns uuid language plpgsql stable security definer set search_path=public,internal,pg_temp as $$
declare found uuid;
begin
  perform internal.require_space_member(p_space_id);
  if p_catalog_id is null then return null; end if;
  select m.entity_id into found from public.mcp_servers m
   join public.entities e on e.id=m.entity_id and e.deleted_at is null
   where m.space_id=p_space_id and m.approved_at is null
     and (m.definition->>'approved')='false' and m.definition->>'catalogId'=p_catalog_id
   order by m.created_at, m.entity_id limit 1;
  return found;
end $$;

revoke all on function public.open_mcp_catalog_request(uuid,text) from public;
grant execute on function public.open_mcp_catalog_request(uuid,text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 5. A live chat's connectors (G4, §5.3).
-- -----------------------------------------------------------------------------
alter table internal.mcp_launch_selections
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.update_chat_mcp_selections(p_chat uuid, p_selections jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare target_space uuid; picks integer;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'),'') <> '' or coalesce(internal.claim_text('tm8.auth_kind'),'') = 'link' then
    raise exception 'MCP chat unavailable' using errcode='42501';
  end if;
  -- The CONFIGURER, exactly as save_chat_mcp_selections has it: connectors ride
  -- the human who owns the thread's configuration, never any member who can
  -- read it.
  select c.space_id into target_space from public.chats c join public.entities e on e.id=c.entity_id
    where c.entity_id=p_chat and c.configured_by_identity_id=internal.identity_id() and e.deleted_at is null;
  if target_space is null then
    raise exception 'MCP chat unavailable' using errcode='42501';
  end if;
  perform internal.require_space_member(target_space);
  if p_selections is null then
    delete from internal.mcp_launch_selections where session_id=p_chat;
    return jsonb_build_object('chatId',p_chat,'mcpSelections',null);
  end if;
  if jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections) > 32 then
    raise exception 'Invalid MCP selections' using errcode='22023';
  end if;
  picks := jsonb_array_length(p_selections);
  if exists(select 1 from jsonb_array_elements(p_selections) s
             where jsonb_typeof(s.value) <> 'object'
                or not (s.value ? 'serverId')
                or exists(select 1 from jsonb_object_keys(s.value) k where k not in ('serverId','credentialId'))
                or (s.value->>'serverId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                or ((s.value ? 'credentialId')
                    and (s.value->>'credentialId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception 'Invalid MCP selections' using errcode='22023';
  end if;
  if (select count(distinct s.value->>'serverId') from jsonb_array_elements(p_selections) s) <> picks then
    raise exception 'duplicate MCP server selection' using errcode='22023';
  end if;
  -- Structure only (B14): the connector must exist, be live and belong to THIS
  -- chat's Space. Approval, readiness and credential usability are re-checked
  -- by compose and bind on every turn, where a pin that went bad must refuse
  -- loudly rather than be quietly dropped here.
  if exists(select 1 from jsonb_array_elements(p_selections) s
             where not exists(select 1 from public.mcp_servers m join public.entities e on e.id=m.entity_id
                               where m.entity_id=(s.value->>'serverId')::uuid and m.space_id=target_space
                                 and e.kind='mcp_server' and e.deleted_at is null)) then
    raise exception 'MCP connector unavailable' using errcode='42501';
  end if;
  insert into internal.mcp_launch_selections(session_id,selections,launcher_identity_id,launcher_auth_kind,updated_at)
    values(p_chat,p_selections,internal.identity_id(),internal.claim_text('tm8.auth_kind'),now())
  on conflict (session_id) do update
    set selections=excluded.selections, launcher_identity_id=excluded.launcher_identity_id,
        launcher_auth_kind=excluded.launcher_auth_kind, updated_at=now();
  return jsonb_build_object('chatId',p_chat,'mcpSelections',p_selections);
end $$;

revoke all on function public.update_chat_mcp_selections(uuid,jsonb) from public;
grant execute on function public.update_chat_mcp_selections(uuid,jsonb) to tm8_app;

reset role;
