// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { workspaceTabUrl, workspaceTabView } from './url';

describe("Home's Copy link (Craft redesign §2: /home is canonical)", () => {
  it('names /home with the active tab, and the bare /home without one', () => {
    expect(workspaceTabUrl('sp-a', 'task-4f8c2a9e')).toMatch(/#\/s\/sp-a\/home\?tab=task-4f8c2a9e$/);
    expect(workspaceTabUrl('sp-a')).toMatch(/#\/s\/sp-a\/home$/);
  });

  it('routes to the tabs view', () => {
    expect(workspaceTabView('task-4f8c2a9e')).toEqual({ view: 'tabs', tab: 'task-4f8c2a9e' });
  });
});
