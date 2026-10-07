/**
 * An agent's requests the human must answer (API doc 01a115c4 §5.10–§5.12,
 * D8): Switch/Stay for an agent's `workspace.switch`, Delete/Keep for an
 * agent's `workspace.delete` outside D6's self-cleanup rule.
 *
 * They live in the node's memory, per (identity, space), like instances and
 * retry records, and die with it: the agent sees its prompt vanish from
 * `workspace.list` and asks again (Q4).
 *
 * - An open prompt expires after 10 minutes; a resolved one stays listed for
 *   10 minutes after it resolved, so the agent can read the outcome.
 * - One switch prompt at a time: a newer one supersedes the open ones (Q5).
 *   Delete prompts don't supersede each other.
 * - At most 8 open per (identity, space); at the cap the oldest open delete
 *   prompt expires.
 *
 * Every state change is reported through `onChange`, so the service can push
 * a `workspace.prompt` frame (§7.3), including expiry by the timer.
 */
import { randomUUID } from 'node:crypto';

import { WORKSPACE_PROMPT_TTL_MS, WORKSPACE_PROMPTS_CAP, type WorkspacePrompt } from '@tm8/contract';

type Closed = Exclude<WorkspacePrompt['state'], 'open'>;

interface Held {
  prompt: WorkspacePrompt;
  /** open: when it expires; resolved: when it stops being listed. */
  until: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WorkspacePromptStoreOptions {
  now?: () => number;
  ttlMs?: number;
  cap?: number;
  onChange?: (identityId: string, spaceId: string, prompt: WorkspacePrompt) => void;
}

export class WorkspacePromptStore {
  private readonly held = new Map<string, Held[]>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cap: number;
  onChange: ((identityId: string, spaceId: string, prompt: WorkspacePrompt) => void) | undefined;

  constructor(opts: WorkspacePromptStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? WORKSPACE_PROMPT_TTL_MS;
    this.cap = opts.cap ?? WORKSPACE_PROMPTS_CAP;
    this.onChange = opts.onChange;
  }

  /** Open prompts, and resolved ones for 10 minutes after; oldest first. */
  list(identityId: string, spaceId: string): WorkspacePrompt[] {
    return this.sweep(identityId, spaceId).map((h) => h.prompt);
  }

  get(identityId: string, spaceId: string, promptId: string): WorkspacePrompt | undefined {
    return this.sweep(identityId, spaceId).find((h) => h.prompt.promptId === promptId)?.prompt;
  }

  /** Raise a prompt. A switch prompt supersedes every open one before it. */
  open(
    identityId: string,
    spaceId: string,
    input: { kind: WorkspacePrompt['kind']; workspaceId: string; workspaceName: string; actorName?: string },
  ): WorkspacePrompt {
    const list = this.sweep(identityId, spaceId);
    if (input.kind === 'switch') this.closeWhere(identityId, spaceId, (p) => p.kind === 'switch', 'superseded');
    const open = list.filter((h) => h.prompt.state === 'open');
    if (open.length >= this.cap) {
      const oldest = open.find((h) => h.prompt.kind === 'delete') ?? open[0]!;
      this.close(identityId, spaceId, oldest, 'expired');
    }
    const prompt: WorkspacePrompt = {
      promptId: randomUUID(),
      kind: input.kind,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      ...(input.actorName ? { actorName: input.actorName } : {}),
      state: 'open',
      createdAt: new Date(this.now()).toISOString(),
    };
    const held: Held = { prompt, until: this.now() + this.ttlMs };
    held.timer = setTimeout(() => this.sweep(identityId, spaceId), this.ttlMs + 1);
    held.timer.unref?.();
    list.push(held);
    this.held.set(key(identityId, spaceId), list);
    this.onChange?.(identityId, spaceId, prompt);
    return prompt;
  }

  /** Close one open prompt; returns it as closed, or undefined if it isn't open. */
  resolve(identityId: string, spaceId: string, promptId: string, state: Closed): WorkspacePrompt | undefined {
    const held = this.sweep(identityId, spaceId).find((h) => h.prompt.promptId === promptId && h.prompt.state === 'open');
    if (!held) return undefined;
    this.close(identityId, spaceId, held, state);
    return held.prompt;
  }

  /** A human switch: one Switch/Stay at a time, and the human already chose. */
  supersedeSwitches(identityId: string, spaceId: string): void {
    this.sweep(identityId, spaceId);
    this.closeWhere(identityId, spaceId, (p) => p.kind === 'switch', 'superseded');
  }

  /** A deleted workspace: nothing can be switched to or deleted any more. */
  expireFor(identityId: string, spaceId: string, workspaceId: string): void {
    this.sweep(identityId, spaceId);
    this.closeWhere(identityId, spaceId, (p) => p.workspaceId === workspaceId, 'expired');
  }

  private closeWhere(identityId: string, spaceId: string, match: (p: WorkspacePrompt) => boolean, state: Closed): void {
    for (const held of this.held.get(key(identityId, spaceId)) ?? []) {
      if (held.prompt.state === 'open' && match(held.prompt)) this.close(identityId, spaceId, held, state);
    }
  }

  private close(identityId: string, spaceId: string, held: Held, state: Closed): void {
    if (held.timer) clearTimeout(held.timer);
    const at = this.now();
    held.prompt = { ...held.prompt, state, resolvedAt: new Date(at).toISOString() };
    held.until = at + this.ttlMs;
    held.timer = undefined;
    this.onChange?.(identityId, spaceId, held.prompt);
  }

  /** Expire open prompts past their TTL and forget resolved ones past theirs. */
  private sweep(identityId: string, spaceId: string): Held[] {
    const k = key(identityId, spaceId);
    const list = this.held.get(k) ?? [];
    const now = this.now();
    for (const held of list) {
      if (held.prompt.state === 'open' && held.until <= now) this.close(identityId, spaceId, held, 'expired');
    }
    const kept = list.filter((h) => h.prompt.state === 'open' || h.until > now);
    if (kept.length > 0) this.held.set(k, kept);
    else this.held.delete(k);
    return kept;
  }
}

function key(identityId: string, spaceId: string): string {
  return `${spaceId}\u0000${identityId}`;
}
