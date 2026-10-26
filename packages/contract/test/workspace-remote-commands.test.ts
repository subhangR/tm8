/**
 * The remote vocabulary (`WORKSPACE_REMOTE_COMMANDS`, the `workspace.command`
 * enum) against the shared command list: a new command is either nameable by
 * an agent or deliberately forbidden, never silently missing (File tabs
 * shipped `workspace.files.open` without it).
 */
import { describe, expect, it } from 'vitest';
import { WORKSPACE_REMOTE_COMMANDS, WorkspaceCommandInputSchema } from '../src/workspace-bridge.js';
import {
  COMMAND_NAMES,
  defaultWorkspaceState,
  reduce,
  REMOTE_FORBIDDEN,
  type WorkspaceHooks,
} from '../src/workspace/index.js';

function hooks(): WorkspaceHooks {
  let n = 0;
  return {
    deleteDraft: () => {},
    draftRevision: () => 0,
    toast: () => {},
    captureUi: () => undefined,
    canCreate: () => true,
    newId: () => `t${++n}`,
    openEntity: () => {},
    focusDraft: () => {},
    openDialog: () => ({ status: 'rejected', reason: 'dialog_unavailable' }),
    closeDialog: () => ({ status: 'rejected', reason: 'dialog_unavailable' }),
    showWorkspace: () => ({ status: 'rejected', reason: 'view_unavailable' }),
    viewMounted: () => true,
    userTyping: () => false,
  };
}

describe('workspace remote commands', () => {
  it('every command is remote-nameable or remote-forbidden', () => {
    const remote = new Set<string>(WORKSPACE_REMOTE_COMMANDS);
    expect(COMMAND_NAMES.filter((name) => !remote.has(name) && !REMOTE_FORBIDDEN.has(name))).toEqual([]);
  });

  it('names nothing the workspace does not know', () => {
    const known = new Set<string>(COMMAND_NAMES);
    expect(WORKSPACE_REMOTE_COMMANDS.filter((name) => !known.has(name))).toEqual([]);
  });

  it('workspace.command accepts workspace.files.open', () => {
    const parsed = WorkspaceCommandInputSchema.safeParse({
      requestId: 'req-files-open',
      command: 'workspace.files.open',
      args: { projectId: 'p1', path: 'src/a.ts', preview: false },
    });
    expect(parsed.success).toBe(true);
  });

  it('an agent workspace.files.open opens a kept tab, then focuses it', () => {
    const h = hooks();
    const args = { projectId: 'p1', path: 'src/a.ts', preview: false };
    const first = reduce(defaultWorkspaceState('space-remote'), { command: 'workspace.files.open', args, source: 'remote' }, h);
    expect(first.result).toMatchObject({ status: 'applied', outcome: 'created', tabId: 't1' });
    expect(first.state.tabs.t1).toEqual({ id: 't1', type: 'file', projectId: 'p1', path: 'src/a.ts', preview: false });
    const again = reduce(first.state, { command: 'workspace.files.open', args, source: 'remote' }, h);
    expect(again.result).toMatchObject({ status: 'no_op', outcome: 'focused', tabId: 't1' });
  });

  it('workspace.rail.set stays the human’s: not nameable, and refused from remote', () => {
    expect(WorkspaceCommandInputSchema.safeParse({ requestId: 'req-rail', command: 'workspace.rail.set', args: {} }).success).toBe(false);
    const r = reduce(defaultWorkspaceState('space-remote'), { command: 'workspace.rail.set', args: {}, source: 'remote' }, hooks());
    expect(r.result).toMatchObject({ status: 'rejected', reason: 'permission_denied' });
  });
});
