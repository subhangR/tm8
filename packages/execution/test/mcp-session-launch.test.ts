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

/**
 * §4.2 end to end: what `bind` resolved reaches the manifest's connector record
 * through a real spawn. This fixture runs the echo agent (TM8_AGENT_CMD), so
 * the claude/codex argv half is asserted where it is built, in
 * mcp-secure-regression.test.ts.
 */
it('records the resolved server key -> id map in the launch manifest',async()=>{
 const second='55555555-5555-4555-8555-555555555555';
 const {service,graph}=await fixture(async()=>[
  {serverId,serverKey:'gmail'},{serverId:second,serverKey:'figma',credentialId:'66666666-6666-4666-8666-666666666666'},
 ]);
 const result=await service.spawn({identityId:'human'},{spaceId,teamMemberId,mcpSelections:[{serverId},{serverId:second}]});
 const recorded=graph.manifests.find(entry=>entry.sessionId===result.sessionId);
 expect(recorded?.manifest.launch.connectors).toEqual([
  {serverKey:'figma',serverId:second},{serverKey:'gmail',serverId:serverId},
 ]);
 // The account never reaches the manifest's connector record.
 expect(JSON.stringify(recorded?.manifest.launch.connectors)).not.toContain('6666');
});
