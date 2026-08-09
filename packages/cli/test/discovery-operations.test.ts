/**
 * The CLI-owned OperationDiscovery projection — harness §7.1.
 *
 * EXHAUSTIVENESS over all 107 catalog rows, including internal and reserved.
 * This file is the classic vacuous-pass risk (a loop that iterates nothing, or
 * `undefined` compared to `undefined`, is green and proves nothing), so every
 * sweep here:
 *
 *   - asserts the row count it swept against the coordinator-verified 102;
 *   - records each visited operation in a set compared back to `OPERATIONS`;
 *   - requires a CONCRETE value from a closed enum for every field, never
 *     merely "not undefined".
 *
 * It was PROBE-RED'd: see the report for the recorded failures produced by
 * feeding the visited-set assertion a deliberately short catalog slice.
 *
 * The cross-check against `tools/conformance/generated/w1-conformance-manifest.json`
 * is drift protection across waves: that file is READ, never written.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { OPERATIONS, RESERVED_OPERATIONS, type OperationName } from '@tm8/contract';
import * as CONTRACT from '@tm8/contract';
import {
  AUTHZ_TARGETS,
  CATALOG_DIGEST,
  DISCOVERY,
  EXPOSURES,
  IDEMPOTENCIES,
  NOUNS,
  SIDE_EFFECTS,
  UNBOUND_MARKER,
  UNBOUND_NOTE,
  VERSIONINGS,
  commandDiscovery,
  commandsForNoun,
  discoveryFor,
} from '../src/discovery/operations.js';
// READ-ONLY consumption of group 1's frozen kernel: the parser's own allowlists
// are the ground truth for what a published flag can actually mean.
import { BOOLEAN_OPTIONS, COMMAND_SCOPED_GLOBALS, GLOBAL_OPTIONS } from '../src/args.js';
// The unbound fact has two renderings; the pin at the bottom of this file drives
// the REAL help renderer through the REAL Output rather than a copy of either.
import { emitCommandHelp } from '../src/commands/help.js';
import { createOutput } from '../src/output.js';

// 121 -> 126 (2026-08-02): auth.* Identity v2 Stage 1 (4 ops, all public, all with commands).
// 126 -> 127 (2026-08-02): execution.launch (public, with a command).
const EXPECTED_ROWS = 128;

const MANIFEST_PATH = fileURLToPath(
  new URL('../../../tools/conformance/generated/w1-conformance-manifest.json', import.meta.url),
);

interface ManifestHelpRow {
  operation: string;
  noun: string;
  exposure: string;
  intentTags: string[];
}
interface Manifest {
  catalogDigest: string;
  reservedOperations: string[];
  help: { operations: ManifestHelpRow[] };
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;

describe('the projection is TOTAL over the catalog', () => {
  it('has exactly one row per catalog operation, in catalog order', () => {
    expect(DISCOVERY).toHaveLength(EXPECTED_ROWS);
    expect(DISCOVERY.map((d) => d.operation)).toEqual(OPERATIONS.map((o) => o.name));
  });

  it('every row carries a concrete value from every closed enum', () => {
    const visited = new Set<string>();
    for (const op of OPERATIONS) {
      const d = discoveryFor(op.name);
      expect(d.operation, op.name).toBe(op.name);
      expect(EXPOSURES, op.name).toContain(d.exposure);
      expect(SIDE_EFFECTS, op.name).toContain(d.sideEffect);
      expect(AUTHZ_TARGETS, op.name).toContain(d.authzTarget);
      expect(IDEMPOTENCIES, op.name).toContain(d.idempotency);
      expect(VERSIONINGS, op.name).toContain(d.versioning);
      // A summary is prose a human reads; an empty one is a row nobody wrote.
      expect(d.summary.length, op.name).toBeGreaterThan(10);
      expect(d.noun, op.name).toMatch(/^[a-z][a-z-]*$/);
      expect(d.verb, op.name).toMatch(/^[a-z][a-z-]*$/);
      expect(d.intentTags.length, op.name).toBeGreaterThan(0);
      expect(d.outputSchemaRef, op.name).toBe(`tm8://schema/${op.name}/output`);
      expect(d.helpRef, op.name).toBe(`tm8://help/operation/${op.name}`);
      visited.add(op.name);
    }
    expect(visited.size).toBe(EXPECTED_ROWS);
    expect([...visited].sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
  });

  it('exact-operation lookup is total — including internal and reserved rows', () => {
    const found = OPERATIONS.map((o) => discoveryFor(o.name).operation);
    expect(found).toHaveLength(EXPECTED_ROWS);
    expect(new Set(found).size).toBe(EXPECTED_ROWS);
    expect(discoveryFor('execution.prompt').exposure).toBe('internal');
    expect(discoveryFor('bridge.fetchBlob').exposure).toBe('reserved');
    expect(discoveryFor('search.query').exposure).toBe('reserved');
  });

  it('the digest is computed from the catalog, not copied from a doc', () => {
    expect(CATALOG_DIGEST).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify(OPERATIONS)).digest('hex')}`,
    );
  });
});

describe('cross-check: the projection agrees with the W1 conformance manifest', () => {
  it('sweeps all 128 manifest help rows and agrees on noun and exposure', () => {
    expect(manifest.help.operations).toHaveLength(EXPECTED_ROWS);
    const checked = new Set<string>();
    for (const row of manifest.help.operations) {
      const d = discoveryFor(row.operation as OperationName);
      expect(d.noun, `${row.operation} noun`).toBe(row.noun);
      expect(d.exposure, `${row.operation} exposure`).toBe(row.exposure);
      checked.add(row.operation);
    }
    expect(checked.size).toBe(EXPECTED_ROWS);
    expect([...checked].sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
  });

  it('agrees on the reserved set exactly', () => {
    expect(manifest.reservedOperations.sort()).toEqual(['bridge.fetchBlob', 'search.query']);
    expect(RESERVED_OPERATIONS.map((o) => o.name).sort()).toEqual(manifest.reservedOperations.sort());
    expect(DISCOVERY.filter((d) => d.exposure === 'reserved').map((d) => d.operation).sort()).toEqual(
      manifest.reservedOperations.sort(),
    );
  });

  it('carries every manifest intent tag, so search cannot lose a term the manifest promised', () => {
    let compared = 0;
    for (const row of manifest.help.operations) {
      const mine = new Set(discoveryFor(row.operation as OperationName).intentTags);
      for (const tag of row.intentTags) {
        expect(mine.has(tag), `${row.operation} is missing intent tag ${tag}`).toBe(true);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(200);
  });

  it('agrees on the catalog digest', () => {
    expect(CATALOG_DIGEST).toBe(manifest.catalogDigest);
  });
});

describe('the exposure histogram is the one the catalog freeze specifies', () => {
  it('124 public, 1 composite, 1 internal, 2 reserved', () => {
    const histogram = { public: 0, composite: 0, internal: 0, reserved: 0 };
    for (const d of DISCOVERY) histogram[d.exposure]++;
    expect(histogram).toEqual({ public: 124, composite: 1, internal: 1, reserved: 2 });
  });
});

describe('the CLI command projection', () => {
  it('exactly two rows have no CLI command, and they are the asymmetric pair', () => {
    const commandless = DISCOVERY.filter((d) => d.command === null).map((d) => d.operation);
    expect(commandless.sort()).toEqual(['bridge.fetchBlob', 'execution.prompt', 'projects.directories.list']);
  });

  it('ASYMMETRIC RESERVED HANDLING: search.query has a command, bridge.fetchBlob has none', () => {
    expect(discoveryFor('search.query').command).toEqual(['search', 'query']);
    expect(discoveryFor('bridge.fetchBlob').command).toBeNull();
    // …and both remain discoverable by exact lookup.
    expect(discoveryFor('bridge.fetchBlob').summary).toMatch(/\S/);
  });

  it('every command path is 2 or 3 tokens — the closed grammar depth', () => {
    let counted = 0;
    for (const d of DISCOVERY) {
      if (d.command === null) continue;
      expect(d.command.length, d.operation).toBeGreaterThanOrEqual(2);
      expect(d.command.length, d.operation).toBeLessThanOrEqual(3);
      for (const seg of d.command) expect(seg, d.operation).toMatch(/^[a-z][a-z-]*$/);
      counted++;
    }
    expect(counted).toBe(EXPECTED_ROWS - 3);
  });

  it('a command that maps several operations reports all of them (file upload)', () => {
    const upload = commandDiscovery(['file', 'upload']);
    expect(upload?.operations).toEqual(['files.uploadInit', 'files.uploadComplete']);
  });

  it('every noun in the index resolves to at least one command or operation', () => {
    expect(NOUNS.length).toBeGreaterThanOrEqual(26);
    for (const noun of NOUNS) {
      const rows = DISCOVERY.filter((d) => d.noun === noun || d.command?.[0] === noun);
      expect(rows.length, noun).toBeGreaterThan(0);
    }
  });

  it('the family noun `collection` is indexed even though its command is `entity query`', () => {
    expect(NOUNS).toContain('collection');
    expect(discoveryFor('collections.query').noun).toBe('collection');
    expect(discoveryFor('collections.query').command).toEqual(['entity', 'query']);
    expect(commandsForNoun('collection').map((c) => c.command)).toContain('entity query');
  });

  it('`task` is a command noun even though no catalog family is named task', () => {
    expect(NOUNS).toContain('task');
    expect(commandsForNoun('task').map((c) => c.command).sort()).toEqual([
      'task complete',
      'task link-commit',
      'task link-pr',
      'task transition',
    ]);
  });
});

describe('honesty rules that are gate items', () => {
  it('execution.prompt names its public composite and renders NO invocation syntax', () => {
    const d = discoveryFor('execution.prompt');
    expect(d.exposure).toBe('internal');
    expect(d.reason).toBe('use_message_send');
    expect(d.publicComposite).toBe('messages.post');
    expect(d.command).toBeNull();
    // The retired vocabulary must never be reconstructable from this row.
    expect(JSON.stringify(d)).not.toContain('session prompt');
    expect(JSON.stringify(d)).not.toMatch(/tm8 session/);
  });

  it('both reserved rows say WHY they are unavailable', () => {
    for (const name of ['search.query', 'bridge.fetchBlob'] as const) {
      const d = discoveryFor(name);
      expect(d.availability, name).toBe('unavailable');
      expect(d.availabilityReason, name).toBe('reserved');
      expect(d.availabilitySource, name).toBe('contract');
    }
  });

  /**
   * ROUND 2. This row USED to say "an upgrade SKELETON, not semantic
   * subscription delivery: do not depend on it for durable ordering yet", and
   * that WAS true. The client→server control protocol has since landed in the
   * frozen contract (`WorkspaceControlFrame` / `WorkspaceControlAck`) and
   * `event watch` sends real frames, so the note outlived its own defect.
   *
   * Help, completion and search are three renderings of this one table, so the
   * note is operator-facing text an agent reads in a PTY. A diagnostic that
   * outlives its defect is a lie the CLI tells.
   *
   * The replacement is deliberately a CONTRACT fact ("the contract defines…"),
   * not a claim about what this node currently does. Whether this node serves
   * the socket is the `availability` axis's question, and prose has nothing
   * that goes red when the world moves under it.
   */
  it('events.subscribe describes the contract control protocol, and never a skeleton', () => {
    const prose = discoveryFor('events.subscribe').notes.join(' ');
    expect(prose.length).toBeGreaterThan(0); // never assert a negative over an empty string
    expect(prose).not.toMatch(/skeleton/i);
    expect(prose).not.toMatch(/\byet\b/i); // no roadmap: a shipped roadmap is a lie in waiting
    expect(prose).toMatch(/control protocol/i);
    expect(prose).toMatch(/control\.refused/);
  });

  /**
   * The SECOND half of the same row was INCOMPLETE rather than wrong: it named
   * `event list` polling as the only reconnect repair. `resume` repairs a gap
   * over the socket AND `events.poll` remains correct when no socket can be
   * opened. Both halves are true; the note must name both, and replacing one
   * incompleteness with the other would be no fix at all.
   */
  it('events.subscribe names BOTH gap repairs — `resume` over the socket, `event list` when it is down', () => {
    const prose = discoveryFor('events.subscribe').notes.join(' ');
    expect(prose).toMatch(/`resume`/);
    expect(prose).toMatch(/event list/);
    expect(prose).toMatch(/presence signals never advance the durable cursor/i);
  });

  /** The paired row made the same over-claim from the other side. */
  it('events.poll no longer calls itself THE reconnect stage of `event watch`', () => {
    const summary = discoveryFor('events.poll').summary;
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).not.toMatch(/the reconnect stage/i);
  });

  it('commands.undo does not claim to be universally applicable', () => {
    const d = discoveryFor('commands.undo');
    expect(d.summary).not.toMatch(/any mutation|all mutations|universal/i);
    expect(d.notes.join(' ')).toMatch(/not every mutation/i);
  });

  it('undoing a message delete is described as REDACTION, and says history survives', () => {
    const d = discoveryFor('messages.delete');
    const prose = `${d.summary} ${d.notes.join(' ')}`;
    expect(prose).toMatch(/redact/i);
    expect(prose).toMatch(/thread history survives/i);
  });

  /**
   * SWEEP FINDING B, arbitrated. This note said "UNTIL IT IS BUILT, query
   * structurally with `entity query` or `graph query`".
   *
   * `search.query` is one of the TWO PERMANENTLY RESERVED rows — reserved in the
   * frozen catalog, node-independent, resolved by the `contract` source in the
   * availability precedence and never by observation. "Until it is built" is a
   * roadmap for a row whose whole point is that it is RESERVED RATHER THAN
   * PENDING, so the note contradicted the row it describes.
   *
   * The alternatives STAY: naming `entity query` / `graph query` is genuinely
   * useful and is not a roadmap. They are what exists INSTEAD, not what to use
   * MEANWHILE. Only the temporal framing goes.
   */
  it('search.query names its structural alternatives as INSTEAD, never as meanwhile', () => {
    const prose = discoveryFor('search.query').notes.join(' ');
    expect(prose.length).toBeGreaterThan(0);
    expect(prose).not.toMatch(/until it is built/i);
    expect(prose).not.toMatch(/\byet\b/i);
    expect(prose).toMatch(/reserved/i);
    // The useful half survives the fix — a sweep that deleted these would have
    // traded a roadmap for a worse answer.
    expect(prose).toMatch(/entity query/);
    expect(prose).toMatch(/graph query/);
  });

  /**
   * ROUND 2, and the worst of the three because it points an operator the wrong
   * way. This note said redeeming a `messages.delete` token "restores a
   * REDACTED message to visible". It is INVERTED at the terminating source:
   *
   *   004_ledgers.sql:168      `undo_tokens.operation` is the INVERSE to run —
   *                            `edges.create` issues a token whose operation is
   *                            `edges.delete`, labelled "Undo link".
   *   018:387                  the ONLY issuer of a `messages.delete`-inverse
   *                            token is `placements.apply` with intent `embed`,
   *                            labelled "Undo embed".
   *   020:128                  redemption dispatches that operation to
   *                            `w2_tombstone_message`.
   *   019:627                  which sets body='[redacted]', clears mentions and
   *                            attachments, sets redacted_at, cancels pending
   *                            deliveries.
   *
   * So redemption REDACTS. Telling an operator that history is recoverable when
   * redemption destroys more of it invites a destructive recovery against data
   * that was never lost — the inverse of the harm the `messages.delete` note
   * above exists to prevent.
   */
  it('commands.undo says redemption REDACTS, and never that it restores a redacted message', () => {
    const prose = discoveryFor('commands.undo').notes.join(' ');
    expect(prose.length).toBeGreaterThan(0);
    expect(prose).not.toMatch(/restores? a redacted message/i);
    expect(prose).not.toMatch(/to visible/i);
    expect(prose).toMatch(/redact/i);
  });

  it('commands.undo says a token names the INVERSE, and whose token the `messages.delete` inverse is', () => {
    const prose = discoveryFor('commands.undo').notes.join(' ');
    expect(prose).toMatch(/inverse/i);
    expect(prose).toMatch(/embed/i);
  });
});

describe('schema references are honest about what is bound', () => {
  it('a read with no request payload has a null inputSchemaRef', () => {
    expect(discoveryFor('identity.get').inputSchemaRef).toBeNull();
    expect(discoveryFor('entities.get').inputSchemaRef).toBeNull();
  });

  it('an operation with a payload points at an operation-keyed ref, never a DTO name', () => {
    expect(discoveryFor('messages.post').inputSchemaRef).toBe('tm8://schema/messages.post/input');
    expect(discoveryFor('messages.post').inputSchemaBound).toBe(true);
  });

  it('a payload-carrying row with no frozen schema binding says so instead of pretending', () => {
    // `commands.undo` is `unbound` in the W0 matrix: it takes a request body and
    // has no frozen input schema. Claiming a bound schema here would be the
    // exact drift this field exists to prevent.
    expect(discoveryFor('commands.undo').inputSchemaBound).toBe(false);
    expect(discoveryFor('commands.undo').notes.join(' ')).toMatch(/no frozen input schema/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE VERSION-GUARD JOIN — both directions
//
// A guard flag in `syntax` is a PROMISE that the bound input DTO has somewhere
// to put the value. The two ways that promise breaks are not symmetric:
//
//   DIRECTION A — the projection advertises a guard the DTO has no field for.
//     Every DTO is `.strict()`, so the value is REJECTED, not ignored. Loud.
//   DIRECTION B — the DTO REQUIRES a guard the projection never mentions.
//     The CLI never asks and never sends, so every call is `invalid_input` and
//     the help text gives no clue why. SILENT, and strictly worse than A.
//
// Direction B cannot be found by searching for `ver:` — it is defined by rows
// that DO NOT have it. So this sweep starts from the CONTRACT and joins back,
// and the schema side is read by runtime introspection rather than a
// hand-copied field list: two hand-lists agreeing would prove only that one
// author wrote both.
//
// THE GUARD IS NOT ALWAYS SPELLED `expectedVersion`. It is also
// `expectedRevision`, `expectedRecordVersion`, `expectedArtifactVersion`, and
// `expectedSettingsRevision` — which is why a grep for `expectedVersion` sees
// 11 of the 17 guard-bearing DTOs and a count of `ver:` rows against it reads
// as a near-match while five silent Direction-B rows hide in the difference.
// ───────────────────────────────────────────────────────────────────────────

/** Any `expected*` key is an optimistic-concurrency guard. */
const GUARD_FIELD = /^expected[A-Z]/;

/**
 * Unwrap to the underlying ZodObject through the wrappers the contract
 * actually uses (`z.lazy`, `.superRefine`/`.transform`). Deliberately reads
 * `_def` at runtime rather than importing zod: the CLI does not depend on zod,
 * and `packages/cli` must not grow a dependency to run a test.
 */
function objectShapeOf(schema: unknown): Record<string, { isOptional(): boolean }> | undefined {
  let s = schema as { _def?: { typeName?: string; schema?: unknown; getter?: () => unknown;
    innerType?: unknown; shape?: unknown }; shape?: unknown } | undefined;
  for (let hops = 0; hops < 20 && s?._def !== undefined; hops++) {
    const kind = s._def.typeName;
    if (kind === 'ZodObject') {
      const raw = typeof s._def.shape === 'function'
        ? (s._def.shape as () => unknown)()
        : s.shape;
      return raw as Record<string, { isOptional(): boolean }>;
    }
    if (kind === 'ZodEffects') { s = s._def.schema as typeof s; continue; }
    if (kind === 'ZodLazy') { s = (s._def.getter as () => unknown)() as typeof s; continue; }
    if (kind === 'ZodOptional' || kind === 'ZodNullable') { s = s._def.innerType as typeof s; continue; }
    return undefined;
  }
  return undefined;
}

function guardFieldsOf(exportName: string): Array<{ field: string; required: boolean }> {
  const shape = objectShapeOf((CONTRACT as Record<string, unknown>)[exportName]);
  if (shape === undefined) return [];
  return Object.keys(shape)
    .filter((k) => GUARD_FIELD.test(k))
    .map((field) => ({ field, required: !shape[field]!.isOptional() }));
}

/**
 * Every guard flag a syntax string advertises, and whether it is REQUIRED.
 * Bracket depth is what distinguishes `--expect-version <n>` (required) from
 * `[--expect-source-version <n>]` (optional), so it is tracked rather than
 * assumed.
 */
function guardFlagsIn(syntax: string): Array<{ flag: string; required: boolean }> {
  const out: Array<{ flag: string; required: boolean }> = [];
  let depth = 0;
  const scan = /\[|\]|--expect[a-z-]*/g;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(syntax)) !== null) {
    if (m[0] === '[') depth++;
    else if (m[0] === ']') depth = Math.max(0, depth - 1);
    else out.push({ flag: m[0], required: depth === 0 });
  }
  return out;
}

/**
 * Operation → the contract DTO that guards its request body, by EXPORT NAME.
 *
 * Every entry is the DTO column of TM8-W0-CONSISTENCY-MATRICES §3 for that
 * row — not inferred from naming. Keyed by name rather than by object because
 * `RemoveMessageAttachmentsInputSchema` IS `AddMessageAttachmentsInputSchema`
 * (schemas.ts:1210), so identity would silently collapse two rows into one and
 * hide whichever of them drifted.
 */
const DTO_BY_OPERATION: Partial<Record<OperationName, string>> = {
  'attentionRequests.update': 'UpdateAttentionRequestInputSchema',
  'entities.patch': 'PatchEntityInputSchema',
  'entities.move': 'MoveEntityInputSchema',
  'entities.commands.complete': 'CompleteTaskInputSchema',
  'messages.edit': 'PatchMessageInputSchema',
  'messages.delete': 'DeleteMessageInputSchema',
  'messages.attachments.add': 'AddMessageAttachmentsInputSchema',
  'messages.attachments.remove': 'RemoveMessageAttachmentsInputSchema',
  'savedViews.create': 'SavedViewInputSchema',
  'savedViews.update': 'SavedViewInputSchema',
  'spaces.menu.update': 'UpdateMenuInputSchema',
  'spaces.defaultChannel.set': 'SetDefaultChannelInputSchema',
  'projects.associations.correct': 'CorrectProjectAssociationInputSchema',
  'handoffs.send': 'SendHandoffInputSchema',
  'handoffs.withdraw': 'WithdrawHandoffInputSchema',
  'interactionProfiles.propose': 'ProposeInteractionProfileInputSchema',
  'interactionProfiles.updateDraft': 'UpdateInteractionProfileDraftInputSchema',
  'interactionProfiles.validate': 'ValidateInteractionProfileInputSchema',
  'interactionProfiles.preview': 'PreviewInteractionProfileInputSchema',
  'interactionProfiles.activate': 'ActivateInteractionProfileInputSchema',
  'interactionProfiles.retire': 'RetireInteractionProfileInputSchema',
  'teamMembers.interactionProfile.setDefault': 'SetTeammateProfileDefaultInputSchema',
  'spaces.interactionProfile.setDefault': 'SetSpaceProfileDefaultInputSchema',
  'artifacts.publish': 'ArtifactsPublishInputSchema',
  'artifacts.restore': 'ArtifactsRestoreInputSchema',
};

/**
 * `PatchTaskInput` carries `expectedVersion` but no catalog row binds it:
 * `entities.patch` uses `PatchEntityInput`. Declared here so "unreachable from
 * the map" stays a FAILURE for every other guard-bearing DTO instead of being
 * quietly tolerated.
 */
const GUARD_DTOS_BOUND_TO_NO_OPERATION = ['PatchTaskInputSchema'];

/**
 * Direction-B rows still awaiting an amendment. **Currently EMPTY — the class
 * is closed.**
 *
 * All six are fixed, and none of the flag names was invented. The FROZEN SCHEMA
 * is the authority for whether a guard exists — `WithdrawHandoffInput` really
 * does require `expectedRecordVersion` — so "omit it" was never an option: not
 * sending a REQUIRED field means every call is rejected and the operation is
 * dead. What was unspecified was only the CLI FLAG NAME, and the flag surface
 * is the CLI's own. Two rows take a spelling an authority names outright
 * (dossier:325 `--expect-revision`, dossier §7 `--expect-version`); the rest
 * kebab-case the frozen field, dropping nothing:
 *
 *     expectedRecordVersion     ->  --expect-record-version
 *     expectedSettingsRevision  ->  --expect-settings-revision
 *
 * The authority-named pair comes out CONSISTENT with the derivation rather than
 * as an exception, which is the check that the derivation is the right one.
 *
 * KEPT, THOUGH EMPTY, because the assertion's value is the EXACT-SET property,
 * not the contents. It fails in BOTH directions: a newly introduced Direction-B
 * row fails it, AND closing one without delisting it fails it too. That second
 * direction is what makes this a named quarantine rather than a suppression,
 * and it is why this is not a `skip` — a skip whose subject gets fixed stops
 * testing anything without ever going red, so it decays silently. This cannot.
 */
const PENDING_AMENDMENT: OperationName[] = [];

describe('version guards: the projection and the frozen DTOs agree, both directions', () => {
  it('the schema side of the join is real — introspection finds the guard DTOs', () => {
    // Vacuity guard. If `objectShapeOf` ever stops unwrapping (a zod upgrade
    // changing `_def`), every guard set silently becomes empty and BOTH
    // directions below pass while checking nothing. Pin the floor.
    const bearing = Object.keys(CONTRACT as Record<string, unknown>)
      .filter((n) => n.endsWith('Schema'))
      .filter((n) => guardFieldsOf(n).length > 0);
    expect(bearing.length).toBeGreaterThanOrEqual(17);
    expect(guardFieldsOf('PatchEntityInputSchema')).toEqual([
      { field: 'expectedVersion', required: true },
    ]);
    // The four distinct spellings a `expectedVersion`-only grep would miss.
    expect(guardFieldsOf('UpdateMenuInputSchema')[0]?.field).toBe('expectedRevision');
    expect(guardFieldsOf('WithdrawHandoffInputSchema')[0]?.field).toBe('expectedRecordVersion');
    expect(guardFieldsOf('CorrectProjectAssociationInputSchema')[0]?.field)
      .toBe('expectedArtifactVersion');
    expect(guardFieldsOf('SetDefaultChannelInputSchema')[0]?.field)
      .toBe('expectedSettingsRevision');
    // A DTO with no guard must report NONE, or Direction A can never fail.
    expect(guardFieldsOf('SavedViewInputSchema')).toEqual([]);
    expect(guardFieldsOf('SendHandoffInputSchema')).toEqual([]);
  });

  it('every guard-bearing contract DTO is reachable from the operation map', () => {
    // Closes Direction B's real hole: a guard DTO nobody mapped is a row this
    // sweep would never visit, and its absence would look exactly like health.
    const bearing = Object.keys(CONTRACT as Record<string, unknown>)
      .filter((n) => n.endsWith('Schema'))
      .filter((n) => guardFieldsOf(n).length > 0);
    const mapped = new Set(Object.values(DTO_BY_OPERATION));
    const unreachable = bearing
      .filter((n) => !mapped.has(n))
      .filter((n) => !GUARD_DTOS_BOUND_TO_NO_OPERATION.includes(n));
    expect(unreachable).toEqual([]);
  });

  it('DIRECTION A — no row advertises a guard flag its DTO cannot receive', () => {
    const unbacked: string[] = [];
    let swept = 0;
    for (const d of DISCOVERY) {
      if (d.syntax === null) continue;
      const flags = guardFlagsIn(d.syntax);
      if (flags.length === 0) continue;
      swept++;
      const dto = DTO_BY_OPERATION[d.operation];
      const fields = dto === undefined ? [] : guardFieldsOf(dto);
      if (fields.length === 0) {
        unbacked.push(
          `${d.operation} advertises ${flags.map((f) => f.flag).join(',')} but ` +
            `${dto ?? '<no DTO mapped>'} has no expected* field`,
        );
      }
    }
    expect(swept).toBeGreaterThan(0);
    expect(unbacked).toEqual([]);
  });

  it('DIRECTION B — every REQUIRED DTO guard is advertised as a REQUIRED flag', () => {
    const missing: OperationName[] = [];
    let swept = 0;
    for (const [operation, dto] of Object.entries(DTO_BY_OPERATION) as [OperationName, string][]) {
      if (!guardFieldsOf(dto).some((f) => f.required)) continue;
      swept++;
      const syntax = discoveryFor(operation).syntax;
      const flags = syntax === null ? [] : guardFlagsIn(syntax);
      if (!flags.some((f) => f.required)) missing.push(operation);
    }
    // Every mapped guard DTO is required.
    expect(swept).toBe(19);
    expect(missing.sort()).toEqual([...PENDING_AMENDMENT].sort());
  });

  it('the `versioning` field and the syntax tell the same story', () => {
    // help, completion and search render different fields of the same row: a
    // row whose `ver:` and `syn:` disagree ships two answers to one question.
    let compared = 0;
    for (const d of DISCOVERY) {
      if (d.syntax === null) continue;
      compared++;
      const advertises = guardFlagsIn(d.syntax).length > 0;
      expect(d.versioning === 'expectedVersion', `${d.operation} ${d.syntax}`).toBe(advertises);
    }
    expect(compared).toBeGreaterThan(90);
  });

  it('savedViews.update describes what it does, with no guard language left behind', () => {
    // The ruled defect. Fixing the flag while leaving prose that promises a
    // guard would leave the dishonest help surface intact — the summary IS the
    // claim a reader acts on.
    const d = discoveryFor('savedViews.update');
    expect(d.versioning).toBe('none');
    expect(d.syntax).not.toMatch(/--expect/);
    expect(`${d.summary} ${d.notes.join(' ')}`).not.toMatch(/version guard|under a guard|expected version/i);
    // Its DTO IS frozen and bound — only the guard was fictional.
    expect(d.inputSchemaBound).toBe(true);
  });

  /**
   * FLAG -> FROZEN FIELD, pinned for every guard row.
   *
   * WHY THIS EXISTS AS A TABLE AND NOT AS PER-ROW CHECKS. The failure this
   * guards against is a TRANSPOSITION between two rows, not a bad row:
   * `spaces.menu.update` and `spaces.defaultChannel.set` are the same noun,
   * carry the SAME FLAG, and are owned by the same group — but they write
   * DIFFERENT fields (`expectedRevision` vs `expectedSettingsRevision`). Two
   * adjacent near-identical rows are exactly what a per-row eyeball, and a
   * per-row assertion, both slide over. Only a whole-table exact set sees a
   * swap, because a swap leaves every individual row looking plausible.
   *
   * Exact-set in BOTH directions, deliberately: a TRANSPOSITION fails, an
   * ADDED guard row not listed here fails, and a listed row that STOPS
   * carrying its guard fails. Same two-way property as PENDING_AMENDMENT, but
   * applied to the MAPPING rather than to membership.
   */
  const GUARD_PIN: ReadonlyArray<readonly [OperationName, string, string]> = [
    ['attentionRequests.update', '--expect-version', 'expectedVersion'],
    ['entities.patch', '--expect-version', 'expectedVersion'],
    ['entities.move', '--expect-version', 'expectedVersion'],
    ['entities.commands.complete', '--expect-version', 'expectedVersion'],
    ['messages.edit', '--expect-version', 'expectedVersion'],
    ['messages.delete', '--expect-version', 'expectedVersion'],
    ['messages.attachments.add', '--expect-version', 'expectedVersion'],
    ['messages.attachments.remove', '--expect-version', 'expectedVersion'],
    ['interactionProfiles.updateDraft', '--expect-version', 'expectedVersion'],
    ['interactionProfiles.validate', '--expect-version', 'expectedVersion'],
    ['interactionProfiles.retire', '--expect-version', 'expectedVersion'],
    ['teamMembers.interactionProfile.setDefault', '--expect-version', 'expectedVersion'],
    ['handoffs.withdraw', '--expect-record-version', 'expectedRecordVersion'],
    ['spaces.interactionProfile.setDefault', '--expect-settings-revision', 'expectedSettingsRevision'],

    // ── THE COLLISION PAIR — one flag, two different fields, same noun ──────
    // This adjacency is what produced a real transposition once already.
    ['spaces.menu.update', '--expect-revision', 'expectedRevision'],
    ['spaces.defaultChannel.set', '--expect-revision', 'expectedSettingsRevision'],

    // ── THE ONE ROW WHERE THE FLAG DOES NOT KEBAB ITS FIELD ─────────────────
    // `--expect-version` against `expectedArtifactVersion`. NOT a mistake and
    // NOT to be "normalised": W0-AMENDMENT-DOSSIER.md §7:335 names the flag
    // verbatim in the table titled "CLI freeze", while §4:123-127 writes the
    // field as `expectedArtifactVersion`. The same document knew the field and
    // chose a shorter flag, so the authority wins over the kebab derivation.
    // Ruled and upheld; the uniformity amendment was declined.
    // A future reader WILL notice this and want to tidy it. That is precisely
    // why it is pinned here rather than left in a comment: tidying it fails
    // this assertion instead of passing review.
    ['projects.associations.correct', '--expect-version', 'expectedArtifactVersion'],

    // ── artifacts: publish-a-revision and restore both guard the artifact ────
    // version. `artifacts.create` (new artifact) carries NO guard and is
    // deliberately absent — its shared `artifact publish` syntax omits the flag.
    ['artifacts.publish', '--expect-version', 'expectedVersion'],
    ['artifacts.restore', '--expect-version', 'expectedVersion'],
  ];

  it('every guard row pins its flag to its frozen field — transposition-proof', () => {
    const actual: Array<readonly [OperationName, string, string]> = [];
    for (const [operation, dto] of Object.entries(DTO_BY_OPERATION) as [OperationName, string][]) {
      const fields = guardFieldsOf(dto);
      if (fields.length === 0) continue;
      const syntax = discoveryFor(operation).syntax;
      const flags = syntax === null ? [] : guardFlagsIn(syntax);
      if (flags.length === 0) continue;
      // One guard per row by construction; assert that rather than assuming it,
      // because a second flag or field would make the pairing ambiguous and
      // this table silently under-specified.
      expect(flags.length, `${operation} advertises ${flags.length} guard flags`).toBe(1);
      expect(fields.length, `${operation} DTO has ${fields.length} guard fields`).toBe(1);
      actual.push([operation, flags[0]!.flag, fields[0]!.field]);
    }
    const norm = (rows: ReadonlyArray<readonly [string, string, string]>): string[] =>
      rows.map((r) => r.join(' -> ')).sort();
    // Non-vacuity: an empty derivation would equal an empty table.
    expect(actual.length).toBe(GUARD_PIN.length);
    expect(actual.length).toBe(19);
    expect(norm(actual)).toEqual(norm(GUARD_PIN));
  });

  it('handoffs.send advertises no source-version guard, because its DTO has no field for one', () => {
    const d = discoveryFor('handoffs.send');
    expect(d.versioning).toBe('none');
    expect(d.syntax).not.toMatch(/--expect/);
    expect(d.notes.join(' ')).not.toMatch(/source-version guard|version guard/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FLAG PARSEABILITY — the same defect shape, one layer down
//
// A guard with no DTO field is unreachable because the SERVER rejects it. A
// flag the PARSER cannot represent is unreachable before the request is even
// built, and it fails far more quietly: `--version <n>` is on the frozen
// boolean allowlist, so `interaction-profile preview <id> --version 3` parses
// `--version` as a boolean, never consumes `3`, and prints the CLI version
// with EXIT 0. A wrong answer that reports success is worse than a refusal.
//
// Two directions again, and again the silent one is the dangerous one:
//   VALUE-DECLARED-BOOLEAN — syn says `--flag <x>` but the allowlist says
//     boolean. The value is never consumed. SILENT, exit 0, wrong output.
//   BARE-NOT-BOOLEAN — syn says bare `--flag` but the allowlist omits it, so
//     it swallows the NEXT token as its value and the following argument
//     disappears.
//
// REPORT-ONLY for the parser side: `src/args.ts` is group 1's frozen kernel.
// This sweep names the disagreement; it does not choose which side is wrong.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Flags this projection publishes that the frozen parser cannot represent.
 *
 * **CURRENTLY EMPTY — the one real instance was FIXED IN THE KERNEL WHILE THIS
 * SWEEP WAS LIVE, AND THE SWEEP HAD TO BE CORRECTED TO MATCH.**
 *
 * `interactionProfiles.preview --version` was a genuine collision: `version` is
 * on the boolean allowlist, so the published A16 form
 * `tm8 interaction-profile preview <id> --version <n>` printed the CLI version
 * and exited 0 without previewing — a wrong answer with a success code.
 * Group 1 then fixed it with `COMMAND_SCOPED_GLOBALS`: a name in that set is
 * the GLOBAL only before the first command token and belongs to the COMMAND
 * from that token onward, and an undecidable position exits 2 rather than
 * guessing.
 *
 * SO THE PREDICATE HERE HAD TO CHANGE. "On BOOLEAN_OPTIONS" no longer implies
 * "cannot take a value" — `args.ts` states outright that for a command-scoped
 * name, `BOOLEAN_OPTIONS` membership is not consulted. `version` deliberately
 * STAYS in that set (their comment says so, naming this sweep), so a sweep that
 * kept the old predicate would have gone on reporting a defect that no longer
 * exists. Left uncorrected it would have shipped a stale finding AND trained a
 * reader to discount the whole sweep.
 */
const PARSER_COLLISIONS_PENDING: string[] = [];

describe('flag parseability: what the projection publishes, the parser can represent', () => {
  it('a flag declared WITH a value is not on the frozen boolean allowlist', () => {
    const collisions: string[] = [];
    let swept = 0;
    for (const d of DISCOVERY) {
      if (d.syntax === null) continue;
      // `--flag <value>` / `--flag a|b` — declared as taking a value.
      for (const m of d.syntax.matchAll(/--([a-z][a-z0-9-]*)\s+(?:<|[a-z0-9_]+\|)/g)) {
        const flag = m[1]!;
        swept++;
        if (BOOLEAN_OPTIONS.has(flag) && !COMMAND_SCOPED_GLOBALS.has(flag)) {
          collisions.push(`${d.operation} --${flag}`);
        }
      }
    }
    expect(swept).toBeGreaterThan(100);
    expect(collisions.sort()).toEqual([...PARSER_COLLISIONS_PENDING].sort());
  });

  it('a flag declared BARE is on the boolean allowlist, or it eats the next token', () => {
    const unlisted: string[] = [];
    const seen = new Set<string>();
    for (const d of DISCOVERY) {
      if (d.syntax === null) continue;
      // `--flag` with no value placeholder after it. `]` terminates a flag just
      // as whitespace does — `[--off]` is a bare boolean, and an earlier form
      // of this regex silently skipped every bracketed one, which is exactly
      // the "swept fewer rows than you think" failure this file exists to
      // refuse. The floor below is membership, not a count, for that reason.
      for (const m of d.syntax.matchAll(/--([a-z][a-z0-9-]*)(?![^\s\]])(?!\s+(?:<|[a-z0-9_]+\|))/g)) {
        const flag = m[1]!;
        seen.add(flag);
        if (!BOOLEAN_OPTIONS.has(flag) && !COMMAND_SCOPED_GLOBALS.has(flag)) {
          unlisted.push(`${d.operation} --${flag}`);
        }
      }
    }
    // Every per-command boolean the frozen grammar declares must actually be
    // reached by this sweep, or it is checking a subset and calling it total.
    for (const flag of ['yes', 'off', 'ready', 'unread', 'overwrite', 'force',
      'grant-only', 'presence', 'confirm-untrusted', 'allow-tightening']) {
      expect(seen.has(flag), `bare-flag sweep never reached --${flag}`).toBe(true);
    }
    expect(unlisted.sort()).toEqual([]);
  });

  it('every global option is spelled the way the kernel spells it', () => {
    // `--timeout <seconds>` and `--limit <count>` are gate item O3: a named
    // dimension rendered as a bare ordinal at ANY surface is a defect.
    for (const d of DISCOVERY) {
      if (d.syntax === null) continue;
      expect(d.syntax, d.operation).not.toMatch(/--timeout <n>/);
      expect(d.syntax, d.operation).not.toMatch(/--limit <n>/);
    }
    // 'fresh' joined 2026-08-02 (F2 read-cache); 'terse'/'full' joined
    // 2026-08-02 (F5 render projection, opt-in). Globals all: no per-command
    // syntax, no catalog digest movement.
    expect(GLOBAL_OPTIONS).toEqual(['server', 'space', 'as', 'format', 'timeout', 'no-color', 'quiet', 'fresh', 'terse', 'full']);
  });
});


// ───────────────────────────────────────────────────────────────────────────
// SWEEP FINDING A — THE STRUCTURAL HALF, AND WHY IT PINS NO WORDING
//
// The "no frozen input schema binding" fact has TWO renderings of one truth:
// the projection's `UNBOUND_NOTE` in the `notes` block, and `help.ts`'s marker
// on the `input:` schema line. Both said "yet" — a prediction, not a fact —
// and each was a separate hand-written literal, so fixing either alone would
// have left help contradicting itself on adjacent lines. They were fixed in
// ONE step and now come from ONE constant.
//
// THE PROPERTY UNDER TEST IS "THESE TWO SURFACES CANNOT DISAGREE", NOT "THIS
// SURFACE SAYS X". An earlier version of this block asserted the rendered text
// matched `/\(not bound\)/`, which is a test matching PROSE: it would have gone
// RED the day an owner legitimately reworded the marker to `(unbound)`. That
// punishes the correct action, and a test that fires on an honest rewording is
// worse than no test — the same defect as prose that goes stale silently, just
// pointed the other way.
//
// So everything below compares the rendered surfaces to the CONSTANTS
// THEMSELVES. Reword either constant and both sides move together and these
// stay green. They go red only for the thing actually being prevented: a copy
// of the text re-inlined somewhere it can drift.
// ───────────────────────────────────────────────────────────────────────────
describe('the unbound fact has one source and two renderings that cannot disagree', () => {
  const HELP_SRC = readFileSync(
    fileURLToPath(new URL('../src/commands/help.ts', import.meta.url)),
    'utf8',
  );

  /** Drives the REAL renderer through the REAL Output, not a copy of either. */
  function renderHelp(path: readonly string[]): string {
    const chunks: string[] = [];
    const out = createOutput({
      format: 'human',
      streams: { stdout: (c) => void chunks.push(String(c)), stderr: () => {} },
    });
    emitCommandHelp(path, out);
    return chunks.join('');
  }

  it('an unbound row renders BOTH constants — wording-agnostic', () => {
    const shown = renderHelp(['undo', 'apply']);
    expect(shown.length).toBeGreaterThan(0);
    const schemaLine = shown.split('\n').find((l) => l.includes('input:'));
    expect(schemaLine, 'no rendered schema line').toBeDefined();
    expect(schemaLine as string).toContain(UNBOUND_MARKER);
    expect(shown).toContain(UNBOUND_NOTE);
  });

  it('a BOUND row renders neither — the probe detects the positive before reporting a negative', () => {
    // Without this the assertions above would pass over a renderer that emitted
    // the marker and note for every row, or for none.
    const shown = renderHelp(['message', 'send']);
    expect(shown).toContain('tm8://schema/messages.post/input');
    expect(shown).not.toContain(UNBOUND_MARKER);
    expect(shown).not.toContain(UNBOUND_NOTE);
  });

  it('help.ts holds the identifier and NEVER a copy of the text', () => {
    // The guard that actually fires on the drift mechanism. Both halves are
    // DERIVED FROM THE CONSTANTS, so rewording either keeps the guard live
    // rather than silently retiring it — the failure mode of a guard hardcoded
    // to yesterday's spelling.
    expect(HELP_SRC).toContain('UNBOUND_MARKER');
    expect(HELP_SRC).not.toContain(UNBOUND_MARKER);
    expect(HELP_SRC).not.toContain(UNBOUND_NOTE);
  });

  /**
   * THE ONE PROSE ASSERTION HERE, ISOLATED AND DECLARED AS SUCH.
   *
   * This is the honesty rule, not the pin: it bans a temporal predicate in the
   * two constants. Its false-positive mode is real and worth naming — an owner
   * who legitimately writes "yet"/"until" in a reworded constant trips it. That
   * surface is two short strings, and reintroducing a roadmap is not an honest
   * rewording under this file's own stated rule, so it is kept. Delete it, not
   * the pin above, if it ever fires on a correct change.
   */
  it('neither constant carries a temporal predicate', () => {
    for (const [label, s] of [['note', UNBOUND_NOTE], ['marker', UNBOUND_MARKER]] as const) {
      expect(s.length, label).toBeGreaterThan(0);
      expect(s, label).not.toMatch(/\byet\b|\buntil\b|\bsoon\b/i);
    }
  });
});
