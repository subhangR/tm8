import type { McpServerDefinition } from '@tm8/contract';

/**
 * THE SERVER NOW OWNS THE CATALOG: `MCP_CATALOG` in `@tm8/contract`
 * (`contract/src/mcp-catalog.ts`), served as `mcp.catalog.list` with the Google
 * first-party cards and, per Space, where each entry is already registered.
 * This list stays as the Discover tab's source only until the Connectors page
 * is rebuilt against that operation (plan §10.1); a new provider belongs in the
 * contract catalog, not here.
 *
 * Official remote MCP servers an administrator can add without looking up their
 * configuration. Choosing one only prefills the connector form: registration,
 * approval and every member's own OAuth account work exactly as for a custom
 * connector. Each `requirement` records what the provider's own documentation
 * demands of a client like tm8, so an administrator learns it before the
 * consent screen fails.
 */
export interface McpDirectoryEntry {
  id: string; title: string; summary: string; docsUrl: string;
  requirement?: string;
  definition: McpServerDefinition;
}

const remote = (name: string, url: string, auth: McpServerDefinition['auth'], provenance: string): McpServerDefinition =>
  ({ name, transport: 'http', url, envKeys: [], headerKeys: [], auth, provenance, approved: false, enabled: true });

/** Slack's advertised user scopes (https://mcp.slack.com/.well-known/oauth-authorization-server). Edit to narrow. */
const SLACK_SCOPES = [
  'search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im', 'search:read.files', 'search:read.users',
  'channels:history', 'groups:history', 'mpim:history', 'im:history',
  'channels:read', 'groups:read', 'mpim:read', 'im:read', 'users:read', 'users:read.email',
  'chat:write', 'reactions:read', 'reactions:write', 'files:read', 'files:write',
  'canvases:read', 'canvases:write', 'lists:read', 'lists:write', 'emoji:read',
];

export const MCP_DIRECTORY: readonly McpDirectoryEntry[] = [
  {
    id: 'notion', title: 'Notion', docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    summary: 'Search, read, create and update pages and databases. Each member signs in with their own Notion workspace account.',
    definition: remote('notion', 'https://mcp.notion.com/mcp', { type: 'oauth2' }, 'Notion remote MCP server (official). OAuth with dynamic client registration.'),
  },
  {
    id: 'slack', title: 'Slack', docsUrl: 'https://docs.slack.dev/ai/mcp-server/',
    summary: 'Search messages and files, read channels and threads, send messages and manage canvases as the signed-in member.',
    requirement: 'Slack admits only internal or directory-published Slack apps and has no dynamic client registration. Create a Slack app in your workspace, enable MCP for it, add <tm8 public origin>/mcp/oauth/callback as a redirect URL and the user scopes below, then enter its Client ID here. Put its Client Secret in the server environment as TM8_MCP_CLIENT_SECRET_SLACK and restart tm8.',
    definition: remote('slack', 'https://mcp.slack.com/mcp',
      // Slack's resource metadata names https://mcp.slack.com, not the /mcp URL, so the issuer is pinned instead of discovered.
      { type: 'oauth2', issuer: 'https://mcp.slack.com', clientSecretEnv: 'TM8_MCP_CLIENT_SECRET_SLACK', scopes: SLACK_SCOPES },
      'Slack remote MCP server (official). Preregistered Slack app; client secret from server env.'),
  },
  {
    id: 'figma', title: 'Figma', docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    summary: 'Read design context, variables and screenshots from Figma files the signed-in member can open.',
    requirement: 'Figma admits only MCP clients on its catalog allowlist. Until this tm8 deployment is approved through Figma\'s MCP client waitlist, Connect fails with "rejected by provider".',
    definition: remote('figma', 'https://mcp.figma.com/mcp', { type: 'oauth2' }, 'Figma remote MCP server (official). OAuth; client must be on Figma\'s allowlist.'),
  },
];
