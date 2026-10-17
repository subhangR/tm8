import { randomUUID } from 'node:crypto';
import { MessagePartSchema, type ChatTurnUsage } from '@tm8/contract';
import {
  type AttemptRef, type GenerationFence, type HarnessRegistry, type HarnessSession,
  type RuntimeConfig, type TerminalOutcome, type UsageFact,
} from '@tm8/execution';
import type { Db, DbClaims } from '../db/types.js';
import type { ClaimedTurn } from './orchestrator.js';
import type { ChatTurnPublisher } from './publisher.js';
import type { createChatPreparedLaunchResolver, PreparedChatLaunch } from './harness-composition.js';
import { historyDigest, projectHistory, readPortableHistory } from './continuity.js';

export interface TurnAuthority {
  identityId: string; authKind: string; authSessionId: string | null; memberId: string;
}
export interface FencedClaim extends ClaimedTurn {
  turnOrdinal: number; captureHighWater: number; runtimeEpoch: number; attemptNo: number;
  configRevision: number; claimedConfiguration: Record<string, unknown>; claimedAuthority: TurnAuthority;
}
export interface ActiveChatHarness {
  session: HarnessSession; attempt: AttemptRef; revalidate(): Promise<void>;
}
export interface FencedTurnOptions {
  db: Db; registry: HarnessRegistry;
  resolvePreparedLaunch: ReturnType<typeof createChatPreparedLaunchResolver>;
  publisher: ChatTurnPublisher; turn: FencedClaim; leaseToken: string; prompt: string;
  historyBudgetBytes: number; createAgentMessage(): Promise<string>;
  track(active: ActiveChatHarness): void; untrack(): void;
  /** Called only after this owner's resources and durable lease are released. */
  onReleased?: (() => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  timeouts?: { preparation?: number; open?: number; submit?: number; observation?: number; close?: number; cleanupRetry?: number };
}

export async function deadline<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function matched(a: GenerationFence, b: GenerationFence): boolean {
  return a.chatId===b.chatId && a.bindingId===b.bindingId && a.generation===b.generation
    && a.leaseEpoch===b.leaseEpoch && a.configRevision===b.configRevision;
}

/** Distinct reported requests aggregate; attempt facts replace a cumulative attempt total. */
export class UsageAccumulator {
  private readonly seen = new Set<string>();
  private readonly requests = new Map<string, UsageFact>();
  private attempt: UsageFact | null = null;
  add(fact: UsageFact): void {
    if (this.seen.has(fact.observationId) || fact.scope==='native_conversation') return;
    this.seen.add(fact.observationId);
    if (fact.scope==='attempt') this.attempt=fact;
    else this.requests.set(fact.requestId ?? fact.observationId,fact);
  }
  value(): ChatTurnUsage | null {
    const facts=this.attempt ? [this.attempt] : [...this.requests.values()];
    if (!facts.length) return null;
    const result: ChatTurnUsage={};
    for (const [input,output] of [['inputTokens','input_tokens'],['outputTokens','output_tokens'],
      ['cacheReadTokens','cache_read_input_tokens'],['cacheWriteTokens','cache_creation_input_tokens'],['costUsd','total_cost_usd']] as const) {
      const values=facts.map(f => input==='costUsd' && f.costBasis!=='provider_reported' ? null : f[input]);
      if (values.every((v): v is number => v!==null && Number.isFinite(v) && v>=0)) result[output]=values.reduce((a,b)=>a+b,0);
    }
    return Object.keys(result).length ? result : null;
  }
}

/** One claimed input, one durable dispatch barrier, and no historical execution. */
export async function executeFencedTurn(options: FencedTurnOptions): Promise<void> {
  const { turn, db }=options;
  const auth: DbClaims={identityId:turn.requesterIdentityId}; // configuring authority owns persistence
  let leaseFence: Record<string, unknown>={runtimeEpoch:turn.runtimeEpoch,turnId:turn.turnId,
    attemptNo:turn.attemptNo,leaseToken:options.leaseToken};
  let prepared: PreparedChatLaunch | undefined;
  let session: HarnessSession | undefined;
  let snapshotId: string | undefined;
  let barrier=false;
  let knownNotSent=false;
  let closed=false;
  let seq=Number(turn.nextSeq);
  let agentMessageId=turn.agentMessageId;
  let terminal: {outcome:TerminalOutcome;evidence:'provider_terminal'|'process_exit'|'reconciliation'} | null=null;
  let terminalPart: {eventId:string;seq:number;payload:{reason:'success'|'interrupted'|'error'};persisted:boolean} | undefined;
  let failure: {code:string;message:string} | null=null;
  let completed=false;
  let settled=false;
  let preparing=false;
  let opening=false;
  let resourcesReleased=false;
  let resourceRelease: Promise<void> | undefined;
  let cleanupRetry: ReturnType<typeof setTimeout> | undefined;
  let cleanupRunning=false;
  let observed: Promise<void> | undefined;
  const textItems=new Map<string,{revision:number;text:string}>();
  const usage=new UsageAccumulator();
  const text=() => [...textItems.values()].map(item=>item.text).join('');
  const rpc=<T>(name:string,args:readonly unknown[]) => db.rpc<T>(auth,name,args);
  const append=async (kind:string,payload:unknown,event:string,partSeq=seq) => {
    if (!agentMessageId || !snapshotId) throw new Error('chat output has no sealed message');
    const stored=await rpc<unknown>('append_chat_message_part',
      [agentMessageId,partSeq,kind,payload,leaseFence,snapshotId,event]);
    const part=MessagePartSchema.parse(stored);
    options.publisher.publish(turn.spaceId,{type:'chat.turn.delta',chatId:turn.chatId,messageId:agentMessageId,seq:part.seq,part});
    seq=Math.max(seq,part.seq+1);
  };
  const releaseResources=() => {
    if (resourceRelease) return resourceRelease;
    resourceRelease=(async () => {
      await prepared?.launch.release();
      const released=await rpc<boolean>('release_chat_runtime',[turn.chatId,turn.runtimeEpoch,options.leaseToken]);
      resourcesReleased=true;
      if (released) options.onReleased?.();
    })().catch(error => {
      options.onError?.(error);
      resourceRelease=undefined;
      // Retry the original launch and lease fence; a successor is never revoked.
      // Closing remains durable until both cleanup operations succeed.
      if (!cleanupRetry) {
        cleanupRetry=setTimeout(() => { cleanupRetry=undefined; void releaseResources(); },options.timeouts?.cleanupRetry ?? 1_000);
        cleanupRetry.unref();
      }
    });
    return resourceRelease;
  };
  const cleanup=async () => {
    // A timed out operation can still materialize a grant or start a child.
    // Its completion handler, rather than the timer, owns eventual cleanup.
    if (resourcesReleased) { await resourceRelease; return; }
    if (preparing || opening || cleanupRunning) return;
    cleanupRunning=true;
    try {
      if (!session) { await releaseResources(); return; }
      const closing=session.close('shutdown');
      void closing.then(receipt => receipt.exited ? releaseResources() : undefined).catch(error=>options.onError?.(error));
      const receipt=await deadline(closing,options.timeouts?.close ?? 15_000,'harness close');
      if (receipt.exited) await releaseResources();
    } catch (error) { options.onError?.(error); }
    finally { cleanupRunning=false; }
  };
  const heartbeat=setInterval(() => { void rpc('heartbeat_chat_runtime',[turn.chatId,leaseFence]).catch(error => {
    options.onError?.(error); void session?.cancel({turnId:turn.turnId,attemptId:snapshotId ?? '',configRevision:turn.configRevision},'revocation');
  }); },30_000);
  heartbeat.unref();
  const persistTerminalPart=async () => {
    if (!terminalPart) throw new Error('terminal has no normalized part');
    if (!terminalPart.persisted) {
      await append('done',terminalPart.payload,terminalPart.eventId,terminalPart.seq);
      terminalPart.persisted=true;
    }
  };
  const settleTerminal=async (proofTerminal: NonNullable<typeof terminal>) => {
    terminalPart ??= {eventId:`server:${snapshotId}:done`,seq,payload:{reason:proofTerminal.outcome==='completed'
      && proofTerminal.evidence==='provider_terminal' ? 'success' : proofTerminal.outcome==='interrupted' ? 'interrupted' : 'error'},persisted:false};
    await persistTerminalPart();
    const proof={...proofTerminal,body:text(),usage:usage.value(),failure,
      ...(terminalPart ? {donePart:{eventId:terminalPart.eventId,seq:terminalPart.seq,payload:terminalPart.payload}} : {})};
    await rpc('record_chat_terminal',[turn.chatId,leaseFence,snapshotId,proof]);
    completed=proofTerminal.outcome==='completed' && proofTerminal.evidence==='provider_terminal';
    await rpc('complete_chat_turn',[turn.turnId,completed ? 'completed' : 'error',text(),usage.value(),
      usage.value()?.total_cost_usd ?? null,failure ?? (completed ? null : {code:proofTerminal.outcome}),leaseFence,snapshotId,proof,null]);
    settled=true;
  };
  try {
    agentMessageId ??= await options.createAgentMessage();
    const harness=turn.agentTool==='claude-code' ? 'claude' : turn.agentTool==='codex' ? 'codex' : null;
    if (!harness) throw new Error('unsupported chat harness');
    const requested={harness,provider:turn.provider,model:turn.model,
      reasoningEffort:typeof turn.claimedConfiguration.reasoningEffort==='string' ? turn.claimedConfiguration.reasoningEffort : null,serviceTier:null} as const;
    const capabilities=await deadline(options.registry.admit(requested,['portableBootstrap']),30_000,'harness admission');
    const reserved=await rpc<{nativeGeneration:number;bindingId:string}>('reserve_chat_continuity',[
      turn.chatId,leaseFence,{replaceRuntime:true,targetBinding:{agentTool:turn.agentTool,
        protocolRevision:capabilities.protocolRevision,storageScopeId:`pending:${turn.runtimeEpoch}`,
        compatibilityDigest:historyDigest({requested,authority:turn.claimedAuthority,mode:turn.chatMode})}}]);
    leaseFence={...leaseFence,nativeGeneration:reserved.nativeGeneration};
    const fence: GenerationFence={chatId:turn.chatId,bindingId:reserved.bindingId,generation:reserved.nativeGeneration,
      leaseEpoch:turn.runtimeEpoch,configRevision:turn.configRevision};
    snapshotId=randomUUID();
    const attempt: AttemptRef={turnId:turn.turnId,attemptId:snapshotId,configRevision:turn.configRevision};
    const history=await readPortableHistory(db,{identityId:turn.claimedAuthority.identityId,authKind:turn.claimedAuthority.authKind,
      sessionSpaceId:turn.spaceId,...(turn.claimedAuthority.authSessionId ? {authSessionId:turn.claimedAuthority.authSessionId} : {})},
      turn.chatId,turn.turnOrdinal,turn.captureHighWater);
    const bootstrap=projectHistory(history,{snapshotId,currentTurnOrdinal:turn.turnOrdinal,captureHighWater:turn.captureHighWater,
      authorityScopeDigest:historyDigest({authority:turn.claimedAuthority,mode:turn.chatMode}),maxBytes:options.historyBudgetBytes});
    const sealed=await rpc<{inputDigest:string}>('seal_chat_turn_snapshot',[turn.chatId,leaseFence,snapshotId,{
      desired:turn.claimedConfiguration,authority:turn.claimedAuthority,
      runtime:{revision:turn.configRevision,target:requested,credentialRevision:null,launchFingerprint:null},
      input:{messageId:turn.userMessageId,body:turn.body,attachments:turn.attachments ?? []},
      historyBudgetBytes:options.historyBudgetBytes,priorCursor:bootstrap.coverage,credentialBinding:null,
    },bootstrap]);
    preparing=true;
    const preparation=options.resolvePreparedLaunch({
      chatId:turn.chatId,requesterIdentityId:turn.claimedAuthority.identityId,requesterAuthKind:turn.claimedAuthority.authKind,
      ...(turn.claimedAuthority.authSessionId ? {requesterAuthSessionId:turn.claimedAuthority.authSessionId} : {}),
      credentialSelection:turn.credentialSelection,teammateId:turn.teammateId,model:turn.model,provider:turn.provider,
      agentTool:turn.agentTool,chatMode:turn.chatMode,spaceId:turn.spaceId,cwd:turn.cwd,mode:'new',
      reasoningEffort:requested.reasoningEffort,
    },{chatId:turn.chatId,generation:fence.generation,ownerLeaseId:reserved.bindingId,claimFence:options.leaseToken},fence).then(value => {
      prepared=value; preparing=false; if (closed) void cleanup(); return value;
    },error => { preparing=false; if (closed) void cleanup(); throw error; });
    prepared=await deadline(preparation,options.timeouts?.preparation ?? 30_000,'launch preparation');
    const config: RuntimeConfig={schemaVersion:1,revision:turn.configRevision,target:prepared.target,
      instructionHash:prepared.instructionHash,toolPolicyHash:prepared.toolPolicyHash,mcpBindingRevision:prepared.mcpBindingRevision,
      cwdIdentity:turn.cwd,credentialBindingId:prepared.credentialBindingId,credentialRevision:prepared.credentialRevision,
      launchFingerprint:prepared.launchFingerprint};
    opening=true;
    const openPromise=options.registry.get(harness).open({fence,config,mode:{kind:'bootstrap',context:bootstrap},launch:prepared.launch})
      .then(value => { session=value; opening=false; if (closed) void cleanup(); return value; },
        error => { opening=false; if (closed) void cleanup(); throw error; });
    session=await deadline(openPromise,options.timeouts?.open ?? 30_000,'harness open');
    await rpc('record_chat_open',[turn.chatId,leaseFence,snapshotId,{...session.opened,
      runtime:config,credentialBinding:prepared.credentialBinding,nativeStorageScopeId:prepared.launch.nativeStorageScopeId,
      nativeStorageGeneration:prepared.launch.nativeStorageGeneration}]);
    options.track({session,attempt,revalidate:prepared.revalidate});
    await prepared.revalidate();
    // Commit before submit, even if submit will fail before writing. Recovery
    // after this commit is conservative unless not_sent is explicitly proved.
    await rpc('begin_chat_dispatch',[turn.chatId,leaseFence,snapshotId,sealed.inputDigest]);
    barrier=true;
    const current=session;
    const consume=async () => {
      const iterator=current.observations[Symbol.asyncIterator]();
      while (!terminal) {
        const next=await deadline(iterator.next(),options.timeouts?.observation ?? 120_000,'harness observation');
        if (next.done) break;
        const observation=next.value;
        if (!matched(observation.fence,fence)) continue;
        if (observation.attempt && (observation.attempt.attemptId!==attempt.attemptId
          || observation.attempt.turnId!==attempt.turnId || observation.attempt.configRevision!==attempt.configRevision)) continue;
        const payload=observation.payload;
        const event=`adapter:${observation.adapterSeq}`;
        if (payload.kind==='seed_acknowledged') {
          await rpc('record_chat_acceptance',[turn.chatId,leaseFence,snapshotId,{nativeTurnId:observation.nativeTurnId,seed:payload.seed}]);
        } else if (payload.kind==='turn_accepted') {
          await rpc('record_chat_acceptance',[turn.chatId,leaseFence,snapshotId,{nativeTurnId:payload.nativeTurnId}]);
        } else if (payload.kind==='runtime_exit') {
          terminal={outcome:'runtime_lost',evidence:'process_exit'};
        } else if (!observation.attempt) continue;
        else if (payload.kind==='text') {
          const before=textItems.get(payload.itemId);
          if (before && payload.revision<=before.revision) continue;
          await append('text',{text:payload.text,itemId:payload.itemId,revision:payload.revision,
            operation:payload.operation,phase:payload.phase},event);
          textItems.set(payload.itemId,{revision:payload.revision,
            text:payload.operation==='replace' ? payload.text : (before?.text ?? '')+payload.text});
        } else if (payload.kind==='thinking') {
          if (payload.text.trim()) await append('thinking',{text:payload.text},event);
        } else if (payload.kind==='tool') {
          const tool=payload.tool;
          await append('tool_call',{id:tool.toolKey,name:tool.name,args:tool.args,
            state:tool.state==='completed' ? 'completed' : tool.state==='running' ? 'running' : 'error'},`${event}:call`);
          if (tool.result!==null) await append('tool_result',{tool_call_id:tool.toolKey,content:tool.result,
            is_error:tool.state!=='completed'},`${event}:result`);
        } else if (payload.kind==='usage') {
          usage.add(payload.usage);
          const total=usage.value(); if (total) await append('usage',total,event);
        } else if (payload.kind==='context') {
          await rpc('record_chat_runtime_observation',[turn.chatId,leaseFence,snapshotId,'context',payload.context]);
          options.publisher.publish(turn.spaceId,{type:'chat.context',chatId:turn.chatId,context:payload.context});
        } else if (payload.kind==='execution_facts') {
          await rpc('record_chat_runtime_observation',[turn.chatId,leaseFence,snapshotId,'execution',payload.facts]);
        } else if (payload.kind==='failure') {
          failure={code:payload.failure.code,message:payload.failure.safeMessage};
          await append('error',failure,event);
        } else if (payload.kind==='request') {
          await current.respond(payload.request.requestKey,{decision:'decline'});
          failure={code:'interaction_unavailable',message:'This chat cannot resolve this runtime interaction.'};
          await append('error',failure,event);
        } else if (payload.kind==='terminal') {
          terminalPart={eventId:event,seq,payload:{reason:payload.outcome==='completed' && payload.evidence==='provider_terminal'
            ? 'success' : payload.outcome==='interrupted' ? 'interrupted' : 'error'},persisted:false};
          const proof={outcome:payload.outcome,evidence:payload.evidence,body:text(),usage:usage.value(),failure,
            donePart:{eventId:event,seq:terminalPart.seq,payload:terminalPart.payload}};
          await rpc('record_chat_terminal',[turn.chatId,leaseFence,snapshotId,proof]);
          terminal={outcome:payload.outcome,evidence:payload.evidence};
          await persistTerminalPart();
        }
      }
    };
    // Start the stream reader before submit; notifications may precede the ACK.
    observed=consume();
    void observed.catch(()=>undefined);
    const dispatched=await deadline(current.submit({attempt,clientSubmissionId:snapshotId,text:options.prompt,
      attachmentRefs:(turn.attachments ?? []).map(file=>file.fileEntityId),config}),options.timeouts?.submit ?? 30_000,'harness submission');
    if (dispatched.delivery!=='sent') {
      knownNotSent=dispatched.delivery==='not_sent';
      await deadline(current.close('failure'),options.timeouts?.close ?? 15_000,'failed dispatch close');
      await deadline(observed.catch(()=>undefined),options.timeouts?.close ?? 15_000,'failed dispatch observations');
      throw new Error(dispatched.delivery==='not_sent' ? 'provider_not_sent' : 'delivery_unknown');
    }
    if (dispatched.acknowledgement==='native_ack') await rpc('record_chat_acceptance',[
      turn.chatId,leaseFence,snapshotId,{nativeTurnId:dispatched.nativeTurnId}]);
    await observed;
    if (!terminal) terminal={outcome:'runtime_lost',evidence:'reconciliation'};
    await settleTerminal(terminal);
  } catch (error) {
    if (barrier && session) {
      await deadline(session.close('failure'),options.timeouts?.close ?? 15_000,'failed turn close').catch(error=>options.onError?.(error));
      if (observed) await deadline(observed.catch(()=>undefined),options.timeouts?.close ?? 15_000,'failed turn observations').catch(error=>options.onError?.(error));
    }
    options.onError?.(error);
    // An ACK failure is weaker evidence than an already-durable provider terminal.
    // Its output parts are consumed before this branch and must not gain a second done.
    if (terminal) await settleTerminal(terminal);
    else {
      failure={code:knownNotSent ? 'provider_not_sent' : barrier ? 'delivery_unknown' : 'preparation_failed',
        message:knownNotSent ? 'The provider confirmed this input was not sent.' : barrier
          ? 'Chat delivery was interrupted; recorded effects may have occurred.' : 'Chat runtime could not prepare this turn.'};
      if (!barrier) { await rpc('fail_chat_preparation',[turn.chatId,leaseFence,failure]); settled=true; }
      else if (snapshotId) {
        await append('error',failure,`server:${snapshotId}:error`);
        await append('done',{reason:'error'},`server:${snapshotId}:done`);
        await rpc('complete_chat_turn',[turn.turnId,'error',text(),usage.value(),usage.value()?.total_cost_usd ?? null,
          failure,leaseFence,snapshotId,{outcome:knownNotSent ? 'failed' : 'runtime_lost',evidence:'reconciliation',body:text(),failure},null]);
        settled=true;
      }
    }
  } finally {
    clearInterval(heartbeat); options.untrack(); closed=true;
    await cleanup();
    if (settled && agentMessageId) options.publisher.publish(turn.spaceId,{type:'chat.turn.done',chatId:turn.chatId,
      messageId:agentMessageId,usage:usage.value()});
  }
}
