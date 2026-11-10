-- Curated Connect Apps endpoint identities. Keep in step with MCP_CATALOG.
create or replace function internal.mcp_catalog(p_catalog_id text)
returns table(catalog_id text, url text, first_party boolean)
language sql immutable set search_path=pg_temp as $$
  select c.catalog_id, c.url, c.first_party
    from (values
      ('google.gmail', 'https://gmail.googleapis.com/gmail/v1', true),
      ('google.calendar', 'https://www.googleapis.com/calendar/v3', true),
      ('google.drive', 'https://www.googleapis.com/drive/v3', true),
      ('notion', 'https://mcp.notion.com/mcp', false),
      ('slack', 'https://mcp.slack.com/mcp', false),
      ('figma', 'https://mcp.figma.com/mcp', false),
      ('figma.api', 'https://api.figma.com/v1', true),
      ('github', 'https://api.githubcopilot.com/mcp/', false),
      ('atlassian', 'https://mcp.atlassian.com/v2/mcp', false),
      ('linear', 'https://mcp.linear.app/mcp', false)
    ) as c(catalog_id, url, first_party)
   where c.catalog_id = p_catalog_id;
$$;
