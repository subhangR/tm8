import { randomUUID } from 'node:crypto';
import { MessagePartSchema, type ChatTurnUsage } from '@tm8/contract';
import {
  HarnessRuntimeError, type AttemptRef, type GenerationFence, type HarnessRegistry, type HarnessSession,
  type RuntimeConfig, type TerminalOutcome, type UsageFact,
} from '@tm8/execution';
import type { Db, DbClaims } from '../db/types.js';
import type { ClaimedTurn } from './orchestrator.js';
import type { ChatTurnPublisher } from './publisher.js';
import type { createChatPreparedLaunchResolver, PreparedChatLaunch } from './harness-composition.js';
import { historyDigest, projectHistory, readPortableHistory } from './continuity.js';
import { ChatLeaseLostError, ChatPhaseTimeoutError, StepTimeoutError, TurnLease, deadline, retryTransient } from './lease.js';

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
  /**
   * True once a Stop has been asked for this turn. A Stop that lands before the
   * harness is tracked (preparation, open) or between track and submit has no
   * running attempt to cancel; it is latched by the caller and read here, so the
   * input is never dispatched — and one that lands just as submit goes out is
   * turned into a cancel right after it.
   */
  stopRequested?: (() => boolean) | undefined;
  /** Called only after this owner's resources and durable lease are released. */
  onReleased?: (() => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  /**
   * Where the lease-critical writes go: renewal, the preparation failure and
   * the release. Production passes a small pool reserved for them, so they
   * never queue behind the main pool's reads; the frozen turn of 2026-10-20
   * lost its only chance to record its failure to exactly that wait. Defaults
   * to `db`.
   */
  leaseDb?: Db | undefined;
  /** Local time the claim wrote the lease (before the claim call). Defaults to now. */
  claimedAt?: number | undefined;
  /**
   * This owner gave the turn up while the database may still hold its lease:
   * the lease was lost, or the turn's outcome could not be recorded even after
   * retries. The caller must recover the attempt after `recoverAfter` (the
   * owner's latest estimate of lease expiry) and resume the queue; nothing
   * else would until a sweep happened to look.
   */
  onAbandoned?: ((info: { reason: string; recoverAfter: number }) => void) | undefined;
  /**
   * `observation` is the IDLE limit: how long the harness may say nothing at
   * all. `tool` is the separate, longer budget that applies while at least one
   * tool call is in flight, because a running tool emits no observation of its
   * own (see `consume` below). `phase` bounds every other pre-launch step
   * (agent message, reservation, history, seal, open receipt, recheck,
   * dispatch barrier). `heartbeat`, `lease`, `leaseSafety` and
   * `heartbeatRetry` are only overridden by tests.
   */
  timeouts?: { preparation?: number; open?: number; submit?: number; observation?: number;
    tool?: number; heartbeat?: number; close?: number; cleanupRetry?: number; phase?: number;
    lease?: number; leaseSafety?: number; heartbeatRetry?: number };
}

export { StepTimeoutError, deadline } from './lease.js';

/**
 * Postgres rolled the whole transaction back and asks the caller to run it
 * again. Every fenced RPC is one transaction, so a retry is exact: nothing of
 * the losing attempt is left behind, and part appends are idempotent by event id.
 *
 * Deadlocks are not hypothetical here. Posting a message to a chat takes the
 * space's event-seq row (the message's event trigger) and THEN the chat row (to
 * queue the turn); a running turn's fenced write takes the chat row and THEN the
 * event-seq row (a tool_call part's activity event). A message that arrives
 * while the agent is mid-tool deadlocks with it, and before this retry the turn
 * was the victim: it settled as `delivery_unknown` about a second later.
 */
const RETRYABLE_SQLSTATES=new Set(['40P01','40001']);
const FENCED_RPC_ATTEMPTS=4;
export function sqlStateOf(error: unknown): string | undefined {
  if (!error || typeof error!=='object') return undefined;
  const details=(error as {details?:{sqlstate?:unknown}}).details;
  if (typeof details?.sqlstate==='string') return details.sqlstate;
  const code=(error as {code?:unknown}).code;
  return typeof code==='string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

const clip=(text: string, max=500) => text.length>max ? `${text.slice(0,max)}…` : text;
/**
 * Secrets have no business in a failure record. HTTP clients and `pg` can echo
 * a URL with credentials, a bearer header or a key; the value is replaced and
 * the shape kept, so the reason stays legible.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…[redacted]')
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]{8,}/g, '$1[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@')
    .replace(/\b((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[redacted]');
}
/**
 * The operator's view of why a turn failed, stored in `chat_turns.failure.detail`.
 * Never rendered as the thread's message, and never shown to a later turn's
 * agent (continuity.ts drops it); bounded and scrubbed of secrets.
 */
export function describeError(error: unknown, depth=0): Record<string, unknown> {
  if (!(error instanceof Error)) return {message:clip(scrubSecrets(String(error)))};
  const cause=depth<3 && error.cause!==undefined ? {cause:describeError(error.cause,depth+1)} : {};
  const sqlstate=sqlStateOf(error);
  const code=(error as {code?:unknown}).code;
  return {name:error.name,message:clip(scrubSecrets(error.message)),
    ...(typeof code==='string' ? {code} : {}),
    ...(sqlstate ? {sqlstate} : {}),
    ...(error instanceof HarnessRuntimeError ? {harness:{code:error.failure.code,stage:error.failure.stage,
      disposition:error.failure.disposition}} : {}),...cause};
}

/** The real error in one short line the thread can show: scrubbed, flattened, clipped. */
export function shortReason(error: unknown): string {
  const raw=error instanceof Error ? error.message : String(error);
  return clip(scrubSecrets(raw).replace(/\s+/g,' ').trim() || 'no message',160);
}

type RuntimeExit={exitCode:number|null;signal:string|null};
const exitNote=(exit: RuntimeExit | null) => exit
  ? ` (exit code ${exit.exitCode ?? 'none'}${exit.signal ? `, signal ${exit.signal}` : ''})` : '';

/** What the thread says when a turn ends without an answer and without a reported reason. */
export function terminalFailure(outcome: TerminalOutcome, evidence: string, exit: RuntimeExit | null=null): {code:string;message:string} {
  if (outcome==='interrupted') return {code:'interrupted',message:'Stopped before the agent finished.'};
  if (outcome==='failed') return {code:'failed',message:`The agent ended this turn with an error${exitNote(exit)}.`};
  return evidence==='process_exit' || exit
    ? {code:'runtime_lost',message:`The agent process exited before it finished this turn${exitNote(exit)}.`}
    : {code:'runtime_lost',message:'The agent stopped responding before it finished this turn.'};
}

/**
 * The IDLE budget: how long the harness may say nothing with no tool call in
 * flight. 30 minutes is the value #1283 shipped, and it is deliberately NOT
 * tightened back to the old 120s here, because a running tool is not the only
 * silent window in the stream: between a tool result and the next COMPLETE
 * assistant message the adapter also emits nothing (the CLI runs without
 * `--include-partial-messages`), and that gap spends this budget, not the tool
 * one. Until partial messages are forwarded, a short idle limit would keep
 * killing turns that are merely thinking.
 */
export const DEFAULT_CHAT_IDLE_TIMEOUT_MS = 30 * 60_000;
/**
 * The budget while at least one tool call is in flight. Equal to the idle
 * budget by default, so these defaults behave exactly like #1283's single
 * 30-minute limit. The split is an operator lever rather than a change of
 * behaviour: a running tool is positive evidence the agent is alive, so
 * `TM8_CHAT_IDLE_TIMEOUT_MS` can be lowered to fail a wedged agent quickly
 * WITHOUT risking a kill in the middle of a legitimately slow tool. The
 * runtime lease is refreshed every 30s, so a wait this long never loses it.
 */
export const DEFAULT_CHAT_TOOL_TIMEOUT_MS = 30 * 60_000;

function humanMs(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`;
  const minutes = milliseconds / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
}

/**
 * The agent produced nothing for its whole budget. This is NOT a delivery
 * failure: the input was provably sent and the runtime was alive, so reporting
 * it as `delivery_unknown` told the human the one thing that was not wrong.
 * The names of any tools still in flight are the single most useful fact about
 * it, so they are in the message the thread renders.
 */
/** From #1284: the human should not assume a silent turn did nothing. */
const EFFECTS_NOTE = 'Steps it already took may have taken effect.';
export class AgentSilentError extends Error {
  readonly code = 'agent_silent';
  constructor(readonly waitedMs: number, readonly runningTools: readonly string[]) {
    super(runningTools.length
      ? `The agent sent nothing for ${humanMs(waitedMs)} while ${runningTools.join(', ')} ${
        runningTools.length > 1 ? 'were' : 'was'} running; the turn was stopped. ${EFFECTS_NOTE}`
      : `The agent sent nothing for ${humanMs(waitedMs)}; the turn was stopped. ${EFFECTS_NOTE}`);
  }
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
  let stoppedBeforeDispatch=false;
  const stopIfRequested=() => {
    if (!options.stopRequested?.()) return;
    stoppedBeforeDispatch=true;
    throw new Error('chat turn stopped before dispatch');
  };
  let closed=false;
  let seq=Number(turn.nextSeq);
  let agentMessageId=turn.agentMessageId;
  let terminal: {outcome:TerminalOutcome;evidence:'provider_terminal'|'process_exit'|'reconciliation'} | null=null;
  let terminalPart: {eventId:string;seq:number;payload:{reason:'success'|'interrupted'|'error'};persisted:boolean} | undefined;
  let failure: {code:string;message:string;detail?:Record<string,unknown>} | null=null;
  // The step in flight, and the last fenced RPC that threw: a failure records
  // both, so the cause no longer needs the server journal to be found.
  let step='agent message creation';
  let failedRpc: string | null=null;
  // How the agent process ended, when it did; named in a runtime_lost/failed reason.
  let runtimeExit: RuntimeExit | null=null;
  let failureShown=false;
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
  const leaseDb=options.leaseDb ?? db;
  const label=`chat ${turn.chatId} turn ${turn.turnId} attempt ${turn.attemptNo}`;
  // Runs before `session` exists; reads it when the lease is lost.
  const lease=new TurnLease({
    label,claimedAt:options.claimedAt ?? Date.now(),
    renew:() => leaseDb.rpc<void>(auth,'heartbeat_chat_runtime',[turn.chatId,leaseFence]),
    ...(options.timeouts?.lease!==undefined ? {leaseMs:options.timeouts.lease} : {}),
    ...(options.timeouts?.leaseSafety!==undefined ? {safetyMs:options.timeouts.leaseSafety} : {}),
    ...(options.timeouts?.heartbeat!==undefined ? {intervalMs:options.timeouts.heartbeat} : {}),
    ...(options.timeouts?.heartbeatRetry!==undefined ? {retryBaseMs:options.timeouts.heartbeatRetry,retryCapMs:options.timeouts.heartbeatRetry*8} : {}),
    onError:options.onError,
    onLost:error => {
      options.onError?.(error);
      void session?.cancel({turnId:turn.turnId,attemptId:snapshotId ?? '',configRevision:turn.configRevision},'revocation')
        .catch(failure=>options.onError?.(failure));
    },
  });
  // Every write is fenced by the lease; a refusal anywhere means it is gone.
  const rpc=async <T>(name:string,args:readonly unknown[]): Promise<T> => {
    for (let attempt=1;;attempt++) {
      try { return await db.rpc<T>(auth,name,args); }
      catch (error) {
        const state=sqlStateOf(error);
        if (!state || !RETRYABLE_SQLSTATES.has(state) || attempt>=FENCED_RPC_ATTEMPTS) {
          failedRpc=name; lease.observe(error); throw error;
        }
        await new Promise(resolve=>setTimeout(resolve,20*attempt+Math.random()*40));
      }
    }
  };
  /** Lease-critical writes: the reserved lane, retried while the lease can still be live. */
  const leaseWrite=<T>(name:string,args:readonly unknown[]) => retryTransient(
    () => leaseDb.rpc<T>(auth,name,args),
    {until:() => lease.safeUntil,onRetry:(error,attempt,delay) => {
      console.error(`[chat] ${name} failed for ${label} (attempt ${attempt}, retrying in ${delay}ms): ${
        error instanceof Error ? error.message : String(error)}`);
      options.onError?.(error);
    }});
  /**
   * Every pre-launch step has a budget and ends the moment the lease is lost.
   * A step that times out fails the turn with its own name in the thread
   * (`ChatPhaseTimeoutError`), instead of leaving it to look frozen.
   */
  const bounded=<T>(phase:string,promise:Promise<T>,milliseconds=options.timeouts?.phase ?? 30_000) =>
    deadline(Promise.race([promise,lease.whenLost]),milliseconds,() => new ChatPhaseTimeoutError(phase,milliseconds));
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
      const released=await leaseWrite<boolean>('release_chat_runtime',[turn.chatId,turn.runtimeEpoch,options.leaseToken]);
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
    if (opening || cleanupRunning) return;
    // A preparation that outlived its budget starts no process, and its grant
    // cannot be minted once the turn is settled (`issue_agent_runtime_session`
    // requires runtime_phase='prepared'). So the lease is released now; the
    // late material, if it ever arrives, is released by its own completion
    // handler below. Waiting for it here is what left a timed-out turn
    // holding the chat with no one left to release it.
    if (preparing) { await releaseResources(); return; }
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
  lease.start();
  let abandoned: string | null=null;
  const persistTerminalPart=async () => {
    if (!terminalPart) throw new Error('terminal has no normalized part');
    if (!terminalPart.persisted) {
      await append('done',terminalPart.payload,terminalPart.eventId,terminalPart.seq);
      terminalPart.persisted=true;
    }
  };
  const settleTerminal=async (proofTerminal: NonNullable<typeof terminal>) => {
    step='turn settlement';
    const succeeded=proofTerminal.outcome==='completed' && proofTerminal.evidence==='provider_terminal';
    // A turn that ends with no answer and no reported reason used to settle with
    // `{code:outcome}` and an empty body, which the DB renders as the bare
    // "Agent turn failed.". Say what is known instead, in the thread too.
    if (!succeeded && !failure) failure=terminalFailure(proofTerminal.outcome,proofTerminal.evidence,runtimeExit);
    if (!succeeded && failure && !failureShown && !terminalPart?.persisted && failure.code!=='interrupted') {
      await append('error',{code:failure.code,message:failure.message},`server:${snapshotId}:error`);
      failureShown=true;
    }
    terminalPart ??= {eventId:`server:${snapshotId}:done`,seq,payload:{reason:proofTerminal.outcome==='completed'
      && proofTerminal.evidence==='provider_terminal' ? 'success' : proofTerminal.outcome==='interrupted' ? 'interrupted' : 'error'},persisted:false};
    await persistTerminalPart();
    const proof={...proofTerminal,body:text(),usage:usage.value(),failure,
      ...(terminalPart ? {donePart:{eventId:terminalPart.eventId,seq:terminalPart.seq,payload:terminalPart.payload}} : {})};
    await rpc('record_chat_terminal',[turn.chatId,leaseFence,snapshotId,proof]);
    completed=proofTerminal.outcome==='completed' && proofTerminal.evidence==='provider_terminal';
    await rpc('complete_chat_turn',[turn.turnId,completed ? 'completed' : 'error',text() || (completed ? '' : failure?.message ?? ''),usage.value(),
      usage.value()?.total_cost_usd ?? null,failure ?? (completed ? null : terminalFailure(proofTerminal.outcome,proofTerminal.evidence,runtimeExit)),
      leaseFence,snapshotId,proof,null]);
    settled=true;
  };
  try {
    agentMessageId ??= await bounded('creating the reply message',options.createAgentMessage());
    const harness=turn.agentTool==='claude-code' ? 'claude' : turn.agentTool==='codex' ? 'codex' : null;
    if (!harness) throw new Error('unsupported chat harness');
    const requested={harness,provider:turn.provider,model:turn.model,
      reasoningEffort:typeof turn.claimedConfiguration.reasoningEffort==='string' ? turn.claimedConfiguration.reasoningEffort : null,serviceTier:null} as const;
    step='harness admission';
    const capabilities=await bounded('checking the agent runtime',options.registry.admit(requested,['portableBootstrap']));
    step='continuity reservation';
    const reserved=await bounded('reserving the chat runtime',rpc<{nativeGeneration:number;bindingId:string}>('reserve_chat_continuity',[
      turn.chatId,leaseFence,{replaceRuntime:true,targetBinding:{agentTool:turn.agentTool,
        protocolRevision:capabilities.protocolRevision,storageScopeId:`pending:${turn.runtimeEpoch}`,
        compatibilityDigest:historyDigest({requested,authority:turn.claimedAuthority,mode:turn.chatMode})}}]));
    leaseFence={...leaseFence,nativeGeneration:reserved.nativeGeneration};
    const fence: GenerationFence={chatId:turn.chatId,bindingId:reserved.bindingId,generation:reserved.nativeGeneration,
      leaseEpoch:turn.runtimeEpoch,configRevision:turn.configRevision};
    snapshotId=randomUUID();
    const attempt: AttemptRef={turnId:turn.turnId,attemptId:snapshotId,configRevision:turn.configRevision};
    step='history read';
    const history=await bounded('reading chat history',readPortableHistory(db,{identityId:turn.claimedAuthority.identityId,authKind:turn.claimedAuthority.authKind,
      sessionSpaceId:turn.spaceId,...(turn.claimedAuthority.authSessionId ? {authSessionId:turn.claimedAuthority.authSessionId} : {})},
      turn.chatId,turn.turnOrdinal,turn.captureHighWater));
    const bootstrap=projectHistory(history,{snapshotId,currentTurnOrdinal:turn.turnOrdinal,captureHighWater:turn.captureHighWater,
      authorityScopeDigest:historyDigest({authority:turn.claimedAuthority,mode:turn.chatMode}),maxBytes:options.historyBudgetBytes});
    step='snapshot seal';
    const sealed=await bounded('sealing the turn',rpc<{inputDigest:string}>('seal_chat_turn_snapshot',[turn.chatId,leaseFence,snapshotId,{
      desired:turn.claimedConfiguration,authority:turn.claimedAuthority,
      runtime:{revision:turn.configRevision,target:requested,credentialRevision:null,launchFingerprint:null},
      input:{messageId:turn.userMessageId,body:turn.body,attachments:turn.attachments ?? []},
      historyBudgetBytes:options.historyBudgetBytes,priorCursor:bootstrap.coverage,credentialBinding:null,
    },bootstrap]));
    step='launch preparation';
    preparing=true;
    const preparation=options.resolvePreparedLaunch({
      chatId:turn.chatId,requesterIdentityId:turn.claimedAuthority.identityId,requesterAuthKind:turn.claimedAuthority.authKind,
      ...(turn.claimedAuthority.authSessionId ? {requesterAuthSessionId:turn.claimedAuthority.authSessionId} : {}),
      credentialSelection:turn.credentialSelection,teammateId:turn.teammateId,model:turn.model,provider:turn.provider,
      agentTool:turn.agentTool,chatMode:turn.chatMode,spaceId:turn.spaceId,cwd:turn.cwd,mode:'new',
      reasoningEffort:requested.reasoningEffort,
    },{chatId:turn.chatId,generation:fence.generation,ownerLeaseId:reserved.bindingId,claimFence:options.leaseToken},fence).then(value => {
      preparing=false;
      // Arrived after the turn ended: nothing will open it, so release it here.
      if (closed) { void value.launch.release().catch(error=>options.onError?.(error)); return value; }
      prepared=value; return value;
    },error => { preparing=false; throw error; });
    prepared=await bounded('preparing credentials and workspace',preparation,options.timeouts?.preparation ?? 30_000);
    stopIfRequested();
    const config: RuntimeConfig={schemaVersion:1,revision:turn.configRevision,target:prepared.target,
      instructionHash:prepared.instructionHash,toolPolicyHash:prepared.toolPolicyHash,mcpBindingRevision:prepared.mcpBindingRevision,
      cwdIdentity:turn.cwd,credentialBindingId:prepared.credentialBindingId,credentialRevision:prepared.credentialRevision,
      launchFingerprint:prepared.launchFingerprint};
    step='harness open';
    opening=true;
    const openPromise=options.registry.get(harness).open({fence,config,mode:{kind:'bootstrap',context:bootstrap},launch:prepared.launch})
      .then(value => { session=value; opening=false; if (closed) void cleanup(); return value; },
        error => { opening=false; if (closed) void cleanup(); throw error; });
    session=await bounded('starting the agent',openPromise,options.timeouts?.open ?? 30_000);
    step='open record';
    await bounded('recording the agent start',rpc('record_chat_open',[turn.chatId,leaseFence,snapshotId,{...session.opened,
      runtime:config,credentialBinding:prepared.credentialBinding,nativeStorageScopeId:prepared.launch.nativeStorageScopeId,
      nativeStorageGeneration:prepared.launch.nativeStorageGeneration}]));
    options.track({session,attempt,revalidate:prepared.revalidate});
    step='launch revalidation';
    await bounded('rechecking credentials',prepared.revalidate());
    stopIfRequested();
    // Commit before submit, even if submit will fail before writing. Recovery
    // after this commit is conservative unless not_sent is explicitly proved.
    step='dispatch commit';
    await bounded('committing dispatch',rpc('begin_chat_dispatch',[turn.chatId,leaseFence,snapshotId,sealed.inputDigest]));
    barrier=true;
    const current=session;
    const idleBudget=options.timeouts?.observation ?? DEFAULT_CHAT_IDLE_TIMEOUT_MS;
    const toolBudget=Math.max(options.timeouts?.tool ?? DEFAULT_CHAT_TOOL_TIMEOUT_MS,idleBudget);
    // Tools in flight, by toolKey. The Claude adapter emits one `tool`
    // observation when a call starts and one when its result arrives, and
    // NOTHING in between: a tool that runs longer than the idle limit used to
    // kill the turn. While this map is non-empty the wait gets `toolBudget`.
    const runningTools=new Map<string,string>();
    const consume=async () => {
      const iterator=current.observations[Symbol.asyncIterator]();
      while (!terminal) {
        const waited=runningTools.size ? toolBudget : idleBudget;
        const next=await deadline(iterator.next(),waited,
          () => new AgentSilentError(waited,[...new Set(runningTools.values())]));
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
          runtimeExit={exitCode:payload.exitCode,signal:payload.signal};
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
          if (tool.state==='running' && tool.result===null) runningTools.set(tool.toolKey,tool.name);
          else runningTools.delete(tool.toolKey);
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
          await append('error',failure,event); failureShown=true;
        } else if (payload.kind==='request') {
          await current.respond(payload.request.requestKey,{decision:'decline'});
          failure={code:'interaction_unavailable',message:'This chat cannot resolve this runtime interaction.'};
          await append('error',failure,event); failureShown=true;
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
    step='harness submission';
    observed=consume();
    void observed.catch(()=>undefined);
    const dispatched=await deadline(Promise.race([current.submit({attempt,clientSubmissionId:snapshotId,text:options.prompt,
      // The prompt already lists every attached file by tm8 id, and the agent
      // opens it with its own tm8 tools (orchestrator.ts attachmentLines), as
      // the legacy runtime did. Raw refs go only to a harness that says it can
      // take files: sending them to one that cannot failed every such turn.
      attachmentRefs:capabilities.fileInputs==='supported' ? (turn.attachments ?? []).map(file=>file.fileEntityId) : [],config}),
      lease.whenLost]),options.timeouts?.submit ?? 30_000,'harness submission');
    if (dispatched.delivery!=='sent') {
      knownNotSent=dispatched.delivery==='not_sent';
      await deadline(current.close('failure'),options.timeouts?.close ?? 15_000,'failed dispatch close');
      await deadline(observed.catch(()=>undefined),options.timeouts?.close ?? 15_000,'failed dispatch observations');
      throw new Error(dispatched.delivery==='not_sent' ? 'provider_not_sent' : 'delivery_unknown');
    }
    step='agent output';
    // A Stop that raced submit found no active attempt to cancel; honour it now.
    if (options.stopRequested?.()) void current.cancel(attempt,'user').catch(error=>options.onError?.(error));
    if (dispatched.acknowledgement==='native_ack') await rpc('record_chat_acceptance',[
      turn.chatId,leaseFence,snapshotId,{nativeTurnId:dispatched.nativeTurnId}]);
    // A lost lease ends the wait at once: the session is cancelled by onLost
    // and the turn is settled (or handed to recovery) below.
    await Promise.race([observed,lease.whenLost]);
    if (!terminal) terminal={outcome:'runtime_lost',evidence:'reconciliation'};
    await settleTerminal(terminal);
  } catch (error) {
    if (barrier && session) {
      await deadline(session.close('failure'),options.timeouts?.close ?? 15_000,'failed turn close').catch(error=>options.onError?.(error));
      if (observed) await deadline(observed.catch(()=>undefined),options.timeouts?.close ?? 15_000,'failed turn observations').catch(error=>options.onError?.(error));
    }
    if (!stoppedBeforeDispatch) options.onError?.(error);
    // A harness refusal (e.g. attachments it cannot take) carries a safe reason.
    // Closing the session after it reports `runtime_exit`, which used to settle
    // the turn as a bare `runtime_lost` and render only "Agent turn failed."
    const refused=error instanceof HarnessRuntimeError ? error.failure : null;
    const detail={step,...(failedRpc ? {rpc:failedRpc} : {}),error:describeError(error)};
    if (refused && !failure) failure={code:refused.code,message:refused.safeMessage,detail};
    // An ACK failure is weaker evidence than an already-durable provider terminal.
    // Its output parts are consumed before this branch and must not gain a second done.
    if (terminal) await settleTerminal(terminal);
    else {
      // `agent_silent` is reported ahead of `delivery_unknown`: the barrier is
      // already committed when the observation budget runs out, so the generic
      // branch would otherwise blame delivery for an agent that simply stopped.
      const silent=error instanceof AgentSilentError ? error : null;
      const lost=lease.lost ?? (error instanceof ChatLeaseLostError ? error : null);
      const timedOut=error instanceof ChatPhaseTimeoutError ? error : null;
      failure=stoppedBeforeDispatch
        ? {code:'interrupted',message:'Stopped before the agent received this message.'}
        : knownNotSent ? {code:'provider_not_sent',message:'The provider confirmed this input was not sent.'}
        : lost ? {code:lost.code,message:barrier ? `${lost.message} ${EFFECTS_NOTE}` : lost.message,detail}
        : silent ? {code:silent.code,message:silent.message}
        : refused ? failure!
        : barrier ? {code:'delivery_unknown',message:`Chat delivery was interrupted (${failedRpc
            ? 'the server could not save the agent\'s output' : `${step} failed`}: ${shortReason(error)}); recorded effects may have occurred.`,detail}
        : timedOut ? {code:timedOut.code,message:timedOut.message,detail}
        : error instanceof StepTimeoutError
          ? {code:'preparation_failed',message:`Chat runtime could not prepare this turn: ${error.step} timed out.`,detail}
        : {code:'preparation_failed',message:`Chat runtime could not prepare this turn: ${step} failed (${shortReason(error)}).`,detail};
      try {
        // The failure is recorded on the reserved lane and retried while the
        // lease can still be live: a single attempt on a saturated pool is
        // how a failed preparation used to leave its turn frozen.
        if (!barrier) { await leaseWrite('fail_chat_preparation',[turn.chatId,leaseFence,failure]); settled=true; }
        else if (snapshotId) {
          await append('error',{code:failure.code,message:failure.message},`server:${snapshotId}:error`);
          await append('done',{reason:'error'},`server:${snapshotId}:done`);
          await rpc('complete_chat_turn',[turn.turnId,'error',text() || failure.message,usage.value(),usage.value()?.total_cost_usd ?? null,
            failure,leaseFence,snapshotId,{outcome:knownNotSent ? 'failed' : 'runtime_lost',evidence:'reconciliation',body:text(),failure},null]);
          settled=true;
        }
      } catch (settlement) {
        abandoned=`its failure (${failure.code}) could not be recorded: ${
          settlement instanceof Error ? settlement.message : String(settlement)}`;
        throw settlement;
      }
    }
  } finally {
    lease.stop(); options.untrack(); closed=true;
    if (!settled) {
      // Unsettled for any reason — lost lease, a terminal write that failed —
      // the durable lease may outlive this call. Hand it to the caller's
      // recovery rather than to a sweep that may be minutes away.
      const reason=abandoned ?? (lease.lost ? lease.lost.reason : 'its outcome could not be recorded');
      console.error(`[chat] ${label} abandoned unsettled: ${reason}`);
      try { options.onAbandoned?.({reason,recoverAfter:lease.latestExpiry}); }
      catch (error) { options.onError?.(error); }
    }
    await cleanup();
    if (settled && agentMessageId) options.publisher.publish(turn.spaceId,{type:'chat.turn.done',chatId:turn.chatId,
      messageId:agentMessageId,usage:usage.value()});
  }
}
