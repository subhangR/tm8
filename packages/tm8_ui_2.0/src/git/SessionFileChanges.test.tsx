// @vitest-environment jsdom
/**
 * The transcript-observed file changes — per-file ± counts, expandable diff,
 * and the provenance label that keeps "observed tool calls" from reading as
 * "git diff". Driven through the fixture seam's `files: true` face.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture.js';
import { sessionLive, sessionStale } from '../fixtures/index.js';
import { SessionFileChanges } from './SessionFileChanges.js';

describe('files this session changed', () => {
  it('renders per-file rows with ± counts, totals, and the transcript label', async () => {
    render(<SessionFileChanges seam={createFixtureSeam()} sessionId={sessionLive.id as EntityId} />);
    const block = await screen.findByTestId('session-file-changes');
    expect(block.textContent).toContain('observed from the agent transcript, not git');

    expect(screen.getByTestId('session-file-changes-totals').textContent).toBe('+36−3');
    const rows = screen.getAllByTestId('session-file-change');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('packages/execution/src/pty/PtyHostService.ts');
    expect(rows[0]!.textContent).toContain('+14');
    expect(rows[0]!.textContent).toContain('−3');
    expect(rows[0]!.textContent).toContain('2 edits');
  });

  it('a text-elided hunk keeps its counts and says the text was elided', async () => {
    render(<SessionFileChanges seam={createFixtureSeam()} sessionId={sessionLive.id as EntityId} />);
    await screen.findByTestId('session-file-changes');
    const rows = screen.getAllByTestId('session-file-change');
    // The Write row carries counts but no hunk text (fixture: null/null).
    expect(rows[1]!.textContent).toContain('+22');
    expect(screen.getByTestId('session-file-change-elided').textContent).toContain('too large to carry text');
  });

  it('a session with no accounting renders NOTHING — no empty frame', async () => {
    const { container } = render(
      <SessionFileChanges seam={createFixtureSeam()} sessionId={sessionStale.id as EntityId} />,
    );
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });
});
