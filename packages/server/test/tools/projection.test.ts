import { describe, expect, it } from 'vitest';
import { ToolRunSchema, ToolViewSchema, type ActorSummary } from '@tm8/contract';
import { TOOL_CONTENT_SQL, projectToolLastRun, projectToolView, toolLastRunSql, toolRunView } from '../../src/tools/projection.js';
import { RUN_SELECT } from '../../src/tools/views.js';

const TOOL = '00000000-0000-4000-8000-000000000001', SPACE = '00000000-0000-4000-8000-000000000002';
const RUN = '00000000-0000-4000-8000-000000000010', LOOP = '00000000-0000-4000-8000-000000000020';
const definition = { name: 'url-check', description: '', help: '', runtime: 'bash' as const, source: 'exit 0\n', inputs: [], tm8Access: 'none' as const, timeoutSeconds: 30 };
const runRow = {
  id: RUN, space_id: SPACE, parent_id: null, tool_id: TOOL, tool_version: 3, tool_source_sha256: 'a'.repeat(64),
  tool_inputs: {}, tool_state: 'exited' as const, tool_keep_open: false, tool_exit_code: 0,
  tool_started_at: new Date('2026-10-28T10:00:00Z'), tool_exited_at: new Date('2026-10-28T10:00:02Z'), tool_output_tail: 'ok\n',
};

describe('tool run view: who fired it', () => {
  it('names the loop behind a provenance-marked triggered_by edge, and null when the row carries none', () => {
    const fired = toolRunView({ ...runRow, triggered_by_id: LOOP, triggered_by_title: 'Nightly check' });
    expect(fired.triggeredBy).toEqual({ id: LOOP, title: 'Nightly check' });
    expect(ToolRunSchema.parse(fired).triggeredBy).toEqual({ id: LOOP, title: 'Nightly check' });
    expect(toolRunView({ ...runRow, triggered_by_id: null, triggered_by_title: null }).triggeredBy).toBeNull();
  });
  it('keeps a deleted or unreadable loop as an id without a title', () => {
    expect(toolRunView({ ...runRow, triggered_by_id: LOOP, triggered_by_title: null }).triggeredBy).toEqual({ id: LOOP, title: null });
  });
  it('leaves triggeredBy out of projections that never selected it, so older event rows still parse', () => {
    const view = toolRunView(runRow);
    expect(view).not.toHaveProperty('triggeredBy');
    expect(ToolRunSchema.safeParse(view).success).toBe(true);
    expect(view.startedAt).toBe('2026-10-28T10:00:00.000Z');
  });
  it('reads only the server-written marker (347): an unmarked triggered_by edge is run history, not an authority', () => {
    expect(RUN_SELECT).toContain("g.type='triggered_by'");
    expect(RUN_SELECT).toContain("g.props->>'provenance'='true'");
  });
});

describe('tool view: the newest run', () => {
  const actors = new Map<string, ActorSummary>();
  const row = { id: TOOL, space_id: SPACE, version: 4 };
  const content = { definition, execution_version: 2, config_revision: 1, config: {}, secretBindings: [] };
  it('projects lastRun with ISO timestamps and a numeric exit code, as Postgres hands jsonb up', () => {
    expect(projectToolLastRun({ sessionId: RUN, state: 'exited', exitCode: '1' as unknown as number, startedAt: new Date('2026-10-28T10:00:00Z'), exitedAt: '2026-10-28T10:00:02.000Z' }))
      .toEqual({ sessionId: RUN, state: 'exited', exitCode: 1, startedAt: '2026-10-28T10:00:00.000Z', exitedAt: '2026-10-28T10:00:02.000Z' });
    expect(projectToolLastRun(null)).toBeNull();
  });
  it('carries lastRun on the view when the summary selected it, null when the tool never ran', () => {
    const ran = projectToolView({ ...row, tool_content: { ...content, lastRun: { sessionId: RUN, state: 'running', exitCode: null, startedAt: '2026-10-28T10:00:00Z', exitedAt: null } } }, actors);
    expect(ran.lastRun).toEqual({ sessionId: RUN, state: 'running', exitCode: null, startedAt: '2026-10-28T10:00:00.000Z', exitedAt: null });
    expect(ToolViewSchema.safeParse(ran).success).toBe(true);
    expect(projectToolView({ ...row, tool_content: { ...content, lastRun: null } }, actors).lastRun).toBeNull();
  });
  it('leaves lastRun out of a summary projected before Tools v2 selected it', () => {
    const older = projectToolView({ ...row, tool_content: content }, actors);
    expect(older).not.toHaveProperty('lastRun');
    expect(ToolViewSchema.safeParse(older).success).toBe(true);
  });
  it('is one SQL fragment for the entity summary, the event projection and tools.get', () => {
    expect(TOOL_CONTENT_SQL).toContain(`'lastRun',${toolLastRunSql('e.id')}`);
    expect(toolLastRunSql('$1::uuid')).toContain("rw.session_kind='tool'");
    expect(toolLastRunSql('$1::uuid')).toContain('internal.entity_readable(re.id)');
    expect(toolLastRunSql('$1::uuid')).toContain('order by rw.entity_id desc limit 1');
  });
});
