/**
 * Message body wire format — the tokens a message body may carry.
 *
 * The data contract stores a message as plain `content.body` plus a typed
 * `content.mentions[]`. Two inline token forms give the body its richness
 * without inventing a second content model:
 *
 *   `{{embed:<entityId>}}` — a LIVE Z2 card of that entity, rendered in-flow
 *                            (the contract's own embed token; `placements`
 *                            with intent 'embed' writes exactly this).
 *   `{{ref:<entityId>}}`   — an inline Z1 chip for a `#entity` reference.
 *
 * `@mentions` need no token: the author's display text stays literal in the
 * body and `content.mentions[]` carries the entity ids, so a body read by a
 * non-UI consumer is still a sentence. `parseBody` re-attaches the chips by
 * matching each mention's `display` against the text.
 */
import type { EntityId, Mention } from '../../types/contract';

/** Mirrors `embedToken` from mock/internal — same shape, no mock import. */
export const embedToken = (entityId: EntityId): string => `{{embed:${entityId}}}`;
export const refToken = (entityId: EntityId): string => `{{ref:${entityId}}}`;

const TOKEN_RE = /\{\{(embed|ref):([^}\s]+)\}\}/g;

export type BodySegment =
  | { type: 'text'; text: string }
  | { type: 'embed'; entityId: EntityId }
  | { type: 'ref'; entityId: EntityId }
  | { type: 'mention'; entityId: EntityId; display: string; kind: Mention['kind'] };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits a plain text run on `@display` occurrences of the known mentions. */
function splitMentions(text: string, mentions: readonly Mention[]): BodySegment[] {
  if (!text) return [];
  const named = mentions.filter((m) => m.display.trim().length > 0);
  if (named.length === 0) return [{ type: 'text', text }];

  // Longest display first so "@Mira Chen" wins over "@Mira".
  const ordered = [...named].sort((a, b) => b.display.length - a.display.length);
  const re = new RegExp(`@(${ordered.map((m) => escapeRe(m.display)).join('|')})`, 'g');

  const out: BodySegment[] = [];
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    const hit = ordered.find((x) => x.display === m[1])!;
    out.push({ type: 'mention', entityId: hit.entityId, display: hit.display, kind: hit.kind });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/**
 * Body → renderable segments. Embeds and refs come from tokens; mentions come
 * from `content.mentions[]` matched against the literal text.
 */
export function parseBody(body: string, mentions: readonly Mention[] = []): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(body); m !== null; m = TOKEN_RE.exec(body)) {
    if (m.index > last) out.push(...splitMentions(body.slice(last, m.index), mentions));
    out.push(m[1] === 'embed'
      ? { type: 'embed', entityId: m[2] }
      : { type: 'ref', entityId: m[2] });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(...splitMentions(body.slice(last), mentions));
  return out;
}

/** Entity ids embedded as live cards in this body, in document order. */
export function embedIdsIn(body: string): EntityId[] {
  const out: EntityId[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(body); m !== null; m = TOKEN_RE.exec(body)) {
    if (m[1] === 'embed') out.push(m[2]);
  }
  return out;
}

/** Token-free text, for excerpts, titles and search previews. */
export function stripTokens(body: string): string {
  return body.replace(TOKEN_RE, '').replace(/\s{2,}/g, ' ').trim();
}

/** Appends an embed token to composer text, keeping exactly one separator. */
export function appendEmbed(value: string, entityId: EntityId): string {
  const token = embedToken(entityId);
  if (value.includes(token)) return value;
  return value.trim().length === 0 ? token : `${value.replace(/\s+$/, '')} ${token}`;
}

// ---------------------------------------------------------------------------
// Composer markup (react-mentions) ⇄ wire format
// ---------------------------------------------------------------------------

/** react-mentions markup for the `@` (actor) and `#` (entity) triggers. */
export const MENTION_MARKUP = '@[__display__](__id__)';
export const REF_MARKUP = '#[__display__](__id__)';

const MENTION_MARKUP_RE = /@\[([^\]]*)\]\(([^)]+)\)/g;
const REF_MARKUP_RE = /#\[([^\]]*)\]\(([^)]+)\)/g;

export interface ComposerDraft { body: string; mentions: Mention[] }

/**
 * Composer markup → the wire body. `@[Forge](tm_1)` becomes the literal
 * "@Forge" plus a `mentions[]` entry; `#[T-103](t_3)` becomes `{{ref:t_3}}`.
 * `{{embed:…}}` tokens (dropped chips) pass through untouched.
 */
export function draftFromMarkup(
  markup: string,
  kindOf: (entityId: EntityId) => Mention['kind'] = () => 'member',
): ComposerDraft {
  const mentions: Mention[] = [];
  const body = markup
    .replace(MENTION_MARKUP_RE, (_all, display: string, id: string) => {
      if (!mentions.some((m) => m.entityId === id)) {
        mentions.push({ entityId: id, kind: kindOf(id), display });
      }
      return `@${display}`;
    })
    .replace(REF_MARKUP_RE, (_all, _display: string, id: string) => refToken(id));
  return { body, mentions };
}

/**
 * The wire body → composer markup, so "edit" reopens what was written.
 * `{{ref:…}}` / `{{embed:…}}` tokens stay literal — they round-trip through
 * `draftFromMarkup` untouched, which is exactly what an edit needs.
 */
export function markupFromBody(body: string, mentions: readonly Mention[] = []): string {
  let out = body;
  for (const m of [...mentions].sort((a, b) => b.display.length - a.display.length)) {
    out = out.split(`@${m.display}`).join(`@[${m.display}](${m.entityId})`);
  }
  return out;
}
