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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  /**
   * THE CENTRING PAIR — held here for the reason stated at the top of this
   * file: jsdom has no layout engine, the pixels were measured in real Chrome,
   * and a CSS rule nothing asserts is a rule that comes back.
   *
   * It takes BOTH declarations and it took both to fix. `.set-card` has carried
   * `max-width` + `margin-inline: auto` since the frame pass and centred
   * nothing, because `.shell-body` (shell.css) is a flex ROW and `.set-root` is
   * an item of it — at the initial `flex: 0 1 auto` the root was sized by its
   * CONTENT, so the card's auto margins had a box exactly its own width to
   * centre inside. Measured in Chrome at a 1440px viewport: 1023px root, 18px
   * gutter left against 433px right. With `flex: 1` on the root, 125px / 125px.
   *
   * So asserting either half alone would pass over the defect.
   */
  describe('the card is centred in the shell’s body row', () => {
    const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'settings.css'), 'utf8');

    /**
     * Every declaration this stylesheet makes for a selector, joined.
     *
     * ALL of them, not the first: `.set-root` is deliberately declared twice —
     * once for the four layout custom properties, once for the frame itself —
     * and a helper that stopped at the first block would read the wrong one and
     * report a missing rule as a failure.
     */
    function declarationsFor(selector: string): string {
      const blocks: string[] = [];
      for (let at = CSS.indexOf(`${selector} {`); at > -1; at = CSS.indexOf(`${selector} {`, at + 1)) {
        blocks.push(CSS.slice(at, CSS.indexOf('}', at)));
      }
      expect(blocks.length, `settings.css declares no rule for \`${selector}\``).toBeGreaterThan(0);
      // Comments carry the words `flex: 1` and `margin-inline: auto` while
      // explaining them; matching those would pass on the explanation alone.
      return blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    }

    it('grows the root, so the auto margins have room to centre in', () => {
      expect(declarationsFor('.set-root')).toMatch(/flex: 1[;\s]/);
    });

    it('caps the card and centres it with auto inline margins', () => {
      const card = declarationsFor('.set-card');
      expect(card).toMatch(/max-width: var\(--set-card-max\)/);
      expect(card).toMatch(/margin-inline: auto/);
    });
  });
});
