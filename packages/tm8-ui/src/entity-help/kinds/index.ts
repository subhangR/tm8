/**
 * THE KIND HELP REGISTRY — one authored module per kind, keyed by kind.
 *
 * HOW A WAVE ADDS A KIND. Write `kinds/<kind>.tsx` exporting a
 * `KindHelpModule` (copy `_template.tsx`), import it here, add it to
 * `MODULES`. That is the whole ceremony; `entity-help.test.tsx` checks every
 * registered module names a kind the dropdown offers and that its command
 * paths exist in the live catalog.
 *
 * The registry is EMPTY in Wave 0 by ruling: the theme and shell ship first,
 * the kinds' stories ship one wave at a time, in their own PRs, inside what
 * this module built. Every kind reads from the baseline until its wave
 * lands — which is the point of the baseline.
 *
 * Kind literals are legal in `kinds/*.tsx`: the §15.2 scan covers `panels/`
 * and the shell, and a per-kind content module naming its own kind is the
 * scan's stated purpose, not a breach of it.
 */
import type { KindHelpModule } from '../types';
import { MEMORY_HELP } from './memory';

const MODULES: readonly KindHelpModule[] = [MEMORY_HELP];

const BY_KIND: ReadonlyMap<string, KindHelpModule> = new Map(MODULES.map((module) => [module.kind, module]));

/** The authored module for a kind, or undefined when the baseline stands. */
export function kindHelpModule(kind: string): KindHelpModule | undefined {
  return BY_KIND.get(kind);
}

/** Every registered module — for the guide's checklist test. */
export function registeredHelpModules(): readonly KindHelpModule[] {
  return MODULES;
}
