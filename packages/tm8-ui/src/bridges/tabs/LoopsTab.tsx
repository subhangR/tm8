import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeView, LoopRunTargetResult, LoopView } from '@tm8/contract';
import { LOOP_TARGET_TEXT_MAX } from '@tm8/contract';
import { shortDate } from '../../kit/time';
import type { LoopsClient } from '../../loops/api';
import { bridgeProviderLabel } from '../bridge-marks';
import { bridgeFailureOf } from '../format';

/**
 * LOOPS (BRIDGES-V2-DESIGN §2.2; v1 D26; Bridges L, #1433): the loops that post
 * into this bridge — a teammate on a schedule, with its own words per group.
 *
 * A loop names its groups in `definition.targets` ({bridgeId, text}). There is
 * no "loops for this bridge" read, so the tab pages `loops.list` and keeps the
 * loops whose targets include this bridge (capped, and it says so if the cap
 * is hit). Everything it writes is a `loops.*` call on the loop itself:
 *   · New loop here — a `post` loop with this group as its one target
 *   · Add to a loop — this group appended to an existing loop's targets
 *   · Edit what it says here / Remove from this group — the target, nothing else
 *   · Run now — `loops.runNow`; the per-group result shows on the row
 * The server is the authority on every rule (a post loop needs text for each
 * group; at most 32 groups; quiet-hours exemption is admin-only) and its
 * refusal is shown where it happened.
 */

const PAGE = 100;
const MAX_PAGES = 5;

const RESULT_WORD: Record<LoopRunTargetResult, string> = {
  pending: 'sending',
  posted: 'posted',
  paused: 'not sent: the bridge was paused',
  held: 'held for quiet hours',
  superseded: 'superseded by a newer post',
  refused: 'refused',
};

const ACTION_WORD: Record<LoopView['definition']['action'], string> = {
  post: 'Posts',
  spawn: 'Runs a teammate',
  dispatch: 'Dispatches',
  tool: 'Runs a tool',
};

function stateWord(loop: LoopView): string {
  if (!loop.state.enabled) return 'off';
  if (loop.state.pausedUntil) return `paused until ${shortDate(loop.state.pausedUntil)}`;
  return 'on';
}

/** The loops whose targets include `bridgeId`, and whether the scan stopped at its cap. */
export async function loopsForBridge(
  loops: Pick<LoopsClient, 'list'>,
  spaceId: string,
  bridgeId: string,
): Promise<{ here: LoopView[]; others: LoopView[]; capped: boolean }> {
  const here: LoopView[] = [];
  const others: LoopView[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await loops.list(spaceId, { limit: PAGE, ...(cursor ? { cursor } : {}) });
    for (const loop of result.items) {
      (loop.definition.targets.some((t) => t.bridgeId === bridgeId) ? here : others).push(loop);
    }
    if (!result.nextCursor) return { here, others, capped: false };
    cursor = result.nextCursor;
  }
  return { here, others, capped: true };
}

export function LoopsTab({
  view,
  loops,
  onOpenEntity,
}: {
  view: BridgeView;
  loops: LoopsClient | null | undefined;
  onOpenEntity?: (id: string) => void;
}) {
  const [state, setState] = useState<{ here: LoopView[]; others: LoopView[]; capped: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ loopId: string; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState<{ loopId: string; text: string } | null>(null);
  const group = view.title;
  const provider = bridgeProviderLabel(view.provider);

  const reload = useCallback(async () => {
    if (!loops) return;
    try {
      setState(await loopsForBridge(loops, view.spaceId, view.id));
      setError(null);
    } catch (err) {
      setError(bridgeFailureOf(err));
    }
  }, [loops, view.spaceId, view.id]);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      await reload();
    } catch (err) {
      setError(bridgeFailureOf(err));
    } finally {
      setBusy(null);
    }
  };

  if (!loops) {
    return <p className="brg-hint" role="status" data-testid="bridge-loops">Loops are not wired on this surface (no loops client).</p>;
  }
  const ended = view.status === 'ended';
  const setTarget = (loop: LoopView, text: string | null) =>
    loop.definition.targets.map((t) => (t.bridgeId === view.id ? { bridgeId: t.bridgeId, text } : t));

  return (
    <div className="brg-loops" data-testid="bridge-loops">
      <p className="brg-hint">
        Loops post into {group} on a schedule, signed with their teammate's handle. Each loop says its own words
        here; while the bridge is paused or in its quiet hours, a post waits instead of going out.
      </p>
      {notice ? <p className="brg-hint" role="status">{notice}</p> : null}
      {error ? <p className="brg-error" role="alert">{error}</p> : null}
      {state === null ? (
        error ? null : <p className="brg-hint" role="status">Looking for loops that post here…</p>
      ) : state.here.length === 0 ? (
        <p className="brg-hint" data-testid="bridge-loops-empty">No loop posts into {group} yet.</p>
      ) : (
        <ul className="brg-loops__list">
          {state.here.map((loop) => {
            const target = loop.definition.targets.find((t) => t.bridgeId === view.id)!;
            const last = loop.runs.last?.targets.find((t) => t.bridgeId === view.id) ?? null;
            const isEditing = editing?.loopId === loop.id;
            return (
              <li key={loop.id} className="brg-loops__row" data-testid={`bridge-loop-${loop.id}`}>
                <div className="brg-loops__head">
                  {onOpenEntity ? (
                    <button type="button" className="brg-link brg-loops__title" onClick={() => onOpenEntity(loop.id)}>{loop.definition.title}</button>
                  ) : <span className="brg-loops__title">{loop.definition.title}</span>}
                  <span className="brg-muted">{ACTION_WORD[loop.definition.action]} · {loop.schedule.summary || loop.definition.schedule}</span>
                  <span className="brg-muted">· {stateWord(loop)}</span>
                  {loop.state.nextRunAt ? <span className="brg-muted">· next {shortDate(loop.state.nextRunAt)}</span> : null}
                </div>
                {isEditing ? (
                  <form
                    className="brg-loops__edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const text = editing.text.trim();
                      void run(loop.id, async () => {
                        await loops.update(loop, { targets: setTarget(loop, text === '' ? null : text) });
                        setEditing(null);
                        return `${loop.definition.title} now says this in ${group}.`;
                      });
                    }}
                  >
                    <textarea
                      aria-label={`What ${loop.definition.title} says in ${group}`}
                      value={editing.text}
                      maxLength={LOOP_TARGET_TEXT_MAX}
                      rows={3}
                      onChange={(e) => setEditing({ loopId: loop.id, text: e.target.value })}
                    />
                    <div className="brg-loops__actions">
                      <button type="button" className="pn-btn" onClick={() => setEditing(null)} disabled={busy !== null}>Cancel</button>
                      <button type="submit" className="pn-btn pn-btn--primary" disabled={busy !== null}>Save</button>
                    </div>
                  </form>
                ) : (
                  <p className="brg-loops__text">
                    {target.text ?? <span className="brg-muted">Uses the loop's own prompt here.</span>}
                  </p>
                )}
                {last ? (
                  <p className="brg-hint" data-testid={`bridge-loop-last-${loop.id}`}>
                    Last run here: {RESULT_WORD[last.result]}{last.reason ? ` (${last.reason})` : ''}
                    {loop.runs.last?.firedAt ? ` · ${shortDate(loop.runs.last.firedAt)}` : ''}
                  </p>
                ) : null}
                {!isEditing ? (
                  <div className="brg-loops__actions">
                    <button type="button" className="pn-btn" disabled={busy !== null || ended}
                      onClick={() => setEditing({ loopId: loop.id, text: target.text ?? '' })}
                      aria-label={`Edit what ${loop.definition.title} says here`}>
                      Edit what it says here
                    </button>
                    <button type="button" className="pn-btn" disabled={busy !== null || ended}
                      aria-label={`Run ${loop.definition.title} now`}
                      onClick={() => void run(loop.id, async () => {
                        await loops.runNow(loop.id);
                        return `${loop.definition.title} is running now.`;
                      })}>
                      Run now
                    </button>
                    <button type="button" className="pn-btn" disabled={busy !== null}
                      aria-label={`Remove ${group} from ${loop.definition.title}`}
                      onClick={() => void run(loop.id, async () => {
                        await loops.update(loop, { targets: loop.definition.targets.filter((t) => t.bridgeId !== view.id) });
                        return `${loop.definition.title} no longer posts in ${group}.`;
                      })}>
                      Remove from this group
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {state?.capped ? (
        <p className="brg-hint">Only the space's first {PAGE * MAX_PAGES} loops were checked; open Loops to see the rest.</p>
      ) : null}

      <div className="brg-loops__actions brg-loops__add">
        <button type="button" className="pn-btn pn-btn--primary" disabled={ended || creating}
          onClick={() => { setCreating(true); setAdding(null); }}>
          + New loop here
        </button>
        <button type="button" className="pn-btn" disabled={ended || !state || state.others.length === 0 || adding !== null}
          title={state && state.others.length === 0 ? 'No other loop in this space to add this group to.' : undefined}
          onClick={() => { setAdding({ loopId: '', text: '' }); setCreating(false); }}>
          Add {group} to a loop…
        </button>
      </div>

      {creating ? (
        <NewPostLoop
          view={view}
          loops={loops}
          provider={provider}
          onCancel={() => setCreating(false)}
          onCreated={(loop) => { setCreating(false); setNotice(`${loop.definition.title} will post in ${group}.`); void reload(); }}
        />
      ) : null}

      {adding && state ? (
        <form
          className="brg-loops__form"
          aria-label={`Add ${group} to a loop`}
          onSubmit={(e) => {
            e.preventDefault();
            const loop = state.others.find((l) => l.id === adding.loopId);
            if (!loop) return;
            const text = adding.text.trim();
            void run('add', async () => {
              await loops.update(loop, { targets: [...loop.definition.targets, { bridgeId: view.id, text: text === '' ? null : text }] });
              setAdding(null);
              return `${loop.definition.title} now posts in ${group} too.`;
            });
          }}
        >
          <label className="brg-form__line">
            <span className="set-eyebrow">Loop</span>
            <select aria-label="Loop to add this group to" value={adding.loopId} onChange={(e) => setAdding({ ...adding, loopId: e.target.value })}>
              <option value="">Choose a loop…</option>
              {state.others.map((l) => <option key={l.id} value={l.id}>{l.definition.title}</option>)}
            </select>
          </label>
          <label className="brg-form__line brg-loops__textline">
            <span className="set-eyebrow">What it says in {group}</span>
            <textarea aria-label={`What it says in ${group}`} rows={3} maxLength={LOOP_TARGET_TEXT_MAX} value={adding.text}
              placeholder="Leave empty to use the loop's own prompt here"
              onChange={(e) => setAdding({ ...adding, text: e.target.value })} />
          </label>
          <div className="brg-loops__actions">
            <button type="button" className="pn-btn" onClick={() => setAdding(null)} disabled={busy !== null}>Cancel</button>
            <button type="submit" className="pn-btn pn-btn--primary" disabled={!adding.loopId || busy !== null}>Add</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/**
 * A `post` loop with this group as its one target. The schedule is previewed
 * by the server as it is typed (`loops.schedule.preview`), never parsed here.
 */
function NewPostLoop({
  view, loops, provider, onCancel, onCreated,
}: {
  view: BridgeView;
  loops: LoopsClient;
  provider: string;
  onCancel(): void;
  onCreated(loop: LoopView): void;
}) {
  const [title, setTitle] = useState('');
  const [schedule, setSchedule] = useState('every weekday at 09:30');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ valid: boolean; summary: string; problem: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = useMemo(browserZone, []);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (!schedule.trim()) { setPreview(null); return; }
    const t = setTimeout(() => {
      void loops.schedulePreview(view.spaceId, schedule, zone).then(
        (p) => { if (seq.current === mine) setPreview(p); },
        () => { if (seq.current === mine) setPreview(null); },
      );
    }, 300);
    return () => clearTimeout(t);
  }, [loops, schedule, view.spaceId, zone]);

  const ready = title.trim() !== '' && text.trim() !== '' && preview?.valid === true;
  return (
    <form
      className="brg-loops__form"
      aria-label={`New loop in ${view.title}`}
      data-testid="bridge-new-loop"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setError(null);
        void loops.create(view.spaceId, {
          title: title.trim(), schedule: schedule.trim(), timezone: zone, action: 'post',
          targets: [{ bridgeId: view.id, text: text.trim() }],
        }).then(onCreated, (err) => { setError(bridgeFailureOf(err)); setBusy(false); });
      }}
    >
      <label className="brg-form__line">
        <span className="set-eyebrow">Name</span>
        <input type="text" aria-label="Loop name" value={title} placeholder="Stand-up nudge" maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="brg-form__line">
        <span className="set-eyebrow">When</span>
        <input type="text" aria-label="Schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
      </label>
      <p className="brg-hint" role="status" data-testid="bridge-new-loop-preview">
        {preview === null ? 'Checking the schedule…' : preview.valid ? `${preview.summary}` : preview.problem ?? 'That schedule is not understood.'}
      </p>
      <label className="brg-form__line brg-loops__textline">
        <span className="set-eyebrow">What it posts in {view.title}</span>
        <textarea aria-label={`What it posts in ${view.title}`} rows={3} maxLength={LOOP_TARGET_TEXT_MAX} value={text}
          placeholder={`e.g. Morning! Reply here with what you're on today.`} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="brg-hint">
        It posts to {provider} as the space's teammate; quiet hours hold it and pausing the bridge stops it. More
        groups, a teammate that answers, and the rest of the schedule options are on the loop's own page.
      </p>
      {error ? <p className="brg-error" role="alert">{error}</p> : null}
      <div className="brg-loops__actions">
        <button type="button" className="pn-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="pn-btn pn-btn--primary" disabled={!ready || busy}>{busy ? 'Creating…' : 'Create loop'}</button>
      </div>
    </form>
  );
}
