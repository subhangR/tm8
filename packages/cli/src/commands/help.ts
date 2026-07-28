/**
 * `tm8 help` — the five help surfaces that share one command, plus the human
 * renderings of their DTOs.
 *
 *   tm8 help                            root shard
 *   tm8 help <noun>                     noun shard
 *   tm8 help <noun> <verb>              command shard
 *   tm8 help --query <intent>           intent search
 *   tm8 help --operation <Operation>    exact lookup, total over all 101
 *
 * HELP IS DATA, NOT A DIAGNOSTIC. It is requested output, so it goes to STDOUT
 * and exits 0. Only a help request that cannot be ANSWERED — an unknown noun,
 * an unknown operation name — is a usage failure on stderr.
 *
 * Every human view here renders the SAME DTO `--format json` emits. There is no
 * second shape: if a field is missing from the human view it is a rendering
 * choice, and if a fact is in the human view it is in the DTO.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import type { Output } from '../output.js';
import type { OptionBag } from '../args.js';
import {
  commandHelp,
  nounHelp,
  operationHelp,
  rootHelp,
  searchHelp,
  type CommandHelp,
  type NounHelp,
  type RootHelp,
  type SearchHelp,
  type Truncation,
} from '../discovery/help.js';
// `UNBOUND_MARKER` is IMPORTED, never restated. This line used to hold its own
// literal, so the schema-line marker and the projection's `UNBOUND_NOTE` were
// two hand-maintained spellings of one fact and could disagree in silence —
// which is what happened: both said "yet", and fixing either alone would have
// left help contradicting itself on adjacent lines.
import { NOUNS, UNBOUND_MARKER, isCommandPath, isNoun } from '../discovery/operations.js';
import { isOperationName } from '@tm8/contract';

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/**
 * Availability rendered for a human. `unknown` says UNKNOWN — it is never
 * blank, and never quietly rendered as though it were fine.
 */
function availabilityLabel(availability: string, reason: string | null): string {
  if (availability === 'available') return '[available]';
  if (availability === 'unavailable') return `[unavailable: ${reason ?? 'unknown reason'}]`;
  return '[availability unknown]';
}

function truncationLines(t: Truncation | undefined): string[] {
  if (t === undefined) return [];
  return [
    '',
    `… ${t.omitted} more in "${t.section}" were omitted to stay inside the byte cap`,
    `  resume at: ${t.cursor ?? '(none)'}`,
    `  fetch:     ${t.fetch}`,
  ];
}

function renderRoot(dto: RootHelp): string {
  const width = Math.max(...dto.nouns.map((n) => n.name.length));
  const optWidth = Math.max(...dto.globalOptions.map((o) => o.option.length));
  return [
    'tm8 — the graph-native CLI for a tm8 Server',
    '',
    '  tm8 <noun> [<subnoun>] <verb> [arguments] [options]',
    '',
    'nouns',
    ...dto.nouns.map((n) => `  ${pad(n.name, width)}  ${n.summary}`),
    '',
    'global options',
    ...dto.globalOptions.map((o) => `  ${pad(o.option, optWidth)}  ${o.summary}`),
    '',
    'discovery',
    ...Object.values(dto.discovery).map((d) => `  ${d}`),
    '',
    `catalog ${dto.catalogDigest}  ·  grammar v${dto.grammarVersion}  ·  cli ${dto.cliVersion}`,
    ...truncationLines(dto.truncated),
  ].join('\n');
}

function renderNoun(dto: NounHelp): string {
  const width = Math.max(8, ...dto.commands.map((c) => c.command.length));
  const lines = [`${dto.noun} — ${dto.summary}`, ''];
  if (dto.commands.length > 0) {
    lines.push('commands');
    for (const c of dto.commands) {
      lines.push(
        `  ${pad(c.command, width)}  ${c.summary}`,
        `  ${pad('', width)}  ${availabilityLabel(c.availability, null)}`,
      );
    }
  }
  if (dto.operationsWithoutCommand.length > 0) {
    lines.push('', 'catalogued with NO cli command');
    for (const o of dto.operationsWithoutCommand) {
      lines.push(
        `  ${o.operation}  (${o.exposure}${o.reason ? `: ${o.reason}` : ''})`,
        o.publicComposite ? `    use instead: ${o.publicComposite}` : '    inspect: tm8 help --operation ' + o.operation,
      );
    }
  }
  lines.push('', `catalog ${dto.catalogDigest}`);
  lines.push(...truncationLines(dto.truncated));
  return lines.join('\n');
}

function renderCommand(dto: CommandHelp): string {
  const title = dto.command ?? dto.operations[0] ?? '(operation)';
  const lines = [
    `${title} — ${dto.summary}`,
    '',
    `exposure: ${dto.exposure}  ·  side effect: ${dto.sideEffect}  ·  idempotency: ${dto.idempotency}  ·  versioning: ${dto.versioning}`,
    `availability: ${availabilityLabel(dto.availability, dto.availabilityReason)} (source: ${dto.availabilitySource})`,
    '',
  ];

  if (dto.syntax !== null) {
    lines.push('syntax', `  ${dto.syntax}`, '');
  } else {
    // The gate rule: no invocation syntax is rendered for a row that has none.
    lines.push(
      'this operation has NO cli invocation, and will not be given one',
      dto.reason ? `  reason: ${dto.reason}` : '',
      dto.publicComposite ? `  use instead: ${dto.publicComposite}` : '',
      '',
    );
  }

  lines.push('operations', ...dto.operations.map((o) => `  ${o}`), '');
  lines.push(
    'schemas',
    `  input:  ${dto.inputSchemaRef ?? '(no request payload)'}${
      dto.inputSchemaRef !== null && !dto.inputSchemaBound ? `  ${UNBOUND_MARKER}` : ''
    }`,
    `  output: ${dto.outputSchemaRef ?? '(none)'}`,
    '',
  );

  if (dto.notes.length > 0) lines.push('notes', ...dto.notes.map((n) => `  - ${n}`), '');
  if (dto.trustNotes.length > 0) lines.push('trust', ...dto.trustNotes.map((n) => `  - ${n}`), '');
  if (dto.examples.length > 0) lines.push('examples', ...dto.examples.map((e) => `  ${e}`), '');
  if (dto.errorRefs.length > 0) lines.push('errors', `  ${dto.errorRefs.join('  ')}`, '');

  lines.push(`catalog ${dto.catalogDigest}`);
  lines.push(...truncationLines(dto.truncated));
  return lines.filter((l) => l !== '').join('\n');
}

function renderSearch(dto: SearchHelp): string {
  if (dto.matches.length === 0) {
    return [
      `no command matches "${dto.query}"`,
      '',
      'try a noun directly: tm8 help <noun>',
      `nouns: ${NOUNS.join(' ')}`,
    ].join('\n');
  }
  const lines = [`matches for "${dto.query}"`, ''];
  for (const m of dto.matches) {
    lines.push(
      `  ${m.command ?? `(no cli command) ${m.operation}`}  ${availabilityLabel(m.availability, null)}`,
      `    ${m.reason}`,
      `    ${m.command ? `tm8 help ${m.command}` : `tm8 help --operation ${m.operation}`}`,
      '',
    );
  }
  lines.push(`catalog ${dto.catalogDigest}`);
  lines.push(...truncationLines(dto.truncated));
  return lines.join('\n');
}

/** `tm8 <command> --help` — the shared renderer, so both routes agree exactly. */
export function emitCommandHelp(path: readonly string[], out: Output): ExitCode {
  const shard = commandHelp(path);
  /* c8 ignore next */
  if (shard === undefined) throw new CliError(`no help for \`tm8 ${path.join(' ')}\``, EXIT_USAGE);
  out.data(shard, renderCommand);
  return EXIT_OK;
}

export function help(args: readonly string[], options: OptionBag, out: Output): ExitCode {
  const operation = options.value('operation');
  if (operation !== undefined) {
    if (!isOperationName(operation)) {
      throw new CliError(`unknown catalog operation: ${operation}`, EXIT_USAGE, {
        hint: 'list what exists with `tm8 help --query <intent>`; operation names look like `messages.post`',
      });
    }
    const shard = operationHelp(operation);
    /* c8 ignore next */
    if (shard === undefined) throw new CliError(`no help for operation ${operation}`, EXIT_USAGE);
    out.data(shard, renderCommand);
    return EXIT_OK;
  }

  const query = options.value('query');
  if (query !== undefined) {
    out.data(searchHelp(query), renderSearch);
    return EXIT_OK;
  }

  if (args.length === 0) {
    out.data(rootHelp(), renderRoot);
    return EXIT_OK;
  }

  // Longest match first, so `tm8 help space task-axis create` resolves to the
  // three-token command rather than to the `space` noun with two stray args.
  for (let n = Math.min(3, args.length); n >= 2; n--) {
    const path = args.slice(0, n);
    if (isCommandPath(path)) return emitCommandHelp(path, out);
  }

  const noun = args[0] as string;
  if (isNoun(noun)) {
    const shard = nounHelp(noun);
    /* c8 ignore next */
    if (shard === undefined) throw new CliError(`no help for noun ${noun}`, EXIT_USAGE);
    out.data(shard, renderNoun);
    return EXIT_OK;
  }

  throw new CliError(`no help for \`${args.join(' ')}\``, EXIT_USAGE, {
    hint: `run \`tm8 help\` for the noun list, or \`tm8 help --query "${args.join(' ')}"\` to search by intent`,
  });
}
