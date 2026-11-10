import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FIGMA_NATIVE } from '@tm8/integrations';
import { FigmaFirstPartyHost } from '../../src/mcp/first-party/figma.js';
import { FirstPartyUnauthorized } from '../../src/mcp/first-party/host.js';
import { McpOAuth } from '../../src/mcp/oauth.js';
import { fixtureKeys, memoryOAuthPending } from './oauth-pending-fixture.js';

const definition = { catalogId: FIGMA_NATIVE.catalogId, url: FIGMA_NATIVE.resource, firstParty: true };
const connection = { accessToken: 'fixture-access', grantedScopes: [...FIGMA_NATIVE.scopes] };
let requests: { method: string; path: string; body: URLSearchParams; authorization?: string }[];
let origin: string;
let close: () => Promise<void>;
let host: FigmaFirstPartyHost;
let challenge: string;
let comments: {id:string;message:string}[];
beforeEach(async () => {
  requests = [];comments=[];
  const server = createServer(async (req, res) => {
    let body = '';for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    requests.push({ method: req.method!, path: req.url!, body: form, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      if (req.headers.authorization !== 'Basic '+Buffer.from('own-client:own-secret').toString('base64') || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge || form.has('resource')) {res.writeHead(400);res.end('{"error":"invalid_grant"}');return;}
      res.end(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'bearer' }));return;
    }
    if (req.url === '/refresh') {res.end(JSON.stringify({ access_token: 'refreshed', expires_in: 3600 }));return;}
    if (req.headers.authorization !== 'Bearer fixture-access') {res.writeHead(401);res.end('{}');return;}
    if(req.url==='/v1/files/File_123/comments') {
      if(req.method==='POST'){const value=JSON.parse(body);const comment={id:'c1',message:value.message};comments.push(comment);res.end(JSON.stringify(comment));return;}
      res.end(JSON.stringify({comments}));return;
    }
    if(req.url==='/v1/files/File_123/comments/c1'&&req.method==='DELETE'){comments=[];res.writeHead(204);res.end();return;}
    if(req.url==='/v1/files/RateLimited/comments'){res.writeHead(429,{'retry-after':'120'});res.end('{}');return;}
    if(req.url==='/v1/files/InvalidToken/comments'){res.writeHead(403);res.end('{"err":"Invalid token"}');return;}
    if(req.url==='/v1/files/Forbidden/comments'){res.writeHead(403);res.end('{"err":"Request denied"}');return;}
    if(req.url==='/v1/dev_resources'&&req.method==='POST'){res.end(JSON.stringify({links_created:[],errors:[{file_key:'File_123',node_id:'1:2',error:'File not found'}]}));return;}
    res.end(JSON.stringify(req.url === '/v1/me' ? { id: 'fixture-user', email: 'figma@example.test' } : { name: 'Fixture design', path: req.url, document: { id: '0:0' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();if (!address || typeof address === 'string') throw Error('fixture address');
  origin = `http://127.0.0.1:${address.port}`;
  close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  host = new FigmaFirstPartyHost({ client: () => ({ clientId: 'own-client', clientSecret: 'own-secret' }), privateNetwork: true,
    endpoints: { api: origin+'/v1', issuer: origin, authorization: origin+'/authorize', token: origin+'/token', refresh: origin+'/refresh' } });
});
afterEach(async () => close());
it('exchanges a PKCE code with own client and retains sealed requested scopes when Figma omits scope', async () => {
  const oauth = new McpOAuth('https://tm8.test/mcp/oauth/callback', memoryOAuthPending(), fixtureKeys());
  const started = await oauth.beginFirstParty({ identityId: 'human' }, { spaceId: 'space', serverId: 'server', resource: FIGMA_NATIVE.resource }, host.authorization(definition));
  const url = new URL(started.authorizationUrl);challenge = url.searchParams.get('code_challenge')!;
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const result = await oauth.callback({ identityId: 'human' }, { state: url.searchParams.get('state')!, code: 'fixture-code' }, undefined, resource => {
    expect(resource).toBe(FIGMA_NATIVE.resource);return host.oauthClient();
  });
  expect(result.secret.grantedScopes).toEqual(FIGMA_NATIVE.scopes);
  expect(await host.accountLabel(result.secret.accessToken)).toBe('figma@example.test');
  const refreshed = await host.refresh(result.secret);
  expect(refreshed.refreshToken).toBe('fixture-refresh');expect(refreshed.accessToken).toBe('refreshed');
  expect(requests.at(-1)?.path).toBe('/refresh');
  expect(requests.at(-1)?.authorization).toBe('Basic '+Buffer.from('own-client:own-secret').toString('base64'));
});
it('discovers only authorized reads and rejects forged identities', async () => {
  const result = await host.request(definition, 'tools/list', {}, { ...connection, grantedScopes: ['current_user:read'] });
  expect(result).toMatchObject({ tools: [{ name: 'get_current_user', annotations: { readOnlyHint: true } }] });
  expect(host.uncovered(definition, ['current_user:read'])).toHaveLength(28);
  await expect(host.request({ ...definition, url: 'https://attacker.test' }, 'tools/list', {}, connection)).rejects.toThrow();
  await expect(host.request(definition, 'tools/call', { name: 'get_file', arguments: { fileKey: 'abc' } }, { ...connection, grantedScopes: ['current_user:read'] })).rejects.toThrow();
});
it('reads design content, nodes, metadata, comments, versions and image links without fetching arbitrary URLs', async () => {
  for (const name of ['get_file', 'get_file_nodes', 'get_file_metadata', 'get_file_comments', 'get_file_versions', 'get_images']) {
    const result = await host.request(definition, 'tools/call', { name, arguments: { fileKey: 'File_123', ...(['get_file_nodes','get_images'].includes(name) ? { ids: ['1:2'] } : {}) } }, connection);
    expect(result).not.toHaveProperty('isError');
  }
  expect(requests).toHaveLength(6);expect(requests.every(req => req.method === 'GET')).toBe(true);
  const before = requests.length;
  expect(await host.request(definition, 'tools/call', { name: 'get_file', arguments: { fileKey: '../secrets' } }, connection)).toMatchObject({ isError: true });
  expect(requests).toHaveLength(before);
});
it('propagates unauthorized access so shared proxy refresh/revocation rules apply', async () => {
  await expect(host.request(definition, 'tools/call', { name: 'get_current_user' }, { ...connection, accessToken: 'expired' })).rejects.toBeInstanceOf(FirstPartyUnauthorized);
});

it('creates a comment, reads its exact content back and deletes only the supplied comment',async()=>{
 const posted=await host.request(definition,'tools/call',{name:'post_comment',arguments:{fileKey:'File_123',message:'fixture write'}},connection);
 expect(posted).toMatchObject({content:[{type:'text',text:JSON.stringify({id:'c1',message:'fixture write'})}]});
 const read=await host.request(definition,'tools/call',{name:'get_file_comments',arguments:{fileKey:'File_123'}},connection);
 expect(JSON.stringify(read)).toContain('fixture write');
 expect(await host.request(definition,'tools/call',{name:'delete_comment',arguments:{fileKey:'File_123',commentId:'c1'}},connection)).not.toHaveProperty('isError');
 expect(comments).toEqual([]);
 expect(requests.map(r=>r.method)).toEqual(['POST','GET','DELETE']);
 const before=requests.length;
 await expect(host.request(definition,'tools/call',{name:'post_comment',arguments:{fileKey:'File_123',message:'denied'}},{...connection,grantedScopes:['file_comments:read']})).rejects.toThrow('unavailable');
 expect(requests).toHaveLength(before);
});
it('distinguishes Figma expired-token403 from an ordinary file-permission403',async()=>{
 await expect(host.request(definition,'tools/call',{name:'get_file_comments',arguments:{fileKey:'InvalidToken'}},connection)).rejects.toBeInstanceOf(FirstPartyUnauthorized);
 expect(await host.request(definition,'tools/call',{name:'get_file_comments',arguments:{fileKey:'Forbidden'}},connection)).toMatchObject({isError:true});
});
it('advertises writes and permanent deletion accurately and bounds user input before network access',async()=>{
 const listed=await host.request(definition,'tools/list',{},connection) as {tools:{name:string;annotations:{readOnlyHint:boolean;destructiveHint:boolean}}[]};
 expect(listed.tools).toHaveLength(29);
 expect(listed.tools.find(t=>t.name==='post_comment')?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:false});
 expect(listed.tools.find(t=>t.name==='delete_comment')?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:true});
 expect(await host.request(definition,'tools/call',{name:'post_comment',arguments:{fileKey:'File_123',message:'x'.repeat(20001)}},connection)).toMatchObject({isError:true});
 expect(requests).toHaveLength(0);
});
it('marks HTTP200 bulk-operation errors as failures and preserves partial outcome details',async()=>{
 const result=await host.request(definition,'tools/call',{name:'create_dev_resource',arguments:{fileKey:'File_123',nodeId:'1:2',name:'fixture link',url:'https://example.test/fixture'}},connection);
 expect(result).toMatchObject({isError:true});
 expect(JSON.stringify(result)).toContain('links_created');
 expect(JSON.stringify(result)).toContain('File not found');
});

it('surfaces provider backoff without refreshing credentials or retrying a write',async()=>{
 const result=await host.request(definition,'tools/call',{name:'post_comment',arguments:{fileKey:'RateLimited',message:'fixture write'}},connection);
 expect(result).toMatchObject({isError:true,content:[{type:'text',text:'Figma rate limit reached. Retry after 120 seconds. The operation was not retried.'}]});
 expect(requests.map(r=>r.method)).toEqual(['POST']);
});
