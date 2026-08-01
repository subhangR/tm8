// @vitest-environment jsdom
/**
 * The Debug journal surface.
 *
 * THE FIRST DESCRIBE IS THE POINT OF THIS FILE. The header stats and the table
 * columns were originally written from OPPOSITE perspectives — the header
 * showed `agentToCli` under a "tokens in" label while the table read from the
 * CLI's side — so the same quantity appeared as "in" in one place and "out" in
 * the other, and the headline number named the wrong direction. The direction
 * is the whole meaning of this surface, so it is pinned rather than trusted.
 *
 * The convention, once: EVERYTHING here is from the AGENT's perspective.
 *   cliToAgent → "into agent context"  (stdout+stderr; the LARGE number)
 *   agentToCli → "typed by agent"      (argv+stdin;   the SMALL number)
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionJournalPage, SessionJournalRecord } from '@tm8/contract';
import { SessionDebugBody } from './SessionDebugBody.js';
import type { Seam } from '../../data/seam.js';

const SESSION = '019fbc0a-2eb2-7992-8da8-c6a6467a3c9a';

function record(over: Partial<SessionJournalRecord> = {}): SessionJournalRecord {
  return {
    v: 1, seq: 0, sessionId: SESSION, spaceId: null, teamMemberId: null,
    pid: 4242, startedAt: '2026-08-01T14:22:07.114Z', durationMs: 214,
    command: { path: ['entity', 'get'], argv: ['entity', 'get', 'abc'], cwd: '/repo' },
    input: { stdinChars: 0 },
    output: { stdoutChars: 4000, stderrChars: 0, stdoutSample: 'x', stderrSample: '', truncated: false },
    calls: [],
    result: { exitCode: 0, error: null },
    // Deliberately lopsided and unmistakable: 7 typed, 1000 into context.
    tokens: { estimator: 'chars/4', agentToCli: 7, cliToAgent: 1000 },
    ...over,
  };
}

function page(over: Partial<SessionJournalPage> = {}): SessionJournalPage {
  return {
    sessionId: SESSION,
    available: true,
    unavailableReason: null,
    totals: {
      invocations: 1, failed: 0,
      agentToCliEst: 7, cliToAgentEst: 1000,
      estimator: 'chars/4', malformed: 0,
    },
    records: [record()],
    hasMore: false,
    ...over,
  };
}

function seamWith(p: SessionJournalPage): Seam {
  return { journal: vi.fn().mockResolvedValue(p) } as unknown as Seam;
}

describe('direction is stated from the agent’s perspective, everywhere', () => {
  it('shows the LARGE number as into-context and the SMALL one as typed', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const header = await screen.findByTestId('session-debug-header');

    // The big number must sit with the into-context label, not the typed one.
    const intoCtx = within(header).getByText(/into agent context/i).closest('.pn-debug__stat');
    const typed = within(header).getByText(/typed by agent/i).closest('.pn-debug__stat');
    expect(intoCtx?.textContent).toContain('1.0k');
    expect(typed?.textContent).toContain('7');
    // And the inversion this test exists to catch: 7 must NOT be the
    // into-context figure.
    expect(intoCtx?.textContent).not.toMatch(/\b7\b/);
  });

  it('orders the row cells the same way the columns are labelled', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const table = await screen.findByTestId('session-debug-table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent ?? '');
    const cells = within(table).getAllByRole('cell').map((c) => c.textContent ?? '');

    const tokCtxCol = headers.findIndex((h) => h.includes('~tok →ctx'));
    const tokTypedCol = headers.findIndex((h) => h.includes('~tok typed'));
    expect(tokCtxCol).toBeGreaterThan(-1);
    expect(tokTypedCol).toBeGreaterThan(-1);
    expect(cells[tokCtxCol]).toContain('1.0k'); // cliToAgent
    expect(cells[tokTypedCol]).toContain('7');   // agentToCli
  });
});

describe('honesty', () => {
  it('never prints a bare token number — every one carries ~ and names the estimator', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const header = await screen.findByTestId('session-debug-header');
    for (const stat of Array.from(header.querySelectorAll('.pn-debug__stat'))) {
      const label = stat.textContent ?? '';
      if (!/tok/i.test(label)) continue;
      expect(label).toContain('~');
      expect(label).toContain('chars/4');
    }
  });

  it('permanently states the CLI boundary and that this is not a shell history', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const note = await screen.findByTestId('session-debug-boundary');
    expect(note.textContent).toMatch(/CLI boundary only/i);
    expect(note.textContent).toMatch(/not a shell history/i);
    expect(note.textContent).toMatch(/never the model’s reported usage/i);
  });

  it('renders an EXPLAINED empty when there is no journal — not a zero', async () => {
    const p = page({
      available: false,
      unavailableReason: 'no_journal_file',
      records: [],
      totals: { invocations: 0, failed: 0, agentToCliEst: 0, cliToAgentEst: 0, estimator: 'chars/4', malformed: 0 },
    });
    render(<SessionDebugBody seam={seamWith(p)} sessionId={SESSION} live={false} />);

    const empty = await screen.findByTestId('session-debug-empty');
    expect(empty.textContent).toMatch(/journal/i);
    // The failure mode being guarded: a confident "0 commands" table.
    expect(screen.queryByTestId('session-debug-table')).toBeNull();
  });

  it('surfaces malformed records rather than dropping them silently', async () => {
    const p = page();
    p.totals.malformed = 3;
    render(<SessionDebugBody seam={seamWith(p)} sessionId={SESSION} live={false} />);
    const header = await screen.findByTestId('session-debug-header');
    expect(header.textContent).toMatch(/malformed/i);
    expect(header.textContent).toContain('3');
  });

  it('marks a truncated sample and still shows the exact character count', async () => {
    const p = page({
      records: [record({
        output: { stdoutChars: 50_000, stderrChars: 0, stdoutSample: 'z'.repeat(20), stderrSample: '', truncated: true },
      })],
    });
    render(<SessionDebugBody seam={seamWith(p)} sessionId={SESSION} live={false} />);
    const table = await screen.findByTestId('session-debug-table');
    within(table).getAllByRole('button', { name: /expand/i })[0]!.click();
    await waitFor(() => expect(screen.getByTestId('session-debug-truncated')).toBeTruthy());
    expect(screen.getByTestId('session-debug-detail').textContent).toContain('50000');
  });
});

describe('polling', () => {
  it('reads once and does NOT poll a session that is not live', async () => {
    vi.useFakeTimers();
    try {
      const seam = seamWith(page());
      render(<SessionDebugBody seam={seam} sessionId={SESSION} live={false} />);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((seam.journal as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
