import { z } from 'zod';

export const ProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  title: z.string().min(1).max(80),
  summary: z.string().min(1).max(400),
  category: z.enum(['Development', 'Design', 'Communication', 'Productivity', 'Data', 'Research']),
  publisher: z.string().min(1).max(80),
  endpoint: z.string().url(),
  docsUrl: z.string().url(),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('dynamic'), issuer: z.string().url().optional() }).strict(),
    z.object({ kind: z.literal('registered'), issuer: z.string().url(), configurationKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict(),
    z.object({ kind: z.literal('approved'), issuer: z.string().url().optional(), configurationKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict(),
    z.object({ kind: z.literal('none') }).strict(),
  ]),
  requirement: z.string().max(2000).optional(),
}).strict();
export type Provider = z.infer<typeof ProviderSchema>;

/** Curated official endpoints. Registration policy is distinct from account consent. */
export const PROVIDERS: readonly Provider[] = [
  { id: 'github', title: 'GitHub', publisher: 'GitHub', category: 'Development',
    summary: 'Explore repositories, review pull requests, and work with issues and code.',
    endpoint: 'https://api.githubcopilot.com/mcp/', docsUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md',
    auth: { kind: 'registered', issuer: 'https://github.com/login/oauth', configurationKey: 'GITHUB' },
    requirement: 'The server operator must register a tm8 OAuth app with GitHub and configure its client ID and secret before accounts can connect.' },
  { id: 'figma', title: 'Figma', publisher: 'Figma', category: 'Design',
    summary: 'Bring design context, variables, and screenshots into your work.',
    endpoint: 'https://mcp.figma.com/mcp', docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    auth: { kind: 'approved', configurationKey: 'FIGMA' },
    requirement: 'Figma requires approval of new MCP clients. The server operator must obtain approval for this deployment.' },
  { id: 'slack', title: 'Slack', publisher: 'Slack', category: 'Communication',
    summary: 'Find conversations, read threads, and work with your team’s channels.',
    endpoint: 'https://mcp.slack.com/mcp', docsUrl: 'https://docs.slack.dev/ai/mcp-server/',
    auth: { kind: 'registered', issuer: 'https://mcp.slack.com', configurationKey: 'SLACK' },
    requirement: 'Slack requires a registered internal or Marketplace app with MCP enabled. The server operator configures the client ID and secret.' },
  { id: 'notion', title: 'Notion', publisher: 'Notion', category: 'Productivity',
    summary: 'Search your workspace and work with pages, databases, and project knowledge.',
    endpoint: 'https://mcp.notion.com/mcp', docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    auth: { kind: 'dynamic' } },
  { id: 'atlassian', title: 'Atlassian', publisher: 'Atlassian', category: 'Productivity',
    summary: 'Connect Jira and Confluence to explore work items, projects, and team knowledge.',
    endpoint: 'https://mcp.atlassian.com/v2/mcp', docsUrl: 'https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/',
    auth: { kind: 'dynamic' }, requirement: 'Your Atlassian administrator may need to allow this client’s redirect domain.' },
  { id: 'linear', title: 'Linear', publisher: 'Linear', category: 'Development',
    summary: 'Find issues, plan projects, and keep track of your team’s work.',
    endpoint: 'https://mcp.linear.app/mcp', docsUrl: 'https://linear.app/docs/mcp', auth: { kind: 'dynamic' } },
];

/** Hosts can add reviewed adapters without changing a provider enum or the UI. */
export class ProviderCatalog {
  private readonly providers = new Map<string, Provider>();
  constructor(providers: readonly Provider[] = PROVIDERS) {
    for (const value of providers) {
      const provider = ProviderSchema.parse(value);
      const endpoint = new URL(provider.endpoint);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Provider endpoint must be HTTPS without credentials or fragments');
      if (this.providers.has(provider.id)) throw new Error(`Duplicate provider: ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
  }
  get(id: string): Provider | undefined { return this.providers.get(id); }
  list(): Provider[] { return [...this.providers.values()]; }
}
/** Native API identity for hosts that cannot enter Figma's remote MCP catalog. */
export const FIGMA_NATIVE = {
  catalogId: 'figma', resource: 'https://api.figma.com/v1',
  scopes: ['current_user:read', 'file_content:read', 'file_metadata:read', 'file_comments:read', 'file_versions:read'],
} as const;
