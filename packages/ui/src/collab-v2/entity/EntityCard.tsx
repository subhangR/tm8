/**
 * EntityCard (Z2) — the summary tile: chip row + 2–4 kind fields (from the
 * registry) + universal footer (reactions, points, message count, key edge
 * chips, actor avatars) + badges (blocked ⚠ · working ● · stale · restricted).
 * THE cell for every collection view, embed, hover preview, and graph node —
 * strictly pure props-in, no store reads, no fetching.
 */
import { Avatar, Pill, Timestamp } from '../kit';
import { isTombstoned, registryFor } from '../registry';
import type { EntitySummary } from '../types/contract';
import { REGISTRY_CTX } from './ctx';
import { Tombstone } from './Tombstone';

export interface EntityCardProps {
  entity: EntitySummary;
  /** Optional key-edge chips for the universal footer (callers pass them in). */
  keyEdges?: EntitySummary[];
  /** Rendered inside the shared hover popover (chrome-less styling). */
  inPopover?: boolean;
}

export function EntityCard({ entity, keyEdges, inPopover = false }: EntityCardProps) {
  if (isTombstoned(entity)) return <Tombstone entity={entity} variant="card" />;

  const entry = registryFor(entity.kind);
  const { badges, counters } = entity;
  const stalePull = badges.pulls?.find((p) => p.contentStale);
  const working = badges.workingActors ?? [];

  return (
    <div
      className={`cv2-card${inPopover ? ' cv2-card--popover' : ''}`}
      data-kind={entity.kind}
    >
      <div className="cv2-card__head">
        <span className="cv2-chip__glyph" style={{ color: entry.tint(entity) }} aria-hidden="true">
          {entry.glyph}
        </span>
        <span className="cv2-card__kind">{entry.label}</span>
        <span className="cv2-card__headspace" />
        {/* activityAt, not createdAt: collections sort by recency of activity
            (contract default `activityAt_desc`), and a card whose time
            disagreed with its own list order would be worse than no time. */}
        <Timestamp className="cv2-card__when" at={entity.activityAt} title="last activity" />
        <Avatar actor={entity.createdBy} size={20} />
      </div>

      <div className="cv2-card__title">{entity.title}</div>

      <div className="cv2-card__fields">
        <entry.SummaryFields entity={entity} ctx={REGISTRY_CTX} />
      </div>

      {(badges.blocked || working.length > 0 || stalePull || badges.restricted) && (
        <div className="cv2-card__badges">
          {badges.blocked && (
            <Pill tone="blocked" title={`waiting on ${badges.blocked.waitingOn.map((w) => w.title).join(', ')}`}>
              ⚠ blocked · {badges.blocked.unresolvedHardDependencyCount}
            </Pill>
          )}
          {working.length > 0 && (
            <Pill tone="working" pulse title={working.map((w) => `${w.actor.displayName} on ${w.task.title}`).join(' · ')}>
              working · {working.map((w) => w.actor.displayName).join(', ')}
            </Pill>
          )}
          {stalePull && (
            <Pill tone="stale" title={`${stalePull.actor.displayName} pinned v${stalePull.pinnedVersion}, content is v${entity.version}`}>
              v{stalePull.pinnedVersion} → stale
            </Pill>
          )}
          {badges.restricted && <Pill tone="neutral" dot={false}>🔒 restricted</Pill>}
        </div>
      )}

      <div className="cv2-card__foot">
        <span className="cv2-count" title="likes">👍 {counters.likes}</span>
        {counters.dislikes > 0 && <span className="cv2-count" title="dislikes">👎 {counters.dislikes}</span>}
        <span className="cv2-count" title="stars">⭐ {counters.stars}</span>
        <span className="cv2-count" title="points pool">◈ {counters.points}</span>
        <span className="cv2-count" title="messages">💬 {counters.messages}</span>
        {keyEdges && keyEdges.length > 0 && (
          <span className="cv2-card__edges">
            {keyEdges.slice(0, 3).map((e) => (
              <REGISTRY_CTX.Chip key={e.id} entity={e} variant="ref" />
            ))}
          </span>
        )}
        {working.length > 0 && (
          <span className="cv2-avatarrow cv2-count--right">
            {working.map((w) => <Avatar key={w.actor.id} actor={w.actor} size={16} />)}
          </span>
        )}
      </div>
    </div>
  );
}
