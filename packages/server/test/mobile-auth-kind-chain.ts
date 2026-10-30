/**
 * Where the TM8 Mobile S4 auth-kind migration (task 01a1867c) runs in the chain:
 * the one place in packages/server/test that knows.
 *
 * The lane files it as `391_mobile_auth_kind.sql`. The space coordinator's
 * ordering rule renumbers a migration numbered below main's top to main's
 * max+1 at merge, so prod and a fresh database both apply it after everything
 * main had. That order is load-bearing: 395_bridge_schema.sql re-adds
 * auth_sessions_kind_check without 'mobile', and S4 must be the CHECK's last
 * writer.
 *
 * Tests find the file by its name suffix, never its number, so the Merger's
 * rename needs no edit here. `asMerged()` is the order main will run: S4 after
 * every file numbered at or below MAIN_TOP, main's top when this lane last
 * merged main. Once the Merger has renamed S4 above MAIN_TOP, `asMerged()` is
 * plain lexical order, so a later migration that drops 'mobile' is still
 * caught. Raise MAIN_TOP whenever the lane merges a newer main.
 */
export const S4_SUFFIX = '_mobile_auth_kind.sql';

/** main's highest migration number when the lane last merged main (29a71ce27: 396_authored_from_origin_index). */
export const MAIN_TOP = 396;

const numberOf = (file: string): number => Number.parseInt(file.slice(0, 3), 10);

/** The S4 migration among `files`; throws unless there is exactly one. */
export function s4File(files: readonly string[]): string {
  const found = files.filter((file) => file.endsWith(S4_SUFFIX));
  if (found.length !== 1) throw new Error(`expected one *${S4_SUFFIX} migration, found ${found.length}`);
  return found[0]!;
}

/** Lexically sorted `files` in the order main runs them once S4 is renumbered above MAIN_TOP. */
export function asMerged(files: readonly string[]): string[] {
  const s4 = s4File(files);
  const rest = files.filter((file) => file !== s4);
  const after = Math.max(MAIN_TOP, numberOf(s4));
  const at = rest.findIndex((file) => numberOf(file) > after);
  return at < 0 ? [...rest, s4] : [...rest.slice(0, at), s4, ...rest.slice(at)];
}
