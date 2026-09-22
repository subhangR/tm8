import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { EntityContent, EntityState, SkillReference } from '@tm8/contract';

/** Both SQL projections use this exact metadata selection; no body is selected. */
export const SKILL_REFERENCE_SQL = `jsonb_build_object(
  'provider', sk.provider, 'level', sk.level, 'root_kind', sk.root_kind,
  'root_ref', sk.root_ref, 'source_path', sk.source_path, 'dir_name', sk.dir_name,
  'loader_metadata', sk.loader_metadata, 'frontmatter', sk.frontmatter, 'content_hash', sk.content_hash,
  'file_mtime', sk.file_mtime, 'body_bytes', sk.body_bytes, 'bundle', sk.bundle,
  'missing', sk.missing, 'last_seen_at', sk.last_seen_at)`;

export function skillReferenceOf(raw: Record<string, unknown> | null | undefined): SkillReference {
  const r = raw ?? {};
  const stamp = (v: unknown): string => new Date(String(v)).toISOString();
  return {
    provider: (r.provider ?? 'tm8') as SkillReference['provider'],
    level: (r.level ?? 'space') as SkillReference['level'],
    ...(r.root_kind ? { root: { kind: r.root_kind as NonNullable<SkillReference['root']>['kind'], ref: r.root_ref as string | null ?? null } } : {}),
    ...(r.source_path ? { sourcePath: String(r.source_path) } : {}),
    ...(r.dir_name ? { dirName: String(r.dir_name) } : {}),
    frontmatter: (r.frontmatter ?? {}) as Record<string, unknown>,
    ...(r.content_hash ? { contentHash: String(r.content_hash) } : {}),
    ...(r.file_mtime ? { fileMtime: stamp(r.file_mtime) } : {}),
    ...(r.body_bytes != null ? { bodyBytes: Number(r.body_bytes) } : {}),
    ...(r.bundle ? { bundle: r.bundle as SkillReference['bundle'] } : {}),
    loaderMetadata: (r.loader_metadata ?? {}) as Record<string, unknown>,
    missing: r.missing === true,
    ...(r.last_seen_at ? { lastSeenAt: stamp(r.last_seen_at) } : {}),
  };
}

/** Detail-only hydration. A missing/unreadable file never falls back to stale content. */
export async function readSkillDetail(
  state: EntityState,
  content: EntityContent,
): Promise<{ state: EntityState; content: EntityContent }> {
  if (state.kind !== 'skill' || content.kind !== 'skill' || !state.sourcePath) return { state, content };
  try {
    const bytes = await readFile(state.sourcePath);
    return {
      state: { ...state, missing: false, changedOnDisk: state.contentHash !== createHash('sha256').update(bytes).digest('hex') },
      content: { ...content, content: bytes.toString('utf8') },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'EPERM') throw error;
    return {
      state: { ...state, missing: code === 'ENOENT' || code === 'ENOTDIR' || state.missing, changedOnDisk: false },
      content: { ...content, content: '', readError: code },
    };
  }
}
