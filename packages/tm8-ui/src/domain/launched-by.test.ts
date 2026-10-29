import { describe, expect, it } from 'vitest';
import { launchedByCrumb, launchedByOf, launcherKindsOf, launcherTitlesOf, treeParentOf } from './launched-by';

describe('launched-by (330)', () => {
  it('reads the launcher off a session state, and nothing else', () => {
    expect(launchedByOf({ kind: 'work_session', launchedBy: 'chat-1' })).toBe('chat-1');
    expect(launchedByOf({ kind: 'work_session', launchedBy: null })).toBeNull();
    expect(launchedByOf({ kind: 'task' })).toBeNull();
    expect(launchedByOf(null)).toBeNull();
  });

  it('nests a session under its launcher, and every other row under its parent', () => {
    expect(treeParentOf({ parentId: null, state: { kind: 'work_session', launchedBy: 'ses-1' } } as never)).toBe('ses-1');
    // A pre-330 node: no launchedBy, the legacy parent still nests it.
    expect(treeParentOf({ parentId: 'ses-0', state: { kind: 'work_session' } } as never)).toBe('ses-0');
    expect(treeParentOf({ parentId: 'task-1', state: { kind: 'task' } } as never)).toBe('task-1');
    expect(treeParentOf({ parentId: null, state: { kind: 'task' } } as never)).toBeNull();
  });

  it('a session can be launched by a session or a chat, read off the registry', () => {
    expect(launcherKindsOf('work_session')[0]).toBe('work_session');
    expect(launcherKindsOf('work_session')).toContain('chat');
  });

  it('names launchers from the rows held, then ONE idIn read per launcher kind for the rest (task 01a182c8)', () => {
    const ses = (id: string, title: string, launchedBy: string | null = null) =>
      ({ id, title, state: { kind: 'work_session', launchedBy } }) as never;
    const rows = [ses('w-1', 'Worker one', 'coord'), ses('w-2', 'Worker two', 'chat-1'), ses('coord', 'Coordinator')];
    const asks: Array<[string, unknown]> = [];
    const titles = launcherTitlesOf(rows, 'work_session', (kind) => (filter) => {
      asks.push([kind, filter]);
      return kind === 'chat' ? [{ id: 'chat-1', title: 'Planning chat' } as never, { id: 'stray', title: 'Not asked' } as never] : [];
    });
    expect(titles.get('coord')).toBe('Coordinator');
    expect(titles.get('chat-1')).toBe('Planning chat');
    expect(titles.has('stray')).toBe(false);
    // Only the launcher no held row named is read, once per kind.
    expect(asks).toEqual([['work_session', { idIn: ['chat-1'] }], ['chat', { idIn: ['chat-1'] }]]);
  });

  it('asks the next launcher kind only for the ids the previous one did not name', () => {
    const rows = [{ id: 'w-1', title: 'Worker', state: { kind: 'work_session', launchedBy: 'coord' } }] as never[];
    const asks: string[] = [];
    const titles = launcherTitlesOf(rows, 'work_session', (kind) => () => {
      asks.push(kind);
      return kind === 'work_session' ? [{ id: 'coord', title: 'Coordinator' } as never] : [];
    });
    expect(titles.get('coord')).toBe('Coordinator');
    expect(asks).toEqual(['work_session']);
  });

  it('crumbs a launched row only, with the short id when no read named the launcher', () => {
    const titles = new Map([['coord', 'Coordinator']]);
    expect(launchedByCrumb({ kind: 'work_session', launchedBy: 'coord' }, titles)).toBe('↳ launched by Coordinator');
    expect(launchedByCrumb({ kind: 'work_session', launchedBy: '01a182b3-9d0e' }, titles)).toBe('↳ launched by 01a182b3…');
    expect(launchedByCrumb({ kind: 'work_session', launchedBy: null }, titles)).toBeNull();
  });
});
