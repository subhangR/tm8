import { homedir } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';
import { CollabError } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import { scanSkills, SkillScanDebouncer, type SkillScanStore } from './scanner.js';
import type { ParsedSkillFile } from './parse.js';
import type { SkillRoots } from './discovery.js';
export interface SkillScanOptions { root?: string; all?: boolean; force?: boolean; homesOnly?: boolean }
interface ProjectRoot { id: string; working_dir: string; trust: string; defaults: Record<string, unknown> }
const debounce = new SkillScanDebouncer();
const absolute = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value);

/** Only project rows visible to the authenticated database principal become roots. */
export async function resolveSkillRoots(db: Db, claims: DbClaims, spaceId: string, options: SkillScanOptions): Promise<SkillRoots> {
  const projects = await db.query<ProjectRoot>(claims,
    `select p.id, p.working_dir, p.trust, p.defaults from public.projects p
      join public.space_projects sp on sp.project_id = p.id where sp.space_id = $1`, [spaceId]);
  if (options.root && !projects.some(p => p.id === options.root)) throw new CollabError('not_found', 'project is not linked to this space');
  const boundaries = await db.query<{ working_dir: string }>(claims, 'select working_dir from public.projects');
  const selected = projects.filter(p => !options.root || p.id === options.root);
  // No member home field exists in this schema. Use explicit authorized project
  // defaults when configured, otherwise the server OS account home.
  const homes = [...new Set([homedir(), ...selected.map(p => p.defaults.homeDir).filter(absolute)])];
  return {
    projects: options.homesOnly ? [] : selected.map(p => ({ id: p.id, workingDir: p.working_dir })),
    projectBoundaries: boundaries.map(p => p.working_dir), homes,
    codexHomes: selected.map(p => p.defaults.codexHome).filter(absolute),
    hermesHomes: selected.map(p => p.defaults.hermesHome).filter(absolute),
    ...(absolute(process.env.CODEX_HOME) ? { codexHomes: [...selected.map(p => p.defaults.codexHome).filter(absolute), process.env.CODEX_HOME] } : {}),
    ...(absolute(process.env.HERMES_HOME) ? { hermesHomes: [...selected.map(p => p.defaults.hermesHome).filter(absolute), process.env.HERMES_HOME] } : {}),
    claudeManagedDir: absolute(process.env.CLAUDE_MANAGED_SETTINGS_DIR) ? process.env.CLAUDE_MANAGED_SETTINGS_DIR : '/etc/claude-code',
  };
}
export function skillReferenceMetadata(file: ParsedSkillFile, scannedAt: string) {
  const rootKind = file.level === 'plugin' ? 'plugin' : file.level === 'nested' ? 'subdir' : file.projectId ? 'project' : 'home';
  return {
    name: file.name, description: file.description, provider: file.provider, level: file.level,
    root_kind: rootKind, root_ref: file.root, source_path: file.path,
    dir_name: file.legacy ? basename(file.path, '.md') : basename(dirname(file.path)),
    frontmatter: file.frontmatter, content_hash: file.contentHash, file_mtime: file.mtime,
    body_bytes: file.size, bundle: file.bundleCounts, last_seen_at: scannedAt,
    loader_metadata: { openai: file.sidecar, enabled: file.enabled, codexDisabled: !file.enabled && file.level !== 'plugin', legacyCommand: file.legacy === true, ...(file.pluginName ? { pluginName: file.pluginName } : {}) },
  };
}
export function skillScanStore(db: Db, claims: DbClaims, spaceId: string): SkillScanStore {
  return {
    listReferences: () => db.query(claims, `select s.entity_id as id, s.source_path as "sourcePath", s.missing
      from public.skills s join public.entities e on e.id = s.entity_id
      where e.space_id = $1 and e.deleted_at is null and s.source_path is not null`, [spaceId]),
    async upsert(file, scannedAt) { await db.rpc(claims, 'upsert_skill_reference', [spaceId, skillReferenceMetadata(file, scannedAt)]); },
    async markMissing(ids, scannedAt) { await db.rpc(claims, 'mark_skill_references_missing', [spaceId, ids, scannedAt]); },
  };
}
export async function scanSpaceSkills(db: Db, claims: DbClaims, spaceId: string, options: SkillScanOptions = {}) {
  // Authorization must precede both cached responses and filesystem access.
  const membership = await db.query<{ allowed: boolean }>(claims, 'select internal.is_space_member($1::uuid) as allowed', [spaceId]);
  if (!membership[0]?.allowed) throw new CollabError('forbidden', 'space membership required for skill scanning');
  if (claims.actorId) {
    const actor = await db.query<{ allowed: boolean }>(claims, 'select internal.can_act_as($1::uuid,$2::uuid) as allowed', [claims.actorId, spaceId]);
    if (!actor[0]?.allowed) throw new CollabError('forbidden', 'not permitted to scan as this actor');
  }
  const roots = await resolveSkillRoots(db, claims, spaceId, options);
  const key = JSON.stringify([spaceId, claims.identityId, claims.actorId, roots]);
  return debounce.run(key, () => scanSkills({ roots, store: skillScanStore(db, claims, spaceId) }), options.force);
}
