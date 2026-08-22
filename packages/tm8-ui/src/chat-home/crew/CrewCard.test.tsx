// @vitest-environment jsdom
/**
 * THE CREW CARD, JUDGED ON WHAT A PERSON READS.
 *
 * Every test here asks "what does this say to someone who does not know what
 * a session is" — a role instead of an id, a sentence instead of a token, a
 * dead end that still offers a next move. The one thing a card like this must
 * never do is look fine while withholding the fact a person needed.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CrewCard } from './CrewCard';
import {
  CREW_ALL_DONE,
  CREW_CROWDED,
  CREW_EMPTY,
  CREW_ONE_NEEDS_YOU,
  CREW_ONE_STUCK,
  CREW_UNKNOWN_STATUS,
} from './crew-fixtures';

/** The row that names this role. Pills carry a leading dot glyph, so their
 *  text is asserted through the row rather than matched exactly. */
const rowFor = (role: string): HTMLElement =>
  screen.getAllByTestId('crew-card-row').find((row) => within(row).queryByText(role))!;

describe('what the card says', () => {
  it('names the helpers by role and says what each is doing', () => {
    render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    expect(screen.getByText('Drafter')).toBeTruthy();
    expect(screen.getByText('Tester')).toBeTruthy();
    expect(screen.getByText('Reviewer')).toBeTruthy();
    // The running helper's live line wins; the others take their state's word.
    expect(screen.getByText('Rewriting the checkout page layout')).toBeTruthy();
    expect(screen.getByText('Waiting its turn')).toBeTruthy();
    expect(screen.getByText('Needs a word from you')).toBeTruthy();
  });

  it('heads with the count and the elapsed phrasing', () => {
    render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    expect(screen.getByText('3 teammates are on this')).toBeTruthy();
    expect(
      screen.getByText('Cleaning up the checkout page · Started 2m ago · about 6 min left'),
    ).toBeTruthy();
  });

  it('counts correctly in the footer', () => {
    render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    expect(screen.getByTestId('crew-card-summary').textContent).toBe(
      '1 needs you · 1 working · 1 waiting',
    );
  });

  it('renders a status pill per helper, in the vocabulary words', () => {
    render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    expect(rowFor('Drafter').textContent).toContain('Working');
    expect(rowFor('Tester').textContent).toContain('Waiting');
    expect(rowFor('Reviewer').textContent).toContain('Your turn');
  });

  it('renders nothing at all for a crew nobody staffed', () => {
    const { container } = render(<CrewCard crew={CREW_EMPTY} />);
    // Not an empty frame — the transcript must not carry furniture for work
    // that never started.
    expect(container.innerHTML).toBe('');
  });

  it('falls back readably for a status the vocabulary does not know', () => {
    render(<CrewCard crew={CREW_UNKNOWN_STATUS} />);
    expect(screen.getByText('Checking on this one')).toBeTruthy();
    expect(screen.getByText('Drafter')).toBeTruthy();
  });
});

describe('only "needs you" is urgent', () => {
  it('marks the card and the row when a helper is asking', () => {
    render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    expect(screen.getByTestId('crew-card').getAttribute('data-urgent')).toBe('true');
    const urgent = screen
      .getAllByTestId('crew-card-row')
      .filter((row) => row.getAttribute('data-tone') === 'needs-you');
    expect(urgent).toHaveLength(1);
  });

  it('leaves a stuck crew un-urgent — stuck is loud enough on its own row', () => {
    render(<CrewCard crew={CREW_ONE_STUCK} />);
    expect(screen.getByTestId('crew-card').getAttribute('data-urgent')).toBeNull();
  });

  it('offers the answer affordance only when someone is asking', () => {
    const onRespond = vi.fn();
    const { rerender } = render(<CrewCard crew={CREW_ONE_NEEDS_YOU} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(onRespond).toHaveBeenCalledOnce();

    rerender(<CrewCard crew={CREW_ALL_DONE} onRespond={onRespond} />);
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
  });

  it('disables the affordance with a reason rather than dropping it', () => {
    // FleetPane's rule, held here: an absent capability disables an action
    // with a reason and never blanks the row.
    render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    const answer = screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    expect(answer.title.length).toBeGreaterThan(10);
  });
});

describe('a dead end always offers a next move', () => {
  it('carries the plain sentence and the one button', () => {
    const onHelperAction = vi.fn();
    render(<CrewCard crew={CREW_ONE_STUCK} onHelperAction={onHelperAction} />);
    // The cause is IN the sentence, not in a second line beside it.
    expect(
      screen.getByText("Hit a wall — the test file it needed doesn't exist yet"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create it' }));
    expect(onHelperAction).toHaveBeenCalledWith({ key: expect.any(String), role: 'Tester' });
  });

  it('still offers one when the host supplied no explanation', () => {
    render(
      <CrewCard
        crew={{ helpers: [{ key: 'k1', role: 'Tester', state: 'blocked' }] }}
        onHelperAction={vi.fn()}
      />,
    );
    // The gap is STATED. A card that printed a bare "Hit a wall" would be
    // indistinguishable from a healthy two-word label.
    expect(screen.getByText('Hit a wall — no reason came back with this one')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Look into it' })).toBeTruthy();
  });

  it('says the minutes of silence rather than spinning', () => {
    render(<CrewCard crew={CREW_ONE_STUCK} />);
    expect(screen.getByText('Nothing heard for 5 min')).toBeTruthy();
  });
});

describe('collapsing above six', () => {
  it('shows six rows and reports what is hidden, including the urgent one', () => {
    render(<CrewCard crew={CREW_CROWDED} />);
    expect(screen.getAllByTestId('crew-card-row')).toHaveLength(6);
    const more = screen.getByTestId('crew-card-more');
    expect(more.textContent).toBe('Show 2 more · 1 needs you · 1 finished');
    // The footer counts the WHOLE crew, not the visible slice.
    expect(screen.getByTestId('crew-card-summary').textContent).toBe(
      '1 needs you · 4 working · 2 waiting · 1 finished',
    );
  });

  it('expands to the full crew and back', () => {
    render(<CrewCard crew={CREW_CROWDED} />);
    fireEvent.click(screen.getByTestId('crew-card-more'));
    expect(screen.getAllByTestId('crew-card-row')).toHaveLength(8);
    expect(screen.getByText('Sorter')).toBeTruthy();
    fireEvent.click(screen.getByTestId('crew-card-fewer'));
    expect(screen.getAllByTestId('crew-card-row')).toHaveLength(6);
  });

  it('offers no collapse control for a crew that fits', () => {
    render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    expect(screen.queryByTestId('crew-card-more')).toBeNull();
    expect(screen.queryByTestId('crew-card-fewer')).toBeNull();
  });
});

describe('the progress track', () => {
  it('reports a measured amount and nothing more', () => {
    render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    const track = within(rowFor('Drafter')).getByRole('progressbar');
    expect(track.getAttribute('aria-valuenow')).toBe('72');
    expect(track.getAttribute('data-track')).toBe('determinate');
  });

  it('never announces — the dock is the one live region (P4)', () => {
    const { container } = render(<CrewCard crew={CREW_ONE_NEEDS_YOU} />);
    // A transcript can hold several cards; N regions would speak one event N
    // times, which is the noise P4 exists to prevent.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
  });

  it('draws no track at all for a helper with nothing to report', () => {
    // Finished, stuck and silent helpers, none carrying a number: a track
    // here would be motion this card cannot vouch for.
    render(<CrewCard crew={CREW_ONE_STUCK} />);
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });
});
