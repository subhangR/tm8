/**
 * The entity half of a tab's menu (task 01a115a6): what clicking a tab's icon
 * — or right-clicking the tab — offers for the entity behind it.
 *
 * Three groups, each only where it applies:
 *  - View: the tab's own Entity · Links · Messages sections;
 *  - the kind's verbs: a session's outcome and process verbs, resolved from
 *    its state exactly as the panel bar resolves them (`sessionControlsFor`),
 *    gated by the same registry availability, and performed by the same
 *    `usePanelPrimaries` executor — so Terminate here opens the same dialog;
 *  - Copy: id, title, link, the CLI context command, a session's transcript.
 *
 * Pure: the strip hands in the facts and the ports, so the menu's contents are
 * testable without mounting a workspace.
 */
import type { ReactNode } from 'react';
import type { SessionTranscriptEntry, SessionTranscriptPage } from '@tm8/contract';
import {
  processControlFor,
  resolveAction,
  sessionControlsFor,
  type ActionContext,
  type ActionRef,
} from '../../domain';
import type { Source, TabSubview } from '../runtime/types';

export interface TabMenuItem {
  key: string;
  label: ReactNode;
  disabled?: boolean;
  /** Why the row is disabled (or what it does), shown as its tooltip. */
  hint?: string;
  checked?: boolean;
  /** Draw a divider above this row. */
  divider?: boolean;
  run(source: Source): void;
}

export interface EntityMenuFacts {
  entityId: string;
  kind: string;
  /** The kind's noun ("Task", "Session") — the Entity section's label. */
  noun: string;
  title: string;
  subview: TabSubview;
  /** The tab draws Entity · Links · Messages (false for canvas kinds). */
  sections: boolean;
  /** The registry's availability context for this entity. */
  ctx: ActionContext;
  /** The verbs the executor can perform (`PanelPrimaries.wiredActions`). */
  wired: readonly ActionRef[];
}

export interface EntityMenuPorts {
  showSubview(subview: TabSubview): void;
  runVerb(ref: ActionRef): void;
  copy(text: string, what: string): void;
  copyLink(): void;
  copyTranscript(): void;
}

const SESSION = 'work_session';

/** The session's verbs, as the panel bar draws them for this state. */
export function sessionVerbs(ctx: ActionContext, wired: readonly ActionRef[]): ActionRef[] {
  const declared: ActionRef[] = ['complete', 'terminate'];
  const verbs = sessionControlsFor(declared, ctx) ?? [processControlFor('terminate', ctx)];
  // Only what the executor performs: a verb nothing can dispatch is not offered.
  return verbs.filter((ref) => ref !== 'complete' && wired.includes(ref));
}

export function entityMenuItems(facts: EntityMenuFacts, ports: EntityMenuPorts): TabMenuItem[] {
  const { entityId, kind, noun, title, subview, ctx } = facts;
  const session = kind === SESSION;
  const items: TabMenuItem[] = [];

  const views: { subview: TabSubview; label: string }[] = [
    { subview: 'entity', label: noun },
    { subview: 'connections', label: 'Links' },
    { subview: 'messages', label: 'Messages' },
  ];
  for (const view of facts.sections ? views : []) {
    items.push({
      key: `view-${view.subview}`,
      label: view.label,
      checked: subview === view.subview,
      run: () => ports.showSubview(view.subview),
    });
  }

  if (session) {
    sessionVerbs(ctx, facts.wired).forEach((ref, i) => {
      const def = resolveAction(ref);
      const availability = def.availability(ctx);
      items.push({
        key: `verb-${ref}`,
        label: `${def.label}${ref === 'terminate' ? '…' : ''}`,
        divider: i === 0 && items.length > 0,
        ...(availability.kind === 'disabled' ? { disabled: true, hint: availability.reason } : {}),
        run: () => ports.runVerb(ref),
      });
    });
  }

  items.push(
    {
      key: 'copy-id',
      label: session ? 'Copy session ID' : 'Copy ID',
      divider: items.length > 0,
      hint: entityId,
      run: () => ports.copy(entityId, session ? 'Session ID' : 'ID'),
    },
    { key: 'copy-title', label: 'Copy title', disabled: !title, run: () => ports.copy(title, 'Title') },
    { key: 'copy-link', label: 'Copy link', run: () => ports.copyLink() },
    {
      key: 'copy-cli',
      label: 'Copy CLI command',
      hint: `tm8 entity context ${entityId}`,
      run: () => ports.copy(`tm8 entity context ${entityId}`, 'CLI command'),
    },
  );
  if (session) {
    items.push({ key: 'copy-transcript', label: 'Copy transcript', run: () => ports.copyTranscript() });
  }
  return items;
}

/** Pages read back from the newest, at most — a guard on a runaway transcript. */
const TRANSCRIPT_MAX_PAGES = 50;

/**
 * The whole transcript as plain text, oldest first. Pages back from the
 * newest window until there is nothing older (or the page cap). Throws the
 * page's `unavailableReason` when the node has no transcript to read.
 */
export async function readTranscriptText(
  read: (opts: { last: number; before?: number }) => Promise<SessionTranscriptPage>,
): Promise<{ text: string; complete: boolean }> {
  const chunks: SessionTranscriptEntry[][] = [];
  let before: number | undefined;
  let complete = false;
  for (let i = 0; i < TRANSCRIPT_MAX_PAGES; i += 1) {
    const page = await read(before === undefined ? { last: 200 } : { last: 200, before });
    if (!page.available) {
      if (chunks.length === 0) throw new Error(transcriptUnavailable(page.unavailableReason));
      break;
    }
    chunks.unshift(page.entries);
    if (!page.hasOlder || page.windowStart == null) {
      complete = true;
      break;
    }
    before = page.windowStart;
  }
  const text = chunks
    .flat()
    .map((entry) => {
      const who = entry.source === 'user' ? 'User' : 'Assistant';
      const at = entry.at ? ` · ${entry.at}` : '';
      return `## ${who}${at}\n\n${entry.text}${entry.truncated ? '\n\n[…truncated]' : ''}`;
    })
    .join('\n\n');
  return { text, complete };
}

function transcriptUnavailable(reason: SessionTranscriptPage['unavailableReason']): string {
  switch (reason) {
    case 'no_native_session_id':
      return 'This session predates transcript capture.';
    case 'unsupported_agent_tool':
      return 'This session’s tool has no transcript tm8 can read.';
    case 'no_transcript_file':
      return 'No transcript has been written for this session.';
    case 'unreadable':
      return 'The transcript file could not be read.';
    default:
      return 'No transcript is available.';
  }
}
