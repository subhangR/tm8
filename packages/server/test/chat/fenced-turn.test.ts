import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HarnessRegistry, type HarnessCapabilities, type HarnessSession, type OpenHarnessInput, type TurnCommand } from '@tm8/execution';
import { executeFencedTurn, UsageAccumulator, type FencedClaim, type FencedTurnOptions } from '../../src/chat/fenced-turn.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';

const caps: HarnessCapabilities={schemaVersion:1,harness:'codex',binaryVersion:'test',protocolRevision:'v2',
  nativeResume:'unknown',portableBootstrap:'supported',cancelActiveTurn:'supported',nativeTurnIds:'supported',usage:'supported',
  contextReading:'supported',interactiveRequests:'unsupported',textInputs:'supported',imageInputs:'unsupported',fileInputs:'unsupported',
  builtInToolRestriction:'unknown',configuration:{model:'per_turn',reasoningEffort:'per_turn',serviceTier:'per_turn',instructions:'restart',tools:'restart',credential:'restart'}};
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function fixture(delivery:'sent'|'unknown'|'not_sent'|'reject'|'timeout'='sent',terminalBeforeAck=false) {
  const calls:{name:string;args:readonly unknown[]}[]=[]; const events:string[]=[];
  const turn={turnId:randomUUID(),chatId:randomUUID(),userMessageId:randomUUID(),agentMessageId:null,spaceId:randomUUID(),
    body:'current request',attachments:[],requesterIdentityId:'creator',requesterAuthKind:'browser',teammateId:randomUUID(),
    model:'gpt-5.6-sol',provider:'openai',agentTool:'codex',chatMode:'explain',nativeSessionId:'legacy-id',cwd:'/tmp/test',runtimeState:'cold',
    nextSeq:0,turnOrdinal:1,captureHighWater:1,runtimeEpoch:1,attemptNo:1,configRevision:1,
    claimedConfiguration:{model:'gpt-5.6-sol',reasoningEffort:null},
    claimedAuthority:{identityId:'poster',authKind:'cli',authSessionId:randomUUID(),memberId:randomUUID()}} as FencedClaim;
  const rpc=async <T>(name:string,args:readonly unknown[]=[]) => {
    calls.push({name,args}); events.push(name);
    if (name==='reserve_chat_continuity') return {nativeGeneration:1,bindingId:randomUUID()} as T;
    if (name==='seal_chat_turn_snapshot') return {inputDigest:'input-hash'} as T;
    if (name==='append_chat_message_part') return {seq:args[1],kind:args[2],payload:args[3],createdAt:new Date().toISOString()} as T;
    if (name==='release_chat_runtime') return true as T;
    return undefined as T;
  };
  const q:Querier={query:async <T>()=>[] as T[],rpc};
  const db:Db={tx:async <T>(_auth:DbClaims,fn:(q:Querier)=>Promise<T>)=>fn(q),query:async <T>()=>[] as T[],rpc:async <T>(_auth:DbClaims,name:string,args:readonly unknown[]=[])=>rpc<T>(name,args)};
  const release=vi.fn(async()=>{events.push('release');});
  const resolver=vi.fn(async (input,owner,fence)=>({launch:{kind:'ephemeral-launch',launchId:'launch',storageScopeId:'private',nativeStorageScopeId:'history',
    nativeStorageGeneration:1,owner,modelCredentialLeaseId:'model-lease',runtimeGrantId:'grant',capabilityPlanId:'capability',release,materialize:vi.fn()},
    credentialBinding:{},credentialBindingId:'binding',credentialRevision:null,launchFingerprint:null,
    target:{harness:'codex',provider:'openai',model:input.model,reasoningEffort:null,serviceTier:null},
    instructionHash:'instructions',toolPolicyHash:'tools',mcpBindingRevision:'mcp',revalidate:vi.fn(async()=>{})}));
  const makeSession=(input:OpenHarnessInput):HarnessSession => {
    const sent=deferred<TurnCommand>();
    return {fence:input.fence,opened:{native:{schemaVersion:1,harness:'codex',nativeId:'opaque-native',nodeId:'node',storageScopeId:'history',
      nativeStorageGeneration:1,cwdIdentity:'/tmp/test',historyFormat:'test'},nativeConfirmed:true,readiness:'protocol_session_ack',capabilities:caps,
      execution:{requested:input.config.target,configuredModel:null,observedModel:null,observedEffort:null,observedServiceTier:null,evidence:'requested_only'},
      seed:input.mode.kind==='bootstrap'?{...input.mode.context,transport:'instructions',acknowledgement:'launch_materialized'}:null},
      observations:(async function*(){
        const command=await sent.promise;
        if (delivery!=='sent' && !terminalBeforeAck) return;
        const base={fence:input.fence,attempt:command.attempt,nativeTurnId:'turn',observedAt:new Date().toISOString()};
        yield {...base,fence:{...input.fence,generation:99},adapterSeq:1,payload:{kind:'text' as const,itemId:'stale',revision:1,operation:'append' as const,phase:'final' as const,text:'STALE'}};
        yield {...base,adapterSeq:2,payload:{kind:'text' as const,itemId:'answer',revision:1,operation:'append' as const,phase:'commentary' as const,text:'draft'}};
        yield {...base,adapterSeq:3,payload:{kind:'text' as const,itemId:'answer',revision:2,operation:'replace' as const,phase:'final' as const,text:'final answer'}};
        yield {...base,adapterSeq:4,payload:{kind:'tool' as const,tool:{toolKey:'generation:attempt:call',nativeCallId:'call',name:'read',args:{path:'file'},state:'completed' as const,
          result:'stored result',origin:'native' as const,evidence:'completion_only' as const}}};
        yield {...base,adapterSeq:5,payload:{kind:'terminal' as const,outcome:'completed' as const,evidence:'provider_terminal' as const}};
      })(),
      submit:async command=>{events.push('submit');sent.resolve(command); await sleep(2); events.push('ack');
        if (delivery==='reject') throw new Error('ACK lost');
        if (delivery==='timeout') return new Promise(()=>{});
        return delivery==='sent'?{delivery:'sent',acknowledgement:'native_ack',nativeTurnId:'turn'}:delivery==='unknown'?{delivery:'unknown',nativeTurnId:null}:{delivery:'not_sent',code:'not_written'};},
      cancel:async()=>({disposition:'requested',nativeTurnId:'turn'}),respond:async()=>{},
      close:async()=>{events.push('exit');return {exited:true,nativeUsable:null};}};
  };
  const open=vi.fn(async(input:OpenHarnessInput)=>makeSession(input));
  const registry=new HarnessRegistry([{kind:'codex',capabilities:async()=>caps,open}]);
  const publish=vi.fn();
  const options={db,registry,resolvePreparedLaunch:resolver,publisher:{publish},turn,leaseToken:'private-fence',prompt:'current request',
    historyBudgetBytes:32768,createAgentMessage:async()=>randomUUID(),track:vi.fn(),untrack:vi.fn(),onError:vi.fn(),onReleased:vi.fn(),
    timeouts:{preparation:100,open:100,submit:100,observation:100,close:100}} as unknown as FencedTurnOptions;
  return {options,calls,events,release,resolver,open,makeSession,publish};
}
it('commits before send, consumes early notifications, folds replacements, ignores stale output and settles before publishing',async()=>{
  const f=fixture(); await executeFencedTurn(f.options);
  expect(f.options.onError).not.toHaveBeenCalled();
  expect(f.events.indexOf('begin_chat_dispatch')).toBeLessThan(f.events.indexOf('submit'));
  expect(f.events.indexOf('append_chat_message_part')).toBeLessThan(f.events.indexOf('ack'));
  const done=f.calls.find(c=>c.name==='complete_chat_turn')!;
  expect(done.args[1]).toBe('completed'); expect(done.args[2]).toBe('final answer');
  expect(f.calls.filter(c=>c.name==='append_chat_message_part').map(c=>c.args[3])).not.toContainEqual(expect.objectContaining({text:'STALE'}));
  expect(f.calls.filter(c=>c.name==='append_chat_message_part').some(c=>c.args[2]==='tool_result')).toBe(true);
  expect(f.events.indexOf('exit')).toBeLessThan(f.events.indexOf('release'));
  expect(f.resolver.mock.calls[0]![0]).toMatchObject({requesterIdentityId:'poster',requesterAuthKind:'cli',requesterAuthSessionId:f.options.turn.claimedAuthority.authSessionId});
  expect(f.publish.mock.calls.at(-1)![1].type).toBe('chat.turn.done');
});
it.each(['unknown','not_sent'] as const)('does not resend a %s dispatch',async delivery=>{
  const f=fixture(delivery); await executeFencedTurn(f.options);
  expect(f.events.filter(e=>e==='submit')).toHaveLength(1);
  expect(f.calls.find(c=>c.name==='complete_chat_turn')!.args[1]).toBe('error');
  if (delivery==='not_sent') expect(f.calls.find(c=>c.name==='complete_chat_turn')!.args[5]).toMatchObject({code:'provider_not_sent'});
});
it.each(['unknown','not_sent','reject','timeout'] as const)('preserves a durable provider terminal before a %s ACK',async delivery=>{
  const f=fixture(delivery,true); f.options.timeouts!.submit=10;
  await executeFencedTurn(f.options);
  const done=f.calls.filter(c=>c.name==='append_chat_message_part' && c.args[2]==='done');
  expect(done.map(c=>c.args[3])).toEqual([{reason:'success'}]);
  const completion=f.calls.find(c=>c.name==='complete_chat_turn')!;
  expect(completion.args[1]).toBe('completed');expect(completion.args[2]).toBe('final answer');
  expect(completion.args[8]).toMatchObject({outcome:'completed',evidence:'provider_terminal'});
  expect(f.events.filter(e=>e==='submit')).toHaveLength(1);
});
it.each(['transient','permanent'] as const)('requires the same normalized done write to persist after a %s failure',async fault=>{
  const f=fixture();const rpc=f.options.db.rpc.bind(f.options.db);const attempts:{seq:unknown;event:unknown}[]=[];
  f.options.db.rpc=async(auth,name,args)=>{
    if(name==='append_chat_message_part' && args?.[2]==='done') {
      attempts.push({seq:args[1],event:args[6]});
      if(fault==='permanent' || attempts.length===1)throw new Error('done write unavailable');
    }
    return rpc(auth,name,args);
  };
  if(fault==='permanent') {
    await expect(executeFencedTurn(f.options)).rejects.toThrow('done write unavailable');
    expect(f.calls.some(c=>c.name==='complete_chat_turn')).toBe(false);
    expect(f.publish.mock.calls.some(c=>c[1].type==='chat.turn.done')).toBe(false);
    expect(f.calls.find(c=>c.name==='record_chat_terminal')!.args[3]).toMatchObject({outcome:'completed',evidence:'provider_terminal'});
  } else {
    await executeFencedTurn(f.options);
    expect(f.calls.find(c=>c.name==='complete_chat_turn')!.args[1]).toBe('completed');
    expect(f.calls.filter(c=>c.name==='append_chat_message_part' && c.args[2]==='done')).toHaveLength(1);
    expect(f.publish.mock.calls.some(c=>c[1].type==='chat.turn.done')).toBe(true);
  }
  expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);
  expect(f.events.filter(e=>e==='submit')).toHaveLength(1);
});
it('keeps the lease until exact resource cleanup succeeds and then wakes the queued drain',async()=>{
  const f=fixture();f.options.timeouts!.cleanupRetry=5;
  let available=false;
  f.release.mockImplementation(async()=>{if(!available)throw new Error('cleanup offline');f.events.push('release');});
  await executeFencedTurn(f.options);
  expect(f.calls.some(c=>c.name==='release_chat_runtime')).toBe(false);
  expect(f.options.onReleased).not.toHaveBeenCalled();
  available=true;await sleep(15);
  expect(f.calls.filter(c=>c.name==='release_chat_runtime')).toHaveLength(1);
  expect(f.options.onReleased).toHaveBeenCalledOnce();
});
it('retains a timed-out open lease until the late child confirms exit',async()=>{
  const f=fixture(); const late=deferred<HarnessSession>(); let input!:OpenHarnessInput;
  f.open.mockImplementation(async value=>{input=value; return late.promise;});
  f.options.timeouts!.open=5;
  await executeFencedTurn(f.options); expect(f.release).not.toHaveBeenCalled();
  late.resolve(f.makeSession(input)); await sleep(5);
  expect(f.events.indexOf('exit')).toBeLessThan(f.events.indexOf('release')); expect(f.release).toHaveBeenCalledOnce();
  expect(f.options.onReleased).toHaveBeenCalledOnce();
});
it('releases late prepared material and does not open it after timeout',async()=>{
  const f=fixture(); const late=deferred<Awaited<ReturnType<typeof f.resolver>>>(); const original=f.resolver.getMockImplementation()!;
  f.resolver.mockImplementation(async(...args)=>late.promise); f.options.timeouts!.preparation=5;
  await executeFencedTurn(f.options); expect(f.release).not.toHaveBeenCalled();
  late.resolve(await original({}, {}, {})); await sleep(5);
  expect(f.open).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
});
it('never publishes durable completion when settlement fails',async()=>{
  const f=fixture(); const rpc=f.options.db.rpc.bind(f.options.db);
  f.options.db.rpc=async(auth,name,args)=>{if(name==='complete_chat_turn'||name==='fail_chat_preparation')throw new Error('DB offline'); return rpc(auth,name,args);};
  await expect(executeFencedTurn(f.options)).rejects.toThrow('DB offline');
  expect(f.publish.mock.calls.some(call=>call[1].type==='chat.turn.done')).toBe(false);
});
it('aggregates distinct request costs and respects an authoritative cumulative attempt count',()=>{
  const u=new UsageAccumulator(); const fact={scope:'request' as const,observationId:'a',requestId:'r1',inputTokens:10,outputTokens:2,
    cacheReadTokens:null,cacheWriteTokens:null,reasoningOutputTokens:null,costUsd:0.2,costBasis:'provider_reported' as const,
    evidence:'reported' as const,baselineId:null};
  u.add(fact);u.add(fact);u.add({...fact,observationId:'b',requestId:'r2'});
  expect(u.value()).toEqual({input_tokens:20,output_tokens:4,total_cost_usd:0.4});
  u.add({...fact,scope:'attempt',observationId:'c',inputTokens:25,costUsd:null,costBasis:'unknown'});
  expect(u.value()).toEqual({input_tokens:25,output_tokens:2});
});
