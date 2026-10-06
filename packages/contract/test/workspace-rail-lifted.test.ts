/** `workspace.rail.set` carries `lifted` — kinds drawn first in the rail list, newest unpin first (rail fixes, 2026-10-07). */
import { describe, expect, it } from 'vitest';
import { defaultWorkspaceState, sanitizeWorkspaceState, workspaceCommands, type CommandEnvelope, type PlanContext } from '../src/workspace/index.js';

const SPACE = 'space-lifted';
const plan = (state: PlanContext['state'], args: unknown) =>
  workspaceCommands.rail.setRail({ state, env: { command: 'workspace.rail.set', args, source: 'click' } as CommandEnvelope } as PlanContext);

describe('workspace.rail.set lifted', () => {
  it('stores lifted with the pins, de-duplicated, and keeps it across other patches', () => {
    const first = plan(defaultWorkspaceState(SPACE), { pins: ['chat'], lifted: ['task', 'project', 'task'] });
    expect(first.type).toBe('commit');
    const state = (first as { next: PlanContext['state'] }).next;
    expect(state.rail).toMatchObject({ pins: ['chat'], lifted: ['task', 'project'] });
    const second = plan(state, { expanded: true });
    expect((second as { next: PlanContext['state'] }).next.rail?.lifted).toEqual(['task', 'project']);
  });

  it('rejects a lifted that is not a list of kind ids', () => {
    expect(plan(defaultWorkspaceState(SPACE), { lifted: 'task' }).type).toBe('reject');
    expect(plan(defaultWorkspaceState(SPACE), { lifted: [''] }).type).toBe('reject');
  });

  it('survives the stored-state sanitizer; an old stored rail without it stays without it', () => {
    const base = defaultWorkspaceState(SPACE);
    const kept = sanitizeWorkspaceState({ ...base, rail: { pins: [], open: {}, expanded: false, lifted: ['doc', 'doc', 7] } }, SPACE);
    expect(kept?.rail?.lifted).toEqual(['doc']);
    const old = sanitizeWorkspaceState({ ...base, rail: { pins: [], open: {}, expanded: false } }, SPACE);
    expect(old?.rail && 'lifted' in old.rail).toBe(false);
  });
});
