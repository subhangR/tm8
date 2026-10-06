// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { workspaceTabUrl, workspaceTabView } from './url';

describe("Work's Copy link (D31: /work is canonical)", () => {
  it('names /work with the active tab, and the bare /work without one', () => {
    expect(workspaceTabUrl('sp-a', 'task-4f8c2a9e')).toMatch(/#\/s\/sp-a\/work\?tab=task-4f8c2a9e$/);
    expect(workspaceTabUrl('sp-a')).toMatch(/#\/s\/sp-a\/work$/);
  });

  it('routes to the tabs view', () => {
    expect(workspaceTabView('task-4f8c2a9e')).toEqual({ view: 'tabs', tab: 'task-4f8c2a9e' });
  });
});
