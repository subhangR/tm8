// `TM8_AUTO_RESUME*` — the operator's control over boot-time auto-resume.
//
// On by default: the ending it acts on already tells the user the session "can
// be resumed to pick up where it left off". Bad numbers fall back to the
// default, because a typo in a tuning knob must not stop a node booting.

import { describe, expect, it } from 'vitest';
import { resolveAutoResumePolicy } from '../src/facade/execution-handlers.js';

const HOUR = 3_600_000;

describe('resolveAutoResumePolicy', () => {
  it('is on, 24h, 2s apart when nothing is set', () => {
    expect(resolveAutoResumePolicy({})).toEqual({ enabled: true, windowMs: 24 * HOUR, staggerMs: 2_000 });
  });

  it.each(['0', 'off', 'false', 'no', ' OFF '])('%j turns it off', (value) => {
    expect(resolveAutoResumePolicy({ TM8_AUTO_RESUME: value }).enabled).toBe(false);
  });

  it.each(['1', 'on', 'true', ''])('%j leaves it on', (value) => {
    expect(resolveAutoResumePolicy({ TM8_AUTO_RESUME: value }).enabled).toBe(true);
  });

  it('reads the window and the stagger', () => {
    expect(
      resolveAutoResumePolicy({ TM8_AUTO_RESUME_WINDOW_HOURS: '6', TM8_AUTO_RESUME_STAGGER_MS: '500' }),
    ).toEqual({ enabled: true, windowMs: 6 * HOUR, staggerMs: 500 });
  });

  it('falls back to the defaults on nonsense or negatives', () => {
    expect(
      resolveAutoResumePolicy({ TM8_AUTO_RESUME_WINDOW_HOURS: 'a day', TM8_AUTO_RESUME_STAGGER_MS: '-5' }),
    ).toEqual({ enabled: true, windowMs: 24 * HOUR, staggerMs: 2_000 });
  });
});
