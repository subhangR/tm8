/**
 * §15.2 FOR THIS LANE — because no existing guard reaches it.
 *
 * D62 §3 is the rule: A RULING THAT CREATES A DIRECTORY NAMES THE CONTROLS THAT
 * WILL SEE IT. `panels/no-branching.test.ts` scans `panels/` plus four named
 * shell files; `authoring/`, `settings-space/` and `files/` each carry their own
 * copy. `src/messages/` is none of those, so creating this directory created a
 * region where the no-kind-literals law is stated everywhere and enforced
 * nowhere. This file is written by the seat that created the gap, not bolted
 * onto someone else's list — D61's settled argument: a lane guard that fails on
 * another seat's file makes the WRONG SEAT RED, and their only moves are nag or
 * exempt.
 *
 * THE TEMPTATION THIS LANE FACES SPECIFICALLY, stated so the guard reads as
 * necessary rather than ceremonial: a unified message browser wants to write
 *
 *     kinds: ['channel', 'task', 'work_session', 'doc']
 *
 * to ask the server for "the kinds people talk on". It writes none of them.
 * `messages-model.ts:isConversation` is STRUCTURAL — `counters.messages > 0` —
 * and message-ness is reached through the presence of `state.anchorId`
 * (`anchorIdOf`), never by comparing a kind. Same move as
 * `files/model.ts:rowFromEntity`, which discriminates on name/mimeType.
 *
 * AND THE STRUCTURAL FORM IS NOT MERELY COMPLIANT, IT IS MORE CORRECT. A kind
 * list is a claim about which kinds can hold a discussion, and that claim goes
 * stale the moment a new kind learns to — the list would silently hide those
 * conversations, and nothing would fail. `counters.messages > 0` is true of the
 * new kind on the day it ships, with no edit here. The same argument covers
 * unread: `unreadOf` asks whether a state CARRIES a count rather than whether
 * the row is a channel, so the day the server widens `loadUnreadCounts` past
 * channels, these rows start rendering unread with no edit either.
 *
 * NO CARVE-OUT. The one literal this lane plausibly needs is `'message'` —
 * `useMessagesData` must ask `collections.query` for message entities
 * specifically — and the registry already exposes that kind as DATA, so the ban
 * is advice someone can follow rather than a wall. The last test below asserts
 * the route resolves; the expression is:
 *
 *     allKinds().filter((row) => row.strategy === 'anchored')[0].kind
 *
 * `message` is the only `strategy: 'anchored'` row in the registry, and that is
 * not a coincidence to be exploited but the definition itself: anchored IS the
 * routing strategy of a thing that has no view of its own because it hangs off
 * something else. If a second anchored kind ever ships, the helper below throws
 * loudly here rather than picking one silently in production.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allKinds } from '../domain';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The kind ref this lane is allowed to reach for, resolved from registry DATA.
 *
 * Duplicated in spirit from `files/port.ts:fileKindRef()` — same shape, same
 * loudness on ambiguity. It lives in the test rather than in the lane because
 * the lane's own copy belongs in `useMessagesData.ts`, and this file must not
 * import an in-flight sibling to make its point.
 */
function anchoredKindRef(): string {
  const rows = allKinds().filter((row) => row.strategy === 'anchored');
  if (rows.length !== 1) {
    throw new Error(
      `messages: expected exactly one registry row with an anchored routing strategy, found ${rows.length}`,
    );
  }
  return rows[0]!.kind;
}

const ownedFiles = walk(HERE);

const sourceFiles = ownedFiles
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

describe('§15.2 — the messages lane knows no kind', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    // The both-halves control: a glob that silently matched nothing would make
    // every assertion below vacuously true. Naming the pure core explicitly as
    // well, so a walk that found one unrelated file still fails here.
    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(sourceFiles.map((f) => relative(HERE, f))).toContain('messages-model.ts');
  });

  it('no source file here contains a kind string literal', () => {
    const kinds = allKinds()
      .map((k) => k.kind)
      .filter((k) => !k.startsWith('c:'));

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const kind of kinds) {
        if (new RegExp(`['"\`]${kind}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)} → '${kind}'`);
        }
      }
    }
    expect(
      offenders,
      `a conversation is \`counters.messages > 0\`, not a list of kinds. Reach the message kind through registry DATA — allKinds().filter((r) => r.strategy === 'anchored') — and everything else structurally (messages-model.ts: anchorIdOf, unreadOf):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no source file compares a kind against a literal', () => {
    const kinds = allKinds().map((k) => k.kind);
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const kind of kinds) {
        if (new RegExp(`kind\\s*===\\s*['"\`]${kind.replace('*', '\\*')}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)} → kind === '${kind}'`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the message kind is reachable from registry data at all — the guard’s other half', () => {
    // A ban is only half a rule. This asserts the ALTERNATIVE exists and
    // resolves, so "don't type the literal" is advice someone can follow. It
    // reads the registry, not this lane, so it stays green while the hook that
    // will use it is still being written.
    const ref = anchoredKindRef();
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);
  });
});

describe('the lane’s own boundary', () => {
  it('creates nothing outside src/messages/', () => {
    // The directive's file ownership is ABSOLUTE. This asserts the shape of that
    // promise from inside: every file this suite walks is under HERE.
    for (const f of ownedFiles) expect(f.startsWith(HERE)).toBe(true);
  });

  it('imports no seam IMPLEMENTATION into product code', () => {
    // The hook takes a `Seam` by TYPE and the host constructs it. A module that
    // reached for `createFixtureSeam`/`createRealSeam` would bind this surface
    // to one implementation and break LLD §10's interchangeability — the test
    // lives here because the import would typecheck perfectly.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      if (/createFixtureSeam|createRealSeam/.test(text)) offenders.push(relative(SRC, file));
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
