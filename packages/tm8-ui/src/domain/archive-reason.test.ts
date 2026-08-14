/**
 * Archive's refusal must name the mechanism, not a permission.
 *
 * For `work_session`, `project`, `member`, `message` and `interaction_profile`
 * the facade answers `canDelete: false` for everyone — the rule never reads the
 * viewer's role. Saying "you do not have permission" sends the reader looking
 * for a role that would grant it, and there is none: the node owner sees the
 * same refusal. D15 asks for the mechanism instead.
 */
import { describe, expect, it } from 'vitest';
import type { ActionContext, EntityCapabilities, EntityId, SpaceId } from './types';
import { REASONS, resolveAction } from './actions';

const CAPS = (canDelete: boolean): EntityCapabilities => ({
  canEdit: true,
  canDelete,
  canAddChild: false,
  canLink: true,
  canPull: false,
  canReact: true,
  canGrantPoints: false,
  canComplete: false,
});

const ctx = (kind: ActionContext['kind'], canDelete: boolean): ActionContext => ({
  spaceId: 'space-1' as SpaceId,
  entityId: 'entity-1' as EntityId,
  ...(kind ? { kind } : {}),
  capabilities: CAPS(canDelete),
});

const archiveOn = (kind: ActionContext['kind'], canDelete: boolean) =>
  resolveAction('archive').availability(ctx(kind, canDelete));

describe('archive names the mechanism for kinds nobody can archive', () => {
  it('points a session at Terminate rather than at a permission', () => {
    const verdict = archiveOn('work_session', false);
    expect(verdict.kind).toBe('disabled');
    const reason = verdict.kind === 'disabled' ? verdict.reason : '';
    expect(reason).toContain('Terminate');
    expect(reason).not.toBe(REASONS.cannotArchive);
  });

  it('points a project at unlinking', () => {
    const verdict = archiveOn('project', false);
    expect(verdict.kind === 'disabled' && verdict.reason).toContain('unlink');
  });

  it('refuses a session the same way even when capabilities claim canDelete', () => {
    // The structural gate runs ahead of the capability read: the kind decides.
    const verdict = archiveOn('work_session', true);
    expect(verdict.kind).toBe('disabled');
  });

  it('leaves genuinely permission-shaped refusals alone', () => {
    // A task IS archivable in principle, so canDelete false really is about the
    // viewer, and the permission wording is the honest one.
    const verdict = archiveOn('task', false);
    expect(verdict.kind === 'disabled' && verdict.reason).toBe(REASONS.cannotArchive);
  });

  it('still permits archiving a task the viewer may delete', () => {
    expect(archiveOn('task', true).kind).toBe('available');
  });
});
