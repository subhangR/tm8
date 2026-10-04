import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { FakeGraph } from './fake-graph.js';
const spaceId='11111111-1111-4111-8111-111111111111',teamMemberId='22222222-2222-4222-8222-222222222222';
const serverId='44444444-4444-4444-8444-444444444444';
const disposers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const dispose of disposers.splice(0))await dispose();});
async function fixture(bind:NonNullable<ConstructorParameters<typeof SpawnService>[0]['mcpBindings']>['bind']) {
 const dataDir=await mkdtemp(join(tmpdir(),'mcp-launch-')),workingDir=await mkdtemp(join(tmpdir(),'mcp-project-'));
 const pty=new PtyHostService(),graph=new FakeGraph({workingDir});
 disposers.push(async()=>{pty.shutdownAll();await rm(dataDir,{recursive:true,force:true});await rm(workingDir,{recursive:true,force:true});});
 const service=new SpawnService({graph,pty,dataDir,baseUrl:'http://127.0.0.1:4615',env:{...process.env,TM8_AGENT_CMD:'echo-agent'},trustWatchdogMs:0,mcpBindings:{bind}});
 return {service,graph};
}
it('actual spawn binds the minted session and preserves explicit empty selection',async()=>{
 const bind=vi.fn(async()=>[]);
 const {service}=await fixture(bind);
 const result=await service.spawn({identityId:'human'},{spaceId,teamMemberId,mcpSelections:[]});
 expect(bind).toHaveBeenCalledOnce();
 expect(bind.mock.calls[0]?.[1]).toMatchObject({sessionId:result.sessionId,spaceId,teamMemberId,mcpSelections:[],agentToken:expect.any(String)});
});
it('actual spawn leaves omitted selections omitted for default resolution',async()=>{
 const bind=vi.fn(async()=>[{serverId}]);
 const {service}=await fixture(bind);
 await service.spawn({identityId:'human'},{spaceId,teamMemberId});
 expect(bind.mock.calls[0]?.[1]).not.toHaveProperty('mcpSelections');
});
it('failed authorization aborts the launch and retires its token',async()=>{
 const {service,graph}=await fixture(async()=>{throw new Error('MCP credential revoked');});
 await expect(service.spawn({identityId:'human'},{spaceId,teamMemberId,mcpSelections:[{serverId}]})).rejects.toThrow('MCP credential revoked');
 expect(graph.transitions.some(s=>s.status==='failed')).toBe(true);
});
