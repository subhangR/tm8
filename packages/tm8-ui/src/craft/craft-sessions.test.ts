/**
 * The craft's sessions (spec §3, 2nd panel): which sessions a craft lists,
 * what "+ New session" spawns, and the best-effort `about` edge that ties the
 * session to the craft (refused until L3's migration 314 lets a work_session
 * be `about` something — the spawn must survive that refusal).
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { HOUSE_TEAMMATE_NAMES } from '@tm8/contract';
import type { LaunchProject, LaunchTeammate } from '../domain/launch';
import { craftSpawnInput, defaultCraftTeammate, listCraftSessions } from './craft-sessions';

const CRAFT = 'craft-1' as EntityId;

function node(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, title: `${kind} ${id}`, createdAt: '2026-10-01T00:00:00Z', deletedAt: null, ...extra };
}
function edge(source: ReturnType<typeof node>, createdAt: string) {
  return { source, createdAt };
}

function seamWith(pages: Record<string, unknown[] | Error>) {
  const connections = vi.fn(async (id: string, opts: { types: string[] }) => {
    const page = pages[`${id}:${opts.types[0]}`] ?? [];
    if (page instanceof Error) throw page;
    return { items: page };
  });
  return { connections } as never;
}

function teammate(id: string, name: string): LaunchTeammate {
  return { id, name, initial: name[0]!, model: 'opus', agentTool: 'claude-code', owner: 'me' };
}

describe('listCraftSessions', () => {
  it('lists sessions on the craft\'s derived tasks and sessions about it, deduped, newest first', async () => {
    const task = node('task-1', 'task');
    const older = node('s-old', 'work_session');
    const newer = node('s-new', 'work_session');
    const gone = node('s-gone', 'work_session', { deletedAt: '2026-10-02T00:00:00Z' });
    const seam = seamWith({
      'craft-1:derived_from': [edge(task, '2026-10-01T00:00:00Z'), edge(node('doc-1', 'doc'), '2026-10-01T00:00:00Z')],
      'task-1:working_on': [edge(older, '2026-10-02T00:00:00Z'), edge(gone, '2026-10-05T00:00:00Z')],
      'craft-1:about': [
        edge(newer, '2026-10-04T00:00:00Z'),
        edge(older, '2026-10-01T00:00:00Z'),
        edge(node('chat-1', 'chat'), '2026-10-06T00:00:00Z'),
      ],
    });
    const rows = await listCraftSessions(seam, CRAFT);
    expect(rows.map((row) => [row.id, row.at])).toEqual([
      ['s-new', '2026-10-04T00:00:00Z'],
      ['s-old', '2026-10-02T00:00:00Z'],
    ]);
  });

  it('still lists the derived sessions when the about read is refused', async () => {
    const seam = seamWith({
      'craft-1:derived_from': [edge(node('task-1', 'task'), '2026-10-01T00:00:00Z')],
      'task-1:working_on': [edge(node('s-1', 'work_session'), '2026-10-02T00:00:00Z')],
      'craft-1:about': new Error('refused'),
    });
    expect((await listCraftSessions(seam, CRAFT)).map((row) => row.id)).toEqual(['s-1']);
  });
});

describe('+ New session spawn input', () => {
  const projects: LaunchProject[] = [
    { id: 'p-untrusted', name: 'u', trusted: false, detail: '' },
    { id: 'p-1', name: 'one', trusted: true, detail: '' },
  ];

  it('runs as the craft chat\'s default teammate, on the craft, in the first trusted project', () => {
    const roster = [teammate('t-1', 'Someone'), teammate('t-arch', HOUSE_TEAMMATE_NAMES.graphArchitect)];
    expect(defaultCraftTeammate(roster)?.id).toBe('t-arch');
    const input = craftSpawnInput({ spaceId: 'sp', craftId: CRAFT, title: 'Launch plan', teammates: roster, projects })!;
    expect(input.teamMemberId).toBe('t-arch');
    expect(input.taskIds).toEqual([CRAFT]);
    // About the craft in the spawn's own transaction; no edge is written afterwards.
    expect(input.aboutEntityId).toBe(CRAFT);
    expect(input.projectId).toBe('p-1');
    expect(input.title).toBe('Launch plan');
  });

  it('falls back to scratch when the default project cannot host it, and to nothing without a teammate', () => {
    const input = craftSpawnInput({
      spaceId: 'sp',
      craftId: CRAFT,
      title: '',
      teammates: [teammate('t-1', 'Someone')],
      projects: [{ ...projects[0]!, selectedByDefault: true }, projects[1]!],
    })!;
    expect(input.teamMemberId).toBe('t-1');
    expect(input.projectId).toBeNull();
    expect(craftSpawnInput({ spaceId: 'sp', craftId: CRAFT, title: '', teammates: [], projects })).toBeNull();
  });
});
