import { useCallback, useRef, useState } from 'react';
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
 * Usage: /flight-dev.html   (add ?theme=dark for the dark ground)
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
const sessions = fixtureSummaries.filter((row) => row.state.kind === 'work_session');
/**
 * Every row is forced `running` because the panel opens on In Progress, and a
 * harness that silently drops five of its eight rows into another band would
 * be measuring an arc across a tree it is not showing.
 *
 * The shape alternates: each row's parent is one or two levels up, which gives
 * both the deep spine (a long flight) and sibling pairs (a short hop) in one
 * tree, rather than a ladder that only ever exercises one arc length.
 */
const chain: readonly EntitySummary[] = sessions.slice(0, 8).map((row, index) => ({
  ...row,
  parentId: index === 0 ? null : sessions[index - 1 - (index % 2 === 0 ? 1 : 0)].id,
  state: { ...row.state, status: 'running' } as EntitySummary['state'],
}));

const rowsFor = (_filter: QueryFilter): readonly EntitySummary[] => chain;

const params = new URLSearchParams(location.search);

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

function FlightDev() {
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

  const send = (kind: MessagePulse['kind']) => {
    sequence += 1;
    const key = `dev-${sequence}`;
    if (kind === 'delegation') fire({ key, kind, fromId: from, toId: to, evidence: 'entity' });
    else if (kind === 'completion') fire({ key, kind, fromId: from, toId: to, outcome: 'exited' });
    else fire({ key, kind: 'message', fromId: from, toId: to });
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
