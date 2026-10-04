import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { KindIcon } from '../../domain';
import { MembershipPicker } from '../../panels/bodies/MembershipBlock';
import { DOCUMENT_KIND, STORY_KIND, TASK_KIND, pct, since, statusWord, toneOf, type StoryNode } from '../model';
import type { StoryBlockProps } from '../props';
import { MenuDot, Meter, TonePill, pressOf } from '../cards/shared';
import { ALL_KINDS, PAGE_SIZE, filterTree, kindLabel, storyTree, type TreeFilter } from './model';
import './story-tree.css';

interface Draft { parentId: string; kind: string; title: string; busy: boolean; error: string | null }
const EMPTY_FILTER: TreeFilter = { kind: ALL_KINDS, query: '', status: '', scope: '' };

export function StoryTree(props: StoryBlockProps & { onLaunch: (id: string) => void; onFilterKinds?: (kinds: string[] | null) => void }) {
  const { view, actions, onLaunch } = props;
  const tree = useMemo(() => storyTree(view), [view]);
  const [filter, setFilter] = useState<TreeFilter>(() => ({ ...EMPTY_FILTER, kinds: props.filter?.kinds, hops: props.filter?.hops }));
  const [sort, setSort] = useState('hierarchy');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [limits, setLimits] = useState<Map<string, number>>(() => new Map());
  const [connections, setConnections] = useState<{ id: string; kind: string } | null>(null);
  // The draft belongs to the workspace, never to a row that filtering can unmount.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const [focus, setFocus] = useState<{ id: string; editor?: boolean; seq: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  const press = pressOf(props);
  const filtered = filter.kind !== ALL_KINDS || !!filter.query || !!filter.status || !!filter.scope || !!filter.kinds || (filter.hops ?? 3) < 3;
  useEffect(() => {
    const next = { ...EMPTY_FILTER, kinds: props.filter?.kinds, hops: props.filter?.hops };
    setFilter(old => ({ ...old, kind: next.kinds?.size === 1 ? [...next.kinds][0]! : ALL_KINDS, kinds: next.kinds, hops: next.hops }));
    if (next.kinds || (next.hops ?? 3) < 3) setExpanded(new Set(filterTree(tree, view.id, next).ancestors));
  }, [props.filter?.kinds, props.filter?.hops]);
  const { matches, visible } = useMemo(
    () => filterTree(tree, view.id, filter, draft?.parentId), [tree, view.id, filter, draft?.parentId],
  );
  const draftAncestors = useMemo(() => {
    const path = new Set<string>();
    let id = draft ? tree.parents.get(draft.parentId) : undefined;
    while (id && id !== view.id) { path.add(id); id = tree.parents.get(id); }
    return path;
  }, [tree, draft?.parentId, view.id]);
  const roots = useMemo(() => new Map(view.page.roots.map(r => [r.id, r])), [view.page.roots]);
  const childStories = useMemo(() => new Map(view.page.childStories.map(c => [c.id, c])), [view.page.childStories]);
  const sessions = useMemo(() => {
    const result = new Map<string, typeof view.page.sessions>();
    for (const s of view.page.sessions) for (const id of new Set([s.id, ...s.taskIds])) {
      const list = result.get(id) ?? [];
      list.push(s);
      result.set(id, list);
    }
    for (const list of result.values()) list.sort((a, b) => Number(b.live) - Number(a.live) || b.createdAt.localeCompare(a.createdAt));
    return result;
  }, [view.page.sessions]);

  const titleButton = (id: string) => [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-tree-title]') ?? [])]
    .find(el => el.dataset.treeTitle === id);
  const moveFocus = (id: string, editor = false) => setFocus(f => ({ id, editor, seq: (f?.seq ?? 0) + 1 }));
  useLayoutEffect(() => {
    if (!focus) return;
    const el = (focus.editor ? input.current : titleButton(focus.id))
      ?? root.current?.querySelector<HTMLInputElement>('input[type=search]');
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [focus]);

  const childrenOf = (parent: string) => (tree.children.get(parent) ?? []).filter(n => visible.has(n.id)).sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'activity') return (b.activityAt ?? '').localeCompare(a.activityAt ?? '');
    return 0;
  });
  const updateFilter = (patch: Partial<TreeFilter>) => {
    const next = { ...filter, ...patch, ...('kind' in patch ? { kinds: null, hops: 3 } : {}) };
    if ('kind' in patch) props.onFilterKinds?.(patch.kind === ALL_KINDS ? null : [patch.kind!]);
    const found = filterTree(tree, view.id, next, draft?.parentId);
    setFilter(next);
    setExpanded(new Set(found.ancestors));
    setLimits(new Map());
  };
  const reveal = (id: string, nextFilter = filter) => {
    const found = filterTree(tree, view.id, nextFilter, id);
    const open = new Set(expanded);
    const pages = new Map(limits);
    let child: string | undefined = id;
    while (child && child !== view.id) {
      const parent: string = tree.parents.get(child) ?? view.id;
      open.add(parent);
      const siblings = (tree.children.get(parent) ?? []).filter(n => found.visible.has(n.id));
      // A draft must remain reachable even when the sort changes its row position.
      pages.set(parent, Math.max(pages.get(parent) ?? PAGE_SIZE, siblings.length));
      child = parent;
    }
    setExpanded(open);
    setLimits(pages);
  };
  const create = (parentId: string, kind: string) => {
    const target = draft?.parentId ?? parentId;
    if (draft && parentId !== target) setNotice('Finish or cancel your current draft before creating elsewhere.');
    else if (!draft) setDraft({ parentId, kind, title: '', busy: false, error: null });
    const nextFilter = target !== view.id && !visible.has(target) ? EMPTY_FILTER : filter;
    setFilter(nextFilter);
    reveal(target, nextFilter);
    moveFocus(target, true);
  };
  const cancel = () => {
    if (draft?.busy) return;
    const parentId = draft?.parentId;
    setDraft(null);
    if (parentId && parentId !== view.id) {
      if (!filterTree(tree, view.id, filter).visible.has(parentId)) {
        setFilter(EMPTY_FILTER); reveal(parentId, EMPTY_FILTER);
      }
      moveFocus(parentId);
    }
    else root.current?.querySelector<HTMLButtonElement>('[data-new-task]')?.focus();
  };
  const submit = async () => {
    if (!draft || draft.busy) return;
    const title = draft.title.trim();
    if (!title) { setDraft({ ...draft, error: 'Enter a title.' }); return; }
    const action = draft.kind === DOCUMENT_KIND ? actions.createDocument : actions.createTask;
    if (!action) return;
    setDraft({ ...draft, busy: true, error: null });
    try {
      await action(draft.parentId, title);
      setDraft(null);
      setNotice(`${kindLabel(draft.kind)} created. The story will update when the server refresh arrives.`);
      if (draft.parentId !== view.id) {
        if (!filterTree(tree, view.id, filter).visible.has(draft.parentId)) {
          setFilter(EMPTY_FILTER); reveal(draft.parentId, EMPTY_FILTER);
        }
        moveFocus(draft.parentId);
      }
      else root.current?.querySelector<HTMLButtonElement>('[data-new-task]')?.focus();
    } catch (e) {
      setDraft({ ...draft, busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const editor = (parentId: string) => draft?.parentId === parentId ? (
    <form className="syt-editor" aria-label="Create entity" onSubmit={e => { e.preventDefault(); void submit(); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
      <p>New {kindLabel(draft.kind).toLowerCase()} {parentId === view.id || [draft.kind, STORY_KIND].includes(tree.nodes.get(parentId)?.kind ?? '') ? 'in' : 'linked to'} <strong>{tree.nodes.get(parentId)?.title ?? view.title}</strong></p>
      <div className="syt-editor__controls">
        <select aria-label="Entity kind" value={draft.kind} disabled={draft.busy}
          onChange={e => setDraft({ ...draft, kind: e.target.value })}>
          {actions.createTask && <option value={TASK_KIND}>Task</option>}
          {actions.createDocument && <option value={DOCUMENT_KIND}>Document</option>}
        </select>
        <input ref={input} aria-label="New entity title" value={draft.title} autoComplete="off" disabled={draft.busy}
          onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="Give it a name…" />
        <button className="stc-btn" type="submit" disabled={draft.busy}>{draft.busy ? 'Creating…' : 'Create'}</button>
        <button className="stc-btn stc-btn--ghost" type="button" disabled={draft.busy} onClick={cancel}>Cancel</button>
      </div>
      {draft.error && <p role="alert">{draft.error}</p>}
    </form>
  ) : null;
  const toggle = (id: string) => setExpanded(old => {
    const next = new Set(old);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const onRowKey = (event: KeyboardEvent, n: StoryNode) => {
    const titles = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-tree-title]') ?? [])];
    const i = titles.findIndex(el => el.dataset.treeTitle === n.id);
    const hasChildren = childrenOf(n.id).length > 0;
    if (event.key === 'ArrowDown') titles[Math.min(i + 1, titles.length - 1)]?.focus();
    else if (event.key === 'ArrowUp') titles[Math.max(0, i - 1)]?.focus();
    else if (event.key === 'Home') titles[0]?.focus();
    else if (event.key === 'End') titles.at(-1)?.focus();
    else if (event.key === 'ArrowRight' && hasChildren) {
      if (!expanded.has(n.id)) toggle(n.id);
      else titleButton(childrenOf(n.id)[0]!.id)?.focus();
    } else if (event.key === 'ArrowLeft') {
      if (expanded.has(n.id) && hasChildren) toggle(n.id);
      else titleButton(tree.parents.get(n.id) ?? '')?.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  let shownCount = 0;
  const renderList = (parentId: string, depth: number) => {
    const children = childrenOf(parentId);
    let limit = limits.get(parentId) ?? PAGE_SIZE;
    // Keep a draft's ancestor chain on the rendered page through every filter/sort/live update.
    if (draft) {
      let pinned: string | undefined = draft.parentId;
      while (pinned && pinned !== view.id) {
        if (tree.parents.get(pinned) === parentId) limit = Math.max(limit, children.findIndex(n => n.id === pinned) + 1);
        pinned = tree.parents.get(pinned);
      }
    }
    const shown = children.slice(0, limit);
    shownCount += shown.length;
    return <ul className="syt-list" aria-label={parentId === view.id ? 'Story entities' : `Children of ${tree.nodes.get(parentId)?.title}`}>
      {shown.map(n => {
        const descendants = childrenOf(n.id);
        const opened = expanded.has(n.id) || draftAncestors.has(n.id);
        const groups = tree.relations.get(n.id);
        const selectedGroup = connections?.id === n.id ? groups?.get(connections.kind) : null;
        const progress = roots.get(n.id)?.taskProgress ?? childStories.get(n.id)?.taskProgress;
        const runs = sessions.get(n.id) ?? [];
        const run = runs[0];
        const assigned = view.page.team.filter(t => t.assigned.includes(n.id));
        const context = !matches.has(n.id);
        const childrenId = `${uid}-children-${n.id}`;
        return <li key={n.id} style={{ '--syt-depth': Math.min(depth, 6) } as CSSProperties} data-tree-node={n.id}>
          <div className={`syt-row${context ? ' syt-row--context' : ''}${props.selectedId === n.id ? ' syt-row--selected' : ''}`}
            data-landed={props.live?.landed.has(n.id) || undefined}>
            <div className="syt-name">
              {descendants.length ? <button type="button" className="syt-disclosure" aria-expanded={opened} aria-controls={childrenId}
                aria-label={`${opened ? 'Collapse' : 'Expand'} ${n.title}`} onClick={() => toggle(n.id)} onKeyDown={e => onRowKey(e, n)}>{opened ? '⌄' : '›'}</button>
                : <span className="syt-disclosure" />}
              <span title={kindLabel(n.kind)}><KindIcon kind={n.kind} size={15} /></span>
              <button type="button" className="syt-title" data-tree-title={n.id} onClick={() => actions.open?.(n.id)}
                onContextMenu={press.menu?.(n.id)} onKeyDown={e => onRowKey(e, n)}>{n.title}</button>
              {descendants.length > 0 && <span className="syt-count" title="Children in this view">{descendants.length}</span>}
              {context && <span className="syt-context">{draft?.parentId === n.id ? 'draft' : 'parent'}</span>}
            </div>
            <div className="syt-connections">
              {[...(groups ?? [])].map(([kind, peers]) => <button key={kind} type="button" className="syt-chip"
                aria-label={`${peers.length} linked ${kindLabel(kind, true)} for ${n.title}`} title={`${peers.length} linked ${kindLabel(kind, true)}`}
                aria-expanded={connections?.id === n.id && connections.kind === kind} aria-controls={`${uid}-connections-${n.id}`}
                onClick={() => setConnections(connections?.id === n.id && connections.kind === kind ? null : { id: n.id, kind })}>
                <KindIcon kind={kind} size={12} /><span>{peers.length}</span>
              </button>)}
            </div>
            <div className="syt-status"><TonePill tone={toneOf(n)} label={n.blocked ? 'blocked' : statusWord(n.status) || '—'} /></div>
            <div className="syt-actions">
              {(actions.createTask || actions.createDocument) && <button type="button" className="syt-icon" aria-label={`Create under ${n.title}`} title="Create task or document"
                onClick={() => create(n.id, actions.createTask ? TASK_KIND : DOCUMENT_KIND)}>+</button>}
              {actions.add && <button type="button" className="syt-icon" aria-label={`Launch on ${n.title}`} title="Launch a session" onClick={() => onLaunch(n.id)}>▷</button>}
              <MenuDot id={n.id} label={n.title} press={press} />
            </div>
            <div className="syt-meta">
              <span>{kindLabel(n.kind)}</span>
              {roots.has(n.id) && <span>root</span>}
              {run ? <button type="button" onClick={() => actions.open?.(run.id)} className={run.live ? 'syt-live' : ''}>
                {run.teamMemberId ? view.people[run.teamMemberId]?.name ?? 'Teammate' : 'Session'} · {run.callSign} · {run.live ? 'live' : statusWord(run.runtimeStatus) || 'not live'}
                {runs.length > 1 ? ` · +${runs.length - 1}` : ''}
              </button> : assigned.length ? <span>{assigned.map(t => t.name).join(', ')}</span> : roots.has(n.id) ? <span>unassigned</span> : null}
              {n.kind === TASK_KIND && n.statusCategory === 'in_progress' && !runs.some(s => s.live) && <span className="syt-stale">No live session</span>}
              <span title={n.activityAt ?? 'No activity recorded'}>active {since(n.activityAt)}</span>
              {progress && <span className="syt-progress"><Meter progress={progress} thin />{progress.done}/{progress.work} tasks · {pct(progress)}%</span>}
            </div>
          </div>
          {selectedGroup && <div className="syt-related" id={`${uid}-connections-${n.id}`} aria-label={`Connections for ${n.title}`}>
            <div className="syt-related__head"><strong>{kindLabel(connections!.kind, true)} · {selectedGroup.length}</strong>
              <button type="button" className="syt-icon" aria-label="Close connections" onClick={() => { setConnections(null); moveFocus(n.id); }}>×</button></div>
            <ul>{selectedGroup.map(r => <li key={r.key}>
              <KindIcon kind={r.peer.kind} size={14} />
              <button type="button" className="syt-peer" onClick={() => actions.open?.(r.peer.id)}>{r.peer.title}</button>
              <span title={r.direction === 'out' ? `${n.title} → ${r.type} → ${r.peer.title}` : `${r.peer.title} → ${r.type} → ${n.title}`}>
                {r.direction === 'out' ? '→' : '←'} {statusWord(r.type)}</span>
              {(actions.createTask || actions.createDocument) && <button type="button" className="syt-icon" aria-label={`Create under ${r.peer.title}`} onClick={() => create(r.peer.id, actions.createTask ? TASK_KIND : DOCUMENT_KIND)}>+</button>}
              {actions.add && <button type="button" className="syt-icon" aria-label={`Launch on ${r.peer.title}`} onClick={() => onLaunch(r.peer.id)}>▷</button>}
            </li>)}</ul>
          </div>}
          {editor(n.id)}
          {descendants.length > 0 && opened && <div id={childrenId}>{renderList(n.id, depth + 1)}</div>}
          {roots.has(n.id) && roots.get(n.id)!.descendantCount > roots.get(n.id)!.childIds.length && <p className="syt-bound">
            {roots.get(n.id)!.descendantCount} descendants in total · {roots.get(n.id)!.childIds.length} in this story read.
            {actions.open && <button type="button" onClick={() => actions.open!(n.id)}>Open full entity</button>}
          </p>}
        </li>;
      })}
      {children.length > limit && <li className="syt-more"><button type="button" className="stc-btn stc-btn--ghost" onClick={() => {
        const count = Math.min(PAGE_SIZE, children.length - limit);
        setLimits(old => new Map(old).set(parentId, limit + PAGE_SIZE));
        moveFocus(children[limit]!.id);
        setNotice(`Loaded ${count} more entities. ${children.length - limit - count} remaining in this branch.`);
      }}>Show {Math.min(PAGE_SIZE, children.length - limit)} more · {children.length - limit} remaining</button></li>}
    </ul>;
  };
  const list = renderList(view.id, 0);
  const tabs: Array<readonly [string, number]> = [[ALL_KINDS, tree.nodes.size - 1], ...tree.kinds];
  if (!tabs.some(([kind]) => kind === filter.kind)) tabs.push([filter.kind, 0]);
  return <section ref={root} className="syt-workspace stc-card" aria-label="In this story" onKeyDown={e => {
    if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) {
      e.preventDefault(); root.current?.querySelector<HTMLInputElement>('[type=search]')?.focus();
    }
  }}>
    <div className="syt-tabbar">
    <div className="syt-tabs" role="tablist" aria-label="Entity kinds" onKeyDown={e => {
      const i = tabs.findIndex(([kind]) => kind === filter.kind);
      const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return;
      e.preventDefault(); updateFilter({ kind: tabs[next]![0] });
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
    }}>
      {tabs.map(([kind, count]) => <button key={kind} type="button" role="tab" id={`${uid}-tab-${kind}`} aria-controls={`${uid}-panel`}
        aria-selected={filter.kind === kind} tabIndex={filter.kind === kind ? 0 : -1} onClick={() => updateFilter({ kind })}>
        {kind !== ALL_KINDS && <KindIcon kind={kind} size={14} />}{kind === ALL_KINDS ? 'All' : kindLabel(kind, true)}<span>{count}</span>
      </button>)}
    </div>
      <div className="syt-new">
        {actions.createTask && <button type="button" className="stc-btn" data-new-task onClick={() => create(view.id, TASK_KIND)}>+ Task</button>}
        {actions.createDocument && <button type="button" className="stc-btn" onClick={() => create(view.id, DOCUMENT_KIND)}>+ Document</button>}
        {actions.addRoot && actions.searchRoots && <MembershipPicker search={actions.searchRoots} onPick={id => void actions.addRoot!(id).catch(e => setNotice(String(e)))} excludeIds={new Set([view.id, ...roots.keys()])} addLabel="Add existing" />}
      </div>
    </div>
    <div className="syt-toolbar" data-filters-open={filtersOpen}>
      <input type="search" aria-label="Find in this story" placeholder="Find in this story…" value={filter.query} onChange={e => updateFilter({ query: e.target.value })} />
      <button type="button" className="stc-btn stc-btn--ghost syt-filter-toggle" aria-expanded={filtersOpen} aria-controls={`${uid}-filters`} onClick={() => setFiltersOpen(!filtersOpen)}>Filters{filter.status || filter.scope || sort !== 'hierarchy' ? ' · active' : ''}</button>
      <div className="syt-filter-fields" id={`${uid}-filters`}>
      <select aria-label="Filter status" value={filter.status} onChange={e => updateFilter({ status: e.target.value })}>
        <option value="">All statuses</option><option value="blocked">Blocked</option><option value="in_progress">In progress</option>
        <option value="to_do">To do</option><option value="done">Done</option><option value="cancelled">Cancelled</option>
      </select>
      <select aria-label="Filter branch" value={filter.scope} onChange={e => updateFilter({ scope: e.target.value })}>
        <option value="">All branches</option>
        {[...new Map([...view.page.roots, ...view.page.childStories].map(n => [n.id, n])).values()].map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
      </select>
      <select aria-label="Sort siblings" value={sort} onChange={e => setSort(e.target.value)}>
        <option value="hierarchy">Story order</option><option value="title">Title</option><option value="activity">Last activity</option>
      </select>
      </div>
      <button type="button" className="stc-btn stc-btn--ghost" onClick={() => setExpanded(expanded.size ? new Set() : new Set(tree.children.keys()))}>{expanded.size ? 'Collapse all' : 'Expand all'}</button>
    </div>
    {filtered && <p className="syt-scope">{matches.size} matches · parents remain visible. <button type="button" onClick={() => updateFilter(EMPTY_FILTER)}>Clear filters</button></p>}
    {editor(view.id)}
    {draft && draft.parentId !== view.id && !tree.nodes.has(draft.parentId) && editor(draft.parentId)}
    <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${filter.kind}`} tabIndex={0}>
      {visible.size ? list : <div className="stc-empty">{filtered ? 'No matching entities. Try another name or clear the filters.' : 'Put a task or document in this story to get started.'}</div>}
    </div>
    <footer className="syt-footer"><span>{shownCount} of {tree.nodes.size - 1} entities shown</span><span>↳ Hierarchy · chips show connections</span></footer>
    {(view.state.truncated || view.page.follow.truncated) && <p className="syt-bound" role="status">Showing a bounded story read: up to {view.page.follow.limit} entities, {view.page.follow.depth} hops from roots. Search and tabs cover loaded entities. Progress covers the whole story.</p>}
    <div className="syt-notice" role="status" aria-live="polite">{notice}</div>
  </section>;
}
