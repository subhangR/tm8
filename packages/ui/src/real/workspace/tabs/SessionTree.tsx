import { useMemo, useState } from 'react';
import type { EntitySummary } from '../../../collab-v2/types/contract';
import type { SessionLinks } from '../useSessions';
import { isLive, sessionState } from '../useSessions';
import { disabledBecause, HollowNote, Note } from '../Unavailable';
import { AgentTile, PanelIcon, StatusGlyph } from './panelPrimitives';

export type SessionLifecycleFilter = 'open' | 'done';

interface TreeNode {
  session: EntitySummary;
  children: TreeNode[];
}

export function buildSessionForest(sessions: EntitySummary[]): TreeNode[] {
  const byId = new Map(sessions.map((session) => [session.id, { session, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const session of sessions) {
    const node = byId.get(session.id)!;
    const parent = session.parentId ? byId.get(session.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function subtreeCount(node: TreeNode): number {
  return 1 + node.children.reduce((total, child) => total + subtreeCount(child), 0);
}

function SessionNode({ node, depth, links, active, onOpen, lifecycle }: {
  node: TreeNode;
  depth: number;
  links: Map<string, SessionLinks>;
  active: string | null;
  onOpen: (id: string) => void;
  lifecycle: SessionLifecycleFilter;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { session, children } = node;
  const related = links.get(session.id);
  const pending = !links.has(session.id);
  const st = sessionState(session);
  const live = isLive(session);
  const status = String(st.status || 'idle');
  const title = related?.agent?.title || session.title || 'Session';
  const done = !live;
  const archived = Boolean(session.deletedAt);
  const visibleChildren = children;

  return (
    <div className={`sessionTreeNode${depth > 0 ? ' sessionTreeNode--child' : ''}`} data-session-node={session.id}>
      <div
        className={`pn-st${active === session.id ? ' pn-st--selected' : ''}${archived ? ' pn-st--archived' : ''}`}
        role="button"
        tabIndex={0}
        aria-current={active === session.id ? 'true' : undefined}
        onClick={() => onOpen(session.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(session.id);
          }
        }}
      >
        <div className="pn-st__main">
          <button
            type="button"
            className={`pn-st__arrow ${visibleChildren.length ? (collapsed ? '' : 'pn-st__arrow--expanded') : 'pn-st__arrow--empty'}`}
            disabled={visibleChildren.length === 0}
            onClick={(event) => { event.stopPropagation(); setCollapsed((value) => !value); }}
            title={visibleChildren.length ? (collapsed ? `Expand ${visibleChildren.length} sub-sessions` : 'Collapse sub-sessions') : 'No projected sub-sessions'}
            aria-label={visibleChildren.length ? (collapsed ? `Expand ${visibleChildren.length} sub-sessions` : 'Collapse sub-sessions') : 'No sub-sessions'}
            aria-expanded={visibleChildren.length ? !collapsed : undefined}
          >
            <PanelIcon name="chevronR" />
          </button>
          {visibleChildren.length > 0 && <span className="pn-st__arrowCount">{visibleChildren.length}</span>}

          <button
            type="button"
            className={`pn-st__radio${done && lifecycle === 'done' ? ' pn-st__radio--on' : ''}`}
            onClick={(event) => event.stopPropagation()}
            aria-pressed={done && lifecycle === 'done'}
            aria-label="Mark session done"
            {...disabledBecause('workSession.markDone', 'Marking a work session done is not implemented on this node')}
          >
            {done && lifecycle === 'done' && <PanelIcon name="check" size={10} sw={2.2} />}
          </button>

          <span className="pn-st__title" title={`${title} · ${session.id}`}>
            <AgentTile tool={st.agentTool} />
            <span className={`pn-st__titleText${pending ? ' ws-session-title--pending' : ''}`}>{pending ? 'Resolving agent…' : title}</span>
          </span>

          {archived && <span className="pn-st__tag">archived</span>}
          {!archived && done && <span className="pn-st__tag pn-st__tag--done">done</span>}
          {!archived && (live
            ? <span className="pn-st__live pn-dot-wrap" title="Live terminal"><span className="pn-dot pn-dot--run" /></span>
            : <span className="pn-st__stopped" title="No live terminal" />)}
          <span className="pn-st__statusglyph" title={status}>
            <StatusGlyph kind={archived ? 'archived' : status} />
          </span>
        </div>
      </div>

      {!collapsed && visibleChildren.length > 0 && (
        <div className="pn-kids pn-kids--st">
          {visibleChildren.map((child) => (
            <SessionNode
              key={child.session.id}
              node={child}
              depth={depth + 1}
              links={links}
              active={active}
              onOpen={onOpen}
              lifecycle={lifecycle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SessionTree({ sessions, links, active, onOpen, lifecycle, liveOnly }: {
  sessions: EntitySummary[];
  links: Map<string, SessionLinks>;
  active: string | null;
  onOpen: (id: string) => void;
  lifecycle: SessionLifecycleFilter;
  liveOnly: boolean;
}) {
  const filtered = useMemo(() => sessions.filter((session) => {
    if (liveOnly && !isLive(session)) return false;
    return lifecycle === 'done' ? !isLive(session) : true;
  }), [sessions, lifecycle, liveOnly]);
  const forest = useMemo(() => buildSessionForest(filtered), [filtered]);

  const groups = useMemo(() => {
    const map = new Map<string, { task: EntitySummary | null; roots: TreeNode[] }>();
    for (const root of forest) {
      const task = links.get(root.session.id)?.task ?? null;
      const key = task?.id ?? '__ungrouped__';
      const group = map.get(key) ?? { task, roots: [] };
      group.roots.push(root);
      map.set(key, group);
    }
    return [...map.values()];
  }, [forest, links]);

  if (filtered.length === 0) {
    return (
      <div className="sessionEmptyState">
        <span className="sessionEmptyState__icon" aria-hidden="true">{lifecycle === 'done' ? '✓' : '◉'}</span>
        <span className="sessionEmptyState__title">{liveOnly ? 'No live sessions' : lifecycle === 'done' ? 'No finished sessions' : 'No sessions'}</span>
        <span className="sessionEmptyState__hint">Sessions returned by this space’s real work-session query appear here.</span>
      </div>
    );
  }

  return (
    <>
      <div className="pn-list">
        {groups.map((group, groupIndex) => {
          const count = group.roots.reduce((total, root) => total + subtreeCount(root), 0);
          const content = group.roots.map((root) => (
            <SessionNode
              key={root.session.id}
              node={root}
              depth={0}
              links={links}
              active={active}
              onOpen={onOpen}
              lifecycle={lifecycle}
            />
          ));
          if (!group.task) return <div key={`ungrouped-${groupIndex}`}>{content}</div>;
          const anyLive = group.roots.some((root) => isLive(root.session));
          return (
            <section className="pn-team" key={group.task.id}>
              <div className="pn-team__head">
                <span className={`pn-team__dot${anyLive ? ' pn-team__dot--live' : ''}`} />
                <span className="pn-team__name" title={group.task.title}>{group.task.title}</span>
                <span className="pn-team__count">{count} session{count === 1 ? '' : 's'}</span>
              </div>
              {content}
            </section>
          );
        })}
      </div>
      <Note testId="session-parent-projection-note">
        Spawned sessions nest beneath the session that launched them; sessions launched by a person stay at the root.
      </Note>
      <HollowNote field="work_session.content.transcriptDoc">
        Scrollback is not a saved transcript — no transcript store on this node.
      </HollowNote>
    </>
  );
}
