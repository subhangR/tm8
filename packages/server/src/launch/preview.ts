/**
 * `launch.preview` — the launch card's "What the agent gets" (launch card
 * v3, contract decision 6). Spawn's body minus the idempotency key and the
 * geometry, run through `SpawnService.preview`: spawn's own context read,
 * launch resolution, `composeManifest` and `composePrompt`. Nothing here
 * renders or budgets anything itself; it only reads the composition back.
 *
 * NOTHING IS WRITTEN. The one write on spawn's way to the composer, minting a
 * derived task for a non-task subject, is replaced by a read
 * (`resolveSubjectTask`); a subject with no open task is previewed as the
 * task spawn would mint.
 *
 * A launch spawn would refuse answers 200 with `refusal` (the code and
 * `details.reason` spawn would give). Only authorization (not a member, a
 * link bearer) and a malformed body are errors.
 */
import {
  CollabError,
  LAUNCH_PREVIEW_SECTION_KEYS,
  type LaunchPreviewInput,
  type LaunchPreviewItem,
  type LaunchPreviewLeftOut,
  type LaunchPreviewRefusal,
  type LaunchPreviewResult,
  type LaunchPreviewSection,
} from '@tm8/contract';
import {
  indexDroppedOf,
  SpawnError,
  type SpawnContext,
  type SpawnPreview,
  type SpawnRequest,
  type SpawnService,
} from '@tm8/execution';
import {
  BudgetExceededError,
  BYTE_BUDGETS,
  contextEntryBytes,
  serializeAttachmentEntry,
  serializeLinkedEntity,
  utf8Bytes,
} from '@tm8/prompt';
import type { Db, DbClaims, Querier } from '../db/types.js';
import { fail } from '../http/errors.js';
import { resolveSubjectTask } from '../jev/candidates.js';
import { ENTITY_COLUMNS, ENTITY_FROM, titleOf } from '../facade/entity-read.js';
import { derivedInFullPointer, inFullIdsFor } from './in-full.js';

export interface LaunchPreviewDeps {
  db: Db;
  spawnService: SpawnService;
  /** Spawn's own pre-write checks (`assertSelectionIds`, `assertInFullIds`), so a bad id refuses as spawn refuses it. */
  assertIds: (q: Querier, input: LaunchPreviewInput) => Promise<void>;
  /** Spawn's error mapping (`toCollabError`), so `refusal` carries spawn's code and details. */
  toCollabError: (error: unknown) => unknown;
  /** Spawn's parent resolution (`resolveSpawnParentId`) for this request. */
  parentSessionId: string | null | undefined;
}

/** Stand-in ids for tasks spawn would mint; the bytes match a real uuid's. */
function syntheticTaskId(i: number): string {
  return `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
}

export async function previewLaunch(
  deps: LaunchPreviewDeps,
  claims: DbClaims,
  input: LaunchPreviewInput,
): Promise<LaunchPreviewResult> {
  const member = await deps.db.tx(claims, async (q) =>
    (await q.query<{ ok: boolean }>('select internal.is_space_member($1::uuid) as ok', [input.spaceId]))[0]?.ok === true);
  if (!member) throw fail('forbidden', 'you are not a member of this space');

  let preview: SpawnPreview | null = null;
  let refusal: LaunchPreviewRefusal | null = null;
  try {
    const { taskIds, synthetic } = await deps.db.tx(claims, async (q) => {
      await deps.assertIds(q, input);
      return resolveTasksReadOnly(q, input);
    });
    preview = await deps.spawnService.preview(claims, spawnRequestOf(input, taskIds, deps.parentSessionId), {
      syntheticTasks: synthetic,
    });
    const over = preview.envelope.layout?.overBudget;
    if (over) refusal = refusalOf(deps.toCollabError(new BudgetExceededError(over.material, over.bytes, over.cap)));
  } catch (error) {
    refusal = refusalOf(deps.toCollabError(error));
  }
  if (!preview) return emptyResult(refusal);
  const titles = await deps.db.tx(claims, (q) => loadTitles(q, input.spaceId, idsNeedingTitles(preview!)));
  return { ...resultOf(preview, input, titles), refusal };
}

/** The ids spawn would anchor on, without minting: a task as is, else its one open derived task. */
async function resolveTasksReadOnly(
  q: Querier,
  input: LaunchPreviewInput,
): Promise<{ taskIds: string[]; synthetic: SpawnContext['tasks'] }> {
  const taskIds: string[] = [];
  const synthetic: SpawnContext['tasks'] = [];
  const inFull = new Set(input.inFullIds ?? []);
  for (const subjectId of input.taskIds ?? []) {
    const resolved = await resolveSubjectTask(q, input.spaceId, subjectId);
    // Spawn refuses an unreadable subject in `derive_task_for_entity`.
    if (!resolved) throw fail('not_found', `entity ${subjectId} not found in this space`);
    const reuse = resolved.anchor.kind === 'task' || !(input.forceNewTask ?? false);
    if (resolved.taskId && reuse) {
      if (!taskIds.includes(resolved.taskId)) taskIds.push(resolved.taskId);
      continue;
    }
    // The task spawn would mint (migration 200): "Work on: <title>", derived
    // from the anchor. Its body is the pointer when the anchor is sent in full.
    const anchor = resolved.anchor;
    synthetic.push({
      id: syntheticTaskId(synthetic.length),
      version: 1,
      title: `Work on: ${titleOf(anchor)}`.slice(0, 500),
      description: inFull.has(anchor.id)
        ? derivedInFullPointer(anchor.id)
        : `Launched from ${anchor.kind} \`${anchor.id}\`.`,
      priority: 'medium',
      status: 'working',
      acceptanceCriteria: [],
      attachments: [],
      linked: [],
      linkedTotal: 0,
    });
  }
  return { taskIds, synthetic };
}

function spawnRequestOf(input: LaunchPreviewInput, taskIds: string[], parentSessionId: string | null | undefined): SpawnRequest {
  return {
    spaceId: input.spaceId,
    teamMemberId: input.teamMemberId,
    parentSessionId: parentSessionId ?? null,
    ...(taskIds.length > 0 ? { taskIds } : {}),
    projectId: input.projectId ?? null,
    ...(input.workdir ? { workdir: input.workdir } : {}),
    ...(input.interactionProfileId ? { interactionProfileId: input.interactionProfileId } : {}),
    ...(input.confirmUntrusted ? { confirmUntrusted: true } : {}),
    mode: input.mode ?? null,
    model: input.model ?? null,
    agentTool: input.agentTool ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    accessMode: input.accessMode ?? null,
    credentialSources: input.credentialSources ?? null,
    credentialSource: input.credentialSource ?? null,
    spaceCredentialIds: input.spaceCredentialIds ?? null,
    title: input.title ?? null,
    promptExtra: input.promptExtra ?? null,
    ...(input.memoryIds?.length ? { memoryIds: input.memoryIds } : {}),
    ...(input.selection ? { selection: input.selection } : {}),
    ...(input.selectionReasons ? { selectionReasons: input.selectionReasons } : {}),
    ...(input.contextBudgets ? { contextBudgets: input.contextBudgets } : {}),
    ...(input.inFullIds?.length ? { inFullIds: input.inFullIds } : {}),
    ...(input.jevRemovedIds?.length ? { jevRemovedIds: input.jevRemovedIds } : {}),
    ...(input.jevRunId ? { jevRunId: input.jevRunId } : {}),
    ...(input.harnessSurface ? { harnessSurface: input.harnessSurface } : {}),
    ...(input.plugins ? { plugins: input.plugins } : {}),
  };
}

function refusalOf(error: unknown): LaunchPreviewRefusal {
  if (error instanceof CollabError) {
    const details = { ...(error.details ?? {}) };
    return { code: error.code, reason: typeof details.reason === 'string' ? details.reason : null, details };
  }
  if (error instanceof SpawnError) {
    return { code: 'upstream_unavailable', reason: null, details: { ...(error.detail ?? {}) } };
  }
  throw error;
}

function emptyResult(refusal: LaunchPreviewRefusal | null): LaunchPreviewResult {
  return {
    sections: [],
    totalBytes: 0,
    launchCapBytes: BYTE_BUDGETS.combinedInitialInjection,
    inFull: { budgetBytes: BYTE_BUDGETS.inFullInjection, bytes: 0 },
    indexDropped: [],
    leftOut: [],
    refusal,
  };
}

type Titles = ReadonlyMap<string, { kind: string; title: string }>;

function idsNeedingTitles(preview: SpawnPreview): string[] {
  const ids = new Set<string>();
  for (const group of preview.manifest.contextIndex?.groups ?? []) for (const entry of group.entries) ids.add(entry.id);
  for (const drop of preview.index?.fit.drops ?? []) ids.add(drop.id);
  for (const drop of preview.manifest.context?.dropped ?? []) ids.add(drop.entityId);
  for (const task of preview.manifest.tasks) for (const file of task.attachments ?? []) ids.add(file.fileEntityId);
  return [...ids];
}

/** Titles as every list shows them (`titleOf`), under the caller's RLS; an unreadable id has none. */
async function loadTitles(q: Querier, spaceId: string, ids: string[]): Promise<Titles> {
  if (ids.length === 0) return new Map();
  const rows = await q.query<Parameters<typeof titleOf>[0] & { id: string; kind: string }>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[]) and e.space_id = $2 and e.deleted_at is null`,
    [ids, spaceId],
  );
  return new Map(rows.map((row) => [row.id, { kind: row.kind, title: titleOf(row) }]));
}

function resultOf(preview: SpawnPreview, input: LaunchPreviewInput, titles: Titles): Omit<LaunchPreviewResult, 'refusal'> {
  const { manifest, envelope } = preview;
  const layout = envelope.layout;
  const item = (id: string, kind: string, bytes: number, fallback?: string | null): LaunchPreviewItem => ({
    id, kind, title: titles.get(id)?.title ?? fallback ?? '', bytes,
  });

  const sections: LaunchPreviewSection[] = [];
  const push = (section: LaunchPreviewSection): void => {
    if (section.bytes > 0 || section.items.length > 0) sections.push(section);
  };

  push({
    key: 'task',
    bytes: layout?.taskBytes ?? utf8Bytes(envelope.task),
    items: manifest.tasks.map((task) => item(task.id, 'task', 0, task.title)),
  });
  push({
    key: 'in_full',
    bytes: (layout?.inFull ?? []).reduce((sum, entry) => sum + entry.bytes, 0),
    items: (layout?.inFull ?? []).map((entry) => ({ id: entry.entityId, kind: entry.kind, title: entry.title, bytes: entry.bytes })),
  });
  push({ key: 'notes', bytes: layout?.notesBytes ?? 0, items: [] });
  push({
    key: 'context_index',
    bytes: layout?.indexBytes ?? 0,
    items: (manifest.contextIndex?.groups ?? []).flatMap((group) =>
      group.entries.map((entry) => item(entry.id, entry.kind, contextEntryBytes(entry), entry.header?.name))),
  });
  // `<attachments>` and `<linked>` ride the task turn; measured on the rendered turn.
  const inline = layout?.taskDelivery !== 'reference';
  push({
    key: 'attachments',
    bytes: inline ? blockBytes(envelope.task, 'attachments', 'attachment-names') : 0,
    items: inline
      ? manifest.tasks.flatMap((task) => (task.attachments ?? []).map((file) =>
        item(file.fileEntityId, 'file', utf8Bytes(serializeAttachmentEntry(file)) + 1, file.name)))
      : [],
  });
  push({
    key: 'linked',
    bytes: inline ? blockBytes(envelope.task, 'linked', 'linked-names') : 0,
    items: inline
      ? manifest.tasks.flatMap((task) => (task.linked ?? []).map((link) =>
        item(link.entityId, link.kind, utf8Bytes(serializeLinkedEntity(link)) + 1, link.title)))
      : [],
  });
  sections.sort((a, b) => LAUNCH_PREVIEW_SECTION_KEYS.indexOf(a.key) - LAUNCH_PREVIEW_SECTION_KEYS.indexOf(b.key));

  // What the index fit dropped whole (`indexDroppedOf`, lane A's rule),
  // measured as the candidate would have rendered. A dropped task link keeps
  // its `<linked>` id line.
  const candidates = new Map((preview.index?.candidates ?? []).flatMap((group) => group.entries.map((entry) => [entry.id, entry] as const)));
  const linkedIds = new Set(manifest.tasks.flatMap((task) => (task.linked ?? []).map((link) => link.entityId)));
  const indexDropped = (preview.index ? indexDroppedOf(preview.index.fit) : []).map((drop) => {
    const entry = candidates.get(drop.id);
    return {
      ...item(drop.id, drop.kind, entry ? contextEntryBytes(entry) : 0, entry?.header?.name),
      stillLinked: linkedIds.has(drop.id),
    };
  });

  const jev = new Set(input.jevRemovedIds ?? []);
  const leftOut: LaunchPreviewLeftOut[] = [];
  const seen = new Set<string>();
  for (const drop of manifest.context?.dropped ?? []) {
    if (drop.reason !== 'not-selected' || seen.has(drop.entityId)) continue;
    seen.add(drop.entityId);
    leftOut.push({
      id: drop.entityId,
      kind: drop.kind,
      title: titles.get(drop.entityId)?.title ?? '',
      reason: jev.has(drop.entityId) ? 'jev' : 'unticked',
    });
  }
  const inFullIds = new Set(inFullIdsFor(input.inFullIds, manifest.tasks.map((task) => task.id)));
  for (const dup of preview.duplicates) {
    if (seen.has(dup.entityId) || !inFullIds.has(dup.entityId)) continue;
    seen.add(dup.entityId);
    leftOut.push({ id: dup.entityId, kind: dup.kind, title: dup.title, reason: 'duplicate' });
  }

  return {
    sections,
    totalBytes: utf8Bytes(`${envelope.system}\n\n${envelope.task}`),
    launchCapBytes: BYTE_BUDGETS.combinedInitialInjection,
    inFull: { budgetBytes: BYTE_BUDGETS.inFullInjection, bytes: layout?.inFullBytes ?? 0 },
    indexDropped,
    leftOut,
  };
}

/** Bytes of a task-turn block (`<attachments …>…</attachments>` or its empty form) plus its names block. */
function blockBytes(task: string, tag: 'attachments' | 'linked', namesType: string): number {
  const control = new RegExp(`^ *<${tag} count="0" />$|^ *<${tag} [^>]*>[\\s\\S]*?^ *</${tag}>$`, 'm').exec(task);
  if (!control || control[0].includes('count="0"')) return 0;
  const names = new RegExp(`<untrusted_data type="${namesType}"[\\s\\S]*?</untrusted_data>`).exec(task);
  return utf8Bytes(control[0]) + 1 + (names ? utf8Bytes(names[0]) + 1 : 0);
}
