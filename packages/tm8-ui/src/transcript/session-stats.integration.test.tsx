// @vitest-environment jsdom
/**
 * THE WHOLE CHAIN, ONCE — host helper → seam → hook → panel.
 *
 * Every other test in this lane holds one link to account with the next one
 * faked. That is the right shape for a rule, and it is exactly the shape that
 * ships a surface which is correct in every part and renders nothing: the
 * helper could return `undefined`, the hook could ask for the wrong options,
 * the fixture arm could answer the explained empty, and each unit test would
 * still be green.
 *
 * So this one runs `sessionStatsSurfaceFor` against the REAL fixture seam and
 * reads the numbers back off the DOM. It is deliberately assertion-heavy about
 * values rather than about structure: the fixture's exited arm is built so that
 * `0` and `—` both appear, and a chain that quietly lost the distinction
 * anywhere along it fails here.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { sessionExited, sessionFailed } from '../fixtures';
import { sessionStatsSurfaceFor } from '../views/sessionStatsSurface';

function mount(id: string) {
  const seam = createFixtureSeam();
  return render(<>{sessionStatsSurfaceFor(seam, id)}</>);
}

describe('the exited session’s post-mortem, end to end over the fixture seam', () => {
  it('reads real numbers through the real helper, keeping 0 and — apart', async () => {
    const { getByTestId } = mount(sessionExited.id);
    await waitFor(() => expect(getByTestId('session-stats').dataset.phase).toBe('ready'));

    // A MEASURED ZERO survives the whole chain as a digit…
    const output = getByTestId('session-stats-token-output');
    expect(output.textContent).toContain('0');
    expect(output.dataset.hollow).toBe('false');

    // …and an UNREPORTED field survives it as a dash. Both from one page.
    expect(getByTestId('session-stats-token-cache-read').dataset.hollow).toBe('true');
    expect(getByTestId('session-stats-token-cache-create').dataset.hollow).toBe('true');

    // The total is the sum of the two reported fields, and says it is a floor.
    expect(getByTestId('session-stats-total').textContent).toBe('12,400');
    expect(getByTestId('session-stats-total-partial')).toBeTruthy();

    // The malformed-line marker made it through with its real count.
    expect(getByTestId('session-stats-malformed').textContent).toMatch(/3 lines/);
    // …while `partial: false` means the tail warning correctly stays away.
    expect(getByTestId('session-stats').textContent).not.toMatch(/newest part/i);

    expect(getByTestId('session-stats-models').textContent).toContain('claude-fable-5');
  });

  it('asks the seam for the file accounting, which only a one-shot read can afford', async () => {
    // Proves the `files: true` option actually reaches the seam: the fixture
    // attaches `fileChanges` ONLY when asked, exactly as the server does.
    const { getByTestId } = mount(sessionExited.id);
    await waitFor(() => expect(getByTestId('session-stats-files-provenance')).toBeTruthy());
    expect(getByTestId('session-stats-files-provenance').textContent).toMatch(/not a git diff/i);
  });

  it('renders the explained empty, per reason, for a session with no transcript', async () => {
    // Every fixture session but the live one and the exited one answers
    // `no_transcript_file`, so this is the common real-world case: a panel that
    // states why there is nothing rather than a grid of zeroes.
    const { getByTestId } = mount(sessionFailed.id);
    await waitFor(() => expect(getByTestId('session-stats').dataset.phase).toBe('unavailable'));
    expect(getByTestId('session-stats-unavailable').textContent).toMatch(
      /no transcript file exists/i,
    );
  });

  it('returns nothing at all when the host has no seam — never an empty panel', () => {
    // An absent host must degrade to the canvas as it was, not to a panel of
    // dashes claiming the provider reported nothing.
    expect(sessionStatsSurfaceFor(undefined, sessionExited.id)).toBeUndefined();
    expect(sessionStatsSurfaceFor(createFixtureSeam(), null)).toBeUndefined();
  });
});
