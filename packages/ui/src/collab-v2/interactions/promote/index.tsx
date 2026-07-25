/**
 * Promote message → task / doc (UX brief §6.3): from a thread message's
 * action row, create the entity, link it `relates_to` the message, and quote
 * the message body in the new entity's content — knowledge grows out of
 * conversation without losing the source.
 *
 * The affordance rides Thread's `reactionsSlot` (its per-message footer
 * slot) via `promoteReactionsSlot` — no Thread edits. A first-class
 * message-actions slot on MessageRow would be cleaner; flagged to Atlas.
 */
import { useState, type ReactNode } from 'react';
import { useFacade } from '../../entity';
import { registryFor, truncate } from '../../registry';
import { useNavStore } from '../../stores';
import { pushToast } from '../../subsystems/live';
import { describeError } from '../../subsystems/palette';
import { ReactionsReadout, stripTokens } from '../../subsystems/thread';
import type { CommandResult, EntityKind, MessageView } from '../../types/contract';
import type { CollabFacade } from '../../facade';
import { createFromSeed } from '../create';

/** Kinds a message can promote into. // registry-purity: allow — promote grammar data (§6.3: "promote to task/doc"); a registry `promoteTarget` field is flagged to Atlas */
export const PROMOTE_TARGETS: readonly EntityKind[] = ['task', 'doc'];

/**
 * Where the quote lands per target kind — creation-schema field names
 * (task.description / doc.body+format), kept as grammar DATA beside
 * PROMOTE_TARGETS so adding a promote target is one entry here.
 */
const QUOTE_CONTENT = new Map<EntityKind, (quote: string) => Record<string, unknown>>([
  ['task', (quote) => ({ description: quote })], // registry-purity: allow — promote grammar data (task quote field)
  ['doc', (quote) => ({ format: 'markdown', body: quote })], // registry-purity: allow — promote grammar data (doc quote field)
]);

/** The quoted excerpt: body minus embed/ref tokens, collapsed, clipped. */
export function quoteExcerpt(body: string, max = 280): string {
  const clean = stripTokens(body).replace(/\s+/g, ' ').trim();
  return truncate(clean, max);
}

/** Blockquote form used inside the created entity's content. */
export function quoteBlock(message: MessageView): string {
  const author = message.state.author.displayName;
  return `> ${quoteExcerpt(message.content.body)}\n> — ${author}`;
}

export interface PromoteResult {
  result: CommandResult;
  kind: EntityKind;
}

/**
 * Create the target entity from the message: `createVia` seam +
 * `attachTo: { message, relates_to }` (edge and entity land atomically) +
 * the quote in the kind's content field.
 */
export async function promoteMessage(
  facade: CollabFacade,
  message: MessageView,
  kind: EntityKind,
): Promise<PromoteResult> {
  const toContent = QUOTE_CONTENT.get(kind);
  if (!toContent || !PROMOTE_TARGETS.includes(kind)) {
    throw new Error(`messages promote to ${PROMOTE_TARGETS.join(' / ')}, not ${kind}`);
  }
  const title = quoteExcerpt(message.content.body, 80) || 'Promoted message';
  const result = await createFromSeed(
    facade,
    kind,
    { spaceId: message.spaceId, attachTo: { entityId: message.id, edgeType: 'relates_to' } },
    title,
    toContent(quoteBlock(message)),
  );
  return { result, kind };
}

// ---------------------------------------------------------------------------
// affordance components
// ---------------------------------------------------------------------------

export interface PromoteMenuProps {
  message: MessageView;
  onClose: () => void;
  onPromoted?: (outcome: PromoteResult) => void;
  /** Push a panel for the created entity (default true). */
  openAfter?: boolean;
}

export function PromoteMenu({ message, onClose, onPromoted, openAfter = true }: PromoteMenuProps) {
  const facade = useFacade();
  const [busy, setBusy] = useState(false);

  const promote = (kind: EntityKind): void => {
    if (busy) return;
    setBusy(true);
    promoteMessage(facade, message, kind)
      .then((outcome) => {
        const created = outcome.result.entity;
        pushToast({
          kind: 'success',
          message: `Promoted to ${registryFor(kind).label.toLowerCase()} — ${created?.title ?? ''}`.trim(),
          entityId: created?.id,
        });
        onPromoted?.(outcome);
        onClose();
        if (openAfter && created) useNavStore.getState().pushPanel({ entityId: created.id });
      })
      .catch((e) => {
        pushToast({ kind: 'error', message: `Promote failed — ${describeError(e)}` });
      })
      .finally(() => setBusy(false));
  };

  return (
    <span
      className="cv2-promote__menu"
      role="menu"
      aria-label="Promote this message"
      data-testid="promote-menu"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      {PROMOTE_TARGETS.map((kind) => {
        const entry = registryFor(kind);
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            className="cv2-promote__item"
            disabled={busy}
            onClick={() => promote(kind)}
          >
            <span aria-hidden="true">{entry.glyph}</span> Promote to {entry.label.toLowerCase()}
          </button>
        );
      })}
    </span>
  );
}

/** The compact "↗ Promote" button that lives in a message's footer. */
export function PromoteAction({ message }: { message: MessageView }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="cv2-promote">
      <button
        type="button"
        className="cv2-thread__act"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ↗ Promote
      </button>
      {open && <PromoteMenu message={message} onClose={() => setOpen(false)} />}
    </span>
  );
}

/**
 * Adapter for Thread's `reactionsSlot`: renders the inner slot (or the
 * default read-only readout) plus the promote affordance. Pass the result
 * as `reactionsSlot` on any Thread / discussionSlot options.
 */
export function promoteReactionsSlot(
  inner?: (message: MessageView) => ReactNode,
): (message: MessageView) => ReactNode {
  return function promoteSlot(message: MessageView): ReactNode {
    return (
      <>
        {inner ? inner(message) : <ReactionsReadout message={message} />}
        <PromoteAction message={message} />
      </>
    );
  };
}
