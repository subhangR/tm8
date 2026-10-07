/**
 * The Workspace remote bridge, node side (Spec C, doc 01a1111d-589e).
 *
 * A browser window announces itself on its events socket
 * (`workspace.register`); an agent or the CLI then reaches it through
 * `workspace.command`, which this registry forwards to that ONE connection and
 * waits on until the window answers (`workspace.result`), the wait times out,
 * or the connection drops.
 *
 * ## In memory, on purpose
 *
 * A live instance IS a connection. A row that outlived the socket would name a
 * window that cannot answer, and a restart that kept it would hand an agent a
 * target that no longer exists. Windows re-register when their socket comes
 * back, so nothing is lost by forgetting.
 *
 * ## Authority is identity equality
 *
 * Every read and every forward is keyed by the caller's identity, and an
 * instance is only ever visible under the identity whose socket registered it.
 * There is no lookup by member, owner or teammate: an agent token carries its
 * owner's full identity, which is exactly "the human's own agents", and nothing
 * else reaches the window. An instance the caller does not own answers
 * `no_live_target` — the same as one that does not exist — so the registry is
 * never an oracle for someone else's windows.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  CollabError,
  WORKSPACE_COMMAND_TIMEOUT,
  WorkspaceRemoteResultBodySchema,
  type WorkspaceBridgeCommandFrame,
  type WorkspaceControlFrame,
  type WorkspaceInstanceView,
  type WorkspaceRef,
  type WorkspaceRemoteResult,
  type WorkspaceWindowCap,
} from '@tm8/contract';

/** The send side of one socket; `EventSink` satisfies it. */
export interface BridgeSink {
  readonly id: string;
  readonly isOpen: boolean;
  send(text: string): void;
}

type RegisterFrame = Extract<WorkspaceControlFrame, { type: 'workspace.register' }>;
type ResultFrame = Extract<WorkspaceControlFrame, { type: 'workspace.result' }>;

interface InstanceRecord {
  readonly instanceId: string;
  readonly identityId: string;
  spaceId: string;
  viewerMemberId: string;
  windowId: string;
  sink: BridgeSink;
  focused: boolean;
  visible: boolean;
  view: string;
  mounted: boolean;
  revision: number;
  caps: WorkspaceWindowCap[];
  /** The workspace whose state this window was last sent as active (§5.2). */
  workspaceId: string | null;
  connectedAt: number;
  lastSeen: number;
  lastFocusedAt: number | null;
}

interface PendingForward {
  readonly connId: string;
  resolve(result: WorkspaceRemoteResult): void;
  reject(error: CollabError): void;
}

interface RetryRecord {
  readonly hash: string;
  readonly at: number;
  readonly outcome: Promise<WorkspaceRemoteResult>;
}

export interface WorkspaceRunInput {
  identityId: string;
  spaceId: string;
  /** Absent: a fresh id, and the call is not recorded (reads). */
  requestId?: string;
  instanceId?: string;
  command: string;
  args?: unknown;
  expectedRevision?: number;
  timeoutMs?: number;
  actorClass: 'human' | 'agent';
  actorName?: string;
  /** The resolved target (§3.2): named on the forward, stamped on the answer. */
  workspace?: WorkspaceRef;
}

/** Who a `push` reaches, within the identity's live windows in the space. */
export interface PushOptions {
  /** Only this instance. */
  only?: string;
  /** Only windows that announced `multiWorkspace` (S9): a non-active workspace's frames. */
  capableOnly?: boolean;
  /** The frame is this workspace's state, as active: the windows now show it. */
  shows?: string;
}

/** Whether a window takes every workspace's frames, not just the active one's (S9). */
export function isCapable(view: Pick<WorkspaceInstanceView, 'caps'>): boolean {
  return view.caps.includes('multiWorkspace');
}

export interface WorkspaceBridgeOptions {
  now?: () => number;
  /** An instance not heard from for this long is not live. */
  staleAfterMs?: number;
  /** How long a request id keeps its recorded outcome. */
  retryTtlMs?: number;
  /** Retry records kept per identity; the oldest is evicted first. */
  retryCap?: number;
  /** Instances one identity may hold at once. */
  instanceCap?: number;
}

export const DEFAULT_INSTANCE_STALE_MS = 90_000;
export const DEFAULT_RETRY_TTL_MS = 10 * 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function noLiveTarget(delivered: boolean): CollabError {
  return new CollabError('not_found', 'no live Workspace window answers for this target', {
    details: { reason: 'no_live_target', delivered },
  });
}

/** Clamp a caller's timeout into the contract's window. */
export function clampTimeout(ms: number | undefined): number {
  const { default: fallback, min, max } = WORKSPACE_COMMAND_TIMEOUT;
  if (ms === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.floor(ms)));
}

/** Stable JSON: object keys sorted, so `{a,b}` and `{b,a}` hash the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class WorkspaceBridge {
  private readonly instances = new Map<string, InstanceRecord>();
  private readonly pending = new Map<string, PendingForward>();
  /** identityId → requestId → record. Map order is insertion order. */
  private readonly retries = new Map<string, Map<string, RetryRecord>>();
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly retryTtlMs: number;
  private readonly retryCap: number;
  private readonly instanceCap: number;

  constructor(opts: WorkspaceBridgeOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_INSTANCE_STALE_MS;
    this.retryTtlMs = opts.retryTtlMs ?? DEFAULT_RETRY_TTL_MS;
    this.retryCap = opts.retryCap ?? 500;
    this.instanceCap = opts.instanceCap ?? 64;
  }

  // -- the window side -------------------------------------------------------

  /**
   * Upsert an instance against this connection. Returns false (and changes
   * nothing) when the id is held by another identity or the identity is at its
   * cap — a window cannot take over a window it does not own.
   */
  register(sink: BridgeSink, identityId: string, viewerMemberId: string, frame: RegisterFrame): boolean {
    const now = this.now();
    const existing = this.instances.get(frame.instanceId);
    if (existing && existing.identityId !== identityId) return false;
    if (!existing && this.countFor(identityId) >= this.instanceCap) return false;

    const focusedAt = frame.lastFocusedAt ? Date.parse(frame.lastFocusedAt) : NaN;
    const lastFocusedAt = frame.focused
      ? now
      : Number.isFinite(focusedAt)
        ? Math.min(focusedAt, now)
        : (existing?.lastFocusedAt ?? null);

    if (existing && existing.sink.id !== sink.id) {
      // The window reconnected: whatever was in flight on the old socket can
      // no longer be answered there.
      this.failPendingFor(existing.instanceId, existing.sink.id);
    }

    this.instances.set(frame.instanceId, {
      instanceId: frame.instanceId,
      identityId,
      spaceId: frame.spaceId,
      viewerMemberId,
      windowId: frame.windowId,
      sink,
      focused: frame.focused,
      visible: frame.visible,
      view: frame.view,
      mounted: frame.mounted,
      revision: frame.revision,
      caps: [...new Set(frame.caps ?? [])],
      workspaceId: frame.workspaceId !== undefined ? frame.workspaceId : (existing?.workspaceId ?? null),
      connectedAt: existing && existing.sink.id === sink.id ? existing.connectedAt : now,
      lastSeen: now,
      lastFocusedAt,
    });
    return true;
  }

  /** Drop one instance, only from the connection that holds it. */
  unregister(sink: BridgeSink, instanceId: string): void {
    const record = this.instances.get(instanceId);
    if (!record || record.sink.id !== sink.id) return;
    this.instances.delete(instanceId);
    this.failPendingFor(instanceId, sink.id);
  }

  /** The socket closed: its instances go, and their in-flight forwards fail. */
  dropConnection(connId: string): void {
    for (const [id, record] of this.instances) {
      if (record.sink.id !== connId) continue;
      this.instances.delete(id);
      this.failPendingFor(id, connId);
    }
  }

  /**
   * A window's answer. Ignored unless it arrives on the connection that owns
   * the instance and a forward is waiting for it: a result is not a way to
   * complete someone else's request.
   */
  acceptResult(sink: BridgeSink, frame: ResultFrame): boolean {
    const record = this.instances.get(frame.instanceId);
    if (!record || record.sink.id !== sink.id) return false;
    const key = pendingKey(frame.instanceId, frame.requestId);
    const waiting = this.pending.get(key);
    if (!waiting || waiting.connId !== sink.id) return false;
    this.pending.delete(key);
    record.lastSeen = this.now();

    const parsed = WorkspaceRemoteResultBodySchema.safeParse(frame.result);
    waiting.resolve(
      parsed.success
        ? { ...(parsed.data as Omit<WorkspaceRemoteResult, 'requestId' | 'instanceId'>), requestId: frame.requestId, instanceId: frame.instanceId }
        : { requestId: frame.requestId, instanceId: frame.instanceId, status: 'rejected', revision: record.revision, reason: 'malformed_result' },
    );
    return true;
  }

  // -- the caller side -------------------------------------------------------

  /** The caller's live windows in one space, most recently focused first. */
  list(identityId: string, spaceId: string): WorkspaceInstanceView[] {
    return this.candidates(identityId, spaceId).map((record) => this.view(record));
  }

  /**
   * Forward one command and wait for the window's answer.
   *
   * With a `requestId` the call is RECORDED: the same id and payload returns
   * the recorded (or still in-flight) outcome without running again, and the
   * same id with a different payload is refused. The record is consulted
   * before anything else, so a retry recovers even when its window has since
   * moved on.
   */
  async run(input: WorkspaceRunInput): Promise<WorkspaceRemoteResult> {
    const timeoutMs = clampTimeout(input.timeoutMs);
    if (input.requestId === undefined) {
      const requestId = randomUUID();
      return this.wait(this.forward({ ...input, requestId }), timeoutMs);
    }
    const requestId = input.requestId;
    return this.recorded(
      input.identityId,
      requestId,
      {
        spaceId: input.spaceId,
        instanceId: input.instanceId ?? null,
        command: input.command,
        args: input.args ?? null,
        expectedRevision: input.expectedRevision ?? null,
      },
      timeoutMs,
      () => this.forward({ ...input, requestId }),
    );
  }

  /**
   * The request-id retry record around any outcome (Spec C §2, Spec D §2).
   *
   * The same id and payload returns the recorded (or still in-flight) outcome
   * without starting again; the same id with a different payload is refused.
   * The record is consulted before anything else, so a retry recovers even
   * when the workspace or its window has since moved on. A refusal that never
   * reached anything (`delivered: false`) is not remembered: a retry should run.
   */
  recorded(
    identityId: string,
    requestId: string,
    payload: unknown,
    timeoutMs: number,
    start: () => Promise<WorkspaceRemoteResult>,
  ): Promise<WorkspaceRemoteResult> {
    const hash = createHash('sha256').update(stable(payload)).digest('hex');
    const records = this.recordsFor(identityId);
    const prior = records.get(requestId);
    if (prior) {
      if (prior.hash !== hash) {
        return Promise.reject(new CollabError('conflict', 'this request id was already used with different arguments', {
          details: { reason: 'request_id_reused' },
        }));
      }
      return this.wait(prior.outcome, timeoutMs);
    }

    const outcome = start();
    // An outcome that fails after its caller stopped waiting must not surface
    // as an unhandled rejection; the record still carries the failure.
    outcome.catch(() => undefined);
    records.set(requestId, { hash, at: this.now(), outcome });
    outcome.catch((error: unknown) => {
      if (error instanceof CollabError && error.details?.['delivered'] === false) {
        if (records.get(requestId)?.outcome === outcome) records.delete(requestId);
      }
    });
    this.evict(records);
    return this.wait(outcome, timeoutMs);
  }

  /** The id of the window a call would target, or null when none is unambiguous (no throw). */
  targetOf(identityId: string, spaceId: string, instanceId?: string): string | null {
    try {
      return this.pick(identityId, spaceId, instanceId).instanceId;
    } catch {
      return null;
    }
  }

  /**
   * Spec D §3: send one frame to EVERY live window of this identity in this
   * space — never to anyone else's, never through the space fan-out. Returns
   * how many sockets took it.
   */
  push(identityId: string, spaceId: string, frame: object, opts: PushOptions = {}): number {
    const text = JSON.stringify(frame);
    let sent = 0;
    for (const record of this.candidates(identityId, spaceId)) {
      if (opts.only !== undefined && record.instanceId !== opts.only) continue;
      if (opts.capableOnly && !isCapable(record)) continue;
      try {
        record.sink.send(text);
        if (opts.shows !== undefined) record.workspaceId = opts.shows;
        sent += 1;
      } catch {
        // The socket's close path drops the instance.
      }
    }
    return sent;
  }

  /** The window was just sent this workspace's state as active (the register snapshot). */
  shows(instanceId: string, workspaceId: string | null): void {
    const record = this.instances.get(instanceId);
    if (record) record.workspaceId = workspaceId;
  }

  /** Live instances, for tests and diagnostics. */
  size(): number {
    return this.instances.size;
  }

  /**
   * Forward one command under an id the caller records itself (inside
   * `recorded`), naming and stamping its resolved workspace.
   */
  dispatch(input: WorkspaceRunInput & { requestId: string }): Promise<WorkspaceRemoteResult> {
    return this.forward(input);
  }

  // -- internals -------------------------------------------------------------

  private forward(input: WorkspaceRunInput & { requestId: string }): Promise<WorkspaceRemoteResult> {
    let target: InstanceRecord;
    try {
      target = this.pick(input.identityId, input.spaceId, input.instanceId);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = pendingKey(target.instanceId, input.requestId);
    const already = this.pending.get(key);
    if (already) {
      // Only reachable for an unrecorded call reusing a live id; never join it.
      return Promise.reject(new CollabError('conflict', 'a request with this id is already in flight', {
        details: { reason: 'request_id_reused' },
      }));
    }

    const frame: WorkspaceBridgeCommandFrame = {
      type: 'workspace.command',
      requestId: input.requestId,
      instanceId: target.instanceId,
      command: input.command,
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      actorClass: input.actorClass,
      ...(input.actorName ? { actorName: input.actorName } : {}),
      ...(input.workspace ? { workspaceId: input.workspace.id } : {}),
    };

    const answered = new Promise<WorkspaceRemoteResult>((resolve, reject) => {
      this.pending.set(key, { connId: target.sink.id, resolve, reject });
      try {
        if (!target.sink.isOpen) throw new Error('socket closed');
        target.sink.send(JSON.stringify(frame));
      } catch {
        this.pending.delete(key);
        reject(noLiveTarget(false));
        return;
      }
    });
    const workspace = input.workspace;
    return workspace ? answered.then((result) => ({ ...result, workspace })) : answered;
  }

  private async wait(outcome: Promise<WorkspaceRemoteResult>, timeoutMs: number): Promise<WorkspaceRemoteResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new CollabError('upstream_unavailable', 'the Workspace window did not answer in time', {
          details: { reason: 'no_reply' },
          retryable: true,
        }));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([outcome, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pick(identityId: string, spaceId: string, instanceId: string | undefined): InstanceRecord {
    const live = this.candidates(identityId, spaceId);
    if (instanceId !== undefined) {
      const hit = live.find((record) => record.instanceId === instanceId);
      if (!hit) throw noLiveTarget(false);
      return hit;
    }
    if (live.length === 0) throw noLiveTarget(false);
    if (live.length === 1) return live[0]!;
    const focused = live.filter((record) => record.focused);
    if (focused.length === 1) return focused[0]!;
    throw new CollabError('conflict', 'more than one Workspace window is live; name one with --instance', {
      details: { reason: 'ambiguous_target', candidates: live.map((record) => this.view(record)) },
    });
  }

  private candidates(identityId: string, spaceId: string): InstanceRecord[] {
    const cutoff = this.now() - this.staleAfterMs;
    const out: InstanceRecord[] = [];
    for (const record of this.instances.values()) {
      if (record.identityId !== identityId || record.spaceId !== spaceId) continue;
      if (!record.sink.isOpen || record.lastSeen < cutoff) continue;
      out.push(record);
    }
    return out.sort((a, b) => (b.lastFocusedAt ?? -1) - (a.lastFocusedAt ?? -1) || b.lastSeen - a.lastSeen);
  }

  private countFor(identityId: string): number {
    let n = 0;
    for (const record of this.instances.values()) if (record.identityId === identityId) n += 1;
    return n;
  }

  private failPendingFor(instanceId: string, connId: string): void {
    const prefix = `${instanceId}\u0000`;
    for (const [key, waiting] of this.pending) {
      if (!key.startsWith(prefix) || waiting.connId !== connId) continue;
      this.pending.delete(key);
      // It was sent; the window may have applied it before the socket went.
      waiting.reject(noLiveTarget(true));
    }
  }

  private recordsFor(identityId: string): Map<string, RetryRecord> {
    let records = this.retries.get(identityId);
    if (!records) {
      records = new Map();
      this.retries.set(identityId, records);
    }
    return records;
  }

  private evict(records: Map<string, RetryRecord>): void {
    const cutoff = this.now() - this.retryTtlMs;
    for (const [id, record] of records) {
      if (record.at >= cutoff && records.size <= this.retryCap) break;
      records.delete(id);
    }
  }

  private view(record: InstanceRecord): WorkspaceInstanceView {
    return {
      instanceId: record.instanceId,
      windowId: record.windowId,
      spaceId: record.spaceId,
      viewerMemberId: record.viewerMemberId,
      focused: record.focused,
      visible: record.visible,
      view: record.view,
      mounted: record.mounted,
      revision: record.revision,
      workspaceId: record.workspaceId,
      caps: [...record.caps],
      connectedAt: iso(record.connectedAt),
      lastSeen: iso(record.lastSeen),
      lastFocusedAt: record.lastFocusedAt === null ? null : iso(record.lastFocusedAt),
    };
  }
}

function pendingKey(instanceId: string, requestId: string): string {
  return `${instanceId}\u0000${requestId}`;
}
