import { describe, expect, it } from 'vitest';

import { branchNameFor } from './worktree-provisioning.js';

/**
 * `branchNameFor` used to be `tm8/${id.replace(/-/g,'').slice(0, 8)}`.
 *
 * A uuidv7's first 6 bytes are a 48-bit big-endian millisecond clock, so 8 hex
 * characters kept the TOP 32 BITS and threw away the low 16 plus all 74 random
 * bits. The name was therefore `floor(ms / 65536)` — a BUCKET, not a sliding
 * window. Two ids 200ms apart inside one bucket always collided; two ids 60s
 * apart might straddle a boundary and pass.
 *
 * That is why these tests pin the ids rather than minting two and hoping. A test
 * that generated two uuids and asserted they differ would have passed against the
 * BROKEN code roughly half the time — a check that cannot reliably fail is not a
 * check.
 */
describe('branchNameFor', () => {
  // Same 65,536ms bucket: identical top 32 bits (0199fbc4), differing low 16.
  const SAME_BUCKET_A = '0199fbc4-0000-7000-8000-000000000001';
  const SAME_BUCKET_B = '0199fbc4-ffff-7000-8000-000000000002';

  it('gives two ids in ONE timestamp bucket different branches', () => {
    // Under the old truncation both of these were exactly `tm8/0199fbc4`.
    expect(branchNameFor(SAME_BUCKET_A)).not.toBe(branchNameFor(SAME_BUCKET_B));
  });

  it('does not collapse ids that differ only below the truncation point', () => {
    // Every one of these shared a branch name before the fix.
    const ids = [
      '0199fbc4-0001-7000-8000-00000000000a',
      '0199fbc4-0002-7000-8000-00000000000b',
      '0199fbc4-0003-7000-8000-00000000000c',
      '0199fbc4-0004-7000-8000-00000000000d',
    ];
    expect(new Set(ids.map(branchNameFor)).size).toBe(ids.length);
  });

  it('retains the whole id, not a prefix of it', () => {
    const id = '0199fbc4-1234-7000-8000-0123456789ab';
    expect(branchNameFor(id)).toBe(`tm8/${id}`);
    expect(branchNameFor(id)).toContain('0123456789ab'); // the random tail survives
  });

  it('stays inside the ref grammar and the varchar(255) column', () => {
    const name = branchNameFor('0199fbc4-1234-7000-8000-0123456789ab');
    expect(name).toMatch(/^tm8\/[0-9a-f-]+$/); // hex and hyphens only
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.startsWith('-')).toBe(false);
    expect(name).not.toContain('..');
    expect(name.endsWith('.lock')).toBe(false);
  });
});
