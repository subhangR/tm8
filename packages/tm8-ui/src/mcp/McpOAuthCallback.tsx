import { useEffect, useMemo, useRef, useState } from 'react';
import { authTokenFor } from '../auth/pass-store';
import { readActiveServerId, routeBaseUrlFor } from '../servers/server-key';
import { createHttpClient } from '../data/real/http';
import type { HttpClient } from '../data/real/http';
import type { McpCredentialView, McpTestResult } from '@tm8/contract';
import type { McpCallback } from './oauth-callback';
import './mcp.css';
export async function completeMcpConnection(http: HttpClient, input: McpCallback['input']): Promise<boolean> {
  const account = await http.call<McpCredentialView>('mcp.oauth.callback', { body: input });
  try {
    const result = await http.call<McpTestResult>('mcp.servers.test', { params: { serverId: account.serverId }, body: { clientMutationId: crypto.randomUUID(), serverId: account.serverId, credentialId: account.id } });
    return result.ready;
  } catch { return false; }
}
export function McpOAuthCallback({ callback, complete }: { callback: McpCallback; complete?: (input: McpCallback['input']) => Promise<unknown> }) {
  const [phase,setPhase]=useState<'pending'|'done'|'failed'|'unavailable'>('pending');
  const request=useRef<Promise<unknown> | null>(null);
  const http=useMemo(()=>createHttpClient({baseUrl:routeBaseUrlFor(callback.serverId),fetch:globalThis.fetch,getAuthToken:()=>authTokenFor(callback.serverId)}),[callback.serverId]);
  useEffect(()=>{
    let active=true;
    if(!callback.valid || callback.serverId!==readActiveServerId()){setPhase('failed');return;}
    request.current ??= complete ? complete(callback.input) : completeMcpConnection(http,callback.input);
    void request.current.then(result=>{if(active)setPhase(result === false ? 'unavailable' : 'done');},()=>{if(active)setPhase('failed');});
    return()=>{active=false;};
  },[callback,complete,http]);
  return <main className="mcp-settings"><h1>Connect account</h1>
    {phase==='pending' && <p role="status">Completing authorization and checking the connection…</p>}
    {phase==='done' && <p role="status">Your private account is connected. Select it when starting a chat or session.</p>}
    {phase==='failed' && <p role="alert">Authorization could not be completed. It may have expired, been declined, or started on another server. Return to connectors and start a new connection.</p>}
    {phase==='unavailable' && <p role="alert">Your account was authorized, but its tools could not be reached. Return to connectors and retry the connection test.</p>}
    {phase!=='pending' && <a href={callback.spaceId ? `/#/s/${encodeURIComponent(callback.spaceId)}/settings/connectors` : '/'}>Return to connectors</a>}
  </main>;
}
