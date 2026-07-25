/**
 * ReactionsPointsBar (L2.3) — the compact universal bar: 👍/👎 (mutually
 * exclusive), ⭐ (independent), and the points control. IDENTICAL on every
 * entity, including messages: pass the envelope you already have
 * (`EntitySummary`, `EntityDetail` or `MessageView` — all carry `counters`)
 * and the bar does the rest.
 *
 *   <ReactionsPointsBar entityId={task.id} entity={task} />
 *   <ReactionsPointsBar entityId={m.id} entity={m} size="sm" />   // thread row
 */
import { IconBtn } from '../../kit';
import type { EntityCapabilities, EntityId, EntitySummary } from '../../types/contract';
import { PointsControl } from './PointsControl';
import type { Reaction } from './model';
import { useReactions } from './useReactions';
import './reactions.css';

export interface ReactionsPointsBarProps {
  entityId: EntityId;
  /** The envelope the host already holds (skips a fetch). */
  entity?: EntitySummary;
  /** Capability overrides; detail-bearing hosts should pass the real ones. */
  capabilities?: Partial<Pick<EntityCapabilities, 'canReact' | 'canGrantPoints'>>;
  size?: 'sm' | 'md';
  /** Hide the points control (rare: surfaces with no economy). */
  showPoints?: boolean;
  /** Hide zero counts (message rows stay quiet until someone reacts). */
  hideZeroCounts?: boolean;
  /** Test/tuning hooks forwarded to the points control. */
  holdMs?: number;
  popoverDelayMs?: number;
}

const REACTIONS: ReadonlyArray<{ key: Reaction; glyph: string; label: string; counter: 'likes' | 'dislikes' | 'stars' }> = [
  { key: 'like', glyph: '👍', label: 'Like', counter: 'likes' },
  { key: 'dislike', glyph: '👎', label: 'Dislike', counter: 'dislikes' },
  { key: 'star', glyph: '⭐', label: 'Star', counter: 'stars' },
];

export function ReactionsPointsBar({
  entityId, entity, capabilities, size = 'md', showPoints = true,
  hideZeroCounts = false, holdMs, popoverDelayMs,
}: ReactionsPointsBarProps) {
  const { counters, isActive, toggle, grant, loadGranters, error } =
    useReactions(entityId, entity);

  const canReact = capabilities?.canReact ?? true;
  const canGrant = capabilities?.canGrantPoints ?? true;

  return (
    <div className="cv2-rxbar" data-size={size} data-entity={entityId}>
      {REACTIONS.map((r) => {
        const count = counters[r.counter];
        const active = isActive(r.key);
        return (
          <IconBtn
            key={r.key}
            aria-label={r.label}
            aria-pressed={active}
            active={active}
            disabled={!canReact}
            title={`${r.label}${count > 0 ? ` · ${count}` : ''}`}
            onClick={() => toggle(r.key)}
          >
            <span aria-hidden="true">{r.glyph}</span>
            {(count > 0 || !hideZeroCounts) && <span className="cv2-actioncount">{count}</span>}
          </IconBtn>
        );
      })}

      {showPoints && (
        <PointsControl
          pool={counters.points}
          disabled={!canGrant}
          onGrant={grant}
          loadGranters={loadGranters}
          holdMs={holdMs}
          popoverDelayMs={popoverDelayMs}
          size={size}
        />
      )}

      {error && <span className="cv2-rxbar__error" role="alert">{error}</span>}
    </div>
  );
}
