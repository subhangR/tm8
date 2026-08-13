/**
 * TEST CASE 3 — a vanilla terminal is not silently dropped by an allow-list.
 *
 * This is the edge case `contract.ts`'s `sessionKind` comment predicts by name,
 * and it is worth a file of its own because of HOW it fails: nothing throws,
 * nothing logs, and every existing test stays green. A session exists, the
 * server returns it, and one surface just does not draw it. The symptom reaches
 * a human as "my terminal disappeared", which is nearly untraceable back to a
 * `=== 'agent'` in a filter.
 *
 * `projectRows` is the ONE place this app filters session rows —
 * `isCredentialLoginSession`'s docstring says so and gives the reason — so a
 * test here covers every panel, roster and future surface that draws through
 * it. The three rows below are the three states the field can be in, and the
 * absent one is not padding: a node predating 083, or a payload cached before
 * the column shipped, carries no `sessionKind` at all, and it is the row an
 * allow-list drops FIRST.
 */
import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { projectRows } from './domain-store.js';
import { SPACE, summary } from './test-support.js';

function session(id: string, state: Record<string, unknown>): EntitySummary {
  return summary(id, {
    kind: 'work_session',
    title: id,
    state: {
      kind: 'work_session',
      status: 'running',
      shareMode: 'none',
      startedAt: null,
      exitedAt: null,
      ...state,
    } as EntitySummary['state'],
  });
}

const AGENT = session('ws_agent', { agentTool: 'claude-code', model: 'opus', sessionKind: 'agent' });
/** Pre-083 / stale payload. Absence is load-bearing and means VISIBLE. */
const LEGACY = session('ws_legacy', { agentTool: 'codex', model: null });
const SHELL = session('ws_shell', { agentTool: null, model: null, sessionKind: 'shell' });
const CREDENTIAL = session('ws_login', { agentTool: null, model: null, sessionKind: 'credential' });

const ALL = [AGENT, LEGACY, SHELL, CREDENTIAL];
const entities = Object.fromEntries(ALL.map((row) => [row.id, row]));

describe('the session row filter is a deny-list, and a vanilla terminal survives it', () => {
  it('keeps a shell session in a page the server already returned', () => {
    const rows = projectRows({
      ordered: ALL.map((row) => row.id),
      entities,
      kind: 'work_session',
      spaceId: SPACE,
      filter: undefined,
    });
    expect(rows.map((row) => row.id)).toEqual(['ws_agent', 'ws_legacy', 'ws_shell']);
  });

  it('keeps a shell session that ARRIVED on the event stream, unread by any query', () => {
    // The other half of the same filter, and the half a page-only test misses:
    // a terminal the member just started reaches the list through the arrivals
    // branch, not through `ordered`.
    const rows = projectRows({
      ordered: [],
      entities,
      kind: 'work_session',
      spaceId: SPACE,
      filter: undefined,
    });
    expect(rows.map((row) => row.id)).toContain('ws_shell');
    expect(rows.map((row) => row.id)).not.toContain('ws_login');
  });

  it('hides ONLY the private login terminal — never the shell, never the unlabelled row', () => {
    const rows = projectRows({
      ordered: ALL.map((row) => row.id),
      entities,
      kind: 'work_session',
      spaceId: SPACE,
      filter: undefined,
    });
    const hidden = ALL.filter((row) => !rows.some((kept) => kept.id === row.id));
    // Asserted as the COMPLETE hidden set rather than "shell is present": the
    // latter passes unchanged the day a fourth kind is added and dropped.
    expect(hidden.map((row) => row.id)).toEqual(['ws_login']);
  });

  it('a null agentTool is not, by itself, grounds for hiding anything', () => {
    // The other half of the trap. `agentTool` is nullable on every session, and
    // a filter written as `Boolean(state.agentTool)` would hide vanilla
    // terminals without ever mentioning `sessionKind`.
    const rows = projectRows({
      ordered: ['ws_shell'],
      entities: { ws_shell: SHELL },
      kind: 'work_session',
      spaceId: SPACE,
      filter: undefined,
    });
    expect(rows).toHaveLength(1);
  });
});
