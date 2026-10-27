import { describe, expect, it } from 'vitest';
import { launchedByOf, treeParentOf } from './launched-by';

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
});
