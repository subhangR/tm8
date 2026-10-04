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

export const McpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('api_key'), headerName: HeaderKey.optional(), envKey: EnvKey.optional(),
    prefix: z.enum(['Bearer', 'none']).optional() }).strict(),
  z.object({ type: z.literal('oauth2'), authorizationUrl: PublicUrl.optional(), tokenUrl: PublicUrl.optional(),
    clientId: z.string().min(1).max(512).optional(), scopes: z.array(z.string().min(1).max(256)).max(32).optional() }).strict(),
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
}).strict().superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (value.transport === 'stdio' && (!value.command || value.url || value.headerKeys.length)) reject('stdio requires command and forbids url and headerKeys');
  if (value.transport === 'http' && (!value.url || value.command || value.args || value.envKeys.length)) reject('http requires url and forbids command, args and envKeys');
  if (value.transport === 'stdio' && value.auth.type === 'oauth2') reject('OAuth requires HTTP transport');
  if (value.auth.type !== 'api_key' && (value.envKeys.length || value.headerKeys.length)) reject('only API key auth declares a secret slot');
  if (value.auth.type === 'api_key') {
    if (value.envKeys.length + value.headerKeys.length !== 1) reject('API key auth requires exactly one secret slot');
    if (value.transport === 'http' && (!value.auth.headerName || value.auth.envKey || !value.headerKeys.includes(value.auth.headerName))) reject('HTTP API key requires a declared headerName');
    if (value.transport === 'stdio' && (!value.auth.envKey || value.auth.headerName || !value.envKeys.includes(value.auth.envKey))) reject('stdio API key requires a declared envKey');
  }
  if (new Set(value.envKeys).size !== value.envKeys.length || new Set(value.headerKeys.map(k => k.toLowerCase())).size !== value.headerKeys.length) reject('duplicate secret keys');
});
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;
export const McpServerEntitySchema = z.object({ kind: z.literal('mcp_server'), definition: McpServerDefinitionSchema }).strict();
export type McpServerEntity = z.infer<typeof McpServerEntitySchema>;
export const McpSelectionSchema = z.object({ serverId: Id, credentialId: Id.optional() }).strict();
export type McpSelection = z.infer<typeof McpSelectionSchema>;
/** Omitted = authorized attachment defaults; [] = disabled; nonempty = full replacement. */
export const McpSelectionsSchema = z.array(McpSelectionSchema).max(32).refine(
  selections => new Set(selections.map(s => s.serverId)).size === selections.length, 'duplicate server selection');
export const McpReadinessReasonSchema = z.enum(['ready', 'not_approved', 'stdio_not_trusted', 'credential_required',
  'credential_unavailable', 'credential_revoked', 'credential_expired', 'server_unavailable', 'access_denied', 'disabled']);
export type McpReadinessReason = z.infer<typeof McpReadinessReasonSchema>;
export const McpCredentialViewSchema = z.object({
  id: Id, serverId: Id, label: z.string(), authType: z.enum(['api_key', 'oauth2']),
  visibility: z.enum(['private', 'selected', 'space']), ownerId: Id, sharedMemberIds: z.array(Id),
  usable: z.boolean(), manageable: z.boolean(), revoked: z.boolean(), reason: McpReadinessReasonSchema,
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
}).strict();
export type McpResolvedSelection = z.infer<typeof McpResolvedSelectionSchema>;
export const McpResolveResultSchema = z.object({ selections: z.array(McpResolvedSelectionSchema), ready: z.boolean() }).strict();
export type McpResolveResult = z.infer<typeof McpResolveResultSchema>;
const Command = { clientMutationId: z.string().min(1), actorId: Id.optional() };
export const McpServerCreateInputSchema = z.object({ ...Command, spaceId: Id, definition: McpServerDefinitionSchema }).strict();
export const McpServerUpdateInputSchema = z.object({ ...Command, serverId: Id, expectedVersion: z.number().int().positive(), definition: McpServerDefinitionSchema }).strict();
export const McpServerDeleteInputSchema = z.object({ ...Command, serverId: Id, expectedVersion: z.number().int().positive() }).strict();
export const McpServerImportInputSchema = z.object({ ...Command, spaceId: Id, definitions: z.array(McpServerDefinitionSchema).min(1).max(32) }).strict();
export const McpServerTestInputSchema = z.object({ ...Command, serverId: Id, credentialId: Id.optional() }).strict();
export const McpResolveInputSchema = z.object({ spaceId: Id, targetIds: z.array(Id).max(32).optional(), teamMemberId: Id.optional(), mcpSelections: McpSelectionsSchema.optional() }).strict();
export type McpResolveInput = z.infer<typeof McpResolveInputSchema>;
export const McpCredentialCreateInputSchema = z.object({ ...Command, serverId: Id, label: z.string().min(1).max(120), secret: z.string().min(1).max(65536) }).strict();
export const McpCredentialCommandInputSchema = z.object({ ...Command, credentialId: Id }).strict();
export const McpCredentialShareInputSchema = z.object({ ...Command, credentialId: Id, visibility: z.enum(['private', 'selected', 'space']), memberIds: z.array(Id).max(100) }).strict();
export const McpOAuthBeginInputSchema = z.object({ ...Command, serverId: Id, label: z.string().min(1).max(120) }).strict();
export const McpOAuthCallbackInputSchema = z.object({ state: z.string().min(1), code: z.string().min(1) }).strict();
export const McpProxyRequestInputSchema = z.object({ sessionId: Id, serverId: Id, message: z.record(z.unknown()) }).strict();

export const McpServerListResultSchema = z.object({ items: z.array(McpServerViewSchema), nextCursor: z.string().nullable(), allowed: z.object({ register: z.boolean(), attach: z.boolean() }).strict() }).strict();
export type McpServerListResult = z.infer<typeof McpServerListResultSchema>;
export const McpCredentialRotateInputSchema = z.object({ ...Command, credentialId: Id, secret: z.string().min(1).max(65536) }).strict();
