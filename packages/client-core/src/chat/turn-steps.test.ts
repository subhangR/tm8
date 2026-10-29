/**
 * THE ONE STEP CLASSIFIER — pinned for both of its readers: the transcript's
 * step list and the live status row under the conversation. The row imports
 * `describeToolStep` / `toolStepState` exactly as these tests call them.
 */
import { describe, expect, it } from 'vitest';
import {
  describeToolStep,
  groupDone,
  toolStepError,
  toolStepState,
  turnEndSeq,
} from './turn-steps';
import type { ChatTurnPart } from './types';

const TASK_A = '019f0000-0000-7000-8000-00000000000a';
const TASK_B = '019f0000-0000-7000-8000-00000000000b';
const DOC_C = '019f0000-0000-7000-8000-00000000000c';

describe('toolStepState — what the reader sees, not what the last record says', () => {
  it('is running while the call has neither a result nor a terminal record', () => {
    expect(toolStepState({ state: 'running' }, false)).toBe('running');
  });

  it('is completed once the RESULT lands, before the terminal record arrives', () => {
    /* The Claude runtime appends the result and THEN a second tool_call record
       with the terminal state. A call whose result is on screen must not
       still pulse. */
    expect(toolStepState({ state: 'running', result: 'ok' }, false)).toBe('completed');
  });

  it('is error from an isError result even when the state record never came', () => {
    expect(toolStepState({ state: 'running', result: 'Exit code 1', resultIsError: true }, false)).toBe('error');
    expect(toolStepState({ state: 'error' }, false)).toBe('error');
    expect(toolStepState({ state: 'completed', result: 'x', resultIsError: true }, false)).toBe('error');
  });

  it('is stopped, never running, when the turn ended around it', () => {
    // Live: an interrupted turn left a call at `running` forever.
    expect(toolStepState({ state: 'running' }, true)).toBe('stopped');
    // A settled call keeps its real outcome in an ended turn.
    expect(toolStepState({ state: 'completed', result: 'ok' }, true)).toBe('completed');
  });
});

describe('turnEndSeq — a done ends only what came before it', () => {
  it('returns the seq of the last done/error part, -1 without one', () => {
    const parts: ChatTurnPart[] = [
      { seq: 0, kind: 'text', text: 'Looking.' },
      { seq: 1, kind: 'tool_call', toolCallId: 'a', name: 'Bash', args: {}, state: 'running' },
      { seq: 2, kind: 'error', message: 'runtime died' },
      { seq: 3, kind: 'done' },
      // The same message CONTINUES after its first done (seen live).
      { seq: 4, kind: 'tool_call', toolCallId: 'b', name: 'Bash', args: {}, state: 'running' },
    ];
    expect(turnEndSeq(parts)).toBe(3);
    expect(turnEndSeq(parts.slice(0, 2))).toBe(-1);
  });
});

describe('describeToolStep — human words, classified by operation first', () => {
  it('words a shell command with the agent’s own description, never the command', () => {
    const words = describeToolStep('Bash', {
      command: 'curl -H "Authorization: Bearer sk-secret" https://x',
      description: 'Check the deploy endpoint',
    });
    expect(words.active).toBe('Running a shell command');
    expect(words.done).toBe('Ran a shell command');
    expect(words.counted(3)).toBe('Ran 3 commands');
    expect(words.detail).toBe('Check the deploy endpoint');
    expect(JSON.stringify(words)).not.toContain('sk-secret');
  });

  it('words a file read and a file edit with the basename only (D6)', () => {
    expect(describeToolStep('Read', { file_path: '/repo/src/chat-home/TurnParts.tsx' })).toMatchObject({
      active: 'Reading a file',
      done: 'Read TurnParts.tsx',
    });
    expect(describeToolStep('mcp__tm8__repo_edit', { path: 'a/b/ledger.ts' })).toMatchObject({
      category: 'file-edit',
      active: 'Editing a file',
      done: 'Edited ledger.ts',
    });
    expect(describeToolStep('Read', {}).done).toBe('Read a file');
  });

  it('reads a graph call from args.operation, with the kind the call asked for', () => {
    const live = describeToolStep('mcp__tm8__tm8_read', { operation: 'entities.list', query: { kind: 'task' } });
    expect(live.active).toBe('Reading tasks');
    expect(live.category).toBe('graph-read');

    const settled = describeToolStep(
      'mcp__tm8__tm8_read',
      { operation: 'entities.list', query: { kind: 'task' } },
      { items: [{ id: TASK_A, kind: 'task', title: 'A' }, { id: TASK_B, kind: 'task', title: 'B' }] },
    );
    expect(settled.done).toBe('Read 2 tasks');
  });

  it('names a single read entity by its title', () => {
    const words = describeToolStep(
      'mcp__tm8__tm8_read',
      { operation: 'entities.get', params: { id: TASK_A } },
      { entity: { id: TASK_A, kind: 'task', title: 'Ship the step list' } },
    );
    expect(words.done).toBe('Read task “Ship the step list”');
  });

  it('words creates, spawns and status changes from the operation, not the group tool (D6)', () => {
    expect(
      describeToolStep('mcp__tm8__tm8_act', { operation: 'entities.create', body: { kind: 'task', title: 'X' } }),
    ).toMatchObject({ active: 'Creating task “X”', done: 'Created task “X”', category: 'create:task' });
    // No title yet ⇒ the kind, never an id.
    expect(describeToolStep('mcp__tm8__tm8_act', { operation: 'entities.create', body: { kind: 'artifact' } }).active)
      .toBe('Creating an artifact');
    expect(describeToolStep('mcp__tm8__tm8_delegate', { operation: 'execution.spawn' }).active).toBe('Spawning a session');
    expect(
      describeToolStep('mcp__tm8__tm8_delegate', { operation: 'execution.spawn' }, {
        entity: { id: TASK_B, kind: 'work_session', title: 'Worker · provider' },
      }).done,
    ).toBe('Spawned session “Worker · provider”');
    expect(describeToolStep('mcp__tm8__tm8_act', { operation: 'messages.post' }).active).toBe('Posting a message');
  });

  it('names a status move by the title the thread already knows (D6)', () => {
    const complete = { operation: 'entities.commands.complete', params: { id: TASK_A } };
    const labels = new Map([[TASK_A, { kind: 'task', title: 'Ship it' }]]);
    expect(describeToolStep('mcp__tm8__tm8_act', complete, undefined, labels)).toMatchObject({
      active: 'Moving “Ship it” to done',
      done: 'Moved “Ship it” to done',
    });
    // Unknown title: the kind or "an entity" — never the id.
    const bare = describeToolStep('mcp__tm8__tm8_act', complete);
    expect(bare.done).toBe('Moved an entity to done');
    expect(bare.done).not.toContain(TASK_A);
    expect(
      describeToolStep('mcp__tm8__tm8_act', { operation: 'entities.commands.work', params: { id: TASK_A }, body: { status: 'working' } }, undefined, labels).active,
    ).toBe('Moving “Ship it” to working');
    expect(
      describeToolStep('mcp__tm8__tm8_act', { operation: 'entities.patch', params: { id: TASK_A } }, undefined, labels).done,
    ).toBe('Edited “Ship it”');
  });

  it('never words tick or pull as a status move — neither changes a status', () => {
    const labels = new Map([[TASK_A, { kind: 'task', title: 'Ship it' }]]);
    const tick = describeToolStep(
      'mcp__tm8__tm8_act',
      { operation: 'entities.commands.tick', params: { id: TASK_A }, body: { criterionIds: ['c1'], done: true } },
      undefined,
      labels,
    );
    expect(tick).toMatchObject({ active: 'Ticking criteria on “Ship it”', done: 'Ticked criteria on “Ship it”', merges: false });
    const pull = describeToolStep('mcp__tm8__tm8_act', { operation: 'entities.commands.pull', params: { id: TASK_A } }, undefined, labels);
    expect(pull.done).toBe('Updated the graph');
    for (const words of [tick, pull]) {
      expect(`${words.active} ${words.done}`).not.toMatch(/Mov(ing|ed)/);
    }
  });

  it('words doc and artifact tools as creates and edits, not as durable-output cards (D17)', () => {
    expect(describeToolStep('mcp__tm8__doc_create', { title: 'Design — steps', body: '#' }).active)
      .toBe('Creating doc “Design — steps”');
    expect(describeToolStep('mcp__tm8__artifact_create', { title: 'Mock' }).done).toBe('Created artifact “Mock”');
    expect(describeToolStep('mcp__tm8__doc_create', {}).category).toBe('create:doc');
    const labels = new Map([[DOC_C, { kind: 'doc', title: 'Runbook' }]]);
    expect(describeToolStep('mcp__tm8__doc_update', { docId: DOC_C, body: 'x' }, undefined, labels).done)
      .toBe('Edited “Runbook”');
    expect(describeToolStep('mcp__tm8__doc_update', { docId: DOC_C, body: 'x' }).active).toBe('Editing a doc');
  });

  it('never surfaces a tool name (R8), whatever the call', () => {
    const names = [
      'mcp__tm8__tm8_read', 'mcp__tm8__tm8_act', 'mcp__tm8__tm8_delegate', 'mcp__tm8__tm8_messages',
      'mcp__tm8__tm8_overview', 'mcp__tm8__git_branch', 'mcp__tm8__memory_write', 'mcp__tm8__session_tail',
      'mcp__acme__frobnicate_widgets', 'Bash', 'TodoWrite', 'WebFetch',
    ];
    for (const name of names) {
      const words = describeToolStep(name, {});
      const surface = [words.active, words.done, words.counted(2), words.detail ?? ''].join(' | ');
      expect(surface).not.toContain(name);
      expect(surface).not.toMatch(/tm8_|mcp__|frobnicate|TodoWrite|WebFetch|Bash/);
    }
    // An unknown tool is "a step" — never its name (D6).
    expect(describeToolStep('mcp__acme__frobnicate_widgets', {})).toMatchObject({ active: 'Working', done: 'Did a step' });
    // A group tool called without an operation is a directory lookup.
    expect(describeToolStep('mcp__tm8__tm8_act', {}).category).toBe('guide');
  });
});

describe('merges — only reads and shell commands fold (D15)', () => {
  it('lets reads and commands merge, and never a write', () => {
    expect(describeToolStep('Read', {}).merges).toBe(true);
    expect(describeToolStep('Bash', {}).merges).toBe(true);
    expect(describeToolStep('Grep', {}).merges).toBe(true);
    expect(describeToolStep('mcp__tm8__tm8_read', { operation: 'entities.get' }).merges).toBe(true);
    expect(describeToolStep('Edit', {}).merges).toBe(false);
    expect(describeToolStep('mcp__tm8__tm8_act', { operation: 'entities.create', body: { kind: 'task' } }).merges).toBe(false);
    expect(describeToolStep('mcp__tm8__tm8_act', { operation: 'entities.commands.complete' }).merges).toBe(false);
    expect(describeToolStep('mcp__tm8__tm8_delegate', { operation: 'execution.spawn' }).merges).toBe(false);
    expect(describeToolStep('mcp__tm8__tm8_act', { operation: 'messages.post' }).merges).toBe(false);
  });
});

describe('groupDone — one counted line for consecutive settled steps', () => {
  it('counts what graph reads RETURNED, deduped across the group', () => {
    const read = (result: unknown) => describeToolStep('mcp__tm8__tm8_read', { operation: 'entities.get' }, result);
    const line = groupDone([
      read({ entity: { id: TASK_A, kind: 'task', title: 'A' } }),
      read({ entity: { id: TASK_B, kind: 'task', title: 'B' } }),
      read({ entity: { id: TASK_A, kind: 'task', title: 'A' } }),
      read({ entity: { id: DOC_C, kind: 'doc', title: 'C' } }),
    ]);
    expect(line).toBe('Read 2 tasks, 1 doc');
  });

  it('counts calls for every other category, and one step is its own words', () => {
    const cmd = describeToolStep('Bash', { command: 'ls' });
    expect(groupDone([cmd, cmd, cmd])).toBe('Ran 3 commands');
    expect(groupDone([cmd])).toBe('Ran a shell command');
  });
});

describe('toolStepError — one line of reason, never a dump', () => {
  it('takes the first non-empty line of a failed command', () => {
    expect(toolStepError('Exit code 1\n 6464 /private/tmp/…\nmore')).toBe('Exit code 1');
  });

  it('unwraps the provider error tag, MCP text blocks and JSON error envelopes', () => {
    expect(toolStepError('<tool_use_error>File does not exist.</tool_use_error>')).toBe('File does not exist.');
    expect(toolStepError([{ type: 'text', text: '{"error":{"code":"conflict","message":"version conflict"}}' }]))
      .toBe('version conflict');
    expect(toolStepError({ error: 'not allowed' })).toBe('not allowed');
    expect(toolStepError(undefined)).toBeNull();
  });

  it('caps the reason at one short line', () => {
    expect(toolStepError('x'.repeat(500))!.length).toBeLessThanOrEqual(120);
  });
});
