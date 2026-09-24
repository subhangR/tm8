import type {
  LaunchContextEntry,
  LaunchContextRole,
  LaunchContextSource,
  RelevanceLevel,
  SessionLaunchContext,
} from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';

/**
 * The launch's selections as the session's Connections tab shows them: every
 * entity the stored manifest names, with why it was there.
 *
 * READ UNDER THE VIEWER'S CLAIMS, ENTRY BY ENTRY. Being able to read the
 * session is not being able to read everything it loaded: a manifest names
 * tasks, references and skills its launcher could read. So each id is looked
 * up in `public.entities` under RLS, and one the viewer cannot read — or one
 * since deleted — is counted, never named. Titles and kinds come from that
 * read, not from the manifest, for the same reason.
 *
 * The manifest is untyped JSON written by whatever build launched the session
 * (see SessionLaunchRecord), so every key is read defensively and a shape this
 * build does not know contributes nothing rather than failing the read.
 */
export async function projectLaunchContext(
  db: Db,
  claims: DbClaims,
  manifest: Record<string, unknown>,
): Promise<SessionLaunchContext> {
  const candidates = collectCandidates(manifest);
  const memoryIds = memoryIdsOf(manifest);
  const unlinkedMemories = unlinkedMemoriesOf(manifest, memoryIds);

  const ids = [...new Set(candidates.map((c) => c.entityId))];
  if (ids.length === 0) return { entries: [], hiddenCount: 0, unlinkedMemories };

  const taskIds = candidates.filter((c) => c.role === 'task').map((c) => c.entityId);
  const teamMemberId = candidates.find((c) => c.role === 'teammate')?.entityId ?? null;
  const [visible, jev] = await Promise.all([
    db.query<{ id: string; kind: string; title: string; teammate_remembers: boolean; task_remembers: boolean }>(
      claims,
      `select e.id, e.kind,
              coalesce(case e.kind
                when 'task' then t.title
                when 'doc' then d.title
                when 'team_member' then tm.name
                when 'file' then f.name
                when 'work_session' then nullif(ws.title, '')
                when 'skill' then sk.name
                when 'memory' then left(m.statement, 200)
                when 'artifact' then ar.name
                when 'drawing' then dr.title
                when 'channel' then ch.name
                when 'collection' then col.name
              end, e.kind) as title,
              exists (select 1 from public.edges r
                       where r.type = 'remembers' and r.src_id = $2 and r.dst_id = e.id) as teammate_remembers,
              exists (select 1 from public.edges r
                       where r.type = 'remembers' and r.src_id = any($3::uuid[]) and r.dst_id = e.id) as task_remembers
         from public.entities e
         left join public.tasks t on t.entity_id = e.id
         left join public.documents d on d.entity_id = e.id
         left join public.team_members tm on tm.entity_id = e.id
         left join public.files f on f.entity_id = e.id
         left join public.work_sessions ws on ws.entity_id = e.id
         left join public.skills sk on sk.entity_id = e.id
         left join public.memories m on m.entity_id = e.id
         left join public.artifacts ar on ar.entity_id = e.id
         left join public.drawings dr on dr.entity_id = e.id
         left join public.channels ch on ch.entity_id = e.id
         left join public.collections col on col.entity_id = e.id
        where e.id = any($1::uuid[]) and e.deleted_at is null`,
      [ids, teamMemberId, taskIds],
    ),
    loadJevRatings(db, claims, manifest),
  ]);
  const byId = new Map(visible.map((row) => [row.id, row]));

  const entries: LaunchContextEntry[] = [];
  const seen = new Set<string>();
  const hidden = new Set<string>();
  for (const c of candidates) {
    const key = `${c.role}:${c.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = byId.get(c.entityId);
    if (!row) {
      hidden.add(c.entityId);
      continue;
    }
    const rating = jev.get(c.entityId) ?? null;
    let source = c.source;
    if (rating?.suggested && (c.role === 'teammate' || c.role === 'memory' || c.role === 'skill')) {
      source = 'jev';
    } else if (c.role === 'memory') {
      // Not recorded at launch (the §6 audit will record it); read from the
      // graph's `remembers` edges now, which is what put it in the launch
      // unless those edges have changed since.
      source = row.teammate_remembers ? 'teammate' : row.task_remembers ? 'task' : 'requested';
    }
    entries.push({
      entityId: c.entityId,
      role: c.role,
      kind: row.kind,
      title: row.title,
      source,
      viaTaskId: c.viaTaskId,
      skillLoad: c.skillLoad,
      jev: rating ? { level: rating.level, score: rating.score } : null,
    });
  }
  return { entries, hiddenCount: hidden.size, unlinkedMemories };
}

interface Candidate {
  entityId: string;
  role: LaunchContextRole;
  source: LaunchContextSource;
  viaTaskId: string | null;
  skillLoad: 'native' | 'indexed' | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** In display order: teammate, tasks, memories, skills, then what the tasks carried, then the coordinator. */
function collectCandidates(manifest: Record<string, unknown>): Candidate[] {
  const out: Candidate[] = [];
  const add = (
    entityId: unknown,
    role: LaunchContextRole,
    source: LaunchContextSource,
    viaTaskId: string | null = null,
    skillLoad: Candidate['skillLoad'] = null,
  ) => {
    if (isId(entityId)) out.push({ entityId, role, source, viaTaskId, skillLoad });
  };

  add(recordOf(manifest.agent)?.teamMemberId, 'teammate', 'launch');
  const tasks = arrayOf(manifest.tasks)
    .map(recordOf)
    .filter((t): t is Record<string, unknown> => t !== null);
  for (const task of tasks) add(task.id, 'task', 'launch');
  for (const id of memoryIdsOf(manifest) ?? []) add(id, 'memory', 'requested');

  // `effectiveSkills` says which load path each skill took; a manifest that
  // predates it lists them in `skills` only.
  const effective = recordOf(manifest.effectiveSkills);
  const skillRows: Array<[unknown, Candidate['skillLoad']]> = effective
    ? [
        ...arrayOf(effective.native).map((s) => [s, 'native'] as [unknown, Candidate['skillLoad']]),
        ...arrayOf(effective.indexed).map((s) => [s, 'indexed'] as [unknown, Candidate['skillLoad']]),
      ]
    : arrayOf(manifest.skills).map((s) => [s, null] as [unknown, Candidate['skillLoad']]);
  for (const [value, load] of skillRows) {
    const skill = recordOf(value);
    if (!skill) continue;
    const viaTaskId = isId(skill.viaTaskId) ? skill.viaTaskId : null;
    add(skill.entityId, 'skill', viaTaskId ? 'task' : 'teammate', viaTaskId, load);
  }

  for (const task of tasks) {
    const taskId = isId(task.id) ? task.id : null;
    for (const value of arrayOf(task.linked)) {
      const linked = recordOf(value);
      add(linked?.entityId, linked?.link === 'attached_to' ? 'attachment' : 'reference', 'task', taskId);
    }
    for (const value of arrayOf(task.attachments)) {
      add(recordOf(value)?.fileEntityId, 'attachment', 'task', taskId);
    }
  }
  add(recordOf(manifest.coordinator)?.sessionId, 'coordinator', 'launch');
  return out;
}

function memoryIdsOf(manifest: Record<string, unknown>): string[] | null {
  const ids = recordOf(manifest.context)?.memoryIds;
  return Array.isArray(ids) ? ids.filter(isId) : null;
}

/**
 * The memories recorded as text only. `agent.memory` is the injected memories
 * (one per recorded id, in the same order) followed by any legacy id-less
 * remainder, so with ids recorded the remainder is the tail past their count;
 * without them, every entry is text only.
 */
function unlinkedMemoriesOf(manifest: Record<string, unknown>, memoryIds: string[] | null): string[] {
  const texts = arrayOf(recordOf(manifest.agent)?.memory).filter(
    (m): m is string => typeof m === 'string',
  );
  return memoryIds ? texts.slice(memoryIds.length) : texts;
}

interface JevRating {
  level: RelevanceLevel;
  score: number;
  suggested: boolean;
}

const LEVELS: ReadonlySet<string> = new Set(['irrelevant', 'background', 'useful', 'critical']);

/**
 * Jev's per-entity ratings for the run this launch came from, keyed by entity
 * id. `jev_runs` is readable by space members (201), so under the viewer's
 * claims a run they cannot see yields no ratings rather than an error.
 */
async function loadJevRatings(
  db: Db,
  claims: DbClaims,
  manifest: Record<string, unknown>,
): Promise<Map<string, JevRating>> {
  const ratings = new Map<string, JevRating>();
  const runId = recordOf(manifest.launch)?.jevRunId;
  if (!isId(runId)) return ratings;
  const rows = await db.query<{ suggestions: unknown }>(
    claims,
    `select suggestions from public.jev_runs where id = $1`,
    [runId],
  );
  const suggestions = recordOf(rows[0]?.suggestions);
  if (!suggestions) return ratings;
  for (const group of ['teammates', 'memories', 'skills']) {
    for (const value of arrayOf(recordOf(suggestions[group])?.items)) {
      const item = recordOf(value);
      if (!item || !isId(item.id) || typeof item.level !== 'string' || !LEVELS.has(item.level)) continue;
      ratings.set(item.id, {
        level: item.level as RelevanceLevel,
        score: typeof item.score === 'number' ? item.score : 0,
        suggested: item.suggested === true,
      });
    }
  }
  return ratings;
}
