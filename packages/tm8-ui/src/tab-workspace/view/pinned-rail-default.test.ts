import { describe, expect, it } from 'vitest';
import { resolveNavigatorEnabled, resolvePinnedRailEnabled } from './navigatorFlag';

/* The pinned-rail layout is the default since 2026-10-18 (Subhang: "make this
   new UI the default"). These pin the resolution order: build env, then the
   device's stored choice, then the default (ON outside the test build). */
describe('pinned-rail default', () => {
  it('is ON with nothing stored in a real build', () => {
    expect(resolvePinnedRailEnabled({ MODE: 'production' }, null)).toBe(true);
    expect(resolvePinnedRailEnabled({ MODE: 'development' }, null)).toBe(true);
  });
  it('stays OFF by default in the test build', () => {
    expect(resolvePinnedRailEnabled({ MODE: 'test' }, null)).toBe(false);
  });
  it('a stored choice wins over the default', () => {
    expect(resolvePinnedRailEnabled({ MODE: 'production' }, 'rail')).toBe(true);
    expect(resolvePinnedRailEnabled({ MODE: 'production' }, 'off')).toBe(false);
    expect(resolvePinnedRailEnabled({ MODE: 'production' }, '1')).toBe(false);
  });
  it('the build env wins over everything', () => {
    expect(resolvePinnedRailEnabled({ MODE: 'production', VITE_TM8_UI_NAVIGATOR: 'rail' }, 'off')).toBe(true);
    expect(resolvePinnedRailEnabled({ MODE: 'production', VITE_TM8_UI_NAVIGATOR: '1' }, null)).toBe(false);
  });
  it('the merged navigator stays opt-in (value 1) and never collides with the rail default', () => {
    expect(resolveNavigatorEnabled({ MODE: 'production' }, null)).toBe(false);
    expect(resolveNavigatorEnabled({ MODE: 'production' }, '1')).toBe(true);
    expect(resolveNavigatorEnabled({ MODE: 'production' }, 'rail')).toBe(false);
  });
});
