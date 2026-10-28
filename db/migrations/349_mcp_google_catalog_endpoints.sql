-- =============================================================================
-- 349: the Google catalog entries get their endpoints. Plan §8.1/§8.2, B23/B25.
--
-- 345 put the catalog in SQL (`internal.mcp_catalog`) and gave the three Google
-- cards `url is null`: "announced, no endpoint yet", which
-- `internal.validate_mcp_definition` refuses to let any definition claim. That
-- was right while tm8 had no Google host. The in-process host has since landed
-- (`server/mcp/first-party/google/`, #1323), so with 345 alone a Gmail, Calendar
-- or Drive connector could not be created at all: every definition naming a
-- `google.*` catalog id was refused before it reached the host that serves it.
--
-- This replaces the catalog function with the same six rows and the three
-- Google URLs filled in. Each URL is the connector's IDENTITY (the Google REST
-- base its tools act on, the resource its connection is bound to), never an
-- address the proxy fetches: the host calls only its own static endpoints. The
-- values are `GOOGLE_FIRST_PARTY[*].resource` in `@tm8/contract`
-- (`mcp-google.ts`), and the drift test that holds this function equal to
-- `MCP_CATALOG` keeps the two in step.
--
-- Nothing else changes. `validate_mcp_definition` reads this function, so the
-- identity rules (the URL must match, `firstParty` must agree) now admit exactly
-- these three definitions and still refuse any other URL for a Google id.
-- =============================================================================

create or replace function internal.mcp_catalog(p_catalog_id text)
returns table(catalog_id text, url text, first_party boolean)
language sql immutable set search_path=pg_temp as $$
  select c.catalog_id, c.url, c.first_party
    from (values
      ('google.gmail',    'https://gmail.googleapis.com/gmail/v1',  true),
      ('google.calendar', 'https://www.googleapis.com/calendar/v3', true),
      ('google.drive',    'https://www.googleapis.com/drive/v3',    true),
      ('notion',          'https://mcp.notion.com/mcp',             false),
      ('slack',           'https://mcp.slack.com/mcp',              false),
      ('figma',           'https://mcp.figma.com/mcp',              false)
    ) as c(catalog_id, url, first_party)
   where c.catalog_id = p_catalog_id;
$$;

-- -----------------------------------------------------------------------------
-- A member may REQUEST a Google card, as they may any other catalog entry.
-- -----------------------------------------------------------------------------
-- 345's predicate keeps `firstParty` and `gates` out of every request, because
-- "only an administrator arms a connector". For a CATALOG request neither is the
-- member's choice: `validate_mcp_definition` already forces `firstParty` to equal
-- the catalog row (so a Google id MUST carry `true`, any other MUST NOT), and the
-- definition is the server's prefill from MCP_CATALOG, whose schema ships every
-- gate CLOSED. So a catalog request may carry `firstParty: true` exactly when its
-- catalog row says so, and `gates` only when every gate is `false`. Opening a
-- gate (`gmailSend`) stays an administrator's edit, made after approval, and it
-- advances the security revision as before. A CUSTOM request is unchanged: it
-- still may carry neither. Everything else is 345's predicate, verbatim.
create or replace function internal.mcp_definition_is_request(d jsonb) returns boolean
language sql immutable set search_path=public,internal,pg_temp as $$
  select jsonb_typeof(d)='object'
     and d->>'transport'='http'
     and (d->>'approved')='false'
     and d->>'url' like 'https://%'
     and not (d ?| array['stdioTrusted','allowPrivateNetwork','defaultOn','allowExternalClients'])
     and d->'auth'->>'clientSecretEnv' is null
     and (case when d ? 'catalogId'
               then not (d ? 'serverKey')
                    and (not (d ? 'firstParty')
                         or (d->>'firstParty') = coalesce((select (c.first_party)::text from internal.mcp_catalog(d->>'catalogId') c), 'false'))
                    and (not (d ? 'gates')
                         or (jsonb_typeof(d->'gates')='object'
                             and not exists (select 1 from jsonb_each(d->'gates') g where g.value <> 'false'::jsonb)))
               else not (d ?| array['catalogId','serverKey','provenance','firstParty','gates'])
          end);
$$;
