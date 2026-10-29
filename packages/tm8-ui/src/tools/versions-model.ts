import type { ActorSummary, ToolDefinition } from '@tm8/contract';
import { sha256HexOfBytes } from '../files/sha256';
import { snapshotVersionOf } from './version-field';

/**
 * A tool's STORED versions, as `entities.versions` returns them: newest first.
 *
 * Since migration 388 every `tools.*` write stores a row, configuration and
 * secret writes included, and a change to what runs (source, runtime, inputs,
 * tm8 access, timeout) takes the new entity version as the tool's
 * `execution_version`: the number a run pins and the page prints. So a row is
 * a DEFINITION version iff `content.execution_version == version`; every other
 * row (help, description or name edits, configuration, secrets) runs as the
 * definition version before it. Rows stored before 388 numbered
 * `execution_version` on its own, so for them a row is a definition version
 * when what runs differs from the next older row. Rows from then may also be
 * missing where one author's quick edits folded into one snapshot, and runs
 * from then pinned `entities.version`. Nothing here invents a row.
 *
 * `classifyVersions` exposes the same facts per row as `tm8 tool versions
 * --format json`: version, executionVersion, definition, changed[], sourceSha256.
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
  execution_version?: unknown;
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
/** `content.execution_version` as stored, or null for a snapshot without it. */
const storedExecutionVersion = (item: ToolVersionItem): number | null => {
  const value = contentOf(item).execution_version;
  return typeof value === 'number' ? value : null;
};

/** What a run executes; a change to any of these is a new definition version. */
export const EXECUTABLE_FIELDS = ['source', 'runtime', 'inputs', 'tm8Access', 'timeoutSeconds'] as const;
export type ToolVersionChange = typeof EXECUTABLE_FIELDS[number] | 'name' | 'description' | 'help' | 'config' | 'secrets';
const DEFINITION_FIELDS: readonly (keyof ToolDefinition & ToolVersionChange)[] = [...EXECUTABLE_FIELDS, 'name', 'description', 'help'];
/** Reader-facing names for the table and the "also changed" line. */
export const CHANGE_LABELS: Record<ToolVersionChange, string> = {
  source: 'source', runtime: 'runtime', inputs: 'inputs', tm8Access: 'tm8 access', timeoutSeconds: 'timeout',
  name: 'name', description: 'description', help: 'help', config: 'config', secrets: 'secrets',
};
export const changeLabels = (changed: readonly ToolVersionChange[]): string => changed.map(field => CHANGE_LABELS[field]).join(', ');

/** Key-sorted JSON, so two snapshots compare by value whatever order their keys arrived in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const bindingsOf = (item: ToolVersionItem) => (contentOf(item).secretBindings ?? [])
  .map(binding => `${String(binding.inputName)}:${String(binding.credentialId)}`).sort();

/** What changed from one stored snapshot to a later one, in the CLI's order. */
export function changedFields(previous: ToolVersionItem, next: ToolVersionItem): ToolVersionChange[] {
  const before = snapshotDefinition(previous), after = snapshotDefinition(next);
  const fields: ToolVersionChange[] = DEFINITION_FIELDS.filter(key => stable(before[key]) !== stable(after[key]));
  if (stable(contentOf(previous).config ?? {}) !== stable(contentOf(next).config ?? {})) fields.push('config');
  if (stable(bindingsOf(previous)) !== stable(bindingsOf(next))) fields.push('secrets');
  return fields;
}
/** `runtime: bash → python` for the scalar fields; the rest are named only. */
export function scalarChanges(previous: ToolVersionItem, next: ToolVersionItem): string[] {
  const before = snapshotDefinition(previous), after = snapshotDefinition(next);
  return (['name', 'runtime', 'tm8Access', 'timeoutSeconds'] as const)
    .filter(key => before[key] !== after[key])
    .map(key => `${CHANGE_LABELS[key]}: ${String(before[key] ?? '—')} → ${String(after[key] ?? '—')}`);
}

/** One classified stored row: the facts `tm8 tool versions --format json` prints, plus the row itself. */
export interface ToolVersionRow {
  item: ToolVersionItem;
  version: number;
  /** The definition version this row runs as: its own when it is one, else the nearest older one. */
  executionVersion: number;
  /** `content.execution_version == version` (388); for older rows, what runs differs from the next older row. */
  definition: boolean;
  /** What changed since the next older stored row; null while that row is not loaded. */
  changed: ToolVersionChange[] | null;
  /** sha256 of the stored source, the hash a run pins; null when the snapshot carries none. */
  sourceSha256: string | null;
}
const utf8 = new TextEncoder();
export const sourceSha256Of = (source: string): string => sha256HexOfBytes(utf8.encode(source));
const executable = (changed: readonly ToolVersionChange[]) => changed.some(field => (EXECUTABLE_FIELDS as readonly string[]).includes(field));

/** Classify loaded rows (newest first). `complete` says the oldest loaded row is the oldest stored. */
export function classifyVersions(items: readonly ToolVersionItem[], complete: boolean): ToolVersionRow[] {
  const rows: ToolVersionRow[] = new Array<ToolVersionRow>(items.length);
  let definitionBelow: number | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!, older = items[index + 1];
    const version = snapshotVersionOf(item), stored = storedExecutionVersion(item);
    const changed = older ? changedFields(older, item) : complete ? [] : null;
    // The oldest loaded row with more pages behind it cannot be judged yet; it stays visible until they load.
    const definition = stored === version || (older ? executable(changed!) : definitionBelow === null);
    const executionVersion = definition ? version : definitionBelow ?? stored ?? version;
    if (definition) definitionBelow = version;
    const source = snapshotSource(item);
    rows[index] = { item, version, executionVersion, definition, changed, sourceSha256: source === null ? null : sourceSha256Of(source) };
  }
  return rows;
}

export type VersionResolution =
  /** A stored row; `row.executionVersion` is the definition version it ran as. */
  | { kind: 'stored'; row: ToolVersionRow }
  /** Pre-388: absorbed by the next stored snapshot above it; its own source is not kept. */
  | { kind: 'folded'; into: number }
  /** Newer than every stored snapshot. */
  | { kind: 'unstored' }
  /** Older than every loaded snapshot while more pages remain. */
  | { kind: 'unknown' };

/**
 * Resolve a version named from outside the list (a run's pin) against loaded,
 * newest-first rows. Any stored row counts: a run from before 388 pinned
 * `entities.version`, which may name a configuration row whose definition is
 * still exactly what ran.
 */
export function resolveVersion(version: number, rows: readonly ToolVersionRow[], complete: boolean): VersionResolution {
  const exact = rows.find(row => row.version === version);
  if (exact) return { kind: 'stored', row: exact };
  const above = rows.filter(row => row.version > version);
  if (!above.length) return complete || rows.length ? { kind: 'unstored' } : { kind: 'unknown' };
  const covered = complete || rows.some(row => row.version < version);
  return covered ? { kind: 'folded', into: Math.min(...above.map(row => row.version)) } : { kind: 'unknown' };
}
/** The sentence for a run whose source cannot be shown; null when a stored row has it. */
export function versionHint(version: number, resolution: VersionResolution): string | null {
  if (resolution.kind === 'folded') return `Source unavailable: v${version} was folded into v${resolution.into} before every write kept its own snapshot.`;
  if (resolution.kind === 'unstored') return `Source unavailable: v${version} has no stored snapshot.`;
  return null;
}
/** The same fact, short enough for a table cell. */
export function versionNote(resolution: VersionResolution): string | null {
  return resolution.kind === 'folded' || resolution.kind === 'unstored' ? 'source unavailable' : null;
}
