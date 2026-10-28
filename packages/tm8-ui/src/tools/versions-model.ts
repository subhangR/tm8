import type { ActorSummary, ToolDefinition } from '@tm8/contract';

/**
 * A tool's STORED versions, as `entities.versions` returns them: newest first,
 * with gaps. One author's edits within five minutes fold into a single stored
 * snapshot (`internal.snapshot_entity_version`), so a version a run pinned may
 * have no snapshot of its own. Nothing here invents one.
 */
export interface ToolVersionItem {
  entityId: string;
  version: number;
  /** `{ entity, content }`; `content` is the tools row plus `config` and `secretBindings`. */
  snapshot: Record<string, unknown> | null;
  changedBy: ActorSummary | null;
  changedAt: string;
}
export interface ToolVersionsPage { items: ToolVersionItem[]; nextCursor: string | null }

interface SnapshotContent {
  definition?: Partial<ToolDefinition>;
  config?: Record<string, unknown>;
  secretBindings?: Array<{ inputName?: unknown; credentialId?: unknown }>;
}
const contentOf = (item: ToolVersionItem): SnapshotContent => {
  const content = item.snapshot?.['content'];
  return content && typeof content === 'object' ? content as SnapshotContent : {};
};
export function snapshotDefinition(item: ToolVersionItem): Partial<ToolDefinition> {
  const definition = contentOf(item).definition;
  return definition && typeof definition === 'object' ? definition : {};
}
export function snapshotSource(item: ToolVersionItem): string | null {
  const source = snapshotDefinition(item).source;
  return typeof source === 'string' ? source : null;
}

/** Key-sorted JSON, so two snapshots compare by value whatever order their keys arrived in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const FIELDS: ReadonlyArray<readonly [keyof ToolDefinition, string]> = [
  ['name', 'name'], ['description', 'description'], ['runtime', 'runtime'], ['source', 'source'], ['inputs', 'inputs'],
  ['help', 'help'], ['tm8Access', 'tm8 access'], ['timeoutSeconds', 'timeout'],
];
const bindingsOf = (item: ToolVersionItem) => (contentOf(item).secretBindings ?? [])
  .map(binding => `${String(binding.inputName)}:${String(binding.credentialId)}`).sort();

/** What changed from one stored snapshot to the next, as reader-facing field names. */
export function changedFields(previous: ToolVersionItem, next: ToolVersionItem): string[] {
  const before = snapshotDefinition(previous), after = snapshotDefinition(next);
  const fields = FIELDS.filter(([key]) => stable(before[key]) !== stable(after[key])).map(([, label]) => label);
  if (stable(contentOf(previous).config ?? {}) !== stable(contentOf(next).config ?? {})) fields.push('config');
  if (stable(bindingsOf(previous)) !== stable(bindingsOf(next))) fields.push('secrets');
  return fields;
}
/** `runtime: bash → python` for the scalar fields; the rest are named only. */
export function scalarChanges(previous: ToolVersionItem, next: ToolVersionItem): string[] {
  const before = snapshotDefinition(previous), after = snapshotDefinition(next);
  return (['name', 'runtime', 'tm8Access', 'timeoutSeconds'] as const)
    .filter(key => before[key] !== after[key])
    .map(key => `${FIELDS.find(([field]) => field === key)![1]}: ${String(before[key] ?? '—')} → ${String(after[key] ?? '—')}`);
}

export type VersionResolution =
  | { kind: 'stored'; item: ToolVersionItem }
  /** Absorbed by the next stored snapshot above it; its own source is not kept. */
  | { kind: 'folded'; into: number }
  /** Newer than every stored snapshot. */
  | { kind: 'unstored' }
  /** Older than every loaded snapshot while more pages remain. */
  | { kind: 'unknown' };

/** Resolve a version named from outside the list (a run's pin) against loaded, newest-first pages. */
export function resolveVersion(version: number, items: readonly ToolVersionItem[], complete: boolean): VersionResolution {
  const exact = items.find(item => item.version === version);
  if (exact) return { kind: 'stored', item: exact };
  const above = items.filter(item => item.version > version);
  if (!above.length) return complete || items.length ? { kind: 'unstored' } : { kind: 'unknown' };
  const covered = complete || items.some(item => item.version < version);
  return covered ? { kind: 'folded', into: Math.min(...above.map(item => item.version)) } : { kind: 'unknown' };
}
export function versionHint(version: number, resolution: VersionResolution): string | null {
  if (resolution.kind === 'folded') return `v${version} was folded into v${resolution.into}; its source is not stored.`;
  if (resolution.kind === 'unstored') return `v${version} has no stored snapshot.`;
  return null;
}
/** The same fact, short enough for a table cell. */
export function versionNote(resolution: VersionResolution): string | null {
  if (resolution.kind === 'folded') return `folded into v${resolution.into}`;
  if (resolution.kind === 'unstored') return 'no stored snapshot';
  return null;
}
