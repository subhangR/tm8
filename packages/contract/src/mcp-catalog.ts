import { PROVIDERS } from '@tm8/integrations/providers';
/**
 * The connector catalog (§8.2) — what the Connectors page's **Discover** tab
 * offers, and the source `mcp.catalog.list` serves.
 *
 * IT LIVES HERE, not in the UI. `ui/mcp/directory.ts` (#1287) held the same
 * three presets as UI-only data, so the CLI could not offer them and no server
 * could tell which preset a connector came from. This module is the single
 * source: the server projects it, the CLI prints it, and the UI renders it.
 *
 * A catalog entry is NOT a connector. Choosing one only prefills the connector
 * form; registration, approval and every member's own account work exactly as
 * for a custom connector (today's `directory.ts` rule, kept verbatim).
 *
 * `requirement` records what the provider's own documentation demands of a
 * client like tm8, so an administrator learns it BEFORE the consent screen
 * fails — the one piece of knowledge a preset exists to carry.
 */
import { z } from 'zod';
import { McpServerDefinitionSchema, type McpServerDefinition } from './mcp.js';
import { googleFirstPartyService, type GoogleFirstPartyService } from './mcp-google.js';

const Id = z.string().uuid();
/** Same shape `internal.validate_mcp_definition` admits for `catalogId` (340). */
const CatalogId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
/**
 * A STABLE SLUG, never a URL: the UI maps it to a bundled icon and falls back
 * to a generic one. A catalog that shipped image URLs would add provider egress
 * and a CSP surface to a settings page for nothing (surface ruling S2).
 */
const LogoSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** Matches a `gates` key in the definition, so the two cannot drift apart. */
const GateKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

/**
 * A per-connector tool gate the UI can offer as a toggle (§10.1). Every gate is
 * OFF until an admin opens it — `mcpGateOpen` treats an absent gate as open, so
 * a gated catalog entry ships `gates: {<key>: false}` in its definition and the
 * label lives here.
 */
export const McpCatalogGateSchema = z.object({
  label: z.string().min(1).max(120),
  tools: z.array(z.string().min(1).max(120)).min(1).max(32),
}).strict();
export type McpCatalogGate = z.infer<typeof McpCatalogGateSchema>;

/** Where this catalog entry is already registered in the Space being asked about. */
export const McpCatalogAddedSchema = z.object({ serverId: Id, approved: z.boolean() }).strict();
export type McpCatalogAdded = z.infer<typeof McpCatalogAddedSchema>;

export const McpCatalogEntrySchema = z.object({
  id: CatalogId,
  title: z.string().min(1).max(80),
  summary: z.string().min(1).max(400),
  docsUrl: z.string().url().max(2048),
  requirement: z.string().max(2000).optional(),
  /**
   * `remote` relays to a provider-hosted MCP server; `first_party` is served by
   * tm8's own in-process resource server over the provider API
   * (§8.1). The UI derives its Type column from this plus `definition.transport`
   * rather than from a label computed here.
   */
  kind: z.enum(['remote', 'first_party']),
  logo: LogoSlug,
  category: z.enum(['Development', 'Design', 'Communication', 'Productivity', 'Data', 'Research']).optional(),
  publisher: z.string().min(1).max(80).optional(),
  setup: z.enum(['ready', 'registration', 'approval']).optional(),
  /**
   * False while the entry is announced but not usable yet — the Google cards
   * until the first-party host and its Google OAuth path land (B15). The UI
   * shows "Coming soon" and disables Add and Connect.
   */
  available: z.boolean(),
  /** Readable scope names for the card and the connect screen. The RAW values live in `definition.auth.scopes`. */
  scopeLabels: z.array(z.string().min(1).max(200)).max(64).optional(),
  /**
   * The server environment variable an administrator must set after approval,
   * for a provider that admits only a preregistered confidential client (Slack).
   *
   * IT SITS ON THE ENTRY, NOT IN `definition`. A definition that named a secret
   * variable with no `clientId` is not a valid definition at all (the schema
   * refuses it), and a definition that a MEMBER could submit must name no
   * server secret whatsoever (B13). Keeping it here lets the Connectors form
   * prefill the field while the prefill stays a thing the server can serve and
   * a request can carry.
   */
  clientSecretEnv: z.string().regex(/^TM8_MCP_CLIENT_SECRET_[A-Z0-9_]+$/).max(128).optional(),
  gates: z.record(GateKey, McpCatalogGateSchema).optional(),
  /**
   * The prefill. ABSENT exactly while `available` is false: an entry with no
   * provider endpoint yet must not carry an invented URL that an admin could
   * approve and the proxy could then fetch.
   */
  definition: McpServerDefinitionSchema.optional(),
  /** Only present when `mcp.catalog.list` was asked about a Space (§10.1 "Added"). */
  added: z.array(McpCatalogAddedSchema).max(32).optional(),
}).strict().superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (value.available && !value.definition) reject('an available catalog entry needs a definition');
  if (value.definition) {
    // The join `mcp.catalog.list` and the Discover tab both use is
    // `definition.catalogId` (§5.1), so a mismatch would silently orphan every
    // connector added from this entry.
    if (value.definition.catalogId !== value.id) reject('catalog entry definition must carry catalogId = the entry id');
    if (value.definition.approved) reject('a catalog entry is a prefill, never pre-approved');
    if (value.kind === 'first_party' && value.definition.firstParty !== true) reject('a first-party entry must set firstParty');
    if (value.kind === 'remote' && value.definition.firstParty) reject('a remote entry must not set firstParty');
    for (const gate of Object.keys(value.gates ?? {})) {
      if (value.definition.gates?.[gate] !== false) reject(`gate ${gate} must ship closed in the definition`);
    }
    // A prefill never names a server environment secret. Which variable to set
    // is an administrator's step after approval, carried in `requirement` as
    // prose, so a member requesting a catalog connector cannot put a server
    // secret in front of an approval click (B13).
    if (value.definition.auth.type === 'oauth2' && value.definition.auth.clientSecretEnv) {
      reject('a catalog entry never names an OAuth client secret variable');
    }
  }
});
export type McpCatalogEntry = z.infer<typeof McpCatalogEntrySchema>;
export const McpCatalogListResultSchema = z.object({ items: z.array(McpCatalogEntrySchema) }).strict();
export type McpCatalogListResult = z.infer<typeof McpCatalogListResultSchema>;

const remote = (
  catalogId: string, name: string, url: string, auth: McpServerDefinition['auth'], provenance: string,
): McpServerDefinition => ({
  name, transport: 'http', url, envKeys: [], headerKeys: [], auth, provenance,
  approved: false, enabled: true, catalogId,
});

/**
 * A Google first-party prefill (§8.1/§8.2), built from `GOOGLE_FIRST_PARTY` so
 * the catalog, the SQL catalog (349) and the in-process host share one URL and
 * one scope list. No client id or secret variable: the node's Google client is
 * server configuration (`TM8_GOOGLE_OAUTH_CLIENT_ID`,
 * `TM8_MCP_CLIENT_SECRET_GOOGLE`), never part of a definition.
 */
const google = (
  catalogId: GoogleFirstPartyService['catalogId'], provenance: string, gates?: Record<string, boolean>,
): McpServerDefinition => {
  const service = googleFirstPartyService(catalogId);
  if (!service) throw new Error(`no Google first-party service ${catalogId}`);
  return {
    name: service.name, transport: 'http', url: service.resource, envKeys: [], headerKeys: [],
    auth: { type: 'oauth2', scopes: [...service.scopes] }, provenance,
    approved: false, enabled: true, catalogId, firstParty: true, ...(gates ? { gates } : {}),
  };
};

const GOOGLE_REQUIREMENT = 'Served by tm8 itself: Google hosts no MCP server. A server operator must register a Google OAuth client with <tm8 public origin>/mcp/oauth/callback as its redirect URI and set TM8_GOOGLE_OAUTH_CLIENT_ID and TM8_MCP_CLIENT_SECRET_GOOGLE; until then Connect reports that Google is not configured on this server.';

/** Official MCP tool scopes, including conversation creation. https://docs.slack.dev/ai/slack-mcp-server/ */
const SLACK_SCOPES = [
  'search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im', 'search:read.files', 'search:read.users',
  'channels:history', 'groups:history', 'mpim:history', 'im:history',
  'channels:read', 'groups:read', 'mpim:read', 'im:read', 'users:read', 'users:read.email',
  'chat:write', 'reactions:read', 'reactions:write', 'files:read', 'files:write',
  'canvases:read', 'canvases:write', 'lists:read', 'lists:write', 'emoji:read',
  'channels:write', 'groups:write', 'im:write', 'mpim:write',
];

/** GitHub MCP's official default OAuth scopes. Operators can request additional tool scopes in the connector. */
const GITHUB_SCOPES = ['repo', 'read:org', 'read:user', 'user:email', 'read:packages', 'write:packages', 'read:project', 'project', 'gist', 'notifications'];

/** Curated catalog. Provider adapters live in the reusable integrations package. */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'google.gmail', title: 'Gmail', logo: 'google-gmail', kind: 'first_party', available: true, category: 'Productivity', publisher: 'Google', setup: 'registration',
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides',
    summary: 'Search and read mail, prepare drafts, and send messages when enabled.',
    requirement: GOOGLE_REQUIREMENT + ' Gmail scopes are restricted: past 100 users Google requires app verification and an annual CASA assessment.',
    scopeLabels: ['Read your mail', 'Create drafts', 'Read your labels'],
    gates: { gmailSend: { label: 'Allow sending email', tools: ['send_message'] } },
    definition: google('google.gmail', 'Read email, prepare drafts, and send messages when enabled.', { gmailSend: false }),
  },
  {
    id: 'google.calendar', title: 'Google Calendar', logo: 'google-calendar', kind: 'first_party', available: true, category: 'Productivity', publisher: 'Google', setup: 'registration',
    docsUrl: 'https://developers.google.com/workspace/calendar/api/guides/overview',
    summary: 'List calendars and events, find free time, and create or update events.',
    requirement: GOOGLE_REQUIREMENT + ' Connecting Calendar after Gmail on the same account asks only for the Calendar scopes.',
    scopeLabels: ['Read your calendars and events', 'Create and update events'],
    definition: google('google.calendar', 'Google Calendar served in-process by tm8 (first-party).'),
  },
  {
    id: 'google.drive', title: 'Google Drive', logo: 'google-drive', kind: 'first_party', available: true, category: 'Productivity', publisher: 'Google', setup: 'registration',
    docsUrl: 'https://developers.google.com/workspace/drive/api/guides/about-sdk',
    summary: 'Search files, read documents and export them, in the files you open with tm8.',
    requirement: GOOGLE_REQUIREMENT + ' Drive access is limited to the files you open with tm8, not your whole Drive.',
    scopeLabels: ['Read files you open with tm8', 'Create files'],
    definition: google('google.drive', 'Google Drive served in-process by tm8 (first-party), limited to files opened with tm8.'),
  },
  ...PROVIDERS.map((provider): McpCatalogEntry => ({
    id: provider.id, title: provider.title, logo: provider.id, kind: 'remote', available: true,
    docsUrl: provider.docsUrl, summary: provider.summary, category: provider.category, publisher: provider.publisher,
    setup: provider.auth.kind === 'registered' ? 'registration' : provider.auth.kind === 'approved' ? 'approval' : 'ready',
    ...(provider.requirement ? { requirement: provider.requirement } : {}),
    definition: remote(provider.id, provider.id, provider.endpoint,
      provider.auth.kind === 'none' ? { type: 'none' } : {
        type: 'oauth2', ...('issuer' in provider.auth && provider.auth.issuer ? { issuer: provider.auth.issuer } : {}),
        ...(provider.id === 'slack' ? { scopes: SLACK_SCOPES } : {}),
        ...(provider.id === 'github' ? { scopes: GITHUB_SCOPES } : {}),
      }, `${provider.publisher} official MCP server.`),
  })),
];

export function mcpCatalogEntry(catalogId: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find(entry => entry.id === catalogId);
}
