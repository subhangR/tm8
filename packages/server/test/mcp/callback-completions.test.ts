import { expect, it, vi } from 'vitest';
import { McpCredentialViewSchema } from '@tm8/contract';
import { McpCallbackCompletions } from '../../src/mcp/callback-completions.js';
const result = McpCredentialViewSchema.parse({id:'00000000-0000-4000-8000-000000000001',serverId:'00000000-0000-4000-8000-000000000002',label:'Fixture account',authType:'oauth2',visibility:'private',ownerId:null,sharedMemberIds:[],usable:true,manageable:true,revoked:false,reason:'ready'});
it('exchanges duplicate browser callbacks once, with a short public-result grace period',async()=>{
 let now=0;const cache=new McpCallbackCompletions(()=>now),run=vi.fn(async()=>result),input={state:'fixture-state',code:'fixture-code'};
 const one=cache.complete('owner',input,run),two=cache.complete('owner',input,run);
 expect(one).toBe(two);expect(await one).toEqual(result);expect(run).toHaveBeenCalledTimes(1);
 expect(await cache.complete('owner',input,run)).toEqual(result);expect(run).toHaveBeenCalledTimes(1);
 now=5001;await cache.complete('owner',input,run);expect(run).toHaveBeenCalledTimes(2);
});
it('never shares completion across owners or different callback inputs',async()=>{
 const cache=new McpCallbackCompletions(),run=vi.fn(async()=>result);
 await cache.complete('one',{state:'same',code:'one'},run);await cache.complete('two',{state:'same',code:'one'},run);await cache.complete('one',{state:'same',code:'two'},run);
 expect(run).toHaveBeenCalledTimes(3);
});
it('does not retain a failed exchange as a success',async()=>{
 const cache=new McpCallbackCompletions(),bad=vi.fn(async()=>{throw Error('fixture failure')});
 await expect(cache.complete('owner',{state:'same'},bad)).rejects.toThrow('fixture failure');
 const good=vi.fn(async()=>result);expect(await cache.complete('owner',{state:'same'},good)).toEqual(result);expect(good).toHaveBeenCalledTimes(1);
});
