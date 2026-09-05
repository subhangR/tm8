import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import type { EntitySummary } from '@tm8/contract';
import { EntityListPanel } from './panels/EntityListPanel';
import type { MessagePulse } from './panels/list/useMessagePulses';
import type { ActionContext, QueryFilter } from './domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from './fixtures';

/**
 * THE FLIGHT SCRATCH HARNESS — a message crossing the session tiles, in a real
 * browser, on demand.
 *
 * This one is not optional the way a harness usually is. The whole change is
 * MOTION over a STYLED tree, and jsdom loads no stylesheets and runs no
 * animations: `tile-flight.render.test.tsx` can prove a glyph exists with the
 * right stops on it and can prove nothing whatsoever about whether the thing
 * reads as a message flying. The defect being fixed — "not visible properly" —
 * is by construction invisible to every vitest in this repo.
 *
 * Four questions only a browser answers:
 *
 *   1. does the glyph READ as a message crossing the list, at the 29px row
 *      rhythm the sessions tree actually uses?
 *   2. does the arc clear the tiles it passes, or cut a chord through them?
 *   3. can the eye follow a long flight (root to a deep leaf) without losing
 *      it, and is a short neighbour hop still legible rather than a twitch?
 *   4. do all three kinds stay distinguishable at 13px, on both grounds,
 *      while several are in the air at once?
 *
 * Usage: /flight-dev.html
 *   ?theme=dark   the dark ground
 *   ?freeze=0.5   park every flight at 50% of its trip and hold it there
 *   ?ttl=600000   keep pulses alive while you look at a frozen frame
 *   ?rows=30      a deep spine, long enough to reach the 1450ms duration cap
 */
if (new URLSearchParams(location.search).get('theme') === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
}


const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/**
 * A deep chain, because depth is the case the old hairline sweep handled worst
 * and the case a flight has to survive: the arc between two rows six levels
 * apart is the longest one the panel can produce.
 */
/**
 * THE TREE IS BUILT HERE, NOT SLICED OUT OF THE FIXTURES — and the previous
 * version's failure is the reason (PR #591 review, GPT 5.6 Sol).
 *
 * It used to take `fixtureSummaries.slice(0, 8)` and derive parents with an
 * index formula. Both halves lied. The slice yielded fewer rows than it asked
 * for, the panel's In Progress band then dropped more, and the formula topped
 * out around depth three — so this file's own comment promised "two rows six
 * levels apart" while the browser showed five rows and every sampled flight
 * sat on the 560ms duration FLOOR. A harness that cannot construct the long
 * arc cannot be evidence for the long arc, and it was being cited as exactly
 * that.
 *
 * So the rows are explicit: a SPINE six deep, with siblings hung off it for
 * the short-hop case. That default spans roughly 320px — enough to lift the
 * duration clearly off its 560ms floor (~680-720ms in practice), and NOT
 * enough to reach the 1450ms ceiling, which needs about 970px. `?rows=30` is
 * what forces the ceiling; see the SHAPE comment below. One template is cloned
 * so the tile keeps a realistic shape; everything the tree depends on — id,
 * title, parent, status — is stated rather than inherited.
 */
const template = fixtureSummaries.find((row) => row.state.kind === 'work_session');
if (template === undefined) throw new Error('flight-dev: no work_session fixture to clone');

/**
 * parent index, or null for the root: a spine six deep with three siblings
 * hung off it, which is the default shape.
 *
 * `?rows=N` extends the SPINE to N rows. Ten rows span roughly 320px, enough
 * to lift the duration off its 560ms floor but not to reach the 1450ms
 * ceiling, which needs about 970px of separation — around thirty rows. The
 * ceiling is pinned by unit test either way; this exists so the ceiling can
 * also be SEEN, rather than being claimed on the strength of a tree that
 * cannot produce it.
 */
const params = new URLSearchParams(location.search);

const requestedRows = Math.min(60, Math.max(0, Number(params.get('rows') ?? '') || 0));
const SHAPE: readonly (number | null)[] = requestedRows > 0
  ? Array.from({ length: requestedRows }, (_, index) => (index === 0 ? null : index - 1))
  : [
      null, // 0  root
      0,    // 1  spine 1
      1,    // 2  spine 2
      2,    // 3  spine 3
      3,    // 4  spine 4
      4,    // 5  spine 5
      5,    // 6  spine 6  <- the far end of the long flight
      1,    // 7  sibling high on the spine
      3,    // 8  sibling mid
      5,    // 9  sibling low  <- short hop against #6
    ];

const chain: readonly EntitySummary[] = SHAPE.map((parent, index) => ({
  ...template,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` as EntitySummary['id'],
  title: parent === null ? 'root · spine 0' : `${parent === index - 1 ? 'spine' : 'sibling'} · row ${index}`,
  parentId: parent === null
    ? null
    : (`00000000-0000-4000-8000-${String(parent).padStart(12, '0')}` as EntitySummary['id']),
  // The panel opens on In Progress; anything else is silently dropped from
  // the band, which is how the old version lost half its rows without saying so.
  state: { ...template.state, status: 'running' } as EntitySummary['state'],
}));

const rowsFor = (_filter: QueryFilter): readonly EntitySummary[] => chain;

/**
 * Matches `useMessagePulses`' real TTL, so the harness ages pulses out as the
 * app does. `?ttl=` overrides it, which is what makes a frozen frame possible:
 * a paused animation is still deleted on schedule, so holding the glyph still
 * also means holding it alive.
 */
const PULSE_TTL_MS = Number(params.get('ttl') ?? '') || 2_200;

/**
 * `?freeze=0.42` parks every flight at 42% of its trip and holds it there.
 *
 * A sub-second arc cannot be inspected by screenshotting at it — the shutter
 * and the animation are not on speaking terms, and "I did not catch it" is
 * indistinguishable from "it did not render". Running the animation for a
 * notional 1000s and seeking into it with a negative delay makes any single
 * frame addressable: takeoff, apex, and landing become three URLs.
 */
const freeze = Number(params.get('freeze') ?? '');
if (Number.isFinite(freeze) && params.has('freeze')) {
  const style = document.createElement('style');
  style.textContent = `
    .cv2-root .lp__flight,
    .cv2-root .lp__flight__glyph,
    .cv2-root .lp__flight__glyph::before {
      animation-duration: 1000s !important;
      animation-delay: ${-1000 * freeze}s !important;
      animation-play-state: paused !important;
    }
  `;
  document.head.append(style);
}

let sequence = 0;

/**
 * OPEN THE TREE ON ARRIVAL AT THE HARNESS.
 *
 * The panel ships collapsed, so a fresh profile lands on ONE root row — and a
 * message between two rows inside it correctly produces NO glyph, because both
 * ends absorb onto that root (the same-row guard). A reviewer opening this page
 * cold therefore sees nothing and reasonably concludes the feature is broken;
 * that happened, on this PR. The harness must not hand anyone that false zero.
 */
function useOpenTree() {
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    /**
     * A pass reveals exactly one more level, so the walk needs as many passes
     * as the tree is DEEP — derived from the shape rather than guessed.
     *
     * It was a fixed 12, which silently half-opened the one tree that matters:
     * `?rows=30` builds a 29-deep spine, so the walk stopped at 14 rows and
     * the "ceiling" control topped out at 959ms instead of 1450ms — unable to
     * exercise the single claim it was added to support (PR #591 review).
     * The slack covers a slow first paint, and the loop still stops early the
     * moment a pass opens nothing.
     */
    let remaining = SHAPE.length + 2;
    const open = () => {
      if (cancelled) return;
      const shut = document.querySelectorAll<HTMLButtonElement>(
        '.pn-st__arrow:not(.pn-st__arrow--empty):not(.pn-st__arrow--expanded)',
      );
      shut.forEach((button) => button.click());
      remaining -= 1;
      if (shut.length > 0 && remaining > 0) timer = window.setTimeout(open, 60);
    };
    timer = window.setTimeout(open, 120);
    // `cancelled` is what actually stops the chain: clearing `timer` alone
    // only cancels whichever pass happens to be pending.
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
}

function FlightDev() {
  useOpenTree();
  const [pulses, setPulses] = useState<readonly MessagePulse[]>([]);
  const [from, setFrom] = useState(chain[chain.length - 1].id);
  const [to, setTo] = useState(chain[0].id);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const fire = useCallback((pulse: MessagePulse) => {
    setPulses((held) => [...held, pulse]);
    timers.current.set(
      pulse.key,
      setTimeout(() => {
        timers.current.delete(pulse.key);
        setPulses((held) => held.filter((item) => item.key !== pulse.key));
      }, PULSE_TTL_MS),
    );
  }, []);

  /**
   * `at` IS STAMPED HERE BECAUSE THE REAL HOOK STAMPS IT.
   *
   * Without it every harness pulse reads as age zero, so the launch window can
   * never refuse anything and the harness silently cannot reproduce the one
   * behaviour it is most needed for — a replay after the layer unmounts. A
   * browser check run against an unstamped pulse proves nothing about the rule
   * it is aiming at, which is exactly the trap this harness exists to avoid.
   */
  const send = (kind: MessagePulse['kind']) => {
    sequence += 1;
    const key = `dev-${sequence}`;
    const at = Date.now();
    if (kind === 'delegation') fire({ key, kind, fromId: from, toId: to, evidence: 'entity', at });
    else if (kind === 'completion') fire({ key, kind, fromId: from, toId: to, outcome: 'exited', at });
    else fire({ key, kind: 'message', fromId: from, toId: to, at });
  };

  const burst = () => {
    // Concurrency is its own question: three arcs in the air at once must stay
    // three readable objects, not one smear.
    const ids = chain.map((row) => row.id);
    for (let index = 0; index < 3; index += 1) {
      sequence += 1;
      fire({
        key: `dev-${sequence}`,
        kind: 'message',
        fromId: ids[(index * 3 + 1) % ids.length],
        toId: ids[(index * 2) % ids.length],
        at: Date.now(),
      });
    }
  };

  const label = (id: string) =>
    `${chain.findIndex((row) => row.id === id)} · ${chain.find((row) => row.id === id)?.title.slice(0, 28)}`;

  return (
    <div className="cv2-root" style={{ padding: 20, display: 'grid', gap: 16, maxWidth: 560 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          {chain.map((row) => <option key={row.id} value={row.id}>from {label(row.id)}</option>)}
        </select>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {chain.map((row) => <option key={row.id} value={row.id}>to {label(row.id)}</option>)}
        </select>
        <button type="button" onClick={() => send('message')}>message</button>
        <button type="button" onClick={() => send('delegation')}>delegation</button>
        <button type="button" onClick={() => send('completion')}>completion</button>
        <button type="button" onClick={burst}>burst ×3</button>
      </div>
      <EntityListPanel kind="work_session" rowsFor={rowsFor} ctx={ctx} messagePulses={pulses} />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<FlightDev />);
