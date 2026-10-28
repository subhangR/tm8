import { describe, expect, it } from 'vitest';

import { capacitySlots, describeCapacity } from './launch';

describe('describeCapacity — ghosts (378)', () => {
  it('reads exactly as before when the node does not report ghosts', () => {
    expect(describeCapacity({ slotsFree: 0, slotsTotal: 64 })).toBe('0 of 64 session slots free');
    expect(describeCapacity({ slotsFree: 3, slotsTotal: 8, ghosts: 0 })).toBe('3 of 8 session slots free');
  });

  it('says how many used slots are dead rows the reaper is retiring', () => {
    expect(describeCapacity({ slotsFree: 0, slotsTotal: 64, ghosts: 19 })).toBe(
      '0 of 64 session slots free · 19 held by dead sessions, reaping',
    );
    expect(describeCapacity({ slotsFree: 2_147_483_640, slotsTotal: 2_147_483_647, ghosts: 2 })).toBe(
      '7 live · no session limit · 2 held by dead sessions, reaping',
    );
  });

  it('leaves the compact count alone', () => {
    expect(capacitySlots({ slotsFree: 0, slotsTotal: 64, ghosts: 19 })).toBe('64/64');
  });
});
