import { randomUUID } from 'node:crypto';
import { isHumanAuthKind } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import { loadOrCreateCredentialKey } from '../credentials/credential-key.js';
import { openSecret, sealSecret } from '../credentials/secret-box.js';

export interface McpCredentialBinding { spaceId: string; serverId: string; credentialId: string }
export interface McpOAuthSecret {
  kind: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: number;
  issuer: string; tokenEndpoint: string; resource: string; clientId: string;
}
export type McpSecret = { kind: 'api_key'; value: string } | McpOAuthSecret;
interface SealedRow { credentialId: string; spaceId: string; serverId: string; ciphertext: string; nonce: string }

/** Server-only opener. Never return its values from a facade handler. */
export class McpCredentialStore {
  constructor(private readonly db: Db, private readonly dataDir: string) {}
  async withRefreshLock<T>(claims:DbClaims,binding:McpCredentialBinding,run:(store:Pick<McpCredentialStore,'read'|'replace'>)=>Promise<T>):Promise<T> {
    return this.db.tx(claims,async q=>{
      await q.query('select pg_advisory_xact_lock(hashtextextended($1, 0))',[JSON.stringify(binding)]);
      const boundDb:Db={
        tx:async (_claims,work)=>work(q),rpc:async (_claims,fn,args)=>q.rpc(fn,args),
        query:async (_claims,sql,args)=>q.query(sql,args),end:async()=>{},
      };
      return run(new McpCredentialStore(boundDb,this.dataDir));
    });
  }
  async create(claims: DbClaims, input: {spaceId: string; serverId: string; label: string; secret: McpSecret}): Promise<unknown> {
    if (!isHumanAuthKind(claims.authKind) || claims.viaLinkId) throw new Error('MCP credential writes require a human session');
    const credentialId = randomUUID();
    const spaceId = input.spaceId.toLowerCase();
    const sealed = sealSecret(await loadOrCreateCredentialKey(this.dataDir), JSON.stringify(input.secret), {spaceId, credentialId, provider:'mcp'});
    return this.db.rpc(claims, 'create_mcp_credential', [credentialId,spaceId,input.serverId,input.label,sealed.ciphertext,sealed.nonce,input.secret.kind==='oauth'?'token':'api_key']);
  }
  async rotate(claims:DbClaims,binding:McpCredentialBinding,value:string):Promise<void> {
    if(!isHumanAuthKind(claims.authKind) || claims.viaLinkId)throw new Error('MCP credential writes require a human session');
    await this.read(claims,binding);
    const sealed=sealSecret(await loadOrCreateCredentialKey(this.dataDir),JSON.stringify({kind:'api_key',value}),{spaceId:binding.spaceId,credentialId:binding.credentialId,provider:'mcp'});
    await this.db.rpc(claims,'rekey_space_credential',[binding.credentialId,'mcp',sealed.ciphertext,sealed.nonce,null]);
  }
  async read(claims: DbClaims, binding: McpCredentialBinding): Promise<{secret: McpSecret; nonce: string}> {
    if (!binding.credentialId || claims.viaLinkId) throw new Error('MCP credential unavailable');
    const row = await this.db.rpc<SealedRow>(claims,'read_mcp_credential',[binding.spaceId,binding.serverId,binding.credentialId]);
    if (row.spaceId !== binding.spaceId || row.serverId !== binding.serverId || row.credentialId !== binding.credentialId) throw new Error('MCP credential unavailable');
    try {
      const value = openSecret(await loadOrCreateCredentialKey(this.dataDir),{ciphertext:Buffer.from(row.ciphertext,'base64'),nonce:Buffer.from(row.nonce,'base64')},{spaceId:row.spaceId,credentialId:row.credentialId,provider:'mcp'});
      return {secret:JSON.parse(value) as McpSecret,nonce:row.nonce};
    } catch { throw new Error('MCP credential unavailable'); }
  }
  async replace(claims: DbClaims,binding: McpCredentialBinding,nonce: string,secret: McpSecret): Promise<void> {
    const sealed = sealSecret(await loadOrCreateCredentialKey(this.dataDir),JSON.stringify(secret),{spaceId:binding.spaceId,credentialId:binding.credentialId,provider:'mcp'});
    const ok = await this.db.rpc<boolean>(claims,'refresh_mcp_credential',[binding.spaceId,binding.serverId,binding.credentialId,Buffer.from(nonce,'base64'),sealed.ciphertext,sealed.nonce]);
    if (!ok) throw new Error('MCP credential changed; reconnect');
  }
}
