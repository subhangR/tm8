/**
 * TITLE NORMALISATION, from registry data.
 *
 * Some kinds' titles are not free text. A channel's title IS its
 * `channels.name`, and that column is check-constrained to
 * `^[a-z0-9][a-z0-9_-]{0,79}$` (001_core_graph.sql:503; voice_channels 053:61
 * is the same grammar). The create/rename RPCs apply `lower(btrim())` only —
 * that normalises CASE and not SPACES — so "Untitled channel" and "Design
 * Review" were both refused by Postgres with an opaque `invariant_violation`,
 * which is what "I press create and save and nothing happens" actually was.
 *
 * The rule lives HERE because per-kind divergence is registry data (L2) and
 * `domain/` is where the §15.2 guards permit a kind to be named at all. The
 * editor takes the resulting function as a prop and stays kind-agnostic.
 */
import type { KindConfig } from './types';

/** Identity — the free-text default, so callers never branch on undefined. */
const asTyped = (raw: string): string => raw;

/**
 * Coerce to the channel-name grammar.
 *
 * Applied on every keystroke, so it must not fight the typist: a trailing `-`
 * is legal under the constraint, which is what lets "design " become "design-"
 * mid-word and then "design-review" without the caret jumping. Only the LEADING
 * character is restricted (`[a-z0-9]`), so leading punctuation is dropped
 * rather than turned into a dash the user would have to delete.
 */
export function slugifyTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 80);
}

/** The normaliser this kind's titles must pass through before they are sent. */
export function titleNormalizerFor(config: Pick<KindConfig, 'titleGrammar'>): (raw: string) => string {
  return config.titleGrammar === 'slug' ? slugifyTitle : asTyped;
}

/**
 * The title the generic-create pattern commits immediately — DISAMBIGUATED for
 * kinds whose name must be unique.
 *
 * `channels_space_id_name_key` makes the name unique per space, and the oracle's
 * create pattern commits a placeholder before the user has typed anything. Those
 * two facts collide on the SECOND create: the first `＋ New channel` takes
 * `untitled-channel` and every one after it is refused as a duplicate key. A
 * task placeholder may repeat; a handle may not.
 *
 * The suffix is therefore part of making the pattern legal for this kind at all,
 * not decoration — and it is short and lowercase so it survives `slugifyTitle`
 * and stays inside the 80-char limit. The user renames it immediately, which is
 * what the flow is for.
 */
export function placeholderNameFor(
  config: Pick<KindConfig, 'titleGrammar'>,
  placeholder: string,
): string {
  const normalized = titleNormalizerFor(config)(placeholder);
  if (config.titleGrammar !== 'slug') return normalized;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${normalized.slice(0, 80 - suffix.length - 1)}-${suffix}`;
}
