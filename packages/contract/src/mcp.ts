import { z } from 'zod';

const Id = z.string().uuid();
const Name = z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  .refine(value => value.toLowerCase() !== 'tm8', 'tm8 is reserved');
const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const HeaderKey = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).max(128);
const PublicUrl = z.string().url().max(2048).refine(value => {
  // `new URL` CANNOT be the thing that decides. Zod runs a refinement even
  // after `.url()` has failed, so a malformed value reaches here and an
  // unguarded constructor throws a TypeError straight out of `safeParse` —
  // which the facade can only answer as a 500 about input the caller could have
  // fixed (lead review of #1318, finding 4; the defect is older than that PR
  // and reached every `mcp.servers.*` op that parses a definition).
  let url: URL;
  try { url = new URL(value); } catch { return false; }
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
 *
 * `__` IS THE FIELD SEPARATOR, so a key may not contain one, and may not end in
 * `_` where the separator would complete it. Claude Code splits
 * `mcp__<server>__<tool>` on `__`: a connector keyed `tm8__evil` would present
 * `mcp__tm8__evil__send`, which reads as tm8's OWN server with a tool named
 * `evil__send` — a lookalike whose `mcp__tm8__*` allow-list entry would then
 * quietly deny every real tm8 tool. `tm8_` would do the same thing one
 * character later. Hence alphanumeric segments joined by SINGLE underscores:
 * that shape cannot forge a prefix whatever it is concatenated with.
 *
 * 32 characters, not 64: `mcp__` + key + `__` is the prefix every tool name
 * carries, and model APIs and MCP clients enforce tool-name limits around 64.
 * At 32 the prefix is 39 characters and leaves room for the provider's own tool
 * names; at 64 it was 71 before the tool name even started.
 */
const ServerKey = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
  'a server key is lowercase alphanumeric segments joined by single underscores')
  .max(32).refine(value => value !== 'tm8', 'tm8 is reserved');
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
/**
 * Bridge entry names no connector may take. `tm8` is not another connector's
 * key: it is the name of tm8's OWN entry in every launcher's `--mcp-config`
 * (`server/chat/compose.ts`, `chat/harness-composition.ts`), so a connector
 * that took it would REPLACE the tm8 server and shadow every tm8 tool. Both
 * the Zod `ServerKey` and `internal.validate_mcp_definition` refuse it as an
 * explicit key; this set is what also catches a NAME that normalises onto it
 * (`tm8--` -> `tm8`) in a row written before migration 344 closed that hole.
 */
export const MCP_RESERVED_SERVER_KEYS: ReadonlySet<string> = new Set(['tm8']);
/**
 * The shape `ServerKey` admits, and so the shape a bridge entry name may take:
 * alphanumeric segments joined by SINGLE underscores, because `__` is how
 * `mcp__<server>__<tool>` is split (see `ServerKey` for the lookalike this
 * forbids). Applied here as well as in Zod and in `validate_mcp_definition`, so
 * a key STORED before all three agreed cannot reach a launcher: it fails this
 * test and the connector takes the opaque name instead, which impersonates
 * nothing.
 */
const SERVER_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** 32, so `mcp__<key>__<tool>` stays inside the clients' tool-name limits. */
const SERVER_KEY_MAX = 32;
/** The opaque pre-§4.2 name: readable by nobody, but it collides with nothing. */
function opaqueServerKey(serverId: string): string {
  return `connector_${serverId.replaceAll('-', '')}`;
}
/**
 * What `bind` hands a launcher: the stored selection plus the tool prefix the
 * model will read (§4.2). The key is SERVER-DERIVED from the resolved
 * definition and never client-supplied.
 *
 * It is deliberately NOT stored in the session binding, and the consequence is
 * worth stating plainly rather than implying: every launch — a resume
 * included — recomputes the key from the connector's CURRENT definition, so
 * renaming a connector CHANGES the tool prefix its sessions see from their next
 * start. The agent's earlier transcript then names a prefix that no longer
 * exists. That is the accepted cost of having one source for the key; the
 * alternative, a stored key, means a resumed session advertising a name the
 * Connectors page has stopped using. Routing is unaffected either way: the
 * bridge is invoked with `--connector <serverId>`, never with the key.
 */
export type McpBoundSelection = McpSelection & { serverKey: string };
/**
 * Name each selected connector's bridge entry, so the model sees
 * `mcp__gmail__search_messages` instead of `mcp__connector_<32 hex>__…` (§4.2,
 * G8). Returns `serverId -> entry name`.
 *
 * `serverKey` is the effective key (`mcpServerKey`, mirroring
 * `internal.mcp_effective_server_key`), and migration 340 keeps it unique among
 * the LIVE connectors of a Space. Three things can still collide at launch, so
 * this function, not the database, is what guarantees the launcher gets
 * distinct names:
 *  - connectors registered BEFORE 340, whose names normalise alike (`my-api`
 *    and `my_api`): 340 refuses the next edit to either, but it rewrote no
 *    existing data, by design;
 *  - two names that differ only past `SERVER_KEY_MAX`, since a `name` may be 80
 *    characters and a tool prefix may not;
 *  - `MCP_RESERVED_SERVER_KEYS`.
 *
 * Collisions resolve DETERMINISTICALLY, and deliberately not by the order the
 * selection arrived in: candidates are considered in ascending `serverId`, so
 * one set of connectors always yields one set of names however the launch
 * ordered them, and a resumed session keeps the names it launched with. The
 * loser takes `<key>_2`, then `_3`, and never a name another connector wants.
 * A selection with no `serverKey` — a launch config built by hand, which never
 * went through `bind` — keeps the opaque name.
 */
export function assignMcpServerKeys(
  selections: readonly { serverId: string; serverKey?: string }[],
): Map<string, string> {
  const base = new Map<string, string>();
  for (const selection of selections) {
    // Trailing `_` is stripped AFTER the cut, not before: truncating
    // `linear_team_eu` at a segment boundary would otherwise leave
    // `linear_team_`, which the shape rule rejects, and the connector would
    // lose its readable name to the opaque one over a formatting detail.
    const candidate = (selection.serverKey ?? '').toLowerCase().slice(0, SERVER_KEY_MAX).replace(/_+$/, '');
    base.set(selection.serverId, SERVER_KEY_PATTERN.test(candidate) && !MCP_RESERVED_SERVER_KEYS.has(candidate)
      ? candidate : opaqueServerKey(selection.serverId));
  }
  const wanted = new Set(base.values());
  const taken = new Set<string>();
  const assigned = new Map<string, string>();
  for (const serverId of [...base.keys()].sort()) {
    const want = base.get(serverId)!;
    if (!taken.has(want)) { taken.add(want); assigned.set(serverId, want); continue; }
    // A suffix must fit the key shape AND be nobody else's first choice. The
    // stem is re-trimmed after its own cut for the same reason the candidate
    // is: a stem ending in `_` would make `<stem>__2`, which carries the field
    // separator the shape rule exists to keep out of a key.
    const stem = want.slice(0, SERVER_KEY_MAX - 3).replace(/_+$/, '') || want.slice(0, 1);
    let key = opaqueServerKey(serverId);
    for (let n = 2; n <= 99; n += 1) {
      const next = `${stem}_${n}`;
      if (!taken.has(next) && !wanted.has(next)) { key = next; break; }
    }
    taken.add(key);
    assigned.set(serverId, key);
  }
  return assigned;
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
/**
 * What a non-admin may ASK for (§11 `mcp.servers.request`, B13/B23). It is the
 * ordinary definition schema minus everything a member must not be able to put
 * in front of an admin's approval click:
 *
 *  - `approved` is false, so the connector is inert the moment it exists:
 *    resolve and bind refuse it, and `test` and `oauth.begin` both go through
 *    `approved()` first, so NOTHING fetches a requested URL before an admin
 *    says yes.
 *  - stdio is refused outright — a local command is an admin-and-node-trust
 *    decision, never a request. HTTPS only, for the same reason.
 *  - `clientSecretEnv` is refused: a member must not name a server environment
 *    secret for an admin to approve by accident. An admin sets it afterwards.
 *  - the trust and reach flags (`stdioTrusted`, `allowPrivateNetwork`,
 *    `defaultOn`, `allowExternalClients`, `firstParty`) and `gates` are refused,
 *    so a request can never arrive pre-armed.
 *  - `catalogId`, `serverKey` and `provenance` are refused, because all three
 *    are CLAIMS ABOUT IDENTITY rather than configuration (B23): the provider's
 *    face in Discover, the tool prefix the model reads, and the line an
 *    administrator reads before approving. A CATALOG request names its entry by
 *    `catalogId` on the REQUEST and the server supplies the definition, so a
 *    member never gets to pair a provider's name with their own URL.
 */
export const McpRequestedServerDefinitionSchema = McpServerDefinitionSchema.superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (value.transport !== 'http') reject('a requested connector must be an HTTP connector');
  if (value.approved) reject('a requested connector cannot arrive approved');
  // `url` has already passed `PublicUrl`, so it parses — but only when it is
  // PRESENT, and an http-transport definition with no url fails a different
  // refinement that does not stop this one from running. Constructing `new URL`
  // on undefined would throw a TypeError out of the schema, which the facade
  // can only answer as a 500 (lead review, finding 4).
  if (value.url === undefined || !value.url.startsWith('https://')) reject('a requested connector needs an https URL');
  if (value.auth.type === 'oauth2' && value.auth.clientSecretEnv) reject('an administrator sets the OAuth client secret after approval');
  for (const field of ['stdioTrusted', 'allowPrivateNetwork', 'defaultOn', 'allowExternalClients', 'firstParty'] as const) {
    if (value[field] !== undefined) reject(`only an administrator sets ${field}`);
  }
  if (value.gates) reject('only an administrator sets tool gates');
  for (const field of ['catalogId', 'serverKey', 'provenance'] as const) {
    if (value[field] !== undefined) reject(`a custom connector request cannot claim ${field}; name a catalogId on the request instead`);
  }
});

/**
 * §11 `mcp.servers.request` — a MEMBER asks the Space's admins to add a
 * connector. Exactly one of `catalogId` or `definition`:
 *
 *  - `catalogId` names a §8.2 entry and the SERVER supplies its definition. A
 *    member never gets to send the URL or auth of a catalog connector, so a
 *    request that looks like "please add Slack" cannot smuggle in a different
 *    endpoint for an admin to approve by eye.
 *  - `definition` is a custom connector, narrowed by
 *    `McpRequestedServerDefinitionSchema` to the inert shape of §10.1: HTTPS
 *    only, unapproved, and none of the admin-only trust flags (B13).
 */
export const McpServerRequestInputSchema = z.object({ ...Command,
  // The Space is addressed by the PATH (`/v2/spaces/:spaceId/mcp/servers/request`)
  // and so is absent here, like every `:id`-addressed `chat.*` command: two
  // places to name one Space is two places for them to disagree, and the body
  // is what the facade validates.
  catalogId: CatalogId.optional(), definition: McpRequestedServerDefinitionSchema.optional(),
  note: z.string().min(1).max(500).optional() }).strict()
  .refine(value => Boolean(value.catalogId) !== Boolean(value.definition),
    'a connector request names exactly one of catalogId or definition');
export type McpServerRequestInput = z.infer<typeof McpServerRequestInputSchema>;

/**
 * `chat.setMcpSelections` (§5.3, G4) — change a LIVE thread's connectors.
 *
 * The chat is addressed by the path (`/v2/chats/:id/mcp-selections`), like every
 * other `chat.*` command, so it is deliberately absent from the body.
 *
 * `null` DELETES the stored selection, which puts the thread back on the
 * default set resolved fresh at each turn; `[]` means every connector off; a
 * non-empty list replaces the selection. That is the same three-way meaning
 * `McpSelectionsSchema` documents for launch, so a thread and a session read
 * the field identically.
 */
// `clientMutationId` is OPTIONAL here, unlike every `mcp.*` command: this is a
// `chat.*` operation and the family's DTOs take it optionally (`chat.setModel`),
// and the write itself is idempotent by construction — an upsert of the same
// list leaves the same row, so it needs no ledger entry to be safe to retry.
export const SetChatMcpSelectionsInputSchema = z.object({
  clientMutationId: z.string().min(1).optional(), actorId: Id.optional(),
  mcpSelections: McpSelectionsSchema.nullable() }).strict();
export type SetChatMcpSelectionsInput = z.infer<typeof SetChatMcpSelectionsInputSchema>;
/** The stored value AFTER the write, so a client never has to assume its own write landed. */
export const ChatMcpSelectionsResultSchema = z.object({ chatId: Id,
  mcpSelections: z.array(McpSelectionSchema).nullable() }).strict();
export type ChatMcpSelectionsResult = z.infer<typeof ChatMcpSelectionsResultSchema>;

export const McpProxyRequestInputSchema = z.object({ sessionId: Id, serverId: Id, message: z.record(z.unknown()) }).strict();

export const McpServerListResultSchema = z.object({ items: z.array(McpServerViewSchema), nextCursor: z.string().nullable(), allowed: z.object({ register: z.boolean(), attach: z.boolean() }).strict() }).strict();
export type McpServerListResult = z.infer<typeof McpServerListResultSchema>;
export const McpCredentialRotateInputSchema = z.object({ ...Command, credentialId: Id, secret: z.string().min(1).max(65536) }).strict();

/**
 * One row of `mcp_call_audit` (§5.6, G10). References, sizes and outcomes
 * only: no arguments, no results, no tokens. `denied` rows carry the reason;
 * `rootMemberId` and `chain` are what bind recorded on the session's binding.
 */
export const McpCallAuditOutcomeSchema = z.enum(['started', 'succeeded', 'failed', 'denied', 'refreshed']);
export type McpCallAuditOutcome = z.infer<typeof McpCallAuditOutcomeSchema>;
export const McpCallAuditRowSchema = z.object({
  id: z.string(), spaceId: Id, sessionId: Id, chatId: Id.nullable(), serverId: Id,
  credentialId: Id.nullable(), credentialScope: z.enum(['member', 'space']).nullable(),
  method: z.enum(['tools/list', 'tools/call']), tool: z.string().nullable(), outcome: McpCallAuditOutcomeSchema,
  denyReason: z.string().nullable(), rootMemberId: Id.nullable(), chain: z.array(Id),
  via: z.enum(['session', 'chat']).nullable(),
  latencyMs: z.number().int().nullable(), requestBytes: z.number().int().nullable(), responseBytes: z.number().int().nullable(),
  occurredAt: z.string(),
}).strict();
export type McpCallAuditRow = z.infer<typeof McpCallAuditRowSchema>;
/** `scope` says what the caller was allowed to see: the whole Space (admin) or their own calls. */
export const McpAuditListResultSchema = z.object({
  items: z.array(McpCallAuditRowSchema), nextCursor: z.string().nullable(), scope: z.enum(['space', 'own']),
}).strict();
export type McpAuditListResult = z.infer<typeof McpAuditListResultSchema>;
