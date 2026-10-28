import { createHash } from 'node:crypto';
import type { ActorSummary, ToolJsonValue } from '@tm8/contract';

/** One `entities.versions` item as the Server sends it: the snapshot is the stored detail row. */
export interface EntityVersionItem {
  entityId: string; version: number; snapshot: unknown; changedBy: ActorSummary | null; changedAt: string | null;
}
export interface ToolVersionRef {
  version: number; changedAt: string | null; changedBy: ActorSummary | null;
  /** sha256 of the stored source: the same digest `tm8 tool runs` pins per run. */
  sourceSha256: string | null;
}
export interface ToolVersionRow extends ToolVersionRef {
  /** Fields that differ from the next older stored snapshot; null for the oldest one stored. */
  changed: string[] | null;
  previousVersion: number | null;
  executionVersion: number | null; configRevision: number | null;
}
export interface ToolVersionsPage { toolId: string; name: string; currentVersion: number; items: ToolVersionRow[]; nextCursor: string | null }
export interface ToolDiffResult {
  toolId: string; name: string; from: ToolVersionRef; to: ToolVersionRef;
  /** Every tracked field that differs between the two versions. */
  changed: string[];
  /** Unified diff of `definition.source`; empty when the source is identical. */
  diff: string;
}

/** Definition fields in ToolDefinition order, then the configuration a snapshot also carries. */
const FIELDS = ['name', 'description', 'runtime', 'source', 'inputs', 'help', 'tm8Access', 'timeoutSeconds'] as const;
export const FOLDED_VERSIONS_NOTE = 'not every version number has a stored snapshot: rapid edits by one author can fold into one';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Key-sorted JSON, so equal values compare equal whatever order they were stored in. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) => inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : inner) ?? 'undefined';
const integer = (value: unknown): number | null => Number.isSafeInteger(value) ? value as number : null;

/** The stored tool row inside a snapshot, read defensively: history is data, not a schema. */
function content(item: EntityVersionItem) {
  const row = record(record(item.snapshot).content), definition = record(row.definition);
  const bindings = Array.isArray(row.secretBindings) ? row.secretBindings.map(record) : [];
  return {
    definition,
    config: record(row.config) as Record<string, ToolJsonValue>,
    secrets: bindings.map(binding => `${String(binding.inputName)}=${String(binding.credentialId)}`).sort(),
    executionVersion: integer(row.execution_version), configRevision: integer(row.config_revision),
  };
}
export const snapshotSource = (item: EntityVersionItem): string | null => {
  const source = content(item).definition.source;
  return typeof source === 'string' ? source : null;
};
export function versionRef(item: EntityVersionItem): ToolVersionRef {
  const source = snapshotSource(item);
  return { version: item.version, changedAt: item.changedAt, changedBy: item.changedBy,
    sourceSha256: source === null ? null : createHash('sha256').update(source).digest('hex') };
}
export function changedFields(newer: EntityVersionItem, older: EntityVersionItem): string[] {
  const a = content(newer), b = content(older);
  return [...FIELDS.filter(field => canonical(a.definition[field]) !== canonical(b.definition[field])),
    ...(canonical(a.config) !== canonical(b.config) ? ['config'] : []),
    ...(canonical(a.secrets) !== canonical(b.secrets) ? ['secrets'] : [])];
}
/** `older` is the snapshot just past the page, when there is one. */
export function versionRows(items: readonly EntityVersionItem[], older: EntityVersionItem | undefined): ToolVersionRow[] {
  return items.map((item, index) => {
    const previous = items[index + 1] ?? older, row = content(item);
    return { ...versionRef(item), changed: previous ? changedFields(item, previous) : null, previousVersion: previous?.version ?? null,
      executionVersion: row.executionVersion, configRevision: row.configRevision };
  });
}

const who = (actor: ActorSummary | null): string => actor ? `${actor.displayName}${actor.isAgent ? ' (agent)' : ''}` : 'unknown';
const pad = (cells: string[][]): string[] => cells.map(row => row.map((cell, index) => index === row.length - 1 ? cell
  : cell.padEnd(Math.max(...cells.map(other => other[index]!.length)))).join('  ').trimEnd());
export function renderVersions(page: ToolVersionsPage): string {
  if (!page.items.length) return `${page.name}: no stored versions`;
  const lines = [`${page.name}: ${page.items.length} stored version${page.items.length === 1 ? '' : 's'}, newest first (current v${page.currentVersion})`,
    ...pad(page.items.map(row => [`v${row.version}`, row.changedAt ?? '', who(row.changedBy),
      row.changed === null ? (row.version === 1 ? 'created' : 'first stored version') : row.changed.join(', ') || 'no tracked change',
      row.sourceSha256 ? `sha256 ${row.sourceSha256.slice(0, 12)}` : '']))];
  if (page.items.some(row => row.previousVersion !== null && row.previousVersion !== row.version - 1)) lines.push(`note: ${FOLDED_VERSIONS_NOTE}`);
  if (page.nextCursor) lines.push(`more: tm8 tool versions ${page.name} --cursor ${page.nextCursor}`);
  return lines.join('\n');
}
export function renderDiff(result: ToolDiffResult): string {
  if (result.diff) return result.diff.replace(/\n$/, '');
  const others = result.changed.filter(field => field !== 'source');
  return `no source change between ${result.name} v${result.from.version} and v${result.to.version}${others.length ? `; changed: ${others.join(', ')}` : ''}`;
}
