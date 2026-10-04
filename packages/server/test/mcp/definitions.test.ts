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
  if(sql.startsWith('select e.id'))return[{id:params[0],space_id:spaceId,version:1,admin:false,definition:{name:edges.find(e=>e.server_id===params[0])?.name??'explicit',transport:'http',url:'https://example.test/mcp',auth:{type:'none'},envKeys:[],headerKeys:[],approved:true}}];
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
