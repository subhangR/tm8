/**
 * Which kinds carry a chat default (entity-chat design 01a0da4e §3.4).
 *
 * FROM THE REGISTRY, NEVER A HAND-WRITTEN LIST: every `allKinds()` row a chat
 * can be about — so not `message` or `chat` (the contract's exclusion list,
 * the same one `applyChatAbout` keeps), and not the `c:*` fallback row, which
 * is an archetype rather than a kind anyone chats about. The space's REAL
 * custom kinds (`entityKinds.list`, origin `custom`) are appended, so a kind
 * made yesterday gets its row with no code change.
 */
import { CHAT_DEFAULTS_EXCLUDED_KINDS, type EntityKindDef } from '@tm8/contract';
import { allKinds, CUSTOM_KIND_FALLBACK } from '../domain';

export interface ChatDefaultKindRow {
  kind: string;
  label: string;
  custom: boolean;
}

const EXCLUDED: ReadonlySet<string> = new Set<string>([...CHAT_DEFAULTS_EXCLUDED_KINDS, CUSTOM_KIND_FALLBACK]);

/** `c:bug_report` → `Bug report`. */
export function customKindLabel(kind: string): string {
  const name = kind.replace(/^c:/, '').replace(/_/g, ' ').trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : kind;
}

export function chatDefaultKindRows(customKinds: readonly Pick<EntityKindDef, 'kind' | 'origin'>[] = []): ChatDefaultKindRow[] {
  const rows: ChatDefaultKindRow[] = allKinds()
    .filter((row) => !EXCLUDED.has(row.kind))
    .map((row) => ({ kind: row.kind, label: row.label, custom: false }));
  const seen = new Set(rows.map((row) => row.kind));
  for (const def of customKinds) {
    if (def.origin !== 'custom' || seen.has(def.kind) || EXCLUDED.has(def.kind)) continue;
    seen.add(def.kind);
    rows.push({ kind: def.kind, label: customKindLabel(def.kind), custom: true });
  }
  return rows;
}
