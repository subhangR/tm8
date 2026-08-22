// @vitest-environment jsdom
/**
 * THE CENTRAL RULE, MADE A TEST: NO ID AND NO STATUS TOKEN EVER REACHES A
 * SCREEN.
 *
 * This is the one law of the whole design — "the person reading never sees the
 * machine word, only the human one" — and it is exactly the kind of law that
 * decays by accident. Nobody sets out to print `awaiting_input`; someone adds
 * a tooltip, a `title=`, an `aria-label` built from a field, or a fallback
 * that reaches for `status` when a label is missing, and the token ships.
 * Typecheck cannot see it (every status is a string), and a component test
 * that asserts what SHOULD be on screen cannot see it either, because the
 * defect is an extra thing rather than a missing one.
 *
 * SO THIS ASSERTS THE ABSENCE, over every fixture and both components, in
 * both directions: rendered TEXT and the attributes a person can actually
 * surface (`title`, `aria-label`, `alt`, `placeholder`). It is deliberately
 * not a scan of every attribute — a `key` handed to React and a `data-` hook
 * are not things a reader can see, and banning them would make the guard
 * about tidiness rather than about the rule.
 *
 * IT ONLY WORKS BECAUSE THE FIXTURES ARE REAL. `crew-fixtures.ts` uses
 * uuid-shaped keys and server-spelled status tokens on purpose; with keys
 * like 'a' and 'b' this file would pass for free and prove nothing.
 *
 * THE SUBSTRING MATCH IS DELIBERATE, AND IT HAS A COST. It already caught one
 * fixture whose activity line read "Running the settings tests" — innocent
 * English that contains `running`. The scan was NOT loosened to a word
 * boundary in response, because `awaiting_input` reaching a screen inside a
 * larger string is exactly the failure this exists for, and every loosening
 * is a hole. The rule for a future contributor is therefore: if legitimate
 * prose trips this, REWORD THE PROSE. That costs one adjective; a guard with
 * an exemption list costs the guard.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CrewCard } from './CrewCard';
import { LiveDock } from './LiveDock';
import { CREW_FIXTURES, FIXTURE_KEYS } from './crew-fixtures';
import { HELPER_WORDS, type HelperStatus } from './status-vocabulary';

const STATUS_TOKENS = Object.keys(HELPER_WORDS) as HelperStatus[];

/** A uuid anywhere in the string, however it was embedded. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The attributes a reader can actually surface, plus the visible text. */
const READABLE_ATTRS = ['title', 'aria-label', 'alt', 'placeholder'] as const;

function readableStrings(root: HTMLElement): string[] {
  const out: string[] = [root.textContent ?? ''];
  for (const element of root.querySelectorAll('*')) {
    for (const attr of READABLE_ATTRS) {
      const value = element.getAttribute(attr);
      if (value) out.push(value);
    }
  }
  return out;
}

/**
 * Both surfaces, every fixture, plus the expanded state of each — a token
 * that only appears once a disclosure is open is still a token that shipped.
 */
function renderAll(crew: (typeof CREW_FIXTURES)[number]['crew']): HTMLElement[] {
  const roots: HTMLElement[] = [];

  const card = render(<CrewCard crew={crew} />);
  const more = card.queryByTestId('crew-card-more');
  if (more) fireEvent.click(more);
  roots.push(card.container as HTMLElement);

  const dock = render(<LiveDock crew={crew} onOpenCrew={() => {}} />);
  const toggle = dock.queryByTestId('live-dock-toggle');
  if (toggle) fireEvent.click(toggle);
  roots.push(dock.container as HTMLElement);

  return roots;
}

describe.each(CREW_FIXTURES.map((f) => [f.name, f.crew] as const))(
  'the %s fixture shows no machine words',
  (_name, crew) => {
    it('renders no entity id', () => {
      for (const root of renderAll(crew)) {
        for (const value of readableStrings(root)) {
          expect(value, `a uuid reached the screen: ${value}`).not.toMatch(UUID);
        }
      }
    });

    it('renders none of the fixture keys verbatim', () => {
      // Belt and braces: the regex above catches uuid SHAPE, this catches the
      // literal values even if the fixtures' key format ever changes.
      for (const root of renderAll(crew)) {
        for (const value of readableStrings(root)) {
          for (const key of FIXTURE_KEYS) {
            expect(value.includes(key), `key ${key} reached the screen`).toBe(false);
          }
        }
      }
    });

    it('renders no raw status token', () => {
      for (const root of renderAll(crew)) {
        for (const value of readableStrings(root)) {
          const lower = value.toLowerCase();
          for (const token of STATUS_TOKENS) {
            expect(lower.includes(token), `status token "${token}" reached the screen: ${value}`)
              .toBe(false);
          }
          // The unknown-status fixture's token, which no vocabulary entry
          // covers and which a naive fallback would print straight out.
          expect(lower).not.toContain('reticulating_splines');
          // Underscored identifiers in general: the shape a machine word has.
          expect(value, `an identifier-shaped word reached the screen: ${value}`).not.toMatch(
            /\b[a-z]+_[a-z_]+\b/,
          );
        }
      }
    });
  },
);

describe('the guard can actually fail', () => {
  it('would catch a uuid or a token if one were rendered', () => {
    // A control on the control. If `readableStrings` ever stopped reading the
    // DOM, every assertion above would pass over an empty list and this file
    // would be worth nothing.
    render(
      <div data-testid="canary" title="awaiting_input">
        01a028f6-5b26-77d6-bf6d-226000000001
      </div>,
    );
    const canary = screen.getByTestId('canary');
    const values = readableStrings(canary);
    expect(values.some((value) => UUID.test(value))).toBe(true);
    expect(
      readableStrings(canary.parentElement as HTMLElement).some((value) =>
        value.includes('awaiting_input'),
      ),
    ).toBe(true);
  });
});
