import { z } from 'zod';
import { CollabError, type McpUnavailableTool } from '@tm8/contract';
import { FIGMA_NATIVE, jsonSchema } from '@tm8/integrations';
import type { McpOAuthSecret } from '../credential-store.js';
import { mcpHttp } from '../transport.js';
import { OAuthTokenError, oauthErrorCode, type McpFirstPartyAuthorization, type OAuthClient } from '../oauth.js';
import { FirstPartyRefused, FirstPartyUnauthorized, type FirstPartyConnection, type FirstPartyDefinition, type FirstPartyOAuthHost } from './host.js';

interface Endpoints { api: string; issuer: string; authorization: string; token: string; refresh: string }
const ENDPOINTS: Endpoints = { api: 'https://api.figma.com/v1', issuer: 'https://www.figma.com', authorization: 'https://www.figma.com/oauth',
  token: 'https://api.figma.com/v1/oauth/token', refresh: 'https://api.figma.com/v1/oauth/refresh' };
export interface FigmaHostOptions {
  client: () => { clientId: string; clientSecret: string } | undefined;
  /** Test fixtures only; no endpoint comes from a connector definition. */
  endpoints?: Endpoints;
  privateNetwork?: boolean;
}
export const FIGMA_NOT_CONFIGURED = 'Figma is not configured on this server: set TM8_MCP_CLIENT_ID_FIGMA_API and TM8_MCP_CLIENT_SECRET_FIGMA_API';
class FigmaApiError extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds?: number) { super(`Figma API request failed (HTTP ${status})`); }
}
type Query = Record<string, string | number | undefined>;
type Api = (path: string, query?: Query, method?: 'GET'|'POST'|'PUT'|'DELETE', body?: unknown) => Promise<unknown>;
interface Tool { name: string; description: string; scopes: string[]; write?: boolean; destructive?: boolean; input: z.ZodTypeAny; run(api: Api, input: unknown): Promise<unknown> }
function tool<T extends z.ZodTypeAny>(name: string, description: string, scope: string, input: T, run: (api: Api, input: z.output<T>) => Promise<unknown>): Tool {
  return { name, description, scopes: [scope], input, run: (api, raw) => run(api, input.parse(raw)) };
}
const fileKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).describe('Figma file key from its URL, not the whole URL.');
const nodeId = z.string().min(1).max(100).regex(/^[A-Za-z0-9:_-]+$/);
const TOOLS: readonly Tool[] = [
  tool('get_current_user', 'Read the connected Figma account profile.', 'current_user:read', z.object({}).strict(), api => api('/me')),
  tool('get_file', 'Read a Figma file and its design node tree. Start with a shallow depth, then fetch specific nodes.', 'file_content:read',
    z.object({ fileKey, depth: z.number().int().min(1).max(10).default(2), version: z.string().max(100).optional() }).strict(),
    (api, input) => api(`/files/${input.fileKey}`, { depth: input.depth, version: input.version })),
  tool('get_file_nodes', 'Read specific nodes from a Figma file, including their design properties.', 'file_content:read',
    z.object({ fileKey, ids: z.array(nodeId).min(1).max(50), depth: z.number().int().min(1).max(10).optional() }).strict(),
    (api, input) => api(`/files/${input.fileKey}/nodes`, { ids: input.ids.join(','), depth: input.depth })),
  tool('get_file_metadata', 'Read metadata for an accessible Figma file.', 'file_metadata:read', z.object({ fileKey }).strict(),
    (api, input) => api(`/files/${input.fileKey}/meta`)),
  tool('get_file_comments', 'Read comments on an accessible Figma file.', 'file_comments:read', z.object({ fileKey }).strict(),
    (api, input) => api(`/files/${input.fileKey}/comments`)),
  tool('get_file_versions', 'Read version history for an accessible Figma file.', 'file_versions:read', z.object({ fileKey }).strict(),
    (api, input) => api(`/files/${input.fileKey}/versions`)),
  tool('get_images', 'Get rendered image URLs for selected Figma nodes. No image URL is fetched by this tool.', 'file_content:read',
    z.object({ fileKey, ids: z.array(nodeId).min(1).max(20), format: z.enum(['png', 'jpg', 'svg']).default('png'), scale: z.number().min(0.1).max(4).default(1) }).strict(),
    (api, input) => api(`/images/${input.fileKey}`, { ids: input.ids.join(','), format: input.format, scale: input.scale })),
  {...tool('post_comment', 'Post a comment to an accessible Figma file.', 'file_comments:write',
    z.object({fileKey,message:z.string().min(1).max(20000),commentId:nodeId.optional()}).strict(),
    (api,i)=>api(`/files/${i.fileKey}/comments`,undefined,'POST',{message:i.message,...(i.commentId?{comment_id:i.commentId}:{})})),write:true},
  {...tool('delete_comment', 'Delete your own comment. This permanently removes the comment.', 'file_comments:write',
    z.object({fileKey,commentId:nodeId}).strict(),(api,i)=>api(`/files/${i.fileKey}/comments/${i.commentId}`,undefined,'DELETE')),write:true,destructive:true},
  tool('get_comment_reactions','Read reactions on a file comment.','file_comments:read',z.object({fileKey,commentId:nodeId}).strict(),
    (api,i)=>api(`/files/${i.fileKey}/comments/${i.commentId}/reactions`)),
  {...tool('post_comment_reaction','Add your reaction to a file comment.','file_comments:write',z.object({fileKey,commentId:nodeId,emoji:z.string().min(1).max(100)}).strict(),
    (api,i)=>api(`/files/${i.fileKey}/comments/${i.commentId}/reactions`,undefined,'POST',{emoji:i.emoji})),write:true},
  {...tool('delete_comment_reaction','Remove your reaction from a file comment.','file_comments:write',z.object({fileKey,commentId:nodeId,emoji:z.string().min(1).max(100)}).strict(),
    (api,i)=>api(`/files/${i.fileKey}/comments/${i.commentId}/reactions`,{emoji:i.emoji},'DELETE')),write:true},
  tool('get_dev_resources','Read development links attached to file nodes.','file_dev_resources:read',z.object({fileKey,ids:z.array(nodeId).min(1).max(50).optional()}).strict(),
    (api,i)=>api(`/files/${i.fileKey}/dev_resources`,{node_ids:i.ids?.join(',')})),
  {...tool('create_dev_resource','Attach a development link to a file node.','file_dev_resources:write',z.object({fileKey,nodeId,name:z.string().min(1).max(200),url:z.string().url().max(2048)}).strict(),
    (api,i)=>api('/dev_resources',undefined,'POST',{dev_resources:[{file_key:i.fileKey,node_id:i.nodeId,name:i.name,url:i.url}]})),write:true},
  {...tool('update_dev_resource','Update a development link.','file_dev_resources:write',z.object({id:nodeId,name:z.string().min(1).max(200).optional(),url:z.string().url().max(2048).optional()}).strict(),
    (api,i)=>api('/dev_resources',undefined,'PUT',{dev_resources:[i]})),write:true},
  {...tool('delete_dev_resource','Delete a development link from a file.','file_dev_resources:write',z.object({fileKey,id:nodeId}).strict(),
    (api,i)=>api(`/files/${i.fileKey}/dev_resources/${i.id}`,undefined,'DELETE')),write:true,destructive:true},
  ...(['components','component_sets','styles'] as const).flatMap(kind=>[
    tool(`get_file_${kind}`,`Read published ${kind.replace('_',' ')} from a file.`,'library_content:read',z.object({fileKey}).strict(),(api,i)=>api(`/files/${i.fileKey}/${kind}`)),
    tool(`get_team_${kind}`,`Read published ${kind.replace('_',' ')} from a team.`,'team_library_content:read',z.object({teamId:fileKey,pageSize:z.number().int().min(1).max(1000).default(30),after:z.number().int().optional(),before:z.number().int().optional()}).strict(),
      (api,i)=>api(`/teams/${i.teamId}/${kind}`,{page_size:i.pageSize,after:i.after,before:i.before})),
    tool(`get_${kind==='styles'?'style':kind==='components'?'component':'component_set'}`,`Read published ${kind.replace('_',' ')} metadata by key.`,'library_assets:read',z.object({key:fileKey}).strict(),(api,i)=>api(`/${kind}/${i.key}`)),
  ]),
  tool('get_folder_metadata','Read folder metadata.','folder_metadata:read',z.object({folderId:fileKey}).strict(),(api,i)=>api(`/v2/folders/${i.folderId}/meta`)),
  tool('get_team_folders','List the connected account’s accessible team folders.','folders:read',z.object({teamId:fileKey}).strict(),(api,i)=>api(`/v2/teams/${i.teamId}/folders`)),
  tool('get_subfolders','List accessible subfolders.','folders:read',z.object({folderId:fileKey}).strict(),(api,i)=>api(`/v2/folders/${i.folderId}/folders`)),
  tool('get_folder_files','List accessible files in a folder.','folders:read',z.object({folderId:fileKey}).strict(),(api,i)=>api(`/v2/folders/${i.folderId}/files`)),

];

/** Figma's supported OAuth/REST API, exposed through TM8's shared MCP lifecycle. */
export class FigmaFirstPartyHost implements FirstPartyOAuthHost {
  private readonly endpoints: Endpoints;
  constructor(private readonly options: FigmaHostOptions) { this.endpoints = options.endpoints ?? ENDPOINTS; }
  private check(definition: FirstPartyDefinition) {
    if (definition.firstParty !== true || definition.catalogId !== FIGMA_NATIVE.catalogId || definition.url !== FIGMA_NATIVE.resource) throw new FirstPartyRefused('MCP connector unavailable');
  }
  scopesFor(definition: FirstPartyDefinition, scopes: readonly string[] | undefined): string[] {
    this.check(definition); return (scopes ?? []).filter(scope => FIGMA_NATIVE.scopes.some(allowed => allowed === scope));
  }
  tools(definition: FirstPartyDefinition, scopes: readonly string[] | undefined): readonly Tool[] {
    const granted = new Set(this.scopesFor(definition, scopes)); return TOOLS.filter(tool => tool.scopes.some(scope => granted.has(scope)));
  }
  covers(definition: FirstPartyDefinition, scopes: readonly string[] | undefined) { return this.tools(definition, scopes).length > 0; }
  uncovered(definition: FirstPartyDefinition, scopes: readonly string[] | undefined): McpUnavailableTool[] {
    const names = new Set(this.tools(definition, scopes).map(tool => tool.name));
    return TOOLS.filter(tool => !names.has(tool.name)).map(tool => ({ name: tool.name, unavailable: 'scope_missing', scopes: [...tool.scopes] }));
  }
  oauthClient(): OAuthClient {
    const client = this.options.client();
    if (!client?.clientId || !client.clientSecret) throw new CollabError('invalid_input', FIGMA_NOT_CONFIGURED);
    return { id: client.clientId, secret: client.clientSecret, method: 'client_secret_basic' };
  }
  authorization(definition: FirstPartyDefinition): McpFirstPartyAuthorization {
    this.check(definition);
    return { metadata: { issuer: this.endpoints.issuer, authorization_endpoint: this.endpoints.authorization, token_endpoint: this.endpoints.token,
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] },
      client: this.oauthClient(), scopes: [...FIGMA_NATIVE.scopes], authorizeParams: {}, privateNetwork: this.options.privateNetwork === true };
  }
  private async json(accessToken: string, path: string, query: Query = {}, method: 'GET'|'POST'|'PUT'|'DELETE' = 'GET', body?: unknown): Promise<unknown> {
    const url = path.startsWith('/v2/') ? new URL(path, this.endpoints.api) : new URL(this.endpoints.api + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await mcpHttp({ url: url.href, method, headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) }, this.options.privateNetwork === true);
    if (response.status === 401 || (response.status === 403 && (() => { try { return JSON.parse(response.body).err === 'Invalid token'; } catch { return false; } })())) throw new FirstPartyUnauthorized();
    if (response.status < 200 || response.status >= 300) {
      const retryAfter = response.headers['retry-after'];
      const seconds = retryAfter && /^\d{1,9}$/.test(retryAfter) ? Number(retryAfter) : undefined;
      throw new FigmaApiError(response.status, seconds);
    }
    return response.body ? JSON.parse(response.body) : { success: true };
  }
  async accountLabel(accessToken: string): Promise<string> {
    const value = z.object({email:z.string().optional(),handle:z.string().optional(),id:z.string().optional()}).parse(await this.json(accessToken, '/me'));
    const label = typeof value.email === 'string' ? value.email : typeof value.handle === 'string' ? value.handle : value.id;
    if (typeof label !== 'string' || !label) throw new Error('Figma account profile invalid');
    return label.slice(0, 200);
  }
  async request(definition: FirstPartyDefinition, method: 'tools/list' | 'tools/call', params: Record<string, unknown>, connection: FirstPartyConnection): Promise<unknown> {
    const tools = this.tools(definition, connection.grantedScopes);
    if (method === 'tools/list') return { tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: jsonSchema(tool.input),
      annotations: { readOnlyHint: !tool.write, destructiveHint: tool.destructive ?? false, idempotentHint: !tool.write, openWorldHint: true } })) };
    const tool = tools.find(tool => tool.name === params.name);
    if (!tool) throw new Error('Figma tool unavailable for this connection');
    try {
      const value = await tool.run((path, query, method, body) => this.json(connection.accessToken, path, query, method, body), params.arguments ?? {});
      const failed = value !== null && typeof value === 'object' &&
        (('errors' in value && Array.isArray(value.errors) && value.errors.length > 0) || ('error' in value && value.error === true));
      return { ...(failed ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      if (error instanceof FirstPartyUnauthorized) throw error;
      return { isError: true, content: [{ type: 'text', text: error instanceof z.ZodError ? 'Invalid Figma tool arguments' : error instanceof FigmaApiError ? error.status === 429
        ? `Figma rate limit reached.${error.retryAfterSeconds === undefined ? ' Retry later.' : ` Retry after ${error.retryAfterSeconds} seconds.`} The operation was not retried.`
        : `${error.message}. Check file access and API limits.` : 'Figma could not complete this operation. Check file access and API limits.' }] };
    }
  }
  async refresh(secret: McpOAuthSecret): Promise<McpOAuthSecret> {
    const client = this.oauthClient();
    if (!secret.refreshToken || secret.clientId !== client.id || secret.resource !== FIGMA_NATIVE.resource || secret.issuer !== this.endpoints.issuer) throw new OAuthTokenError('invalid_grant');
    const response = await mcpHttp({ url: this.endpoints.refresh, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: secret.refreshToken }).toString() }, this.options.privateNetwork === true);
    if (response.status !== 200) throw new OAuthTokenError(oauthErrorCode(response.body));
    const value = z.object({access_token:z.string().min(1),refresh_token:z.string().min(1).optional(),expires_in:z.number().finite().positive()}).parse(JSON.parse(response.body));
    return { ...secret, accessToken: value.access_token, expiresAt: Date.now() + value.expires_in * 1000,
      ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}) };
  }
}
