import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { McpProvider } from '../src/mcp/context';
import { McpSettings } from '../src/mcp/McpSettings';
import { McpPicker } from '../src/mcp/McpPicker';
import { McpEquipment } from '../src/mcp/McpEquipment';
import type { McpCatalog, McpPort, McpSelection } from '../src/mcp/port';
const data: McpCatalog = { canRegister: true, canAttach: true, defaults: [], attachedServerIds: [], servers: [{ id:'calendar',version:1,title:'Calendar',description:'Your work calendar tools',transport:'http',url:'https://calendar.example/mcp',auth:'api_key',approved:true,enabled:true,canManage:true,canApprove:true,canAttach:true,accounts:[{id:'work',label:'Work account',status:'connected',canUse:true,canManage:true,sharing:'private'}]}] };
const port: McpPort = {
 catalog: async () => structuredClone(data), register: async input => { data.servers.push({ ...input, id:'new',version:1,approved:false,enabled:true,canManage:true,canApprove:true,canAttach:true,accounts:[] }); },
 update: async (server,input) => { Object.assign(data.servers.find(s => s.id===server.id)!,input); }, remove: async server => { data.servers=data.servers.filter(s=>s.id!==server.id); }, importConfig: async () => {},
 attach: async (_target,id) => { data.attachedServerIds!.push(id); }, detach: async (_target,id) => { data.attachedServerIds=data.attachedServerIds!.filter(s=>s!==id); },
 test: async () => ({ok:true,message:'ready',tools:[{name:'list_events',description:'List upcoming meetings'}]}),
 createKey: async (_server,label) => { data.servers[0]!.accounts.push({id:'personal',label,canUse:true,canManage:true,status:'connected',sharing:'private'}); }, rotateKey: async () => {},
 startOAuth: async () => ({authorizationUrl:'https://identity.example/authorize'}),
 share: async (_server,id,sharing,memberIds) => { Object.assign(data.servers[0]!.accounts.find(a=>a.id===id)!,{sharing,memberIds}); },
 revoke: async (_server,id) => { Object.assign(data.servers[0]!.accounts.find(a=>a.id===id)!,{status:'revoked',canUse:false}); }, members: async () => [{id:'ada',label:'Ada'}],
};
function App(){const [selection,setSelection]=useState<McpSelection[]|undefined>();const [ready,setReady]=useState(false);return <main><h1 style={{padding:'0 20px'}}>Connect your tools</h1><McpProvider port={port}><McpSettings/><section style={{padding:20}} aria-label="Launch fixture"><McpPicker targetId="task" value={selection} onChange={setSelection} onReady={setReady}/><button disabled={!ready}>Launch session</button></section><McpEquipment targetId="task"/></McpProvider></main>}
createRoot(document.getElementById('root')!).render(<App/>);
