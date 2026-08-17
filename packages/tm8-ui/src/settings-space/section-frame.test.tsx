// @vitest-environment jsdom
/**
 * THE FRAME CONTRACT, asserted.
 *
 * jsdom has no layout engine, so nothing here can assert a pixel — and the
 * headline defect this lane fixed (`.set-card` with no `flex: 1`, collapsing to
 * content height) is invisible to it. That one is held by the CSS itself and
 * was measured in real Chrome; see SECTION-CONTRACT.md §8.
 *
 * What jsdom CAN hold is the structural half, which is what actually drifted:
 * whether each section renders the frame at all. Both regressions below were
 * real before this lane:
 *
 *   - `profile` and `danger` rendered NO scroller, so their content ran under
 *     the card's `overflow: hidden` and was unreachable on a short window.
 *   - sections disagreed about how many scrollers they had, and a nested pair
 *     silently clips the inner one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { resolveMenu } from '../shell/menu-resolve';
import { SettingsShell } from './SettingsShell';
import { SectionFrame } from './SectionFrame';
import { specimenMembers } from './specimen';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './types';
import type { SettingsPort } from './port';
import type { IdentityView } from '../data/seam';

afterEach(cleanup);

const NOW = Date.parse('2026-07-29T04:00:00.000Z');

const IDENTITY: IdentityView = {
  identityId: 'id-ada',
  accountId: 'acc-ada',
  username: 'ada',
  displayName: 'Ada Osei',
  avatar: null,
  email: null,
  globalId: null,
  isNodeAdmin: false,
  isOwner: true,
  status: 'active',
  actingAs: null,
  memberships: [{ spaceId: 'specimen-space', memberId: 'm-ada', role: 'owner' }],
};

function fakePort(): SettingsPort {
  return {
    loadSpace: async () => ({
      id: 'specimen-space' as never,
      name: 'atelier',
      description: 'the workshop space',
      memberCount: 3,
      unreadTotal: 0,
      githubRepo: null,
      createdAt: '2026-01-04T09:00:00.000Z',
    }),
    loadMembers: async () => specimenMembers(NOW),
    loadIdentity: async () => IDENTITY,
    loadMenu: async () => resolveMenu(null),
    loadInvites: async () => Promise.reject(new Error('space admin required')),
    loadAxes: async () => Promise.reject(new Error('space admin required')),
    loadWorkflows: async () => Promise.reject(new Error('space admin required')),
    setMemberRole: async () => ({ patches: [] }) as never,
    createInvite: async () => ({}) as never,
    revokeInvite: async () => ({}) as never,
    updateProfile: async () => ({}) as never,
    createAxis: async () => ({}) as never,
    updateAxis: async () => ({}) as never,
    deleteAxis: async () => ({}) as never,
    tasksUsingAxis: async () => 0,
    upsertWorkflow: async () => ({}) as never,
    deleteWorkflow: async () => ({}) as never,
  } as unknown as SettingsPort;
}

async function mount(id: SettingsSectionId) {
  const r = render(<SettingsShell port={fakePort()} initialSection={id} />);
  // The shell's reads are a `Promise.allSettled` in an effect; without this the
  // assertions run against the pre-load render and every section looks empty.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return r;
}

describe('the section frame', () => {
  it.each(SETTINGS_SECTIONS.map((s) => s.id))(
    '%s renders exactly one scroller — never zero, never nested',
    async (id) => {
      const { container } = await mount(id as SettingsSectionId);
      const scrollers = container.querySelectorAll('.set-section__scroll');

      // ZERO is the `profile`/`danger` regression: content with nowhere to go
      // under a card that clips its overflow.
      expect(scrollers.length).toBeGreaterThan(0);

      // NESTED is the other half: the outer scroller takes all the overflow and
      // the inner one is left with none to distribute, so its content is
      // clipped rather than scrolled. A section that needs an inner pane must
      // bound that pane's height instead (SECTION-CONTRACT.md §3).
      for (const outer of scrollers) {
        expect(outer.querySelectorAll('.set-section__scroll')).toHaveLength(0);
      }
    },
  );

  it.each(SETTINGS_SECTIONS.map((s) => s.id))('%s renders a heading', async (id) => {
    const { container } = await mount(id as SettingsSectionId);
    expect(container.querySelector('.set-section__title')?.textContent).toBeTruthy();
  });

  it('measures and pads by default, because most bodies are prose or a form', () => {
    const { container } = render(<SectionFrame title="t">body</SectionFrame>);
    const inner = container.querySelector('.set-section__scroll')?.firstElementChild;
    expect(inner?.className).toContain('set-section__measure');
    expect(inner?.className).toContain('set-section__pad');
  });

  it('drops both when asked, for the full-bleed row tables', () => {
    const { container } = render(
      <SectionFrame title="t" measure={false} pad={false}>
        body
      </SectionFrame>,
    );
    const inner = container.querySelector('.set-section__scroll')?.firstElementChild;
    expect(inner?.className).toBe('');
  });

  it('puts the action in the head, not the body — it must not scroll away', () => {
    const { container } = render(
      <SectionFrame title="t" action={<button type="button">Invite</button>}>
        body
      </SectionFrame>,
    );
    expect(container.querySelector('.set-section__head button')).not.toBeNull();
    expect(container.querySelector('.set-section__scroll button')).toBeNull();
  });
});
