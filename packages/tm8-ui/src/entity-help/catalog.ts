/**
 * THE LIVE CATALOG READ — Toolkit's commands come from here and nowhere else.
 *
 * `@tm8/cli/discovery` is the browser-reachable barrel over the CLI's own
 * operation catalog: the SAME rows `tm8 help <noun> --format json` serialises,
 * with the same summaries, syntax lines, notes and examples. The prompts
 * screen already reads it (`prompts/CliHelpBody.tsx`); Entity Help is the
 * second reader. Because the rows are imported, not copied, a verb renamed in
 * the CLI is renamed on every help page in the same build — and
 * `kind-nouns.test.ts` fails the build if a registry vocabulary names a
 * command the catalog no longer has.
 *
 * Availability is deliberately NOT rendered. The catalog's `availability`
 * ledger is a node-local observation the CLI makes as it runs; a browser has
 * not observed anything, and printing `[availability unknown]` on every row
 * would be noise that teaches nothing.
 */
import {
  CATALOG_DIGEST,
  commands,
  commandlessForNoun,
  commandsForNoun,
  nounSummary,
  type CommandDiscovery,
  type OperationDiscovery,
} from '@tm8/cli/discovery';
import { GENERIC_ENTITY_COMMANDS, kindCliVocabulary } from '../domain';

export type { CommandDiscovery, OperationDiscovery };

/** `sha256:…` — printed in the Toolkit's footer so a reader can match a binary. */
export const HELP_CATALOG_DIGEST: string = CATALOG_DIGEST;

let byPath: Map<string, CommandDiscovery> | null = null;

/** Every command, keyed by its space-joined path. Built once. */
function index(): Map<string, CommandDiscovery> {
  if (byPath === null) byPath = new Map(commands().map((row) => [row.command, row]));
  return byPath;
}

/** The catalog row for a path (`'task tick'`), or undefined when it has none. */
export function commandByPath(path: string): CommandDiscovery | undefined {
  return index().get(path);
}

/** Resolve paths in order, dropping the ones the catalog does not know. */
export function resolveCommands(paths: readonly string[]): CommandDiscovery[] {
  const out: CommandDiscovery[] = [];
  for (const path of paths) {
    const row = commandByPath(path);
    if (row && !out.includes(row)) out.push(row);
  }
  return out;
}

export interface KindToolkitCatalog {
  /** The nouns the kind owns, each with its catalog summary. */
  readonly nouns: readonly { name: string; summary: string }[];
  /** The kind's own commands: every command of its nouns, then its named extras. */
  readonly own: readonly CommandDiscovery[];
  /** The generic entity family, minus anything already in `own`. */
  readonly generic: readonly CommandDiscovery[];
  /** Operations of the kind's nouns that have no CLI invocation — listed, not hidden. */
  readonly commandless: readonly OperationDiscovery[];
}

/**
 * The live command set for a kind: registry vocabulary (`domain/kind-nouns`)
 * plus any nouns / paths an authored module adds. Pure over the catalog, so
 * the same kind always yields the same rows for one build.
 */
export function kindToolkitCatalog(
  kind: string,
  extra: { nouns?: readonly string[]; commands?: readonly string[] } = {},
): KindToolkitCatalog {
  const vocabulary = kindCliVocabulary(kind);
  const nounNames = [...new Set([...vocabulary.nouns, ...(extra.nouns ?? [])])];
  const own: CommandDiscovery[] = [];
  const push = (row: CommandDiscovery) => {
    if (!own.includes(row)) own.push(row);
  };
  for (const noun of nounNames) for (const row of commandsForNoun(noun)) push(row);
  for (const row of resolveCommands([...vocabulary.commands, ...(extra.commands ?? [])])) push(row);
  const generic = resolveCommands(GENERIC_ENTITY_COMMANDS).filter((row) => !own.includes(row));
  const commandless = nounNames.flatMap((noun) => [...commandlessForNoun(noun)]);
  return {
    nouns: nounNames.map((name) => ({ name, summary: nounSummary(name) })),
    own,
    generic,
    commandless,
  };
}

/** `tm8 task tick …` — the syntax as a reader types it. */
export function invocationOf(row: CommandDiscovery): string {
  return row.syntax.startsWith('tm8 ') ? row.syntax : `tm8 ${row.syntax}`;
}

/**
 * The lines a typed terminal plays for a set of commands: each command's
 * first catalog example, or its syntax when it has none. Prefixed with a
 * `#` comment naming the command so the reel reads as a demonstration.
 */
export function demoLinesFor(rows: readonly CommandDiscovery[], limit = 4): string[] {
  const lines: string[] = [];
  for (const row of rows.slice(0, limit)) {
    lines.push(`# ${row.summary}`);
    const example = row.examples[0] ?? invocationOf(row);
    lines.push(example.startsWith('tm8 ') ? example : `tm8 ${example}`);
  }
  return lines;
}
