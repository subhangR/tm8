import type { HandoffView } from '@tm8/contract';
import { Avatar, Eyebrow } from '../../kit';
import { DisabledIconControl, toReason } from '../honesty/DisabledWithReason';
import { deliveryFacet, recordFacet, withdrawalAudit } from './facets';

/**
 * SHARED CONTEXT — what has been shared INTO this session (T0-2 §6).
 *
 * Every row states two facets side by side and never merges them (see
 * facets.ts for why that is load-bearing). Two further rules the canvas is
 * explicit about:
 *
 *   · WITHDRAWAL DECORATES, NEVER REWRITES. A withdrawn share keeps its row
 *     and its content; it gains a badge and an audit line. Nothing is deleted
 *     from history, because the receiving agent may already have read it and
 *     pretending otherwise would be a false record.
 *   · sourceMissing IS RENDERED, not hidden. The share record outlives its
 *     source — deleted, unshared, or on an unreachable node. The row is dashed
 *     like a tombstone and amber because the source may come back, and it
 *     offers NO navigation, because there is nothing to navigate to.
 *
 * The WITHDRAW control renders disabled-with-reason: `handoffs.withdraw` is a
 * §10.7 deferred seam amendment. The read side is fully live — these rows come
 * from the seam's `handoffs()` read — so the state rendering ships now and
 * only the write waits.
 */

export function SharedContextSection({
  handoffs,
  withdrawUnavailableReason,
  onOpenSource,
}: {
  handoffs: readonly HandoffView[];
  /** The §10.7 interim copy. Passed in so the reason has one home. */
  withdrawUnavailableReason: string;
  onOpenSource?: (entityId: string) => void;
}) {
  return (
    <section className="pn-section" data-testid="shared-context-section">
      <Eyebrow faint>{`SHARED CONTEXT · ${handoffs.length}`}</Eyebrow>
      {handoffs.length === 0 ? (
        <p className="pn-section__empty">
          Nothing shared into this session yet — drop an entity here to share it.
        </p>
      ) : (
        <ul className="pn-handoffs">
          {handoffs.map((h) => (
            <HandoffRow
              key={h.handoffId}
              handoff={h}
              withdrawUnavailableReason={withdrawUnavailableReason}
              onOpenSource={onOpenSource}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function HandoffRow({
  handoff,
  withdrawUnavailableReason,
  onOpenSource,
}: {
  handoff: HandoffView;
  withdrawUnavailableReason: string;
  onOpenSource?: (entityId: string) => void;
}) {
  const delivery = deliveryFacet(handoff);
  const record = recordFacet(handoff);
  const audit = withdrawalAudit(handoff);
  const { title, truncated, omittedFields } = handoff.sourceSnapshot;

  return (
    <li
      className={handoff.sourceMissing ? 'pn-handoff pn-handoff--source-missing' : 'pn-handoff'}
      data-testid="handoff-row"
      data-delivery={handoff.deliveryStatus}
      data-record={handoff.recordStatus}
    >
      <div className="pn-handoff__main">
        {handoff.sourceMissing ? (
          /* No link: the entity is gone. Offering a click that cannot resolve
             would be the affordance lying about what it can do. */
          <span className="pn-handoff__label pn-handoff__label--missing" title={title}>
            {title}
          </span>
        ) : (
          <button
            type="button"
            className="pn-handoff__label"
            onClick={() => onOpenSource?.(handoff.sourceEntityId)}
            title={title}
          >
            {title}
          </button>
        )}

        <span className="pn-handoff__spacer" />

        {/* TWO pills. Always both. Never merged. */}
        <span className={`pn-facet kit-pill--${delivery.tone}`} title={delivery.detail}>
          {delivery.label}
        </span>
        <span className={`pn-facet kit-pill--${record.tone}`} title={record.detail}>
          {record.label}
        </span>

        <DisabledIconControl
          label={`Withdraw share of ${title}`}
          reason={toReason(withdrawUnavailableReason)}
          glyph="↩"
        />
      </div>

      {handoff.sourceMissing ? (
        <p className="pn-handoff__note pn-handoff__note--warn">
          source missing — the shared entity is gone; this snapshot is what survives
        </p>
      ) : null}

      {truncated ? (
        /* Say what the agent did NOT get. Silence here would imply the whole
           entity crossed over. */
        <p className="pn-handoff__note">
          {`snapshot truncated — omitted: ${omittedFields.join(', ')}`}
        </p>
      ) : null}

      {audit ? (
        <p className="pn-handoff__note pn-handoff__note--audit">
          {handoff.withdrawnBy ? (
            <Avatar
              actorId={handoff.withdrawnBy.id}
              provenance={handoff.withdrawnBy.isAgent ? 'agent' : 'human'}
              label={handoff.withdrawnBy.displayName}
              size={15}
              src={handoff.withdrawnBy.avatar ?? null}
            />
          ) : null}
          <span>{audit}</span>
        </p>
      ) : null}
    </li>
  );
}
