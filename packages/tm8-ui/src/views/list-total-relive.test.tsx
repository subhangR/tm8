// @vitest-environment jsdom
/**
 * A LIST'S `total` IS THE ONLY THING ON A LIST THE EVENT STREAM COULD NOT REACH.
 *
 * `projectRows` keeps the ROWS current — an `entity.upsert` re-files a row into
 * the right band without a read — but `total` is written in exactly one place
 * (`absorb`, on a FETCH) and `countLabel` returns `String(page.total)` verbatim,
 * ignoring the projected rows entirely. So every category tab's number, the
 * footer line and the kind-selector total were a snapshot of the moment the
 * panel first loaded, frozen until a resync or a space switch.
 *
 * User report 2026-08-21, against the session list: "the counts are not getting
 * updated". In Progress kept saying 2 while the rows beneath it emptied out.
 *
 * The band chosen here is `sessionStatus`, not `category`, for a reason worth
 * keeping: it is the axis the FIXTURE moves when a session is terminated, so
 * the test exercises a real transition rather than a hand-written summary.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureSeam } from '../data';
import { useGateData } from './useGateData';

const RUNNING = { sessionStatus: ['running'] };

/** COUNTS_DEBOUNCE_MS is 400; give the trailing timer room without racing it. */
const AFTER_DEBOUNCE = { timeout: 4000 };

describe('a list total follows the durable stream', () => {
  it('drops when a running session is terminated out of the band', async () => {
    const seam = createFixtureSeam();

    const { result, unmount } = renderHook(() => {
      const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam });
      // Called FROM RENDER, exactly as EntityListPanel's `tabCount` calls it.
      const rows = data.rowsFor('work_session')(RUNNING);
      const page = data.pageStateOf('work_session')(RUNNING);
      return { data, rows, page };
    });

    await waitFor(() => expect(result.current.data.ready).toBe(true));
    await waitFor(() => expect(result.current.page.total).toBeDefined());

    const before = result.current.page.total!;
    // A band with nothing in it cannot show a count going stale.
    expect(before).toBeGreaterThan(0);
    expect(result.current.rows.length).toBe(before);

    const victim = result.current.rows[0]!.id;
    await act(async () => {
      await seam.commands.terminate(victim, {});
    });

    // The ROW leaves immediately — that half always worked, and asserting it
    // here is what makes the total's failure legible as a SECOND defect rather
    // than as the list not updating at all.
    await waitFor(() => expect(result.current.rows.some((r) => r.id === victim)).toBe(false));

    // THE LINE THIS FILE EXISTS FOR.
    await waitFor(() => expect(result.current.page.total).toBe(before - 1), AFTER_DEBOUNCE);

    unmount();
    seam.dispose();
  });

  /**
   * THE OTHER HALF OF THE SAME REPORT — "Sessions Status in the Entity List is
   * not correct. and the counts also."
   *
   * A live count and a live list can still be wrong together. `projectRows`
   * drops every `sessionKind: 'credential'` row (082, Ruling 16 — a login
   * terminal is not work), and the QUERY did not, so `total` counted rows the
   * list refused to render. On the launch node that put "To Do 1" over an
   * empty tab, because the only to_do session in the space was an eight-day-old
   * `spawning` credential terminal that nothing ever reaps.
   *
   * The fixture seeds `ws-credential-login` as `running` precisely so this is
   * reachable without a database — and it reproduced the defect verbatim
   * (`total: 3` over two rendered rows) until the query learned the rule.
   */
  it('counts exactly the rows the list will render', async () => {
    const seam = createFixtureSeam();
    const { result, unmount } = renderHook(() => {
      const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam });
      return {
        data,
        rows: data.rowsFor('work_session')(RUNNING),
        page: data.pageStateOf('work_session')(RUNNING),
      };
    });

    await waitFor(() => expect(result.current.data.ready).toBe(true));
    await waitFor(() => expect(result.current.page.total).toBeDefined());

    // The band is not saturated, so `total` and the rendered rows are the same
    // question asked of two sources. They must give the same answer.
    expect(result.current.page.hasMore).toBe(false);
    expect(result.current.page.total).toBe(result.current.rows.length);
    // And the row the count used to include is genuinely absent, so the
    // assertion above cannot be satisfied by both sides being empty.
    expect(result.current.rows.length).toBeGreaterThan(0);
    expect(result.current.rows.some((r) => r.id === 'ws-credential-login')).toBe(false);

    unmount();
    seam.dispose();
  });
});
