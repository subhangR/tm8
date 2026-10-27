import { useEffect, useMemo, useRef, useState } from 'react';
import { authTokenFor } from '../auth/pass-store';
import { readActiveServerId, routeBaseUrlFor } from '../servers/server-key';
import { createHttpClient } from '../data/real/http';
import type { McpCallback } from './oauth-callback';
import './mcp.css';
export function McpOAuthCallback({ callback, complete }: { callback: McpCallback; complete?: (input: McpCallback['input']) => Promise<unknown> }) {
  const [phase,setPhase]=useState<'pending'|'done'|'failed'>('pending');
  const request=useRef<Promise<unknown> | null>(null);
  const http=useMemo(()=>createHttpClient({baseUrl:routeBaseUrlFor(callback.serverId),fetch:globalThis.fetch,getAuthToken:()=>authTokenFor(callback.serverId)}),[callback.serverId]);
  useEffect(()=>{
    let active=true;
    if(!callback.valid || callback.serverId!==readActiveServerId()){setPhase('failed');return;}
    request.current ??= complete ? complete(callback.input) : http.call('mcp.oauth.callback',{body:callback.input});
    void request.current.then(()=>{if(active)setPhase('done');},()=>{if(active)setPhase('failed');});
    return()=>{active=false;};
  },[callback,complete,http]);
  return <main className="mcp-settings"><h1>Connect account</h1>
    {phase==='pending' && <p role="status">Completing authorization…</p>}
    {phase==='done' && <p role="status">Your private account is connected. Select it when starting a chat or session.</p>}
    {phase==='failed' && <p role="alert">Authorization could not be completed. It may have expired, been declined, or started on another server. Return to connectors and start a new connection.</p>}
    {phase!=='pending' && <a href={callback.spaceId ? `/#/s/${encodeURIComponent(callback.spaceId)}/settings/connectors` : '/'}>Return to connectors</a>}
  </main>;
}
