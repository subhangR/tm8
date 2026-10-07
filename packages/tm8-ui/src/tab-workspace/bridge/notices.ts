/**
 * The window's notice for remote changes (Spec C, coordinator ruling Q5,
 * design ruling R35 in doc 01a11056-1477).
 *
 * A remote action that changes what the human sees shows ONE small
 * non-blocking notice per actor through the existing NoticeHost. Actions from
 * the same actor within 2 s coalesce into that one notice (replace-by-id);
 * different actors get separate notices. Silent for inspect, no_op, rejected
 * and requires_user_choice (the in-window prompt is the signal).
 *
 * Copy (R35): the actor's name opens the sentence, plain; titles go in curly
 * quotes and are cut at 40 characters with "…"; body empty, no action.
 */
import type { DialogId, TabRecord, TabScope } from '../runtime/types';

export type RemoteChange =
  | { verb: 'opened'; count: number; title?: string }
  | { verb: 'closed'; count: number; title?: string }
  | { verb: 'moved'; count: number; title?: string }
  | { verb: 'switched'; title?: string }
  | { verb: 'scope'; label: string }
  | { verb: 'dialog'; title: string }
  | { verb: 'view' };

export const COALESCE_MS = 2000;
const TITLE_MAX = 40;

/** Each registered dialog's own title, sentence case (R35). */
export const DIALOG_TITLES: Record<DialogId, string> = {
  palette: 'the command palette',
  prompts: 'System prompts',
  agentTools: 'Agent tools',
  newSpace: 'Create space',
  addServer: 'Add server',
};

export function quoteTitle(title: string): string {
  const trimmed = title.trim();
  const cut = trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX).trimEnd()}…` : trimmed;
  return `“${cut}”`;
}

/**
 * S14: a notice about a workspace that is not on screen names it
 * ("… in Billing"), so a rollback there is not read as one here.
 */
export function inWorkspace(text: string, name: string | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return text;
  return `${text} in ${cutName(trimmed)}`;
}

function cutName(name: string): string {
  return name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX).trimEnd()}…` : name;
}

/** A tab as a notice names it: the entity's title, or the draft's kind. */
export function tabTitle(tab: TabRecord | undefined, titleOf: (id: string) => string | undefined): string | undefined {
  if (!tab) return undefined;
  if (tab.type === 'entity') return titleOf(tab.entityId);
  if (tab.type === 'draft') return `New ${tab.kind.replace(/_/g, ' ')}`;
  return undefined;
}

/**
 * An agent's stored-path write (API doc 01a115c4 §7.3 `cause.actor`), named
 * with its workspace (S14). On the active workspace it "opened" what the
 * human now sees; on another one it "prepared" it, and the notice offers Go.
 * `count` 0 is a write that opened nothing (close, move, scope…).
 */
export function agentWriteLine(
  actor: string,
  write: { workspaceName: string | undefined; active: boolean; count: number; title?: string },
): string {
  const verb = write.active ? 'opened' : 'prepared';
  const what = write.count === 0 ? 'changed tabs' : tabsPhrase(verb, write.count, write.count === 1 ? write.title : undefined);
  return inWorkspace(`${actor} ${what}`, write.workspaceName);
}

/** An agent's change to the workspace list (Q3: create, rename, recolour; D6 delete). */
export function agentManageLine(actor: string, kind: 'created' | 'renamed' | 'recolored' | 'deleted', name: string): string {
  const cut = cutName(name.trim());
  switch (kind) {
    case 'created': return `${actor} created ${cut}`;
    case 'renamed': return `${actor} renamed a workspace to ${cut}`;
    case 'recolored': return `${actor} changed the colour of ${cut}`;
    case 'deleted': return `${actor} deleted ${cut}`;
  }
}

/** The scope control's own label: `Mixed` or `By type · N`. */
export function scopeLabel(scope: TabScope): string {
  return scope.mode === 'mixed' ? 'Mixed' : `By type · ${scope.selectedTypeIds.length}`;
}

/** Who acted: the node's actor name, else the R35 fallbacks. */
export function actorLabel(actorClass: 'human' | 'agent', actorName?: string): string {
  const name = actorName?.trim();
  if (name) return name;
  return actorClass === 'agent' ? 'An agent' : 'Your CLI';
}

function tabsPhrase(verb: 'opened' | 'closed' | 'moved' | 'prepared', count: number, title: string | undefined): string {
  if (count === 1) return title ? `${verb} ${quoteTitle(title)}` : `${verb} a tab`;
  return `${verb} ${count} tabs`;
}

/** One notice line for everything one actor did inside the coalescing window. */
export function noticeLine(actor: string, changes: readonly RemoteChange[]): string {
  const last = changes[changes.length - 1];
  if (!last) return '';
  const sameVerb = changes.every((change) => change.verb === last.verb);
  if (!sameVerb) return `${actor} made ${changes.length} changes to your workspace`;

  switch (last.verb) {
    case 'opened':
    case 'closed':
    case 'moved': {
      const counted = changes as readonly Extract<RemoteChange, { count: number }>[];
      const total = counted.reduce((sum, change) => sum + change.count, 0);
      return `${actor} ${tabsPhrase(last.verb, total, total === 1 ? counted[0]?.title : undefined)}`;
    }
    case 'switched':
      return changes.length === 1 && last.title
        ? `${actor} switched to ${quoteTitle(last.title)}`
        : `${actor} switched tabs`;
    case 'scope':
      return `${actor} set the tab scope to ${last.label}`;
    case 'dialog':
      return `${actor} opened ${last.title}`;
    case 'view':
      return `${actor} opened the Workspace`;
  }
}

interface Bucket {
  changes: RemoteChange[];
  lastAt: number;
}

/**
 * Coalesces per actor. `add` returns the line to show now under that actor's
 * notice id; a newer line replaces the older one (NoticeHost replace-by-id).
 */
export class RemoteNoticeCoalescer {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  add(actor: string, change: RemoteChange): { id: string; title: string } {
    const at = this.now();
    let bucket = this.buckets.get(actor);
    if (!bucket || at - bucket.lastAt > COALESCE_MS) {
      bucket = { changes: [], lastAt: at };
      this.buckets.set(actor, bucket);
    }
    bucket.changes.push(change);
    bucket.lastAt = at;
    return { id: `tws-remote-${actor}`, title: noticeLine(actor, bucket.changes) };
  }

  /**
   * Name a change that went out untitled because its entity had not loaded
   * yet. Returns the corrected line, or null when that change is no longer
   * the actor's latest (a newer line already replaced it).
   */
  retitle(actor: string, change: RemoteChange, title: string): { id: string; title: string } | null {
    const bucket = this.buckets.get(actor);
    if (!bucket || change.verb !== 'opened' || bucket.changes[bucket.changes.length - 1] !== change) return null;
    change.title = title;
    return { id: `tws-remote-${actor}`, title: noticeLine(actor, bucket.changes) };
  }
}
