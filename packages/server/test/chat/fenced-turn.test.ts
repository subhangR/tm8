import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HarnessRegistry, harnessFailure, type HarnessCapabilities, type HarnessSession, type OpenHarnessInput, type TurnCommand } from '@tm8/execution';
import { AgentSilentError, DEFAULT_CHAT_IDLE_TIMEOUT_MS, DEFAULT_CHAT_TOOL_TIMEOUT_MS, executeFencedTurn,
  UsageAccumulator, type FencedClaim, type FencedTurnOptions } from '../../src/chat/fenced-turn.js';
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
it('names the startup step that timed out in a preparation failure',async()=>{
  const f=fixture(); const late=deferred<HarnessSession>();
  f.open.mockImplementation(async()=>late.promise); f.options.timeouts!.open=5;
  await executeFencedTurn(f.options);
  const failed=f.calls.find(c=>c.name==='fail_chat_preparation')!;
  expect(failed.args[2]).toMatchObject({code:'preparation_failed',message:'Chat runtime could not prepare this turn: harness open timed out.',
    detail:{step:'harness open',error:{name:'Error',message:'harness open timed out'}}});
});
it('settles a harness refusal with its own reason, not a bare runtime_lost',async()=>{
  const f=fixture();
  f.open.mockImplementation(async value=>{
    const session=f.makeSession(value); let exited=false; let wake=()=>{};
    return {...session,
      submit:async()=>{ throw harnessFailure('unsupported_capability','submit','This chat cannot take file attachments yet. Paste the content as text instead.'); },
      close:async()=>{ exited=true; wake(); return {exited:true,nativeUsable:null}; },
      observations:(async function*(){
        if (!exited) await new Promise<void>(r=>{wake=r;});
        yield {fence:value.fence,attempt:null,nativeTurnId:null,observedAt:new Date().toISOString(),adapterSeq:1,
          payload:{kind:'runtime_exit' as const}};
      })()} as HarnessSession;
  });
  await executeFencedTurn(f.options);
  const done=f.calls.find(c=>c.name==='complete_chat_turn')!;
  expect(done.args[1]).toBe('error');
  expect(done.args[5]).toMatchObject({code:'unsupported_capability',
    message:'This chat cannot take file attachments yet. Paste the content as text instead.',
    detail:{step:'harness submission',error:{name:'HarnessRuntimeError',harness:{code:'unsupported_capability',stage:'submit'}}}});
  // The thread shows the reason, not the DB's "Agent turn failed." default.
  expect(done.args[2]).toBe('This chat cannot take file attachments yet. Paste the content as text instead.');
  expect(f.calls.some(c=>c.name==='append_chat_message_part' && c.args[2]==='error'
    && (c.args[3] as {message?:string}).message?.startsWith('This chat cannot take file attachments'))).toBe(true);
});

it('sends attachments to a harness without file inputs only through the prompt manifest',async()=>{
  const f=fixture(); const sent:TurnCommand[]=[];
  (f.options.turn as {attachments:unknown}).attachments=[{fileEntityId:randomUUID(),name:'a.json',mime:'application/json'}];
  const open=f.open.getMockImplementation()!;
  f.open.mockImplementation(async input=>{ const s=await open(input);
    return {...s,submit:async command=>{ sent.push(command); return s.submit(command); }}; });
  await executeFencedTurn(f.options);
  expect(sent[0]!.attachmentRefs).toEqual([]);
  expect(f.calls.find(c=>c.name==='complete_chat_turn')!.args[1]).toBe('completed');
  // The sealed input still records the attachment.
  expect((f.calls.find(c=>c.name==='seal_chat_turn_snapshot')!.args[3] as {input:{attachments:unknown[]}}).input.attachments).toHaveLength(1);
});

it('passes attachment refs to a harness that declares file inputs',async()=>{
  const f=fixture(); const sent:TurnCommand[]=[]; const file=randomUUID();
  (f.options.turn as {attachments:unknown}).attachments=[{fileEntityId:file,name:'a.png',mime:'image/png'}];
  const withFiles={...caps,fileInputs:'supported' as const};
  const open=f.open.getMockImplementation()!;
  const registry=new HarnessRegistry([{kind:'codex',capabilities:async()=>withFiles,open:async input=>{ const s=await open(input);
    return {...s,submit:async command=>{ sent.push(command); return s.submit(command); }}; }}]);
  await executeFencedTurn({...f.options,registry});
  expect(sent[0]!.attachmentRefs).toEqual([file]);
});

it('retries a fenced write that lost a deadlock instead of failing the turn',async()=>{
  const f=fixture(); const rpc=f.options.db.rpc.bind(f.options.db); let thrown=0;
  f.options.db.rpc=async(auth,name,args)=>{
    if(name==='append_chat_message_part' && args?.[2]==='tool_call' && thrown<2) {
      thrown++; throw Object.assign(new Error('internal database error'),{details:{sqlstate:'40P01'}});
    }
    return rpc(auth,name,args);
  };
  await executeFencedTurn(f.options);
  expect(thrown).toBe(2);
  expect(f.calls.find(c=>c.name==='complete_chat_turn')!.args[1]).toBe('completed');
  expect(f.options.onError).not.toHaveBeenCalled();
});

it('records the failing step, RPC and error when an output write fails for good',async()=>{
  const f=fixture(); const rpc=f.options.db.rpc.bind(f.options.db);
  f.options.db.rpc=async(auth,name,args)=>{
    if(name==='append_chat_message_part' && args?.[2]==='tool_call')
      throw Object.assign(new Error('stale chat execution fence'),{details:{sqlstate:'42501'}});
    return rpc(auth,name,args);
  };
  await executeFencedTurn(f.options);
  const done=f.calls.find(c=>c.name==='complete_chat_turn')!;
  const failure=done.args[5] as {code:string;message:string;detail:Record<string,unknown>};
  expect(failure.code).toBe('delivery_unknown');
  expect(failure.message).toBe("Chat delivery was interrupted (the server could not save the agent's output); recorded effects may have occurred.");
  expect(failure.detail).toMatchObject({step:'agent output',rpc:'append_chat_message_part',
    error:{message:'stale chat execution fence',sqlstate:'42501'}});
  expect(done.args[2]).toBe('final answer');
  // The part the thread renders carries only the readable reason.
  const part=f.calls.filter(c=>c.name==='append_chat_message_part' && c.args[2]==='error').at(-1)!.args[3];
  expect(part).toEqual({code:'delivery_unknown',message:failure.message});
});

it('names the step and keeps the error when preparation throws',async()=>{
  const f=fixture();
  f.resolver.mockImplementationOnce(async()=>{ throw new Error('credential lease refused'); });
  await executeFencedTurn(f.options);
  const failure=f.calls.find(c=>c.name==='fail_chat_preparation')!.args[2];
  expect(failure).toMatchObject({code:'preparation_failed',message:'Chat runtime could not prepare this turn: launch preparation failed.',
    detail:{step:'launch preparation',error:{name:'Error',message:'credential lease refused'}}});
});

it('gives a turn whose process exits without a reason a readable failure in the thread',async()=>{
  const f=fixture();
  f.open.mockImplementation(async value=>{
    const session=f.makeSession(value); const sent=deferred<TurnCommand>();
    return {...session,
      submit:async command=>{ sent.resolve(command); return session.submit(command); },
      observations:(async function*(){
        await sent.promise;
        yield {fence:value.fence,attempt:null,nativeTurnId:null,observedAt:new Date().toISOString(),adapterSeq:1,
          payload:{kind:'runtime_exit' as const,expected:false,exitCode:1,signal:null}};
      })()} as HarnessSession;
  });
  await executeFencedTurn(f.options);
  const done=f.calls.find(c=>c.name==='complete_chat_turn')!;
  expect(done.args[5]).toEqual({code:'runtime_lost',message:'The agent process exited before it finished this turn.'});
  expect(done.args[2]).toBe('The agent process exited before it finished this turn.');
  const parts=f.calls.filter(c=>c.name==='append_chat_message_part').map(c=>c.args[2]);
  expect(parts.slice(-2)).toEqual(['error','done']);
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
it('a Stop latched before dispatch settles the turn as interrupted and never submits it',async()=>{
  const f=fixture(); let stop=false;
  f.resolver.mockImplementationOnce(async(...args)=>{ stop=true; return (await f.resolver.getMockImplementation()!(...args)); });
  (f.options as {stopRequested?:()=>boolean}).stopRequested=()=>stop;
  await executeFencedTurn(f.options);
  expect(f.events).not.toContain('submit');
  expect(f.events).not.toContain('begin_chat_dispatch');
  const failed=f.calls.find(c=>c.name==='fail_chat_preparation')!;
  expect(failed.args[2]).toMatchObject({code:'interrupted'});
  expect(f.options.onError).not.toHaveBeenCalled();
  expect(f.calls.some(c=>c.name==='release_chat_runtime')).toBe(true);
  expect(f.publish.mock.calls.at(-1)![1].type).toBe('chat.turn.done');
});
it('a Stop latched between track and submit is not lost: the opened harness is cancelled before dispatch',async()=>{
  const f=fixture(); let stop=false;
  (f.options as {stopRequested?:()=>boolean}).stopRequested=()=>stop;
  f.options.track=vi.fn(()=>{ stop=true; });
  await executeFencedTurn(f.options);
  expect(f.events).not.toContain('submit');
  expect(f.calls.find(c=>c.name==='fail_chat_preparation')!.args[2]).toMatchObject({code:'interrupted'});
});
it('a Stop that races submit is turned into a cancel right after the send',async()=>{
  const f=fixture(); let stop=false; const cancel=vi.fn(async()=>({disposition:'requested' as const,nativeTurnId:'turn'}));
  (f.options as {stopRequested?:()=>boolean}).stopRequested=()=>stop;
  const open=f.open.getMockImplementation()!;
  f.open.mockImplementation(async input=>{ const s=await open(input); const submit=s.submit;
    return {...s,cancel,submit:async command=>{ stop=true; return submit(command); }}; });
  await executeFencedTurn(f.options);
  expect(f.events.filter(e=>e==='submit')).toHaveLength(1);
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({turnId:f.options.turn.turnId}),'user');
});

/**
 * The observation budget. `fixture()` above scripts a stream that never
 * pauses; this one holds a started tool call open until the test releases it,
 * which is the gap that used to end the turn after 120s.
 */
function toolGapFixture() {
  const f=fixture();
  const gate=deferred<void>();
  f.open.mockImplementation(async value => {
    const session=f.makeSession(value);
    const sent=deferred<TurnCommand>();
    const base=(adapterSeq:number,attempt:TurnCommand['attempt'])=>({fence:value.fence,attempt,adapterSeq,
      nativeTurnId:'turn',observedAt:new Date().toISOString()});
    const tool=(state:'running'|'completed')=>({toolKey:'k1',nativeCallId:'c1',name:'WebSearch',args:{query:'q'},
      state,result:state==='completed'?'hits':null,origin:'native' as const,
      evidence:state==='running'?'started' as const:'completed' as const});
    return {...session,
      // The attempt id is minted inside executeFencedTurn and an observation
      // that names a different one is skipped by design, so take it from the
      // command the turn actually submitted.
      submit:async (command:TurnCommand)=>{sent.resolve(command); return session.submit(command);},
      observations:(async function*(){
        const {attempt}=await sent.promise;
        yield {...base(1,attempt),payload:{kind:'tool' as const,tool:tool('running')}};
        await gate.promise;
        yield {...base(2,attempt),payload:{kind:'tool' as const,tool:tool('completed')}};
        yield {...base(3,attempt),payload:{kind:'text' as const,itemId:'answer',revision:1,
          operation:'append' as const,phase:'final' as const,text:'searched'}};
        yield {...base(4,attempt),payload:{kind:'terminal' as const,outcome:'completed' as const,
          evidence:'provider_terminal' as const}};
      })()};
  });
  return {...f,gate};
}

it('lets a tool outlive the idle limit and still completes inside the tool budget',async()=>{
  const f=toolGapFixture();
  f.options.timeouts!.observation=40; f.options.timeouts!.tool=5_000;
  const run=executeFencedTurn(f.options);
  await sleep(160);                                  // four times the idle limit
  expect(f.calls.some(c=>c.name==='complete_chat_turn')).toBe(false);
  f.gate.resolve(); await run;
  const done=f.calls.find(c=>c.name==='complete_chat_turn')!;
  expect(done.args[1]).toBe('completed'); expect(done.args[2]).toBe('searched');
  expect(done.args[5]).toBeNull();
  expect(f.options.onError).not.toHaveBeenCalled();
});

it('fails with agent_silent, not delivery_unknown, when no tool is in flight',async()=>{
  const f=fixture(); const stall=deferred<void>();
  f.open.mockImplementation(async value=>({...f.makeSession(value),
    observations:(async function*(){ await stall.promise; })()}));
  f.options.timeouts!.observation=30; f.options.timeouts!.tool=5_000;
  await executeFencedTurn(f.options);
  const failure=f.calls.find(c=>c.name==='complete_chat_turn')!.args[5] as {code:string;message:string};
  expect(failure.code).toBe('agent_silent');
  expect(failure.message).toBe('The agent sent nothing for 0s; the turn was stopped. Steps it already took may have taken effect.');
  expect(f.calls.some(c=>c.name==='append_chat_message_part'
    && (c.args[3] as {code?:string}|null)?.code==='delivery_unknown')).toBe(false);
  stall.resolve();
});

it('fails with agent_silent naming the tool when one outruns the tool budget',async()=>{
  const f=toolGapFixture();
  f.options.timeouts!.observation=10; f.options.timeouts!.tool=60;
  await executeFencedTurn(f.options);
  const failure=f.calls.find(c=>c.name==='complete_chat_turn')!.args[5] as {code:string;message:string};
  expect(failure.code).toBe('agent_silent');
  // The budget these tests can afford is milliseconds, so it rounds to 0s
  // here; the message at the real budgets is asserted below.
  expect(failure.message).toBe('The agent sent nothing for 0s while WebSearch was running; the turn was stopped. Steps it already took may have taken effect.');
  f.gate.resolve();
});

it('names the running tools and the real budget in the message a thread renders',()=>{
  // Explicit budgets, so the wording stays asserted even if the defaults move.
  expect(new AgentSilentError(600_000,['WebSearch']).message)
    .toBe('The agent sent nothing for 10m while WebSearch was running; the turn was stopped. Steps it already took may have taken effect.');
  expect(new AgentSilentError(600_000,['WebSearch','Bash']).message)
    .toBe('The agent sent nothing for 10m while WebSearch, Bash were running; the turn was stopped. Steps it already took may have taken effect.');
  expect(new AgentSilentError(120_000,[]).message)
    .toBe('The agent sent nothing for 2m; the turn was stopped. Steps it already took may have taken effect.');
  expect(new AgentSilentError(90_000,[]).message).toBe('The agent sent nothing for 1.5m; the turn was stopped. Steps it already took may have taken effect.');
  expect(new AgentSilentError(120_000,[]).code).toBe('agent_silent');
});

/**
 * The shipped defaults. #1283 raised the single observation limit to 30 min;
 * splitting it in two must not quietly tighten either half, and the tool
 * budget must never end up BELOW the idle one.
 */
it('keeps both default budgets at the 30 minutes #1283 shipped',()=>{
  expect(DEFAULT_CHAT_IDLE_TIMEOUT_MS).toBe(30*60_000);
  expect(DEFAULT_CHAT_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_CHAT_IDLE_TIMEOUT_MS);
  expect(new AgentSilentError(DEFAULT_CHAT_IDLE_TIMEOUT_MS,[]).message)
    .toBe('The agent sent nothing for 30m; the turn was stopped. Steps it already took may have taken effect.');
});

it('heartbeats the runtime lease through a wait that outlasts the idle limit',async()=>{
  const f=toolGapFixture();
  f.options.timeouts!.observation=40; f.options.timeouts!.tool=5_000; f.options.timeouts!.heartbeat=25;
  const run=executeFencedTurn(f.options);
  await sleep(160);
  expect(f.calls.filter(c=>c.name==='heartbeat_chat_runtime').length).toBeGreaterThanOrEqual(2);
  f.gate.resolve(); await run;
});
