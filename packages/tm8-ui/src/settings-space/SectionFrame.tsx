/**
 * THE SECTION FRAME — the one layout primitive all twelve settings sections
 * are built against.
 *
 * WHY THIS FILE EXISTS. Before it, every section hand-wrote its own
 * `set-section__head` / `set-section__scroll` pair, and twelve independent
 * transcriptions of the same three divs drifted exactly as far apart as you
 * would expect: `menu` padded its body with an inline `style={{ padding: 16 }}`
 * against an 18px head, `danger` and `profile` rendered no scroller at all so
 * their content ran under the card's `overflow: hidden` and was simply gone on
 * a short window, and no section agreed with any other about where the second
 * column started. The user's report (2026-08-16) was "not properly laid out",
 * and this was the mechanism.
 *
 * THE CONTRACT. A section is exactly three things:
 *
 *   root  — `.set-section`, a flex column that owns the height `.set-body`
 *           hands it. Never scrolls itself.
 *   head  — `.set-section__head`, fixed. Title left, actions right.
 *   body  — `.set-section__scroll`, the ONE scroller. Everything else lives
 *           inside it.
 *
 * Two scrollers in one section is the bug this shape prevents: the outer one
 * wins, the inner one gets zero overflow to distribute, and the content that
 * was meant to scroll is clipped instead. If a section needs an internally
 * scrolling pane (the menu editor's preview), that pane must be sized, not
 * `flex: 1` — see SECTION-CONTRACT.md §3.
 *
 * `measure` IS THE DEFAULT AND SHOULD USUALLY STAY ON. Turn it off only for a
 * body whose rows are meant to span the card edge to edge — the member table,
 * the invite list. Prose and forms always want it: without the cap, the roles
 * legend rendered as a single 2800px line on the reporter's display.
 */
import type { ReactNode } from 'react';

export interface SectionFrameProps {
  /** The section heading. Use the `heading` from `SETTINGS_SECTIONS`, not a re-typed copy. */
  title: string;
  /**
   * Right-aligned header controls — the invite chip, an "Add" chip.
   *
   * IF YOU PUT AN ENABLED CONTROL HERE YOU MUST REGISTER ITS ACCESSIBLE NAME
   * in `LIVE_VERBS` (`settings.test.tsx`). A shell-wide sweep asserts that no
   * enabled control on this surface promises an act it cannot perform, so an
   * unregistered chip fails the suite. Append a delimited block naming your
   * section and stating WHY the verb is live — SECTION-CONTRACT.md §2.
   *
   * This is documented here because the first wave's ownership rule forbade
   * editing that file, which made this prop unfillable: a lane built a chip,
   * measured the failure, and deleted its own work. Appending to the allowlist
   * is explicitly allowed (§5); it is the one shared-file edit that does not
   * conflict between parallel lanes.
   */
  action?: ReactNode;
  /**
   * Cap the body at the reading measure (`--set-measure`). Default `true`.
   * Pass `false` ONLY for full-bleed row tables; see the note above.
   */
  measure?: boolean;
  /**
   * Apply the standard body gutters. Default `true`. Pass `false` when the
   * body's own children carry the gutter — full-bleed rows do, because their
   * hairline has to reach the card edge to read as a table rule rather than an
   * underline.
   */
  pad?: boolean;
  /** Marks the scroller for tests that need to assert on THIS section's body. */
  bodyTestId?: string;
  children: ReactNode;
}

export function SectionFrame({
  title,
  action,
  measure = true,
  pad = true,
  bodyTestId,
  children,
}: SectionFrameProps) {
  return (
    <section className="set-section">
      <div className="set-section__head">
        <span className="set-section__title">{title}</span>
        <div className="set-section__grow" />
        {action}
      </div>
      <div className="set-section__scroll" data-testid={bodyTestId}>
        {/* The measure wrapper is a real element rather than a class on the
            scroller: capping the SCROLLER would cap its scrollbar too, parking
            it mid-card away from the edge a scrollbar is read at. */}
        <div
          className={[
            measure ? 'set-section__measure' : '',
            pad ? 'set-section__pad' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {children}
        </div>
      </div>
    </section>
  );
}

/**
 * The honest-absence block, hoisted out of `SettingsShell` so a section lane
 * can state a gap without importing the shell (which imports every section —
 * that cycle is why three sections had copy-pasted their own version of this).
 */
export function SectionAbsent({
  head,
  why,
  testId = 'section-absent',
}: {
  head: string;
  why: string;
  testId?: string;
}) {
  return (
    <div className="set-absent" data-testid={testId}>
      <span className="set-absent__head">{head}</span>
      <span className="set-absent__why">{why}</span>
    </div>
  );
}
