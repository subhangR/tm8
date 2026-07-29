/**
 * Placeholder center views — stand-ins until L5 screens plug into the
 * `ViewRegistry`. They are deliberately data-backed (real facade counts, real
 * entity titles) so navigation is visibly real: switching views or deep-linking
 * changes numbers that came from the seeded world, not static copy.
 */
import { Eyebrow, Kbd, Pill } from '../kit';
import { registryFor } from '../registry';
import type { EntityKind, EntitySummary } from '../types/contract';
import type { ShellViewProps, ViewComponent, ViewRegistry } from './types';
import { useAsyncValue } from './useShellData';

const VIEW_KINDS: Partial<Record<string, EntityKind[]>> = {
  tasks: ['task'],
  docs: ['doc'],
  team: ['member', 'team_member'],
  tracking: ['pull_request', 'commit'],
  graph: ['task'],
  home: ['task'],
  leaderboard: ['member', 'team_member'],
  inbox: ['message'],
  settings: ['member'],
};

const VIEW_BLURB: Partial<Record<string, string>> = {
  home: 'My work — ready to pull, in flight, needs me.',
  tasks: 'Collection view, default Board; axis pivots; bulk ops.',
  docs: 'Tree sidebar + Z4 reader with margin threads.',
  team: 'Member cards with nested agent org-trees.',
  tracking: 'PRs and commits linked by tracks edges.',
  graph: 'Full-page canvas over the seeded subgraphs.',
  leaderboard: 'Score rows, recent awards, completion moments.',
  inbox: 'Cross-space notifications — click opens a panel.',
  settings: 'Members, invites, task-axis management.',
  channel: 'Channel hub — shelf, auto-tabs, thread, composer.',
  entity: 'Generic entity Z4 route.',
};

function ProofRow({ item, onOpenEntity }: { item: EntitySummary; onOpenEntity: (id: string) => void }) {
  const status = registryFor(item.kind).status.current(item);
  return (
    <button type="button" className="cv2-placeholder__row" onClick={() => onOpenEntity(item.id)}>
      <span className="cv2-placeholder__kind">{item.kind}</span>
      <span className="cv2-placeholder__title">{item.title}</span>
      {status && <Pill tone={status.tone} pulse={status.pulse}>{status.label}</Pill>}
      {item.badges.blocked && <Pill tone="blocked">blocked</Pill>}
    </button>
  );
}

/** The generic placeholder used for every view without a registered screen. */
export function PlaceholderView({ facade, spaceId, view, entityId, onOpenEntity }: ShellViewProps) {
  const kinds = VIEW_KINDS[view] ?? ['task'];
  const { value: collection } = useAsyncValue(
    () => facade.queryCollection({ spaceId, kinds, limit: 6, sort: 'activityAt_desc' }),
    [facade, spaceId, view],
  );
  const { value: focus } = useAsyncValue(
    entityId ? () => facade.getEntity(entityId) : null,
    [facade, entityId],
  );

  const total = collection?.page.total ?? collection?.page.items.length ?? 0;

  return (
    <div className="cv2-placeholder" data-view={view} data-testid={`view-${view}`}>
      <header className="cv2-placeholder__header">
        <Eyebrow>{view}</Eyebrow>
        <h1 className="cv2-placeholder__h1">{focus ? focus.title : view}</h1>
        <p className="cv2-placeholder__blurb">{VIEW_BLURB[view] ?? 'Screen arrives in wave 3.'}</p>
      </header>

      <div className="cv2-placeholder__proof">
        <Eyebrow>
          {kinds.join(' · ')} · <span data-testid="placeholder-count">{total}</span> in space
        </Eyebrow>
        <div className="cv2-placeholder__rows">
          {(collection?.page.items ?? []).map((item) => (
            <ProofRow key={item.id} item={item} onOpenEntity={onOpenEntity} />
          ))}
        </div>
        <p className="cv2-placeholder__hint">
          Click a row to peek it as a Z3 panel · <Kbd>⌫</Kbd> pops · <Kbd>g</Kbd> then <Kbd>t</Kbd> jumps to tasks
        </p>
      </div>
    </div>
  );
}

/** Placeholder body for panels, until the entity component is wired in. */
export function PlaceholderPanelBody({ facade, entityId, onOpenEntity }: {
  facade: ShellViewProps['facade']; entityId: string; onOpenEntity: (id: string) => void;
}) {
  const { value: detail } = useAsyncValue(() => facade.getEntity(entityId), [facade, entityId]);
  const children = detail?.hierarchy.children.items ?? [];
  return (
    <div className="cv2-panel__placeholder">
      <Eyebrow>{detail ? detail.kind : 'loading'}</Eyebrow>
      <div className="cv2-panel__placeholder-title">{detail?.title ?? entityId}</div>
      {(() => {
        const status = detail ? registryFor(detail.kind).status.current(detail) : null;
        return status && (
          <div className="cv2-panel__placeholder-pills">
            <Pill tone={status.tone} pulse={status.pulse}>{status.label}</Pill>
          </div>
        );
      })()}
      {children.length > 0 && (
        <>
          <Eyebrow>children</Eyebrow>
          <div className="cv2-placeholder__rows">
            {children.map((child) => (
              <button key={child.id} type="button" className="cv2-placeholder__row" onClick={() => onOpenEntity(child.id)}>
                <span className="cv2-placeholder__kind">{child.kind}</span>
                <span className="cv2-placeholder__title">{child.title}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <p className="cv2-placeholder__hint">Entity component plugs in here (W1a · EntityPanel).</p>
    </div>
  );
}

/** Every view resolves to the placeholder until a screen overrides it. */
export const PLACEHOLDER_VIEWS: ViewRegistry = Object.fromEntries(
  ['home', 'tasks', 'docs', 'team', 'tracking', 'graph', 'leaderboard', 'inbox', 'settings', 'channel', 'entity']
    .map((v) => [v, PlaceholderView as ViewComponent]),
);
