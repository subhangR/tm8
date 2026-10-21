import { z } from 'zod';

const Id = z.string().uuid();
const Name = z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  .refine(value => value.toLowerCase() !== 'tm8', 'tm8 is reserved');
const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const HeaderKey = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).max(128);
const PublicUrl = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search;
}, 'URLs must be HTTP(S) without credentials, query secrets or fragments');

/**
 * Names the server environment variable holding a preregistered client's secret
 * (Slack's MCP server, for one, admits only preregistered confidential clients).
 * The prefix confines it: a connector definition must never be able to send an
 * arbitrary server variable, such as a database URL, to a token endpoint.
 */
const ClientSecretEnv = z.string().regex(/^TM8_MCP_CLIENT_SECRET_[A-Z0-9_]+$/).max(128);

/** The Discover preset a connector came from: `google.gmail`, `figma`, `notion`. */
const CatalogId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
/**
 * The readable tool prefix (§4.2). The model sees `mcp__<serverKey>__<tool>`, so
 * it is confined to what a tool name admits, and `tm8` is reserved for tm8's own
 * tools. Optional: absent, the key is the normalised name (`mcpServerKey`), so
 * every definition stored before this field existed still has one.
 */
const ServerKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).max(64)
  .refine(value => value !== 'tm8', 'tm8 is reserved');
/** Per-connector tool gates, e.g. `{gmailSend: false}`. Names to booleans only. */
const ToolGates = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.boolean())
  .refine(value => Object.keys(value).length <= 32, 'at most 32 tool gates');

export const McpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('api_key'), headerName: HeaderKey.optional(), envKey: EnvKey.optional(),
    prefix: z.enum(['Bearer', 'none']).optional() }).strict(),
  z.object({ type: z.literal('oauth2'), issuer: PublicUrl.optional(), authorizationUrl: PublicUrl.optional(), tokenUrl: PublicUrl.optional(),
    clientId: z.string().min(1).max(512).optional(), clientSecretEnv: ClientSecretEnv.optional(),
    scopes: z.array(z.string().min(1).max(256)).max(32).optional() }).strict(),
]);

/** Definition metadata only. Literal env/header values are never graph content. */
export const McpServerDefinitionSchema = z.object({
  name: Name,
  transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).max(1024).optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  url: PublicUrl.optional(),
  envKeys: z.array(EnvKey).max(32),
  headerKeys: z.array(HeaderKey).max(32),
  auth: McpAuthSchema,
  provenance: z.string().max(2048).optional(),
  approved: z.boolean(),
  enabled: z.boolean().optional(),
  stdioTrusted: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  catalogId: CatalogId.optional(),
  serverKey: ServerKey.optional(),
  defaultOn: z.boolean().optional(),
  allowExternalClients: z.boolean().optional(),
  firstParty: z.boolean().optional(),
  gates: ToolGates.optional(),
}).strict().superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (value.transport === 'stdio' && (!value.command || value.url || value.headerKeys.length)) reject('stdio requires command and forbids url and headerKeys');
  if (value.transport === 'http' && (!value.url || value.command || value.args || value.envKeys.length)) reject('http requires url and forbids command, args and envKeys');
  if (value.transport === 'stdio' && value.auth.type === 'oauth2') reject('OAuth requires HTTP transport');
  if (value.auth.type !== 'api_key' && (value.envKeys.length || value.headerKeys.length)) reject('only API key auth declares a secret slot');
  if (value.auth.type === 'oauth2' && value.auth.clientSecretEnv && !value.auth.clientId) reject('OAuth client secret requires a client id');
  if (value.auth.type === 'api_key') {
    if (value.envKeys.length + value.headerKeys.length !== 1) reject('API key auth requires exactly one secret slot');
    if (value.transport === 'http' && (!value.auth.headerName || value.auth.envKey || !value.headerKeys.includes(value.auth.headerName))) reject('HTTP API key requires a declared headerName');
    if (value.transport === 'stdio' && (!value.auth.envKey || value.auth.headerName || !value.envKeys.includes(value.auth.envKey))) reject('stdio API key requires a declared envKey');
  }
  if (new Set(value.envKeys).size !== value.envKeys.length || new Set(value.headerKeys.map(k => k.toLowerCase())).size !== value.headerKeys.length) reject('duplicate secret keys');
});
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;
/**
 * The connector's tool prefix: its explicit `serverKey`, or the normalised name
 * when it has none (§4.2). MUST stay in step with
 * `internal.mcp_effective_server_key` (migration 340), which is what enforces
 * uniqueness within a Space — the two are one rule in two languages.
 */
export function mcpServerKey(definition: Pick<McpServerDefinition, 'name'> & { serverKey?: string }): string {
  if (definition.serverKey) return definition.serverKey;
  const normalised = definition.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(normalised) ? normalised : `c${normalised}`;
}
/** Whether a per-connector tool gate is open. An absent gate is open. */
export function mcpGateOpen(definition: Pick<McpServerDefinition, 'gates'>, gate: string): boolean {
  return definition.gates?.[gate] !== false;
}
export const McpServerEntitySchema = z.object({ kind: z.literal('mcp_server'), definition: McpServerDefinitionSchema }).strict();
export type McpServerEntity = z.infer<typeof McpServerEntitySchema>;
export const McpSelectionSchema = z.object({ serverId: Id, credentialId: Id.optional() }).strict();
export type McpSelection = z.infer<typeof McpSelectionSchema>;
/** Omitted = authorized attachment defaults; [] = disabled; nonempty = full replacement. */
export const McpSelectionsSchema = z.array(McpSelectionSchema).max(32).refine(
  selections => new Set(selections.map(s => s.serverId)).size === selections.length, 'duplicate server selection');
export const McpReadinessReasonSchema = z.enum(['ready', 'not_approved', 'stdio_not_trusted', 'credential_required',
  'credential_unavailable', 'credential_revoked', 'credential_expired', 'credential_definition_changed', 'server_unavailable', 'access_denied', 'disabled',
  /** The row is intact but the provider will not honour it; see `statusReason`. */
  'needs_reconnect',
  /**
   * The stored definition cannot be read as one — today only a connector with no
   * `name`, which the validator forbids and no supported write can produce. It
   * is reported rather than silently dropped, and ONLY ever skips a DEFAULT: an
   * explicit selection naming such a connector still refuses (B9).
   */
  'invalid_definition',
  /**
   * No human is provably behind this launch, so no connection may be lent to
   * it (§6.1). It is the LOOP-EXECUTOR shape and its kin: a bind whose claims
   * are neither a human bearer (browser/cli) nor an agent bearer with a live
   * launcher binding — today the in-process scheduler, which spawns under the
   * node's loopback owner with no `authKind` at all, and a legacy chat whose
   * `requesterAuthKind` was never recorded. Without this the §3 resolver's
   * first tier would hand such a launch the NODE OWNER's own personal
   * connection. Only connectors that need no account are bound; every connector
   * that needs one is reported here instead, whether it came from `defaultOn`,
   * an `equips` attachment or an explicit selection.
   */
  'no_human_provenance']);
/** Who owns a connection: a member ("Just me") or the Space ("Shared with Space"). */
export const McpCredentialScopeSchema = z.enum(['member', 'space']);
export type McpCredentialScope = z.infer<typeof McpCredentialScopeSchema>;
/** Why a connection stopped being honoured (§5.2, §7.2). Never a secret. */
export const McpCredentialStatusReasonSchema = z.enum(['invalid_grant', 'security_revision_changed', 'scope_reduced', 'possible_reuse']);
export type McpCredentialStatusReason = z.infer<typeof McpCredentialStatusReasonSchema>;
/** How §3's order picked the connection a session uses. */
export const McpCredentialSourceSchema = z.enum(['pinned', 'personal', 'space_shared']);
export type McpCredentialSource = z.infer<typeof McpCredentialSourceSchema>;
export type McpReadinessReason = z.infer<typeof McpReadinessReasonSchema>;
export const McpCredentialViewSchema = z.object({
  id: Id, serverId: Id, label: z.string(), authType: z.enum(['api_key', 'oauth2']),
  visibility: z.enum(['private', 'selected', 'space']),
  /** Null on a Space-owned connection: it has no member owner (§5.2, G2). */
  ownerId: Id.nullable(), ownerLabel: z.string().max(200).optional(), sharedMemberIds: z.array(Id),
  usable: z.boolean(), manageable: z.boolean(), revoked: z.boolean(), reason: McpReadinessReasonSchema,
  scope: McpCredentialScopeSchema.optional(),
  status: z.enum(['pending', 'active', 'stale', 'revoked', 'needs_reconnect']).optional(),
  statusReason: McpCredentialStatusReasonSchema.nullable().optional(),
  /** The provider's own name for the account, e.g. "subhang@gmail.com". */
  accountLabel: z.string().max(200).nullable().optional(),
  grantedScopes: z.array(z.string().max(1024)).max(64).optional(),
  lastUsedAt: z.string().nullable().optional(), lastRefreshAt: z.string().nullable().optional(),
}).strict();
export type McpCredentialView = z.infer<typeof McpCredentialViewSchema>;
export const McpToolSchema = z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.unknown()) }).strict();
export const McpTestResultSchema = z.object({ ready: z.boolean(), reason: McpReadinessReasonSchema, tools: z.array(McpToolSchema), checkedAt: z.string() }).strict();
export type McpTestResult = z.infer<typeof McpTestResultSchema>;
export const McpServerViewSchema = z.object({
  id: Id, spaceId: Id, version: z.number().int(), definition: McpServerDefinitionSchema,
  health: McpTestResultSchema.optional(),
  allowed: z.object({ register: z.boolean(), approve: z.boolean(), manage: z.boolean(), attach: z.boolean() }).strict(),
}).strict();
export type McpServerView = z.infer<typeof McpServerViewSchema>;
export const McpResolvedSelectionSchema = z.object({
  server: McpServerViewSchema, credentialId: Id.optional(), ready: z.boolean(), reason: McpReadinessReasonSchema,
  /** How the account was chosen (§3). Absent when the connector needs none. */
  credentialSource: McpCredentialSourceSchema.optional(),
  /** True when the connector came from the default set, not an explicit pick. */
  fromDefault: z.boolean().optional(),
  /** A connection owned by the root that exists but is not usable, so the UI can show ⚠ even when a shared one carried the launch. */
  unusableCredential: z.object({ credentialId: Id, reason: McpReadinessReasonSchema }).strict().optional(),
}).strict();
export type McpResolvedSelection = z.infer<typeof McpResolvedSelectionSchema>;
/**
 * `skipped` holds defaults that resolved to no usable connection (G15). They are
 * dropped from `selections` rather than failing the launch (§7.3); an EXPLICIT
 * selection that is not ready still shows up in `selections` with `ready:false`.
 */
/** `name` is empty when the definition is what was wrong with it. */
export const McpSkippedSelectionSchema = z.object({ serverId: Id, name: z.string(), reason: McpReadinessReasonSchema }).strict();
export type McpSkippedSelection = z.infer<typeof McpSkippedSelectionSchema>;
export const McpResolveResultSchema = z.object({ selections: z.array(McpResolvedSelectionSchema), ready: z.boolean(),
  skipped: z.array(McpSkippedSelectionSchema).optional() }).strict();
export type McpResolveResult = z.infer<typeof McpResolveResultSchema>;
const Command = { clientMutationId: z.string().min(1), actorId: Id.optional() };
export const McpServerCreateInputSchema = z.object({ ...Command, spaceId: Id, definition: McpServerDefinitionSchema }).strict();
export const McpServerUpdateInputSchema = z.object({ ...Command, serverId: Id, expectedVersion: z.number().int().positive(), definition: McpServerDefinitionSchema }).strict();
export const McpServerDeleteInputSchema = z.object({ ...Command, serverId: Id, expectedVersion: z.number().int().positive() }).strict();
export const McpServerImportInputSchema = z.object({ ...Command, spaceId: Id, definitions: z.array(McpServerDefinitionSchema).min(1).max(32) }).strict();
export const McpServerTestInputSchema = z.object({ ...Command, serverId: Id, credentialId: Id.optional() }).strict();
export const McpResolveInputSchema = z.object({ spaceId: Id, targetIds: z.array(Id).max(32).optional(), teamMemberId: Id.optional(), mcpSelections: McpSelectionsSchema.optional() }).strict();
export type McpResolveInput = z.infer<typeof McpResolveInputSchema>;
export const McpCredentialCreateInputSchema = z.object({ ...Command, serverId: Id, label: z.string().min(1).max(120), secret: z.string().min(1).max(65536),
  /** `space` needs a Space admin and creates a Space-owned row (§5.2). */
  scope: McpCredentialScopeSchema.optional(), accountLabel: z.string().min(1).max(200).optional() }).strict();
export const McpCredentialCommandInputSchema = z.object({ ...Command, credentialId: Id }).strict();
export const McpCredentialShareInputSchema = z.object({ ...Command, credentialId: Id, visibility: z.enum(['private', 'selected', 'space']), memberIds: z.array(Id).max(100) }).strict();
/**
 * Where a same-tab sign-in lands afterwards (§10.2, popup blocked): a path on
 * tm8's own origin, never a URL. `//host` and `\` are refused because browsers
 * read both as another origin.
 */
const SameOriginPath = z.string().min(1).max(2048).refine(
  value => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value),
  'returnTo must be a path on this origin');
// `scope` and `returnTo` (§11) ride the durable pending row of §5.4
// (`scope_kind`, `return_to`), which is how they survive the provider redirect.
export const McpOAuthBeginInputSchema = z.object({ ...Command, serverId: Id, label: z.string().min(1).max(120),
  /** `space` needs a Space admin, checked at begin and again at callback (§5.2). */
  scope: McpCredentialScopeSchema.optional(), returnTo: SameOriginPath.optional() }).strict();
export const McpOAuthCallbackInputSchema = z.object({ state: z.string().min(1).max(2048), code: z.string().min(1).max(8192).optional(), error: z.string().min(1).max(128).optional(), issuer: PublicUrl.optional() }).strict().refine(value => Boolean(value.code) !== Boolean(value.error), 'OAuth callback requires exactly one of code or error');
export const McpProxyRequestInputSchema = z.object({ sessionId: Id, serverId: Id, message: z.record(z.unknown()) }).strict();

export const McpServerListResultSchema = z.object({ items: z.array(McpServerViewSchema), nextCursor: z.string().nullable(), allowed: z.object({ register: z.boolean(), attach: z.boolean() }).strict() }).strict();
export type McpServerListResult = z.infer<typeof McpServerListResultSchema>;
export const McpCredentialRotateInputSchema = z.object({ ...Command, credentialId: Id, secret: z.string().min(1).max(65536) }).strict();
