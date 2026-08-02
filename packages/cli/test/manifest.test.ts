/**
 * The manifest reader's contract is TOLERANCE. SpawnService composes this file
 * moments before the PTY starts; if the reader is strict, every field the
 * composer adds or renames turns a spawned terminal into a stack trace, and
 * the operator sees "the agent didn't boot" rather than "one field moved".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseManifest, readManifest } from '../src/manifest.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/manifest.sample.json', import.meta.url));

describe('parseManifest', () => {
  it('preserves launch authorization facts needed to recompose a plan prompt', () => {
    expect(
      parseManifest({
        sessionId: 'ws_plan',
        launch: { tool: 'codex', permissionMode: 'readOnly', accessMode: 'plan' },
      }).launch,
    ).toEqual({ tool: 'codex', permissionMode: 'readOnly', accessMode: 'plan' });
  });

  it('reads every field the CLI consumes from the sample manifest', () => {
    const m = readManifest(FIXTURE);
    expect(m.sessionId).toBe('ws_01HZPHOENIXSESSION');
    expect(m.spaceId).toBe('sp_01HZDEMOSPACE');
    expect(m.mode).toBe('coordinated-worker');
    expect(m.agent?.teamMemberId).toBe('tm_01HZPHOENIX');
    expect(m.agent?.name).toBe('Phoenix');
    expect(m.agent?.memory).toEqual(['The PTY host runs under node, never bun.']);
    expect(m.project?.workingDir).toBe('/Users/subhang/Desktop/Projects/tm8');
    expect(m.tasks?.[0]?.id).toBe('ent_01HZTASKONE');
    expect(m.coordinator?.sessionId).toBe('ws_01HZORION');
    expect(m.directive?.subject).toContain('lane 4');
    expect(m.skills?.[0]?.name).toBe('reporting-discipline');
    expect(m.promptExtra).toContain('501');
  });

  it('ignores fields it does not know — the composer may run ahead of the reader', () => {
    const m = parseManifest({
      sessionId: 'ws_1',
      spells: [{ id: 'sp_1' }],
      launchConfig: { model: 'opus' },
      agent: { name: 'A', unknownField: 42 },
    });
    expect(m.sessionId).toBe('ws_1');
    expect(m.agent?.name).toBe('A');
    expect(Object.keys(m)).not.toContain('spells');
  });

  it('degrades a malformed sub-object to undefined instead of throwing', () => {
    const m = parseManifest({ sessionId: 'ws_1', agent: 'not-an-object', tasks: 'nope', mode: 'wizard' });
    expect(m.sessionId).toBe('ws_1');
    expect(m.agent).toBeUndefined();
    expect(m.tasks).toBeUndefined();
    expect(m.mode).toBeUndefined(); // unknown mode falls back at compose time
  });

  it('drops tasks with no id rather than emitting a task the agent cannot address', () => {
    const m = parseManifest({ tasks: [{ title: 'orphan' }, { id: 'ent_1', title: 'real' }] });
    expect(m.tasks).toHaveLength(1);
    expect(m.tasks?.[0]?.id).toBe('ent_1');
  });

  it('survives an empty object and a non-object', () => {
    expect(parseManifest({})).toEqual({});
    expect(parseManifest(null)).toEqual({});
    expect(parseManifest('nope')).toEqual({});
  });

  it('names the path when the file is missing — the operator needs to know WHICH file', () => {
    expect(() => readManifest('/nonexistent/manifest.json')).toThrow(/\/nonexistent\/manifest\.json/);
  });

  it('rejects non-JSON with a usage exit code, not a crash', () => {
    expect(() => readManifest(fileURLToPath(new URL('./fixtures/not-json.txt', import.meta.url))))
      .toThrow(/not valid JSON/);
  });

  it('the sample fixture is valid JSON on disk (it is the shape Draco reconciles against)', () => {
    expect(() => JSON.parse(readFileSync(FIXTURE, 'utf8'))).not.toThrow();
  });
});
