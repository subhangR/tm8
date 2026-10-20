import { expect, it, vi } from 'vitest';
import { resolveMcpSelections } from '../../src/mcp/definitions.js';
import type { Querier } from '../../src/db/types.js';
const spaceId='00000000-0000-4000-8000-000000000001',target='00000000-0000-4000-8000-000000000002',parent='00000000-0000-4000-8000-000000000003';
const first='00000000-0000-4000-8000-000000000004',second='00000000-0000-4000-8000-000000000005';
type Lineage={id:string;parent_id:string|null;depth:number;path:string[]};
type Edge={server_id:string;source_id:string;name:string};
function fixture(lineage:Lineage[],edges:Edge[],readable=true){
 const query=vi.fn(async(sql:string,params:unknown[])=>{
  if(sql.includes('as allowed'))return[{allowed:readable}];
  if(sql.includes('with recursive lineage'))return lineage;
  if(sql.includes('g.dst_id as server_id'))return edges.filter(e=>(params[0] as string[]).includes(e.source_id));
  if(sql.startsWith('select e.id'))return[{id:params[0],space_id:spaceId,version:1,security_revision:1,admin:false,definition:{name:edges.find(e=>e.server_id===params[0])?.name??'explicit',transport:'http',url:'https://example.test/mcp',auth:{type:'none'},envKeys:[],headerKeys:[],approved:true}}];
  throw new Error('Unexpected query');
 });return{q:{query,rpc:vi.fn()} as unknown as Querier,query};
}
it('inherits only reachable ancestors and picks nearest same-name definitions',async()=>{
 const {q}=fixture([{id:target,parent_id:parent,depth:0,path:[target]},{id:parent,parent_id:null,depth:1,path:[target,parent]}],[{server_id:first,source_id:parent,name:'shared'},{server_id:second,source_id:target,name:'SHARED'}]);
 const result=await resolveMcpSelections(q,{spaceId,targetIds:[target]});expect(result.selections.map(s=>s.server.id)).toEqual([second]);
});
it('refuses distinct same-depth name collisions instead of choosing by iteration order',async()=>{
 const {q}=fixture([{id:target,parent_id:null,depth:0,path:[target]}],[{server_id:first,source_id:target,name:'shared'},{server_id:second,source_id:target,name:'SHARED'}]);
 await expect(resolveMcpSelections(q,{spaceId,targetIds:[target]})).rejects.toThrow('same attachment depth');
});
it('an inaccessible parent contributes no defaults and an inaccessible source is refused',async()=>{
 const {q}=fixture([{id:target,parent_id:parent,depth:0,path:[target]}],[{server_id:first,source_id:parent,name:'private'}]);
 expect((await resolveMcpSelections(q,{spaceId,targetIds:[target]})).selections).toEqual([]);
 const denied=fixture([],[],false);await expect(resolveMcpSelections(denied.q,{spaceId,targetIds:[target]})).rejects.toThrow('target is unavailable');
});
it('bounds corrupt cycles and deep ancestry, while explicit replacement skips default ancestry',async()=>{
 for(const row of [{id:target,parent_id:target,depth:0,path:[target]},{id:target,parent_id:parent,depth:16,path:[target]}]){
  const{q,query}=fixture([row],[]);await expect(resolveMcpSelections(q,{spaceId,targetIds:[target]})).rejects.toThrow('depth or cycle');
  query.mockClear();expect((await resolveMcpSelections(q,{spaceId,mcpSelections:[]})).selections).toEqual([]);expect(query).not.toHaveBeenCalled();
  expect((await resolveMcpSelections(q,{spaceId,mcpSelections:[{serverId:first}]})).selections[0]?.server.id).toBe(first);
  expect(query.mock.calls.some(([sql])=>sql.includes('recursive'))).toBe(false);
 }
});

/**
 * ac1/ac2. A default attachment carries no credentialId, so every
 * authenticated connector a task equipped resolved to `credential_required`
 * and refused the whole launch — a trap the member could not escape from the
 * picker, because there was nothing to pick. Defaults now resolve the member's
 * own account when the choice is unambiguous, and an unready default is
 * dropped with its reason instead of failing the launch.
 */
type Account = { id: string; usable: boolean; manageable: boolean; reason: string };
const mine='00000000-0000-4000-8000-00000000000a',theirs='00000000-0000-4000-8000-00000000000b';
function authFixture(accounts: Account[], overrides: Record<string, unknown> = {}) {
  const definition={name:'authenticated',transport:'http',url:'https://example.test/mcp',
    auth:{type:'api_key',headerName:'Authorization',prefix:'Bearer'},envKeys:[],headerKeys:['Authorization'],approved:true,...overrides};
  const query=vi.fn(async(sql:string,params:unknown[])=>{
    if(sql.includes('as allowed'))return[{allowed:true}];
    if(sql.includes('with recursive lineage'))return[{id:target,parent_id:null,depth:0,path:[target]}];
    if(sql.includes('g.dst_id as server_id'))return[{server_id:first,source_id:target,name:'authenticated'}];
    if(sql.startsWith('select e.id'))return[{id:params[0],space_id:spaceId,version:1,security_revision:1,admin:false,definition}];
    throw new Error('Unexpected query');
  });
  const rpc=vi.fn(async(fn:string,params:unknown[])=>{
    if(fn==='list_mcp_credentials')return accounts.map(a=>({...a,serverId:first,label:a.id,authType:'api_key',visibility:'private',ownerId:a.id,sharedMemberIds:[],revoked:false}));
    if(fn==='mcp_credential_readiness'){const found=accounts.find(a=>a.id===params[1]);return{ready:found?.usable===true,reason:found?.reason??'credential_unavailable'};}
    throw new Error(`Unexpected rpc ${fn}`);
  });
  return{q:{query,rpc} as unknown as Querier,rpc};
}
const usable=(id:string,manageable:boolean):Account=>({id,usable:true,manageable,reason:'ready'});

it('resolves a default to the launching member own sole usable account',async()=>{
 const {q,rpc}=authFixture([usable(mine,true)]);
 const result=await resolveMcpSelections(q,{spaceId,targetIds:[target]});
 expect(result.selections).toMatchObject([{credentialId:mine,ready:true,reason:'ready',fromDefault:true}]);
 expect(result.dropped).toEqual([]);
 expect(result.ready).toBe(true);
 expect(rpc.mock.calls.some(([fn])=>fn==='list_mcp_credentials')).toBe(true);
});

it('prefers the member own account over one another member shared, and refuses to choose between two',async()=>{
 const owned=await resolveMcpSelections(authFixture([usable(theirs,false),usable(mine,true)]).q,{spaceId,targetIds:[target]});
 expect(owned.selections[0]?.credentialId).toBe(mine);
 const shared=await resolveMcpSelections(authFixture([usable(theirs,false)]).q,{spaceId,targetIds:[target]});
 expect(shared.selections[0]?.credentialId).toBe(theirs);
 const ambiguous=await resolveMcpSelections(authFixture([usable(mine,true),usable('00000000-0000-4000-8000-00000000000c',true)]).q,{spaceId,targetIds:[target]});
 expect(ambiguous.selections).toEqual([]);
 expect(ambiguous.dropped).toMatchObject([{reason:'credential_required',fromDefault:true}]);
});

it('drops an unready default with its reason instead of refusing the launch',async()=>{
 for (const [accounts,reason] of [[[],'credential_required'],[[{id:mine,usable:false,manageable:true,reason:'credential_expired'}],'credential_required']] as const) {
  const result=await resolveMcpSelections(authFixture([...accounts]).q,{spaceId,targetIds:[target]});
  expect(result.selections).toEqual([]);
  expect(result.ready).toBe(true);
  expect(result.dropped).toMatchObject([{ready:false,reason,fromDefault:true}]);
  expect(result.dropped[0]?.server.definition.name).toBe('authenticated');
 }
 const disabled=await resolveMcpSelections(authFixture([usable(mine,true)],{enabled:false}).q,{spaceId,targetIds:[target]});
 expect(disabled.dropped).toMatchObject([{reason:'disabled'}]);
 expect(disabled.ready).toBe(true);
});

it('keeps refusing an explicit selection that is not ready, and never guesses its account',async()=>{
 const {q,rpc}=authFixture([usable(mine,true)]);
 const result=await resolveMcpSelections(q,{spaceId,mcpSelections:[{serverId:first}]});
 expect(result.selections).toMatchObject([{ready:false,reason:'credential_required'}]);
 expect(result.selections[0]?.fromDefault).toBeUndefined();
 expect(result.ready).toBe(false);
 expect(result.dropped).toEqual([]);
 expect(rpc.mock.calls.some(([fn])=>fn==='list_mcp_credentials')).toBe(false);
});
