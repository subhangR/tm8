/**
 * The `--terse` render projection (F5) — OPT-IN, one shape, chosen once.
 *
 * Under `--terse`, every EntitySummary-shaped node inside a structured payload
 * loses its DECORATION and keeps its WORK fields. A pure summary renders as
 *
 *   { projected: true, id, kind, title, version, parentId, excerpt?,
 *     createdBy: "<display name>", state }
 *
 * and a node that carries MORE than a summary (EntityDetail adds content,
 * hierarchy, connections, capabilities) keeps every extra field — content is
 * the point of a get — while shedding the same decoration. What goes:
 * counters, badges, spaceId, visibility, position, the four timestamps, and
 * the full `createdBy` ActorSummary (collapsed to its display name). Measured
 * at 18% of one real context payload; inferred 15-30% across structured reads.
 *
 * The projection is LOSSY BUT HONEST, and two rules are load-bearing:
 *
 *  - `version` and `state` are NEVER projected away. Version is optimistic
 *    concurrency — a caller who mutates from a versionless read conflicts on
 *    arrival. `state` carries status and acceptance counts — the actual
 *    work signals — and passes through VERBATIM, including any ActorSummaries
 *    nested inside it: those are work data, not decoration.
 *  - every projected node carries `projected: true`, so a reader can always
 *    tell a terse envelope from a full one, and `--full` is one flag away.
 *
 * Scope: the projection applies to `json` and `jsonl` output only. A human
 * render is already a projection — its renderer reads the FULL DTO and shows
 * what it chooses — so projecting its input would change what those renderers
 * can say without making any output smaller.
 *
 * Detection is structural, not schema-driven: an object carrying the summary's
 * unmistakable field combination (id, kind, title, version, createdBy,
 * counters, state) IS one, wherever it appears — a page item, a context root,
 * a parent list, a detail. One function at one boundary, so the terse shape
 * cannot drift per command.
 */

export type RenderMode = 'full' | 'terse';

/** UI decoration a work reader never consumes — dropped whole. */
const DECORATION: ReadonlySet<string> = new Set([
  'spaceId', 'position', 'visibility',
  'activityAt', 'createdAt', 'updatedAt', 'deletedAt',
  'counters', 'badges',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The field combination nothing but an EntitySummary (or its detail) carries. */
function isEntitySummary(v: unknown): v is Record<string, unknown> {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['kind'] === 'string' &&
    typeof v['title'] === 'string' &&
    typeof v['version'] === 'number' &&
    isRecord(v['createdBy']) &&
    isRecord(v['counters']) &&
    isRecord(v['state'])
  );
}

function terseSummary(full: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { projected: true };
  for (const [key, value] of Object.entries(full)) {
    if (DECORATION.has(key)) continue;
    if (key === 'createdBy') {
      // Collapsed to the one fact a work reader uses; the full ActorSummary
      // is one `--full` away.
      const actor = value as Record<string, unknown>;
      out[key] = typeof actor['displayName'] === 'string' ? actor['displayName'] : null;
      continue;
    }
    if (key === 'state') {
      // VERBATIM, never recursed into — see the module header.
      out[key] = value;
      continue;
    }
    // Detail extras (content, hierarchy, connections, …) stay, and any
    // summaries nested inside them project too.
    out[key] = projectTerse(value);
  }
  return out;
}

/**
 * Deep-walk a DTO, projecting every EntitySummary-shaped node. Everything
 * that is not one passes through unchanged.
 */
export function projectTerse(dto: unknown): unknown {
  if (Array.isArray(dto)) return dto.map(projectTerse);
  if (!isRecord(dto)) return dto;
  if (isEntitySummary(dto)) return terseSummary(dto);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dto)) out[key] = projectTerse(value);
  return out;
}
