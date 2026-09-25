/**
 * The DEFAULT `entity get` projection under json/jsonl: bounded, not unbounded.
 *
 * An `EntityDetail` inlines the whole neighbourhood of an entity: every edge
 * group with two full EntitySummaries per edge, the parent, the path and the
 * first page of children. Measured on one working task: 34.5 KB of CLI json,
 * of which connections were 25 KB and hierarchy 12.8 KB, and 343 KB-1.86 MB on
 * the wire in live runs. Agents read it to learn one fact (a version, the
 * acceptance-criteria shape) and paid for all of it on every later turn.
 *
 * What this keeps: identity, `version` (optimistic concurrency, NEVER dropped),
 * `state` verbatim (status, assignees, acceptance counts are work data),
 * capabilities, and `content` with every long string capped. Structured
 * content (acceptanceCriteria and anything else that is not a long string)
 * passes through whole, because it is exactly what a caller rewrites.
 *
 * What it replaces: `hierarchy` and `connections` become COUNTS. The
 * relationships themselves are one bounded read away in `tm8 entity context`,
 * and the old envelope is one flag away in `--full`. Every cut is named in
 * `truncated`; nothing is dropped silently.
 *
 * CLI-side, by choice: `entities.get` has no query schema, and adding one is a
 * contract/catalog change in a lane other work is touching. The server still
 * builds the full detail, so this bounds what an agent READS, not what the
 * server sends.
 */

/** Characters kept of any one content string. Enough for a description's intent. */
export const CONTENT_STRING_CAP = 1000;

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An EntityDetail is the only DTO this projection touches. Anything else passes through. */
export function isEntityDetail(v: unknown): v is Rec {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['kind'] === 'string' &&
    (isRecord(v['hierarchy']) || isRecord(v['connections']))
  );
}

function ref(v: unknown): Rec | null {
  if (!isRecord(v)) return null;
  return { id: v['id'], kind: v['kind'], title: v['title'] };
}

function edgeCounts(groups: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(groups)) return out;
  for (const g of groups) {
    if (!isRecord(g) || typeof g['type'] !== 'string') continue;
    const n = Array.isArray(g['edges']) ? g['edges'].length : 0;
    // A group with a cursor has more edges than it inlined; say so rather than undercount.
    const more = typeof g['nextCursor'] === 'string' && g['nextCursor'].length > 0;
    out[g['type']] = (out[g['type']] ?? 0) + n;
    if (more) out[`${g['type']}+`] = 1;
  }
  return out;
}

export interface BoundedCut {
  field: string;
  shownChars: number;
  totalChars: number;
}

function capContent(content: unknown, cuts: BoundedCut[]): unknown {
  if (!isRecord(content)) return content;
  const out: Rec = {};
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string' && value.length > CONTENT_STRING_CAP) {
      out[key] = `${value.slice(0, CONTENT_STRING_CAP)}…`;
      cuts.push({ field: `content.${key}`, shownChars: CONTENT_STRING_CAP, totalChars: value.length });
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function boundEntityDetail(detail: Rec): Rec {
  const id = detail['id'] as string;
  const cuts: BoundedCut[] = [];
  const hierarchy = isRecord(detail['hierarchy']) ? detail['hierarchy'] : {};
  const children = isRecord(hierarchy['children']) ? hierarchy['children'] : {};
  const connections = isRecord(detail['connections']) ? detail['connections'] : {};
  const createdBy = detail['createdBy'];

  const out: Rec = {
    projection: 'bounded',
    id,
    kind: detail['kind'],
    title: detail['title'],
    version: detail['version'],
    parentId: detail['parentId'] ?? null,
    ...(detail['category'] === undefined ? {} : { category: detail['category'] }),
    createdBy: isRecord(createdBy) ? (createdBy['displayName'] ?? null) : (createdBy ?? null),
    state: detail['state'],
    ...(detail['capabilities'] === undefined ? {} : { capabilities: detail['capabilities'] }),
    content: capContent(detail['content'], cuts),
    // The selection header is itself the bounded summary: the server clips its
    // text to 400 + 600 chars and 12 × 40 keywords, and names a cut in `clipped`.
    ...(detail['header'] === undefined ? {} : { header: detail['header'] }),
    hierarchy: {
      parent: ref(hierarchy['parent']),
      depth: Array.isArray(hierarchy['path']) ? hierarchy['path'].length : 0,
      children: Array.isArray(children['items']) ? children['items'].length : 0,
      ...(typeof children['nextCursor'] === 'string' && children['nextCursor'].length > 0
        ? { moreChildren: true }
        : {}),
    },
    edgeCounts: {
      outgoing: edgeCounts(connections['outgoing']),
      incoming: edgeCounts(connections['incoming']),
      unresolvedHardDependencyCount: connections['unresolvedHardDependencyCount'] ?? 0,
    },
  };
  if (cuts.length > 0) out['truncated'] = cuts;
  out['next'] = {
    relationships: `tm8 entity context ${id}`,
    full: `tm8 entity get ${id} --full`,
  };
  return out;
}
