// PARITY BETWEEN THE CONTRACT'S SECRET-KEY PREDICATE AND 177'S DOOR.
//
// `isSecretLookingEnvKey` promises a caller a 400 that NAMES the offending key
// instead of the raw plpgsql `22023` the door raises. That promise holds only
// while the contract refuses EVERYTHING the door refuses — and it did not:
// the door matches SUBSTRINGS (`~*`), the contract matched `_`-delimited
// SEGMENTS, so `AUTHOR` (containing `auth`) passed the contract and was
// refused by the database, unhandled.
//
// This test lives in the SERVER package, not in `packages/contract`, for one
// reason: it must read `db/migrations/177_container_kind.sql`, and the
// contract package reads no files by design. The server is where the door and
// the contract actually meet, and its tests already read migration text.
//
// The door's pattern is EXTRACTED FROM THE MIGRATION, never retyped. A
// transcribed copy would drift from its authority exactly the way the comment
// this test replaces did.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { isSecretLookingEnvKey } from '@tm8/contract';

const MIGRATION = fileURLToPath(
  new URL('../../../../db/migrations/177_container_kind.sql', import.meta.url),
);

/** 177:866's `env_key ~* '(...)'`, read from the file that defines it. */
function doorPredicate(): RegExp {
  const sql = readFileSync(MIGRATION, 'utf8');
  const pattern = sql.match(/env_key ~\* '([^']+)'/)?.[1];
  // An UNMATCHED extraction must fail loudly. A null here silently turns every
  // assertion below into a comparison over an empty set, which reports success.
  if (!pattern) {
    throw new Error('could not extract the door predicate from 177 — did it move?');
  }
  return new RegExp(pattern, 'i');
}

// A corpus wide enough to separate the two matching styles: ordinary env vars,
// real secrets, and the substring-only keys that exposed the gap.
/**
 * Every key 177 refuses that this corpus exercises. The seven that used to
 * diverge are only the visible part: the widened predicate must cover the
 * WHOLE DB-refused set, and hitting the seven while dropping one of the
 * others would satisfy the headline and leave the gap open.
 */
const DB_REFUSED = [
  'ACCESSKEY', 'ACCESS_KEY', 'ANTHROPIC_API_KEY', 'APIKEY', 'AUTH',
  'AUTHENTICATION', 'AUTHOR', 'AUTHORIZED_KEYS', 'AWS_SECRET_ACCESS_KEY',
  'CREDENTIALS', 'GH_TOKEN', 'GITHUB_TOKEN', 'MYTOKENVALUE', 'MY_SECRET_THING',
  'NPM_CONFIG_PASSWORD', 'OAUTH', 'PASSWD', 'PASSWORD_FILE', 'PRIVATE_KEY',
  'SECRETS', 'TM8_AGENT_TOKEN', 'TOKENIZER',
];

/** Demonstrably ordinary. Overshooting into these IS a defect. */
const ORDINARY = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'SHELL', 'USER',
  'NODE_ENV', 'CI', 'EDITOR', 'PAGER', 'HOSTNAME', 'DISPLAY', 'COLORTERM',
];

/**
 * Refused by the contract and NOT by the door. Overshoot in this direction is
 * SAFE — the caller gets a named 400 and never reaches an unhandled 22023 —
 * so it is asserted to stay non-empty rather than driven to zero.
 */
const CONTRACT_STRICTER = ['PWD', 'SESSION_KEY', 'BEARER'];

const CORPUS = [...DB_REFUSED, ...ORDINARY, ...CONTRACT_STRICTER];

describe('the contract refuses everything 177 refuses', () => {
  it('extracts the door predicate, and it actually matches things', () => {
    // POSITIVE CONTROL on the instrument. If the extraction regressed to
    // something that matches nothing, the parity assertion below would pass
    // vacuously — an empty door set is trivially a subset.
    const door = doorPredicate();
    expect(door.test('SECRET')).toBe(true);
    expect(door.test('AUTHOR')).toBe(true);
    expect(door.test('PATH')).toBe(false);
  });

  it('the corpus is conserved and has no duplicates', () => {
    // A comparison over a shrunken set reports success. Size is asserted with
    // EQUALITY, not `>=`.
    expect(DB_REFUSED).toHaveLength(22);
    expect(ORDINARY).toHaveLength(15);
    expect(CONTRACT_STRICTER).toHaveLength(3);
    expect(CORPUS).toHaveLength(40);
    expect(new Set(CORPUS).size).toBe(CORPUS.length);
  });

  it('every key in DB_REFUSED really is refused by the door', () => {
    // Guards the LIST, not the predicate. If a key were listed here that 177
    // does not actually refuse, the set-difference test would still pass and
    // the corpus would be quietly wrong about its own authority.
    const door = doorPredicate();
    const notActuallyRefused = DB_REFUSED.filter((key) => !door.test(key));
    expect(notActuallyRefused).toEqual([]);
  });

  it('DB-refuses-but-contract-accepts is EMPTY — the actual goal', () => {
    const door = doorPredicate();
    const slipped = CORPUS.filter((key) => door.test(key) && !isSecretLookingEnvKey(key));
    // Named, not counted: a regression says WHICH key would reach the door.
    expect(slipped).toEqual([]);
  });

  it('the reverse direction may be non-empty, and that is the SAFE side', () => {
    // The contract being STRICTER than the door is fine: those keys are
    // refused here, by name, and never reach the database. Asserted rather
    // than left implicit so nobody "fixes" it into parity in the wrong
    // direction by loosening the contract.
    const door = doorPredicate();
    const stricter = CORPUS.filter((key) => !door.test(key) && isSecretLookingEnvKey(key));
    // NON-EMPTY first. A loop over an empty array passes while asserting
    // nothing, and this set going empty would mean the contract had been
    // loosened to exactly the door — which is a real change, not a no-op.
    expect(stricter).toEqual(CONTRACT_STRICTER);
  });

  it('ordinary environment variables survive the widening', () => {
    for (const key of ['PATH', 'HOME', 'LANG', 'NODE_ENV', 'TERM', 'TZ', 'CI']) {
      expect(isSecretLookingEnvKey(key), `${key} must stay accepted`).toBe(false);
    }
  });
});
