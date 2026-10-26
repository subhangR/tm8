/**
 * The Projects ＋ in the tab workspace (task 01a13ba3): a project has no
 * generic create, so it is an own-door kind whose draft tab hosts the Add
 * project sheet. Before this the ＋ was muted "Projects can't be created here."
 */
import { describe, expect, it } from 'vitest';
import { canCreateKind, getKindAdapter } from './registry';
import { ProjectDraftBody } from './ProjectDraftBody';

describe('the project door', () => {
  it('is creatable, and its draft body is the Add project sheet host', () => {
    expect(canCreateKind('project')).toBe(true);
    expect(getKindAdapter('project').draftBody).toBe(ProjectDraftBody);
  });
});
