// @vitest-environment jsdom
/**
 * The Changes rail for a session WITHOUT a worktree, read from its own git
 * checkouts. What a screenshot cannot show:
 *
 *  1. COMMITTED WORK COUNTS. A file the agent committed (clean working tree)
 *     is listed — the measured prod shape was 16 commits ahead and nothing
 *     uncommitted, and a rail that read only `git status` showed nothing.
 *  2. "JUST CHANGED" IS DERIVED. The first read is a baseline; only a file
 *     whose counts moved between two reads is tagged.
 *  3. AN OLDER NODE STILL ANSWERS. A failing checkouts read falls back to the
 *     transcript list, and stops polling the op that does not exist.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId, SessionCheckoutFile, SessionCheckouts, SessionTranscriptPage } from '@tm8/contract';
import type { Seam } from '../data/seam.js';
import { SessionCheckoutChanges } from './SessionCheckoutChanges.js';

const SESSION = '55555555-5555-4555-8555-555555555555' as EntityId;

function listing(files: SessionCheckoutFile[], over: Partial<SessionCheckouts['checkouts'][number]> = {}): SessionCheckouts {
  return {
    sessionId: SESSION,
    available: true,
    unavailableReason: null,
    checkouts: [
      {
        name: 'w266',
        shared: false,
        readable: true,
        branch: 'crawl/266',
        remote: null,
        baseRef: 'origin/main',
        mergeBaseOid: 'm',
        headOid: 'h',
        ahead: 16,
        uncommitted: 0,
        lastCommitAt: new Date().toISOString(),
        files,
        filesTruncated: false,
        stat: {
          filesChanged: files.length,
          additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
          deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
        },
        ...over,
      },
    ],
    checkoutsTruncated: false,
    checkedAt: new Date().toISOString(),
  };
}

const committed: SessionCheckoutFile[] = [
  { path: 'src/crawl/fetch.ts', change: 'M', additions: 7, deletions: 2, uncommitted: false },
  { path: 'src/crawl/queue.ts', change: 'A', additions: 40, deletions: 0, uncommitted: false },
];

const noTranscript: SessionTranscriptPage = {
  available: false,
  unavailableReason: 'no_transcript_file',
} as unknown as SessionTranscriptPage;

function seamWith(over: Partial<Seam>): Seam {
  return {
    transcript: async () => noTranscript,
    gitCheckoutDiff: async (_s: EntityId, checkout: string, path: string) => ({
      sessionId: SESSION,
      checkout,
      path,
      change: 'M' as const,
      additions: 7,
      deletions: 2,
      baseRef: 'origin/main',
      diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      diffTruncated: false,
      checkedAt: new Date().toISOString(),
    }),
    ...over,
  } as unknown as Seam;
}

const mount = (seam: Seam, live = false) =>
  render(<SessionCheckoutChanges seam={seam} sessionId={SESSION} live={live} cause="No worktree." noWorktree />);

const rowFor = (path: string) =>
  screen.getAllByTestId('session-changes-file').find((li) => li.dataset.path === path)!;

describe('a worktree-less session shows its checkouts', () => {
  it('lists COMMITTED work with branch and commits ahead — a clean tree is not "no changes"', async () => {
    mount(seamWith({ gitCheckouts: async () => listing(committed) }));
    await screen.findByTestId('session-changes-checkout');
    expect(screen.getByTestId('session-changes-checkout-facts').textContent).toContain('16 commits ahead of origin/main');
    expect(screen.getByText('crawl/266')).toBeTruthy();
    expect(rowFor('src/crawl/fetch.ts')).toBeTruthy();
    expect(rowFor('src/crawl/queue.ts').textContent).toContain('+40');
    expect(screen.getByTestId('session-changes-totals').textContent).toBe('+47−2');
  });

  it('opens a read-only diff for the clicked file, by checkout and path', async () => {
    const diffs = vi.fn();
    const base = seamWith({ gitCheckouts: async () => listing(committed) });
    mount({
      ...base,
      gitCheckoutDiff: async (s: EntityId, c: string, p: string) => {
        diffs(c, p);
        return base.gitCheckoutDiff(s, c, p);
      },
    } as Seam);
    await screen.findByTestId('session-changes-checkout');
    fireEvent.click(screen.getAllByTestId('session-changes-open').find((b) => b.dataset.path === 'src/crawl/fetch.ts')!);
    await screen.findByTestId('session-changes-diff-head');
    expect(diffs).toHaveBeenCalledWith('w266', 'src/crawl/fetch.ts');
    expect(screen.queryByRole('button', { name: /stage|commit|discard/i })).toBeNull();
  });

  it('tags only the file whose counts moved between two reads as "just changed"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      mount(
        seamWith({
          gitCheckouts: async () => {
            reads += 1;
            return reads === 1
              ? listing(committed)
              : listing([{ ...committed[0]!, additions: 9, uncommitted: true }, committed[1]!]);
          },
        }),
        true,
      );
      await screen.findByTestId('session-changes-checkout');
      expect(screen.queryByTestId('session-changes-just-changed')).toBeNull(); // baseline
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(() => expect(rowFor('src/crawl/fetch.ts').dataset.justChanged).toBe('true'));
      expect(rowFor('src/crawl/queue.ts').dataset.justChanged).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the transcript when the node has no checkouts op, and stops asking it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = vi.fn();
      mount(
        seamWith({
          gitCheckouts: async () => {
            calls();
            throw new Error('404 not found');
          },
        }),
        true,
      );
      await screen.findByTestId('session-changes-transcript-state');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the transcript when the directory holds no checkout', async () => {
    mount(seamWith({ gitCheckouts: async () => ({ ...listing([]), checkouts: [] }) }));
    await screen.findByTestId('session-changes-transcript-state');
  });

  it('keeps the transcript reachable as a second, named source', async () => {
    mount(seamWith({ gitCheckouts: async () => listing(committed) }));
    await screen.findByTestId('session-changes-checkout');
    fireEvent.click(screen.getByTestId('session-changes-source-transcript'));
    await screen.findByTestId('session-changes-transcript-state');
  });
});
