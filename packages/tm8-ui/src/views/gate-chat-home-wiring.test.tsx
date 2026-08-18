// @vitest-environment jsdom
/**
 * THE GATE'S CHAT-HOME MOUNT, ASSERTED THROUGH THE REAL HOST.
 *
 * WHY THIS FILE EXISTS. #368 swapped four props out and three in at GateApp's
 * <ChatHomeSurface> mount (graphFull/onGraphFullChange/graphFilters/
 * onGraphFiltersChange left; stage/onStageChange/onOpenTranscript arrived)
 * while #371's five-host rename passed through the same mount. Both landed
 * clean and the merge was textually conflict-free — but NOTHING IN THE SUITE
 * ASSERTED THE WIRING, so the pair could have compiled, typechecked, rendered,
 * and still handed the mount the wrong callback.
 *
 * The gap was exact, and it is worth naming because it is easy to recreate:
 * cockpit-stages.test.tsx:52 asserts the stage tabs "ask the HOST to change the
 * address rather than swapping locally" — it renders ChatHomeScreen DIRECTLY
 * and checks that `onStageChange` fires. FleetPane.test.tsx covers
 * `onOpenTranscript` the same way. So the COMPONENT's half of the contract was
 * tested and the HOST's half was not: everything verified that the screen ASKS,
 * and nothing verified that the gate ANSWERS.
 *
 * These cases close that half. They drive the real <GateApp /> — the actual
 * mount, the actual HomeView regions, the actual navStore — and assert the
 * OBSERVABLE consequence rather than that a prop is present. A presence check
 * would pass just as happily with `onStageChange` bound to the wrong verb;
 * the address either changes or it does not.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    },
  });
  resetNav();
  // jsdom keeps ONE window.location per file and an addressable hash at boot
  // outranks last-place, so a case that navigates would otherwise seed the
  // next one. Same reasoning as GateChatHome.test.tsx.
  window.location.hash = '';
});

describe("the gate answers the chat-home screen's stage request", () => {
  it('puts the stage in the ADDRESS when the screen asks — the half cockpit-stages cannot see', async () => {
    render(<GateApp />);
    await screen.findByTestId('chat-home-screen');

    const fleet = await screen.findByText('Fleet');
    fireEvent.click(fleet);

    /*
     * The screen deliberately renders NOTHING on click — it asks the host and
     * waits for the stage to come back down the address (cockpit-stages.test.tsx
     * :57). So the address is the only honest place to look, and it is exactly
     * what a misrouted `onStageChange` would leave untouched.
     */
    await waitFor(() => {
      expect(
        window.location.hash,
        'clicking Fleet did not reach the address. The screen asks via onStageChange '
          + '(HomeView.tsx:653-659 navigates with root.stage); if the hash never gains '
          + 'stage=fleet, the gate is not answering — the mount is stale or the verb is misrouted',
      ).toContain('stage=fleet');
    });
  });

  it('takes the stage back OUT of the address, so Back leaves it', async () => {
    const { container } = render(<GateApp />);
    await screen.findByTestId('chat-home-screen');

    fireEvent.click(await screen.findByText('Fleet'));
    await waitFor(() => expect(window.location.hash).toContain('stage=fleet'));

    /*
     * Esc leaves a stage by NAVIGATING, not by resetting local state
     * (cockpit-stages.test.tsx:163) — so the address must lose it too.
     *
     * Dispatched on `.tch-conversation`, the element that owns the handler,
     * exactly as the component-level case does. A keyDown on `window` never
     * reaches it and the case then fails against a perfectly good app — which
     * is how it failed when this file was first written.
     */
    const conversation = container.querySelector('.tch-conversation');
    expect(conversation, 'the conversation region is gone — this guard needs repointing').toBeTruthy();
    fireEvent.keyDown(conversation!, { key: 'Escape' });

    await waitFor(() => {
      expect(
        window.location.hash,
        'the stage survived Esc in the address. A stage that cannot be left by the '
          + 'address is a stage Back cannot leave and a reload restores forever',
      ).not.toContain('stage=fleet');
    });
  });
});

describe("the gate's ChatHomeSurface mount supplies the whole cockpit set", () => {
  /**
   * A source-level companion to the behavioural cases above. It cannot catch a
   * MISROUTED prop — only the address assertions can — but it catches a
   * DELETED one immediately and names it, which is the failure #368's swap
   * could have produced in any of the five hosts its rename passed through.
   *
   * Asserted as a SET, following panel-host-wiring.test.ts:174: a check on one
   * prop goes stale the day the slot is repointed.
   */
  const COCKPIT_MOUNT_SET: readonly { prop: string; why: string }[] = [
    { prop: 'stage=', why: 'which non-entity stage is up — absent, ?stage= in a shared link opens nothing' },
    { prop: 'onStageChange=', why: 'the verb that swaps it — absent, the stage tabs ask a host that never answers' },
    { prop: 'onOpenTranscript=', why: "the fleet's Transcript link — absent, it lands nowhere and the session panel's Transcript surface is unreachable from the fleet" },
  ];

  /** The <ChatHomeSurface …> element, closed at the opening tag's own indent. */
  function mountBlock(source: string): string {
    const lines = source.split('\n');
    const start = lines.findIndex((l) => l.includes('<ChatHomeSurface'));
    expect(start, 'GateApp.tsx no longer mounts <ChatHomeSurface> — this guard needs repointing').toBeGreaterThan(-1);
    const indent = lines[start]!.slice(0, lines[start]!.indexOf('<'));
    const collected: string[] = [];
    for (let i = start; i < lines.length; i += 1) {
      collected.push(lines[i]!);
      const line = lines[i]!;
      // Close only at the opening tag's OWN indentation: these mounts pass
      // whole elements as props, and a nested `/>` would truncate the block
      // before the attribute under test — failing a mount that is wired right.
      if (i > start && (line === `${indent}/>` || line === `${indent}>`)) break;
    }
    return collected.join('\n');
  }

  it('passes every member of the set at the mount', () => {
    const source = readFileSync(join(__dirname, 'GateApp.tsx'), 'utf8');
    const block = mountBlock(source);
    const missing = COCKPIT_MOUNT_SET.filter(({ prop }) => !block.includes(prop));
    expect(
      missing.map(({ prop, why }) => `${prop} (${why})`),
      "GateApp's <ChatHomeSurface> mount is missing part of the cockpit set",
    ).toEqual([]);
  });

  it('does not still pass the props #368 removed', () => {
    const source = readFileSync(join(__dirname, 'GateApp.tsx'), 'utf8');
    const block = mountBlock(source);
    // Reintroducing one of these typechecks at the definition site and is DEAD
    // at the mount — the quiet half of the failure mode this file guards.
    const retired = ['graphFull', 'onGraphFullChange', 'graphFilters', 'onGraphFiltersChange'];
    expect(
      retired.filter((prop) => block.includes(prop)),
      'a prop #368 deleted is being passed again; ?stage= replaced ?graph=/?gf= and the surface no longer reads it',
    ).toEqual([]);
  });
});
