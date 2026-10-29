import { createHash } from 'node:crypto';
import type { ActorSummary, ToolJsonValue } from '@tm8/contract';
import { columns, who } from './tool-views.js';

/** One `entities.versions` item as the Server sends it: the snapshot is the stored detail row. */
export interface EntityVersionItem {
  entityId: string; version: number; snapshot: unknown; changedBy: ActorSummary | null; changedAt: string | null;
}
export interface ToolVersionRef {
  /** The entity version of the stored write (the concurrency token `--expect-version` takes). */
  version: number;
  /**
   * The execution version this snapshot pins, the number runs record as `toolVersion`. It equals
   * `version` for a definition version; a configuration, secret or metadata write keeps the older one.
   */
  executionVersion: number | null;
  /**
   * True when a run can pin this version: the pin equals the entity version (every definition write
   * since migration 388), or the executable fields differ from the next older stored snapshot
   * (definition writes before 388, whose pin counted separately).
   */
  definition: boolean;
  changedAt: string | null; changedBy: ActorSummary | null;
  /** sha256 of the stored source: the same digest `tm8 tool runs` pins per run. */
  sourceSha256: string | null;
}
export interface ToolVersionRow extends ToolVersionRef {
  /** Fields that differ from the next older listed snapshot; null for the oldest one listed. */
  changed: string[] | null;
  previousVersion: number | null;
  configRevision: number | null;
}
export interface ToolVersionsPage {
  toolId: string; name: string;
  /** The tool's entity version and the execution version its runs pin now. */
  currentVersion: number; currentExecutionVersion: number;
  /** True when every stored write is listed (`--all`); false lists definition versions only. */
  all: boolean;
  items: ToolVersionRow[];
  /** `--all` pages through the Server; the cursor continues the next page. */
  nextCursor: string | null;
  /** Definition view: stored writes that are not definition versions, and definition versions past `--limit`. */
  hidden: number; truncated: number;
}
export interface ToolDiffResult {
  toolId: string; name: string; from: ToolVersionRef; to: ToolVersionRef;
  /** Every tracked field that differs between the two versions. */
  changed: string[];
  /** Unified diff of `definition.source`; empty when the source is identical. */
  diff: string;
}

/** Definition fields in ToolDefinition order, then the configuration a snapshot also carries. */
const FIELDS = ['name', 'description', 'runtime', 'source', 'inputs', 'help', 'tm8Access', 'timeoutSeconds'] as const;
/** The fields whose change bumps the execution version: what a run executes, and how. */
const EXECUTABLE: ReadonlySet<string> = new Set(['source', 'runtime', 'inputs', 'tm8Access', 'timeoutSeconds']);
export const FOLDED_VERSIONS_NOTE = 'versions written before migration 388 may have been folded, so not every version number has a stored snapshot';

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
export function changedFields(newer: EntityVersionItem, older: EntityVersionItem): string[] {
  const a = content(newer), b = content(older);
  return [...FIELDS.filter(field => canonical(a.definition[field]) !== canonical(b.definition[field])),
    ...(canonical(a.config) !== canonical(b.config) ? ['config'] : []),
    ...(canonical(a.secrets) !== canonical(b.secrets) ? ['secrets'] : [])];
}
/** `older` is the next older STORED snapshot, whatever kind of write it was; undefined for the first stored one. */
export function isDefinitionVersion(item: EntityVersionItem, older: EntityVersionItem | undefined): boolean {
  if (content(item).executionVersion === item.version || !older) return true;
  return changedFields(item, older).some(field => EXECUTABLE.has(field));
}
export function versionRef(item: EntityVersionItem, older: EntityVersionItem | undefined): ToolVersionRef {
  const source = snapshotSource(item);
  return { version: item.version, executionVersion: content(item).executionVersion, definition: isDefinitionVersion(item, older),
    changedAt: item.changedAt, changedBy: item.changedBy, sourceSha256: source === null ? null : createHash('sha256').update(source).digest('hex') };
}
/**
 * Rows for `items`, newest first. `older` is the stored snapshot just past them, when there is one.
 * With `definitionsOnly` the configuration and metadata writes drop out and each row's `changed`
 * names what differs from the next older DEFINITION version.
 */
export function versionRows(items: readonly EntityVersionItem[], older: EntityVersionItem | undefined, definitionsOnly = false): ToolVersionRow[] {
  const refs = items.map((item, index) => ({ item, ref: versionRef(item, items[index + 1] ?? older) }));
  const listed = definitionsOnly ? refs.filter(entry => entry.ref.definition) : refs;
  return listed.map((entry, index) => {
    const previous = listed[index + 1]?.item ?? (definitionsOnly ? undefined : older);
    return { ...entry.ref, changed: previous ? changedFields(entry.item, previous) : null, previousVersion: previous?.version ?? null,
      configRevision: content(entry.item).configRevision };
  });
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
export function renderVersions(page: ToolVersionsPage): string {
  if (!page.items.length) return `${page.name}: no stored versions`;
  const lines = [`${page.name}: ${plural(page.items.length, page.all ? 'stored write' : 'definition version')}, newest first (current v${page.currentExecutionVersion})`,
    columns(page.items.map(row => [`v${row.version}`, row.changedAt ?? '', who(row.changedBy),
      row.changed === null ? (row.version === 1 ? 'created' : 'first stored version') : row.changed.join(', ') || 'no tracked change',
      row.definition ? (row.sourceSha256 ? `sha256 ${row.sourceSha256.slice(0, 12)}` : '') : `definition v${row.executionVersion ?? '?'}`]))];
  if (page.all && page.items.some(row => row.previousVersion !== null && row.previousVersion !== row.version - 1)) lines.push(`note: ${FOLDED_VERSIONS_NOTE}`);
  if (page.hidden) lines.push(`hidden: ${plural(page.hidden, 'configuration or metadata write')}; --all lists every stored write`);
  if (page.truncated) lines.push(`more: ${plural(page.truncated, 'older definition version')}; drop --limit to list all`);
  if (page.nextCursor) lines.push(`more: tm8 tool versions ${page.name} --all --cursor ${page.nextCursor}`);
  return lines.join('\n');
}
export function renderDiff(result: ToolDiffResult): string {
  if (result.diff) return result.diff.replace(/\n$/, '');
  const others = result.changed.filter(field => field !== 'source');
  return `no source change between ${result.name} v${result.from.version} and v${result.to.version}${others.length ? `; changed: ${others.join(', ')}` : ''}`;
}
