import { NOUNS, commands } from '@tm8/cli/discovery';
import { describe, expect, it } from 'vitest';
import { homeRootKinds } from './home-rail';
import { GENERIC_ENTITY_COMMANDS, KIND_CLI_VOCABULARY, kindCliVocabulary } from './kind-nouns';
import { collectionKinds } from './registry';

/**
 * THE DRIFT GUARD for Entity Help's Toolkit. The vocabulary names nouns and
 * command paths, never their text; this holds every name to the LIVE catalog
 * (`@tm8/cli/discovery`, the rows `tm8 help` prints) so a renamed verb fails
 * the build instead of silently emptying a help page.
 */
describe('KIND_CLI_VOCABULARY — kinds joined to the live help catalog', () => {
  const paths = new Set(commands().map((row) => row.command));

  it('every noun is a catalog noun', () => {
    const offenders: string[] = [];
    for (const [kind, row] of Object.entries(KIND_CLI_VOCABULARY)) {
      for (const noun of row.nouns) if (!NOUNS.includes(noun)) offenders.push(`${kind} → ${noun}`);
    }
    expect(offenders).toEqual([]);
  });

  it('every command path is a catalog command', () => {
    const offenders: string[] = [];
    for (const [kind, row] of Object.entries(KIND_CLI_VOCABULARY)) {
      for (const path of row.commands) if (!paths.has(path)) offenders.push(`${kind} → ${path}`);
    }
    for (const path of GENERIC_ENTITY_COMMANDS) if (!paths.has(path)) offenders.push(`generic → ${path}`);
    expect(offenders).toEqual([]);
  });

  it('every key is a collection kind — the dropdown population', () => {
    const known = new Set(collectionKinds().map((k) => k.kind));
    expect(Object.keys(KIND_CLI_VOCABULARY).filter((kind) => !known.has(kind))).toEqual([]);
  });

  it('every dropdown kind has a vocabulary row, so no baseline is generic by accident', () => {
    const missing = homeRootKinds()
      .map((k) => k.kind)
      .filter((kind) => KIND_CLI_VOCABULARY[kind] === undefined);
    expect(missing).toEqual([]);
  });

  it('an unknown kind still answers with the empty vocabulary, never undefined', () => {
    expect(kindCliVocabulary('c:never')).toEqual({ nouns: [], commands: [] });
  });
});
