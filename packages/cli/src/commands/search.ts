/**
 * `tm8 search query <text>` — the ASYMMETRIC half of the reserved pair.
 *
 * `search.query` and `bridge.fetchBlob` are both reserved, and they are handled
 * DIFFERENTLY on purpose:
 *
 *   search.query      gets this command, which answers honestly.
 *   bridge.fetchBlob  gets NO command, and stays discoverable only through
 *                     `tm8 help --operation bridge.fetchBlob`.
 *
 * The asymmetry is the point. `search` is a capability a caller will reach for
 * by name, so a missing command would read as "this tool cannot search" when
 * the truth is "this operation is catalogued and deliberately unbuilt". The
 * bridge is a Server-to-Server path no caller should ever invoke, so inventing
 * a command for it would be advertising a capability the matrices forbid.
 *
 * IT REFUSES LOCALLY AND SENDS NOTHING. Availability precedence is contract →
 * observed → advertised, and the contract verdict for a reserved row is final
 * on every node. Making the round trip to be told the same thing would burn a
 * request to learn something already known, and — worse — would let a
 * misconfigured node's 404 or HTML error page look like new information.
 */
import { CliError, EXIT_NOT_IMPLEMENTED, EXIT_USAGE, type ExitCode } from '../exit.js';
import type { Output } from '../output.js';
import { discoveryFor } from '../discovery/operations.js';

export function searchQuery(args: readonly string[], _out: Output): ExitCode {
  const text = args.join(' ').trim();
  if (text === '') {
    throw new CliError('tm8 search query requires the text to search for', EXIT_USAGE, {
      hint: 'tm8 search query "<text>" [--space <space-id>] [--kind <kind>...] [--limit <count>]',
    });
  }

  const row = discoveryFor('search.query');
  /* c8 ignore next 3 — unreachable while search.query is reserved in the frozen catalog. */
  if (row.availability !== 'unavailable') {
    throw new CliError('search.query is no longer reserved; this command needs implementing', EXIT_USAGE);
  }

  throw new CliError(
    'not_implemented: `search query` is a RESERVED row in the frozen operation catalog. ' +
      'It is catalogued so it is discoverable, and every tm8 node answers it with an honest 501 — ' +
      'it is not missing, and it is not a failure of this node.',
    EXIT_NOT_IMPLEMENTED,
    {
      hint:
        'query structurally instead: `tm8 entity query --kind <kind> ...` for entities, ' +
        '`tm8 graph query --focus <entity-id>` to traverse, or `tm8 message list <anchor-entity-id>` for a thread. ' +
        'Inspect the reserved row with `tm8 help --operation search.query`.',
    },
  );
}
