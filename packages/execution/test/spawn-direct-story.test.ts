import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';
import type { CreateWorkSessionInput, GraphPort } from '../src/spawn/types.js';
const STORY='66666666-6666-4666-8666-666666666666';
const SESSION='55555555-5555-4555-8555-555555555555';
describe('story spawn launch', () => {
  let dataDir:string; let projectDir:string; let pty:PtyHostService;
  beforeEach(async () => {
    dataDir=await mkdtemp(join(tmpdir(),'tm8-story-data-')); projectDir=await mkdtemp(join(tmpdir(),'tm8-story-project-'));
    pty=new PtyHostService();
    vi.spyOn(pty,'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty,'spawnIfAbsent').mockReturnValue({reused:false} as never);
    vi.spyOn(pty,'waitForBootSettlement').mockResolvedValue(null);
  });
  afterEach(async () => {vi.restoreAllMocks();await rm(dataDir,{recursive:true,force:true});await rm(projectDir,{recursive:true,force:true});});
  it.each([false, true])('launches taskless when story context reading fails (v2=%s)', async v2 => {
    const graph = new FakeGraph({ workingDir: projectDir, sessionId: SESSION,
      ...(v2 ? { profileSnapshot: { agentProjection: { promptPolicy: { kernelTemplate: 'tm8.core.v2' } } } } : {}) });
    (graph as GraphPort).loadStoryContext = vi.fn().mockRejectedValue(new Error('context unavailable'));
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const service = new SpawnService({ graph, pty, logger, baseUrl: 'http://127.0.0.1:4611', dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD }, bootSettlementMs: 25 });
    await service.spawn({ identityId: 'identity-1', actorId: 'actor-1' }, {
      spaceId: '11111111-1111-4111-8111-111111111111',
      teamMemberId: '22222222-2222-4222-8222-222222222222',
      projectId: '33333333-3333-4333-8333-333333333333', storyId: STORY,
    });
    expect(graph.manifests[0]!.manifest.tasks).toEqual([]);
    expect(graph.manifests[0]!.prompts.task).not.toContain('<story ');
    expect(pty.spawnIfAbsent).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('spawn: story context read failed', {
      sessionId: SESSION, taskId: undefined, error: 'Error: context unavailable',
    });
  });
  it.each([false,true])('persists story anchor and injects taskless context (v2=%s)',async v2 => {
    const graph = new FakeGraph({workingDir:projectDir,sessionId:SESSION,...(v2 ? {profileSnapshot:{agentProjection:{promptPolicy:{kernelTemplate:'tm8.core.v2'}}}} : {})});
    const create=vi.spyOn(graph,'createWorkSession');
    const load=vi.fn(async (_auth, input) => {
      expect(input).toEqual({sessionId:SESSION});
      return {id:STORY,title:'Direct story',taskId:null,viaRootId:SESSION,depth:0,snapshot:'loaded',description:'Acceptance context'};
    });
    (graph as GraphPort).loadStoryContext=load;
    const service=new SpawnService({graph,pty,baseUrl:'http://127.0.0.1:4611',dataDir,env:{PATH:process.env.PATH,HOME:process.env.HOME,TM8_AGENT_CMD:ECHO_AGENT_CMD},bootSettlementMs:25});
    await service.spawn({identityId:'identity-1',actorId:'actor-1'},{spaceId:'11111111-1111-4111-8111-111111111111',teamMemberId:'22222222-2222-4222-8222-222222222222',projectId:'33333333-3333-4333-8333-333333333333',storyId:STORY,sourceWorkSessionId:'parent-1'});
    expect((create.mock.calls[0]![1] as CreateWorkSessionInput)).toMatchObject({storyId:STORY,taskIds:[],sourceWorkSessionId:'parent-1'});
    expect(graph.manifests[0]!.manifest.tasks).toEqual([]);
    expect(graph.manifests[0]!.prompts.task).toContain(`<story id="${STORY}"`);
    expect(graph.manifests[0]!.prompts.task).toContain('Acceptance context');
  });
});
