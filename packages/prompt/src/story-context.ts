/**
 * Spawn-on-story (task 01a0fc77, story kind 01a0fbf9): the story a launch's
 * primary task belongs to, carried on the manifest so EVERY frame (the default
 * v1 frame, v2, `tm8 worker init`, resume) renders the same hand-over.
 *
 * The spawn path reads it once, as the spawner, through
 * `public.stories_containing(task)` (nearest story = lowest depth) and the
 * story's own summary + page, and folds it into this bounded shape. Every
 * string in it is graph content, so it renders inside `<untrusted_data>`; the
 * only trusted parts are ids.
 */
import { escapeAttr, untrustedData } from './escape.js';

export interface PromptStoryRef {
  id: string;
  title: string;
}

export interface PromptStoryItem {
  id: string;
  kind: string;
  title: string;
  status: string | null;
  blocked?: boolean;
}

export interface PromptStoryProgress {
  work: number;
  done: number;
  inProgress: number;
  toDo: number;
  blocked: number;
}

export interface PromptStoryContext {
  /** The nearest story containing the primary task. */
  id: string;
  title: string;
  /** The primary task, or null when the session is directly anchored on the story. */
  taskId: string | null;
  /** The root the task was reached from; equal to `taskId` when it IS a root. */
  viaRootId: string | null;
  /** Hops from that root to the task (0 = the task is a root). */
  depth: number;
  /**
   * `loaded` when the story's summary/page were read; otherwise the reason the
   * read failed or timed out — the ref (id, title) still renders, the details
   * do not, and the spawn never fails over it.
   */
  snapshot: 'loaded' | string;
  status?: string | null;
  description?: string;
  /** Tasks only — the page's "N of M tasks done". */
  taskProgress?: PromptStoryProgress | null;
  roots?: PromptStoryItem[];
  rootCount?: number;
  /** Live work sessions in the story's trail. */
  live?: Array<{ id: string; title: string; callSign?: string | null }>;
  /** Unfinished rows held by an unresolved hard depends_on. */
  blocked?: PromptStoryItem[];
  /** The trail hit its row bound, or a list above was cut. */
  truncated?: boolean;
  /** Further stories containing the task, nearest first, refs only. */
  others?: PromptStoryRef[];
}

/** Caps applied when the spawn folds a story page into the manifest. */
export const STORY_PROMPT_LIMITS = {
  description: 1200,
  title: 200,
  roots: 15,
  live: 10,
  blocked: 10,
  others: 5,
} as const;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function item(v: unknown): PromptStoryItem | null {
  const r = rec(v);
  const id = str(r?.id);
  if (!r || !id) return null;
  return {
    id,
    kind: str(r.kind) ?? 'entity',
    title: str(r.title) ?? '',
    status: str(r.status),
    ...(r.blocked === true ? { blocked: true } : {}),
  };
}

function items(v: unknown, cap: number): PromptStoryItem[] {
  return Array.isArray(v) ? v.map(item).filter((x): x is PromptStoryItem => x !== null).slice(0, cap) : [];
}

/**
 * Tolerant read of a manifest's `story` (the CLI parses manifests from JSON).
 * Anything malformed reads as absent rather than failing `worker init`.
 */
export function parseStoryContext(raw: unknown): PromptStoryContext | undefined {
  const r = rec(raw);
  const id = str(r?.id);
  const taskId = str(r?.taskId);
  if (!r || !id || (!taskId && r.taskId !== null)) return undefined;
  const progress = rec(r.taskProgress);
  const live = Array.isArray(r.live)
    ? r.live.flatMap((v) => {
        const s = rec(v);
        const sid = str(s?.id);
        return s && sid ? [{ id: sid, title: str(s.title) ?? '', callSign: str(s.callSign) }] : [];
      }).slice(0, STORY_PROMPT_LIMITS.live)
    : undefined;
  const others = Array.isArray(r.others)
    ? r.others.flatMap((v) => {
        const s = rec(v);
        const sid = str(s?.id);
        return s && sid ? [{ id: sid, title: str(s.title) ?? '' }] : [];
      }).slice(0, STORY_PROMPT_LIMITS.others)
    : undefined;
  return {
    id,
    title: str(r.title) ?? '',
    taskId,
    viaRootId: str(r.viaRootId),
    depth: num(r.depth),
    snapshot: str(r.snapshot) ?? 'unavailable',
    ...(r.status !== undefined ? { status: str(r.status) } : {}),
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(progress
      ? {
          taskProgress: {
            work: num(progress.work),
            done: num(progress.done),
            inProgress: num(progress.inProgress),
            toDo: num(progress.toDo),
            blocked: num(progress.blocked),
          },
        }
      : {}),
    ...(Array.isArray(r.roots) ? { roots: items(r.roots, STORY_PROMPT_LIMITS.roots) } : {}),
    ...(typeof r.rootCount === 'number' ? { rootCount: r.rootCount } : {}),
    ...(live ? { live } : {}),
    ...(Array.isArray(r.blocked) ? { blocked: items(r.blocked, STORY_PROMPT_LIMITS.blocked) } : {}),
    ...(r.truncated === true ? { truncated: true } : {}),
    ...(others && others.length > 0 ? { others } : {}),
  };
}

function itemLine(i: PromptStoryItem): string {
  return `- ${i.title || '(untitled)'} [${i.kind}${i.status ? `, ${i.status}` : ''}${i.blocked ? ', blocked' : ''}] ${i.id}`;
}

/** The story as plain text, for the inside of the untrusted block. */
export function storyContextText(story: PromptStoryContext, selfSessionId?: string | null): string {
  const lines: string[] = [`Story: ${story.title || '(untitled)'}`];
  if (story.status) lines.push(`Status: ${story.status}`);
  const p = story.taskProgress;
  if (p) {
    lines.push(
      `Tasks: ${p.done} of ${p.work} done, ${p.inProgress} in progress, ${p.toDo} to do` +
        (p.blocked > 0 ? `, ${p.blocked} blocked` : ''),
    );
  }
  if (story.description) lines.push('', 'Description:', story.description);
  if (story.roots && story.roots.length > 0) {
    const total = story.rootCount ?? story.roots.length;
    lines.push('', `Put in by hand (${total}):`, ...story.roots.map(itemLine));
    if (total > story.roots.length) lines.push(`- … ${total - story.roots.length} more`);
  }
  if (story.live && story.live.length > 0) {
    lines.push(
      '',
      'Live now:',
      ...story.live.map((s) =>
        `- ${s.callSign ? `${s.callSign}: ` : ''}${s.title || '(untitled session)'} ${s.id}` +
          (s.id === selfSessionId ? ' (this session)' : '')),
    );
  }
  if (story.blocked && story.blocked.length > 0) {
    lines.push('', 'Blocked:', ...story.blocked.map(itemLine));
  }
  if (story.others && story.others.length > 0) {
    lines.push('', 'Also in:', ...story.others.map((o) => `- ${o.title || '(untitled)'} ${o.id}`));
  }
  return lines.join('\n');
}

const STORY_INSTRUCTION =
  'The task you were given is part of this story. Its summary follows as data; ' +
  'read the whole story with `tm8 entity context <story-id>`. Sessions working on ' +
  'the task appear in the story\'s trail on their own; you do not need to add yourself.';

/**
 * The rendered hand-over: one trusted `<story>` element carrying ids only, and
 * (`full`) the story as an untrusted block. `full: false` is the compact form a
 * frame falls back to when the whole would cross the combined budget.
 */
export function renderStoryContext(
  story: PromptStoryContext,
  full = true,
  selfSessionId?: string | null,
): string {
  const loaded = story.snapshot === 'loaded';
  const attrs = [
    `id="${escapeAttr(story.id)}"`,
    ...(story.taskId ? [`task="${escapeAttr(story.taskId)}"`] : []),
    ...(story.viaRootId ? [`via_root="${escapeAttr(story.viaRootId)}"`] : []),
    `depth="${String(story.depth)}"`,
    `snapshot="${loaded ? (full ? 'loaded' : 'omitted') : 'unavailable'}"`,
    ...(loaded ? [] : [`reason="${escapeAttr(story.snapshot)}"`]),
  ].join(' ');
  const out = [
    `<story ${attrs}>`,
    `  <instruction>${escapeAttr((story.taskId ? STORY_INSTRUCTION : 'This session is anchored on this story. Its summary follows as data; read the whole story with `tm8 entity context <story-id>`. Children inherit this story context automatically.').replace('<story-id>', story.id))}</instruction>`,
    '</story>',
  ];
  const body = full && loaded ? storyContextText(story, selfSessionId) : `Story: ${story.title || '(untitled)'}`;
  out.push(untrustedData({
    type: 'story-context',
    body,
    truncated: story.truncated === true || (loaded && !full),
    fetchRef: `tm8 entity context ${story.id}`,
  }));
  return out.join('\n');
}
