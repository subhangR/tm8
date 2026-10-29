/**
 * The temporary Run now shim on entities.patch (lead ruling on review item 9
 * of #1406; PR5b removes it): a client nextRunAt at or before now is "due at
 * the next tick", anything later is ignored, and a space-link caller never gets
 * it, because loops.runNow is refused to links and this would fire B's loop as
 * B's human armer (review 8b).
 */
import { describe, expect, it } from 'vitest';

import { isRunNowRequest } from '../../src/loops/write.js';

const NOW = Date.parse('2026-10-29T08:00:00Z');
const member = { viaLink: false };

describe('isRunNowRequest', () => {
  it('honours a nextRunAt at or before now, with half a minute of client clock skew', () => {
    expect(isRunNowRequest('2026-10-29T07:59:00Z', member, NOW)).toBe(true);
    expect(isRunNowRequest('2001-01-01T00:00:00Z', member, NOW)).toBe(true);
    expect(isRunNowRequest('2026-10-29T08:00:20Z', member, NOW)).toBe(true);
  });

  it('ignores a later instant: computing a schedule is the server\'s job', () => {
    expect(isRunNowRequest('2026-10-29T08:05:00Z', member, NOW)).toBe(false);
    expect(isRunNowRequest('2099-01-01T00:00:00Z', member, NOW)).toBe(false);
  });

  it('ignores what is not an instant', () => {
    for (const value of [null, undefined, 0, NOW, 'soon', '']) expect(isRunNowRequest(value, member, NOW), String(value)).toBe(false);
  });

  it('never runs a loop for a space-link caller', () => {
    expect(isRunNowRequest('2026-10-29T07:59:00Z', { viaLink: true }, NOW)).toBe(false);
  });
});
