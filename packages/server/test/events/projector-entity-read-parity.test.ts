/**
 * entity-read.ts ↔ projector.ts kind-dispatch parity.
 *
 * Every kind-dispatch site in `facade/entity-read.ts` (titleOf, excerptOf,
 * stateOf, contentOf) has a twin in `events/projector.ts` (titleOf, excerptOf,
 * stateOf over SummaryRow). Until this test, that parity was asserted only in
 * prose comments — miss the projector arm and an entity renders fine over REST
 * but is untitled in the event feed; miss the entity-read arm and the reverse.
 * Both files end in `default:` fallbacks, so TypeScript exhaustiveness can
 * never catch the miss. This test does, structurally:
 *
 *   1. every CoreEntityKind is dispatched in projector.ts;
 *   2. every kind dispatched in entity-read.ts is dispatched in projector.ts;
 *   3. every kind dispatched in projector.ts is dispatched in entity-read.ts,
 *      except a FROZEN legacy gap (see below) that predates this test.
 *
 * Together 1+3 force any NEW contract kind (memory, worktree, artifact, …) to
 * carry BOTH dispatch arms before this suite goes green.
 *
 * The kind list is parsed from the contract SOURCE, not imported: the union is
 * type-level (no runtime array exists), and vitest does not type-check, so a
 * `satisfies`-based exhaustiveness trick would be read by nobody. Parsing the
 * union literal keeps the test self-updating the moment a lane edits the
 * contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = join(__dirname, '..', '..');
const CONTRACT_SRC = join(SERVER_ROOT, '..', 'contract', 'src', 'contract.ts');
const ENTITY_READ_SRC = join(SERVER_ROOT, 'src', 'facade', 'entity-read.ts');
const PROJECTOR_SRC = join(SERVER_ROOT, 'src', 'events', 'projector.ts');

/**
 * Kinds the projector renders that entity-read.ts still sends to its
 * `default:` arms (title = the raw kind string, no typed state). This gap
 * predates this test. DO NOT ADD TO THIS LIST — a new kind belongs in both
 * files, in the same change as its contract entry; shrinking this list is the
 * only edit it should ever see.
 */
const FROZEN_LEGACY_ENTITY_READ_GAP = new Set(['spell', 'skill', 'commit']);

/**
 * Kinds whose contract entry has landed but whose dispatch arms are still
 * being built by a named in-flight lane. Each entry must name its owner; the
 * final test below forces the entry OUT of this set the moment both arms
 * exist. An entry with no active owner is a defect — treat it as red.
 */
const IN_FLIGHT_KINDS = new Map<string, string>([]);

function coreEntityKinds(): string[] {
  const src = readFileSync(CONTRACT_SRC, 'utf8');
  const union = /export type CoreEntityKind =([\s\S]*?);/.exec(src);
  if (!union) throw new Error(`CoreEntityKind union not found in ${CONTRACT_SRC}`);
  const body = union[1] ?? '';
  const kinds = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((k): k is string => k !== undefined);
  if (kinds.length < 15) {
    throw new Error(`CoreEntityKind parse degraded: only [${kinds}] — check the union syntax`);
  }
  return kinds;
}

/** Kinds a file dispatches on: every `case '<kind>'` whose literal is a core kind. */
function dispatchedKinds(file: string, kinds: readonly string[]): Set<string> {
  const src = readFileSync(file, 'utf8');
  const cased = new Set([...src.matchAll(/case '([a-z_:]+)'/g)].map((m) => m[1]));
  return new Set(kinds.filter((k) => cased.has(k)));
}

describe('entity-read ↔ projector kind-dispatch parity', () => {
  const kinds = coreEntityKinds();
  const inRead = dispatchedKinds(ENTITY_READ_SRC, kinds);
  const inProjector = dispatchedKinds(PROJECTOR_SRC, kinds);

  it('sanity: both files dispatch on kinds at all (the parser found real arms)', () => {
    expect(inRead.size).toBeGreaterThanOrEqual(11);
    expect(inProjector.size).toBeGreaterThanOrEqual(15);
  });

  it('every CoreEntityKind has a projector dispatch arm (untitled-in-feed guard)', () => {
    const missing = kinds.filter((k) => !inProjector.has(k) && !IN_FLIGHT_KINDS.has(k));
    expect(missing, `kinds in the contract with NO arm in projector.ts — these render as bare-kind/untitled rows in the event feed: ${missing}`).toEqual([]);
  });

  it('every kind entity-read dispatches is also dispatched by the projector', () => {
    const missing = [...inRead].filter((k) => !inProjector.has(k) && !IN_FLIGHT_KINDS.has(k));
    expect(missing, `kinds handled over REST but NOT in the event feed: ${missing}`).toEqual([]);
  });

  it('every kind the projector dispatches is dispatched by entity-read, minus the frozen legacy gap', () => {
    const missing = [...inProjector].filter(
      (k) => !inRead.has(k) && !FROZEN_LEGACY_ENTITY_READ_GAP.has(k) && !IN_FLIGHT_KINDS.has(k),
    );
    expect(missing, `kinds in the event feed but falling to entity-read defaults over REST (add the arm, do NOT grow the frozen list): ${missing}`).toEqual([]);
  });

  it('the frozen legacy gap only shrinks', () => {
    // If someone adds an entity-read arm for a legacy kind, force them to
    // delete it from the frozen list so the guard tightens permanently.
    const healed = [...FROZEN_LEGACY_ENTITY_READ_GAP].filter((k) => inRead.has(k));
    expect(healed, `now handled by entity-read — remove from FROZEN_LEGACY_ENTITY_READ_GAP: ${healed}`).toEqual([]);
  });

  it('in-flight exceptions are evicted the moment both arms land', () => {
    const done = [...IN_FLIGHT_KINDS.keys()].filter((k) => inRead.has(k) && inProjector.has(k));
    expect(done, `both arms now exist — remove from IN_FLIGHT_KINDS so the guard applies: ${done}`).toEqual([]);
  });
});
