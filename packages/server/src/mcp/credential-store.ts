import { randomUUID } from 'node:crypto';
import { isHumanAuthKind, type McpCredentialScope, type McpCredentialView } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import { localKeyProvider, mcpSecretBinding, type KeyProvider } from '../credentials/key-provider.js';
import { openSecret, sealSecret } from '../credentials/secret-box.js';

export interface McpCredentialBinding { spaceId: string; serverId: string; credentialId: string }
export type { McpOAuthSecret } from '@tm8/integrations';
import type { McpOAuthSecret } from '@tm8/integrations';
export type McpSecret = { kind: 'api_key'; value: string } | McpOAuthSecret;
/** Why a refresh leaves a connection needing a reconnect (§7.2, B41). possible_reuse is the database's call, never the caller's. */
export type McpRefreshFailure = 'invalid_grant' | 'scope_reduced';
interface SealedRow { credentialId: string; spaceId: string; serverId: string; definitionVersion?: number; ciphertext: string; nonce: string; keyId?: string|null }

/** Server-only opener. Never return its values from a facade handler. */
export class McpCredentialStore {
  private readonly keys: KeyProvider;
  constructor(private readonly db: Db, private readonly dataDir: string, keys?: KeyProvider) {
    this.keys = keys ?? localKeyProvider(dataDir);
  }
  async withRefreshLock<T>(claims:DbClaims,binding:McpCredentialBinding,run:(store:Pick<McpCredentialStore,'read'|'replace'>)=>Promise<T>):Promise<T> {
    return this.db.tx(claims,async q=>{
      await q.query('select pg_advisory_xact_lock(hashtextextended($1, 0))',[JSON.stringify(binding)]);
      const boundDb:Db={
        tx:async (_claims,work)=>work(q),rpc:async (_claims,fn,args)=>q.rpc(fn,args),
        query:async (_claims,sql,args)=>q.query(sql,args),end:async()=>{},
      };
      return run(new McpCredentialStore(boundDb,this.dataDir,this.keys));
    });
  }
  async create(claims: DbClaims, input: {spaceId: string; serverId: string; label: string; secret: McpSecret; expectedRevision?:number; scope?:McpCredentialScope; accountLabel?:string; grantedScopes?:string[]}): Promise<unknown> {
    if (!isHumanAuthKind(claims.authKind) || claims.viaLinkId) throw new Error('MCP credential writes require a human session');
    if (input.secret.kind === 'oauth' && input.accountLabel?.trim()) {
      return this.db.tx(claims, async q => {
        await q.query('select pg_advisory_xact_lock(hashtextextended($1, 297))', [input.serverId]);
        const rows = await q.rpc<McpCredentialView[]>('list_mcp_credentials', [input.serverId]);
        const account = input.accountLabel!.trim().toLowerCase();
        const existing = rows.find(row => row.manageable && !row.revoked && row.authType === 'oauth2'
          && (row.ownerId === null) === (input.scope === 'space') && row.accountLabel?.trim().toLowerCase() === account);
        const bound: Db = { tx: async (_claims, work) => work(q), rpc: async (_claims, fn, args) => q.rpc(fn, args),
          query: async (_claims, sql, args) => q.query(sql, args), end: async () => {} };
        return new McpCredentialStore(bound, this.dataDir, this.keys).save(claims, input, existing?.id);
      });
    }
    return this.save(claims, input);
  }
  private async save(claims: DbClaims, input: Parameters<McpCredentialStore['create']>[1], reconnectId?: string): Promise<unknown> {
    const credentialId = reconnectId ?? randomUUID();
    const spaceId = input.spaceId.toLowerCase();
    // New rows are always sealed under the ACTIVE key and the keyed AAD; the
    // unkeyed form exists only to open what was written before migration 341.
    const keyId = this.keys.activeKeyId;
    const sealed = sealSecret(await this.keys.keyFor(keyId), JSON.stringify(input.secret), mcpSecretBinding({spaceId, credentialId}, keyId));
    const expected=input.expectedRevision ?? Number((await this.db.query<{mcp_security_revision:number}>(claims,'select mcp_security_revision from public.mcp_servers where entity_id=$1',[input.serverId]))[0]?.mcp_security_revision);
    return this.db.rpc(claims, reconnectId ? 'reconnect_mcp_credential' : 'create_mcp_credential', [credentialId,spaceId,input.serverId,input.label,sealed.ciphertext,sealed.nonce,input.secret.kind==='oauth'?'token':'api_key',input.secret.kind==='oauth' && input.secret.expiresAt!==undefined?new Date(input.secret.expiresAt).toISOString():null,input.secret.kind==='oauth' && Boolean(input.secret.refreshToken),expected,input.scope??'member',keyId,input.accountLabel??null,normalizeScopes(input.grantedScopes)]);
  }
  async rotate(claims:DbClaims,binding:McpCredentialBinding,value:string):Promise<void> {
    if(!isHumanAuthKind(claims.authKind) || claims.viaLinkId)throw new Error('MCP credential writes require a human session');
    // NO read precheck. It used to open the OLD secret first, which refuses any
    // status other than 'active' — so a row marked needs_reconnect (§7.2) could
    // never be rotated, and rotating IS the reconnect for an API key. The
    // authority check is rekey_mcp_credential's own (manager, plus admin-only
    // for a Space connection), which is strictly stronger than being able to
    // read the row, and it verifies the space/server/provider of the binding.
    const keyId=this.keys.activeKeyId;
    const sealed=sealSecret(await this.keys.keyFor(keyId),JSON.stringify({kind:'api_key',value}),mcpSecretBinding(binding,keyId));
    // rekey_mcp_credential, not rekey_space_credential: the ciphertext and its
    // key id must land in ONE statement or they can drift apart (§5.2).
    await this.db.rpc(claims,'rekey_mcp_credential',[binding.spaceId,binding.serverId,binding.credentialId,sealed.ciphertext,sealed.nonce,keyId]);
  }
  async read(claims: DbClaims, binding: McpCredentialBinding): Promise<{secret: McpSecret; nonce: string; definitionVersion?: number; keyId?: string|null}> {
    if (!binding.credentialId || claims.viaLinkId) throw new Error('MCP credential unavailable');
    const row = await this.db.rpc<SealedRow>(claims,'read_mcp_credential',[binding.spaceId,binding.serverId,binding.credentialId]);
    if (row.spaceId !== binding.spaceId || row.serverId !== binding.serverId || row.credentialId !== binding.credentialId) throw new Error('MCP credential unavailable');
    try {
      // One form, chosen by the row. An unknown key id throws out of keyFor.
      const value = openSecret(await this.keys.keyFor(row.keyId),{ciphertext:Buffer.from(row.ciphertext,'base64'),nonce:Buffer.from(row.nonce,'base64')},mcpSecretBinding(row,row.keyId));
      return {secret:JSON.parse(value) as McpSecret,nonce:row.nonce,definitionVersion:row.definitionVersion,keyId:row.keyId??null};
    } catch { throw new Error('MCP credential unavailable'); }
  }
  /** A refresh RE-SEALS under the active key, so a legacy row upgrades here. */
  async replace(claims: DbClaims,binding: McpCredentialBinding,nonce: string,secret: McpSecret): Promise<void> {
    const keyId=this.keys.activeKeyId;
    const sealed = sealSecret(await this.keys.keyFor(keyId),JSON.stringify(secret),mcpSecretBinding(binding,keyId));
    const ok = await this.db.rpc<boolean>(claims,'refresh_mcp_credential',[binding.spaceId,binding.serverId,binding.credentialId,Buffer.from(nonce,'base64'),sealed.ciphertext,sealed.nonce,secret.kind==='oauth' && secret.expiresAt!==undefined?new Date(secret.expiresAt).toISOString():null,secret.kind==='oauth' && Boolean(secret.refreshToken),keyId]);
    if (!ok) throw new Error('MCP credential changed; reconnect');
  }
  /**
   * §7.2: this connection cannot be used until its owner reconnects. The
   * database marks it (one-way, B8), decides whether an invalid_grant is a
   * possible reuse, and puts the inbox item in front of whoever can fix it.
   */
  async reportFailure(claims: DbClaims, binding: McpCredentialBinding, reason: McpRefreshFailure): Promise<void> {
    await this.db.rpc(claims,'report_mcp_credential_failure',[binding.spaceId,binding.serverId,binding.credentialId,reason]);
  }
  /**
   * §9.3(4) kill switch: revoke every MCP connection in a Space (spaceId) or on
   * the node (null). The rows are revoked locally FIRST, in the database; what
   * comes back is the rows the caller may then revoke at the provider, opened.
   * A row that will not open is counted, never thrown: it is already revoked.
   */
  async revokeAll(claims: DbClaims, spaceId: string | null): Promise<{ scope: 'space' | 'node'; revoked: number; providerRevoke: Array<{ binding: McpCredentialBinding; secret?: McpSecret }> }> {
    if (!isHumanAuthKind(claims.authKind) || claims.viaLinkId) throw new Error('MCP credential writes require a human session');
    const result = await this.db.rpc<{ scope: 'space' | 'node'; revoked: number; providerRevoke: SealedRow[] }>(claims, 'revoke_all_mcp_credentials', [spaceId]);
    const providerRevoke = [];
    for (const row of result.providerRevoke) {
      const binding = { spaceId: row.spaceId, serverId: row.serverId, credentialId: row.credentialId };
      try {
        const value = openSecret(await this.keys.keyFor(row.keyId), { ciphertext: Buffer.from(row.ciphertext, 'base64'), nonce: Buffer.from(row.nonce, 'base64') }, mcpSecretBinding(row, row.keyId));
        providerRevoke.push({ binding, secret: JSON.parse(value) as McpSecret });
      } catch { providerRevoke.push({ binding }); }
    }
    return { scope: result.scope, revoked: Number(result.revoked), providerRevoke };
  }
  /** §5.2 "Make the proxy write it". Best-effort: never fail a tool call on it. */
  async touch(claims: DbClaims, binding: McpCredentialBinding): Promise<void> {
    await this.db.rpc(claims,'touch_mcp_credential',[binding.spaceId,binding.serverId,binding.credentialId]);
  }
}

/** The per-scope length cap a CHECK constraint could not carry (migration 341). */
function normalizeScopes(scopes?: string[]): string[] | null {
  if (!scopes?.length) return null;
  return scopes.slice(0, 64).map(scope => scope.slice(0, 1024));
}
