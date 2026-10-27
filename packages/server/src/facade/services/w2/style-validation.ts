/**
 * The server's ONE seam onto the style resolver (styles spec 01a0fc22 v8 §1.5,
 * §8). Everything the facade needs from `@tm8/contract`'s style module — write-
 * time normalisation, resolve, ref parsing, export — is reached through this
 * file, so the server never grows a second opinion about what a style means:
 * the same functions run in the UI and the CLI.
 *
 * WHY A SEAM AND NOT DIRECT IMPORTS. The style contract is owned by another
 * lane; when its surface moves, this is the only server file that has to.
 */
import {
  BUILTIN_STYLES,
  BUILTIN_STYLE_IDS,
  CollabError,
  StyleDocSchema,
  exportStyle,
  normalizeStyleDoc,
  parseStyleRef,
  resolveStyle,
} from '@tm8/contract';
import type { ResolvedStyle, StyleClamp, StyleDoc, StyleWarning } from '@tm8/contract';

export type StyleRefKind = 'builtin' | 'personal' | 'space';

export interface ParsedStyleRef {
  kind: StyleRefKind;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every built-in id this node ships, as a set (the database does not know them). */
function builtinIds(): Set<string> {
  return new Set<string>(Object.keys(BUILTIN_STYLES));
}

export function isBuiltinId(id: string): boolean {
  return builtinIds().has(id);
}

/** The fallback every "no choice" path lands on (spec §3.5, §3.6). */
export const DEFAULT_STYLE_REF: string = BUILTIN_STYLE_IDS.light;

/**
 * A typed reference, or — for path params — a bare uuid, which the caller
 * resolves (personal first, then space; spec §5). Throws `invalid_input` on
 * anything else, and on a `builtin:` this node does not ship.
 */
export function parseRefOrUuid(raw: string): ParsedStyleRef | { kind: 'bare'; id: string } {
  const value = decodeURIComponent(raw).trim();
  if (UUID_RE.test(value)) return { kind: 'bare', id: value.toLowerCase() };
  const parsed = parseStyleRef(value);
  if (!parsed) {
    throw new CollabError('invalid_input',
      `not a style reference: "${value}" (expected builtin:<slug>, personal:<uuid> or space:<uuid>)`);
  }
  if (parsed.kind === 'builtin' && !isBuiltinId(value)) {
    throw new CollabError('not_found', `no built-in style "${value}" on this server`);
  }
  return parsed.kind === 'builtin' ? { kind: 'builtin', id: value } : { kind: parsed.kind, id: parsed.id };
}

/** A ref that must be typed (bodies): built-ins are checked against the shipped set. */
export function assertKnownRef(ref: string, field: string): void {
  const parsed = parseStyleRef(ref);
  if (!parsed) throw new CollabError('invalid_input', `${field}: not a style reference: "${ref}"`);
  if (parsed.kind === 'builtin' && !isBuiltinId(ref)) {
    throw new CollabError('invalid_input', `${field}: no built-in style "${ref}" on this server`);
  }
}

/** A built-in's document: the identity (foundation = itself, nothing set). */
export function builtinDoc(id: string): StyleDoc {
  return { schemaVersion: 1, foundation: id, vars: {}, css: null } as StyleDoc;
}

export function builtinTitle(id: string): string {
  return (BUILTIN_STYLES as Record<string, { title?: string }>)[id]?.title ?? id;
}

export function builtinRevision(id: string): number {
  return (BUILTIN_STYLES as Record<string, { builtinRevision?: number }>)[id]?.builtinRevision ?? 1;
}

export function resolveDoc(doc: StyleDoc): ResolvedStyle {
  return resolveStyle(doc);
}

export interface NormalizedWrite {
  doc: StyleDoc;
  warnings: StyleWarning[];
  clamped: StyleClamp[];
  hash: string;
}

/**
 * The WRITE path (spec §7 of the design, §8 of the spec): shape check, then
 * the resolver's own normalisation — clamped values stored clamped, unknown
 * keys and invalid values dropped with a warning, css replaced by its
 * sanitised text — then a resolve for the contrast lint and `resolved_hash`.
 * Only a document that is not a document at all is a 400.
 */
export function normalizeForWrite(candidate: unknown): NormalizedWrite {
  const shape = StyleDocSchema.safeParse(candidate);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    throw new CollabError('invalid_input',
      `style document: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'malformed'}`);
  }
  if (!isBuiltinId(shape.data.foundation)) {
    throw new CollabError('invalid_input', `style foundation "${shape.data.foundation}" is not a built-in on this server`);
  }
  const normalized = normalizeStyleDoc(shape.data);
  const resolved = resolveStyle(normalized.doc);
  return {
    doc: normalized.doc,
    warnings: mergeWarnings(normalized.warnings, resolved.warnings),
    clamped: normalized.clamped,
    hash: resolved.hash,
  };
}

/** Normalisation and resolve can both report a finding; say each once. */
function mergeWarnings(a: readonly StyleWarning[], b: readonly StyleWarning[]): StyleWarning[] {
  const seen = new Set<string>();
  const out: StyleWarning[] = [];
  for (const w of [...a, ...b]) {
    const key = JSON.stringify([w.code, (w as { key?: unknown }).key, w.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

export function exportDoc(doc: StyleDoc, format: 'css' | 'json', only: 'set' | 'all'): string {
  return exportStyle(doc, { format, only });
}
