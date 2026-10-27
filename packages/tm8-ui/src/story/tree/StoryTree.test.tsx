// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { StoryTree } from './StoryTree';
import { filterTree, storyTree, ALL_KINDS, kindLabel } from './model';
import { EMPTY_PROGRESS, emptyPage, type StoryNode, type StoryView } from '../model';

afterEach(cleanup);
const node = (id: string, kind = 'task', title = id): StoryNode => ({
  id, kind, title, status: 'working', statusCategory: 'in_progress', blocked: false,
  depth: 0, rootIds: [], activityAt: '2026-10-04T00:00:00Z', createdAt: '2026-10-01T00:00:00Z',
});
function fixture(count = 100): StoryView {
  const page = emptyPage();
  page.nodes = [node('root', 'story', 'A story branch'), ...Array.from({ length: count }, (_, i) => node(`task-${i}`, 'task', `Task ${i}`)), node('doc', 'doc', 'The reference')];
  page.edges = page.nodes.slice(1).map(n => ({ id: null, fromId: 'root', toId: n.id, type: 'parent', family: 'parent', cross: false, rootIds: [] }));
  page.roots = [{ ...node('root', 'story', 'A story branch'), position: 0, progress: EMPTY_PROGRESS,
    taskProgress: { ...EMPTY_PROGRESS, work: 100, done: 34, inProgress: 66 }, descendantCount: count + 1,
    childIds: page.nodes.slice(1).map(n => n.id), trail: [] }];
  return { id: 'story', version: 1, title: 'Our story', description: '', status: 'working', statusCategory: 'in_progress',
    state: { kind: 'story', rootCount: 1, itemCount: count + 2, truncated: false, progress: EMPTY_PROGRESS,
      taskProgress: EMPTY_PROGRESS, rollup: EMPTY_PROGRESS, liveSessionCount: 0, pendingAttentionCount: 0, lastActivityAt: null, childStoryCount: 0 },
    page, people: {}, feed: [] };
}
const actions = () => ({ open: vi.fn(), createTask: vi.fn().mockResolvedValue('created'), createDocument: vi.fn().mockResolvedValue('created-doc'), add: vi.fn() });

describe('Story tree', () => {
  it('bounds siblings, exposes branch counts, and focuses and announces the next page', () => {
    const ui = render(<StoryTree view={fixture(125)} actions={actions()} onLaunch={vi.fn()} />);
    expect(ui.container.querySelectorAll('[data-tree-title]')).toHaveLength(1);
    fireEvent.click(ui.getByRole('button', { name: 'Expand A story branch' }));
    expect(ui.container.querySelectorAll('[data-tree-title]')).toHaveLength(26);
    fireEvent.click(ui.getByRole('button', { name: 'Show 25 more · 101 remaining' }));
    expect(document.activeElement?.textContent).toBe('Task 25');
    expect(ui.getByRole('status').textContent).toContain('Loaded 25 more entities');
    expect(ui.container.querySelectorAll('[data-tree-title]')).toHaveLength(51);
  });

  it('finds a late child and retains its hierarchy; status filters never change progress', () => {
    const view = fixture(125);
    view.page.nodes.find(n => n.id === 'task-124')!.blocked = true;
    const ui = render(<StoryTree view={view} actions={actions()} onLaunch={vi.fn()} />);
    fireEvent.change(ui.getByRole('searchbox'), { target: { value: 'Task 124' } });
    expect(ui.getByRole('button', { name: 'Task 124' })).toBeTruthy();
    expect(ui.getByRole('button', { name: 'A story branch' })).toBeTruthy();
    fireEvent.change(ui.getByLabelText('Filter status'), { target: { value: 'blocked' } });
    expect(ui.getByText('34/100 tasks · 34%')).toBeTruthy();
    expect(ui.container.querySelectorAll('[data-tree-title]')).toHaveLength(2);
  });

  it('retains typed draft and kind across filters, sorting, collapse and a live rerender', async () => {
    const ports = actions();
    const view = fixture();
    const ui = render(<StoryTree view={view} actions={ports} onLaunch={vi.fn()} />);
    fireEvent.click(ui.getByRole('button', { name: 'Expand A story branch' }));
    fireEvent.click(ui.getByRole('button', { name: 'Create under Task 3' }));
    fireEvent.change(ui.getByLabelText('New entity title'), { target: { value: 'Retain this draft' } });
    fireEvent.change(ui.getByLabelText('Entity kind'), { target: { value: 'doc' } });
    fireEvent.click(ui.getByRole('tab', { name: /Documents/ }));
    fireEvent.change(ui.getByRole('searchbox'), { target: { value: 'reference' } });
    fireEvent.change(ui.getByLabelText('Sort siblings'), { target: { value: 'title' } });
    fireEvent.change(ui.getByLabelText('Filter status'), { target: { value: 'done' } });
    fireEvent.change(ui.getByLabelText('Filter branch'), { target: { value: 'root' } });
    fireEvent.click(ui.getByRole('button', { name: 'Collapse all' }));
    ui.rerender(<StoryTree view={{ ...view, version: 2, page: { ...view.page, nodes: [...view.page.nodes] } }} actions={ports} onLaunch={vi.fn()} />);
    expect((ui.getByLabelText('New entity title') as HTMLInputElement).value).toBe('Retain this draft');
    expect((ui.getByLabelText('Entity kind') as HTMLSelectElement).value).toBe('doc');
    fireEvent.click(ui.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(ports.createDocument).toHaveBeenCalledWith('task-3', 'Retain this draft'));
    expect(ports.createTask).not.toHaveBeenCalled();
  });

  it.each(['doc', 'drawing', 'memory', 'pull_request', 'commit', 'custom_kind'].flatMap(kind => ['task', 'doc'].map(draftKind => [kind, draftKind])))('reveals creation on a filtered-out %s connection with a %s draft', (kind, draftKind) => {
    const view = fixture(1);
    view.page.nodes.push(node('peer', kind, 'Connected peer'));
    view.page.edges.push({ id: 'link', fromId: 'task-0', toId: 'peer', type: 'custom_relation', family: 'parent', cross: false, rootIds: [] });
    const ui = render(<StoryTree view={view} actions={actions()} onLaunch={vi.fn()} />);
    fireEvent.click(ui.getByRole('tab', { name: /^Tasks/ }));
    const row = ui.container.querySelector('[data-tree-node="task-0"]')!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: `1 linked ${kindLabel(kind, true)} for Task 0` }));
    fireEvent.click(ui.getByRole('button', { name: 'Create under Connected peer' }));
    expect(document.activeElement).toBe(ui.getByLabelText('New entity title'));
    fireEvent.change(ui.getByLabelText('Entity kind'), { target: { value: draftKind } });
    expect((ui.getByLabelText('Entity kind') as HTMLSelectElement).value).toBe(draftKind);
    expect(ui.getByRole('form', { name: 'Create entity' }).textContent).toContain('Connected peer');
    expect(ui.getByRole('tab', { name: /^All/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps all relationship kinds, directions and absent endpoints accessible', () => {
    const view = fixture(1);
    const kinds = ['doc', 'drawing', 'artifact', 'file', 'form', 'memory', 'pull_request', 'commit', 'member', 'team_member', 'skill', 'project', 'custom_kind'];
    for (const kind of kinds) {
      view.page.nodes.push(node(kind, kind));
      view.page.edges.push({ id: kind, fromId: kind, toId: 'root', type: `custom_${kind}`, family: 'parent', cross: false, rootIds: [] });
    }
    view.page.edges.push({ id: 'outside', fromId: 'root', toId: 'outside-page', type: 'linked', family: 'parent', cross: false, rootIds: [] });
    const tree = storyTree(view);
    expect([...tree.relations.get('root')!.keys()]).toEqual(expect.arrayContaining([...kinds, 'entity']));
    expect(tree.relations.get('root')!.get('memory')![0]!.direction).toBe('in');
    const ui = render(<StoryTree view={view} actions={actions()} onLaunch={vi.fn()} />);
    fireEvent.click(ui.getByRole('button', { name: '1 linked entity for A story branch' }));
    expect(ui.getByRole('button', { name: 'outside-page' })).toBeTruthy();
  });

  it('navigates by keyboard and passes each exact launch subject', () => {
    const launch = vi.fn();
    const ports = actions();
    const ui = render(<StoryTree view={fixture(2)} actions={ports} onLaunch={launch} />);
    const root = ui.getByRole('button', { name: 'A story branch' });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Task 0');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(root);
    fireEvent.click(ui.getByRole('button', { name: 'Launch on Task 0' }));
    expect(launch).toHaveBeenCalledWith('task-0');
    fireEvent.click(ui.getByRole('button', { name: 'Task 0' }));
    expect(ports.open).toHaveBeenCalledWith('task-0');
  });

  it('retains a refused draft and prevents a duplicate pending submission', async () => {
    let reject!: (e: Error) => void;
    const ports = actions();
    ports.createTask.mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const ui = render(<StoryTree view={fixture()} actions={ports} onLaunch={vi.fn()} />);
    fireEvent.click(ui.getByRole('button', { name: '+ Task' }));
    fireEvent.change(ui.getByLabelText('New entity title'), { target: { value: 'Keep me' } });
    fireEvent.submit(ui.getByRole('form', { name: 'Create entity' }));
    fireEvent.submit(ui.getByRole('form', { name: 'Create entity' }));
    expect(ports.createTask).toHaveBeenCalledTimes(1);
    reject(new Error('Permission denied'));
    await waitFor(() => expect(ui.getByRole('alert').textContent).toBe('Permission denied'));
    expect((ui.getByLabelText('New entity title') as HTMLInputElement).value).toBe('Keep me');
  });

  it('renders cyclic and shared input once and admits every ancestor of a match', () => {
    const view = fixture(1);
    view.page.edges.push({ id: null, fromId: 'task-0', toId: 'root', type: 'parent', family: 'parent', cross: false, rootIds: [] });
    const tree = storyTree(view);
    const found = filterTree(tree, view.id, { kind: ALL_KINDS, query: 'Task 0', status: '', scope: '' });
    expect([...found.visible]).toEqual(['task-0', 'root']);
    expect(tree.parents.get('root')).toBe(view.id);
  });
});
