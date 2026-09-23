/**
 * THE CONTEXT NUMBER — `48k · 24% · cache 80% · 8s ago` — on the panel bar.
 *
 * USER RULING: it rides the EXISTING row (Session | Connections | Discussion
 * and the end icons). No new row, no taller bar. So it is a single line of
 * tabular numerals in the end cluster, and it gives up words as the bar
 * narrows rather than wrapping or pushing the bar taller:
 *
 *   wide     48k · 24% · cache 80% · 8s ago
 *   medium   48k · 24% · 8s
 *   narrow   24%        (or 48k when capacity is unknown)
 *
 * Nothing is lost at any width: the button's accessible name and tooltip
 * carry the whole reading, and pressing it opens the exact counts, capacity,
 * remaining room, sample time, model and provenance.
 *
 * NOT A LIVE REGION. It changes every second; announcing that would drown a
 * screen reader. The name is current whenever the reader focuses it.
 *
 * The read is the SHARED tail (`tail-resource`), so a Transcript or Debug tab
 * open on the same session costs no second poll.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { EntityId, SessionTranscriptContext } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useNow, useNowSeconds } from '../kit/time';
import { useDismissable } from '../panels/useDismissable';
import { readContext, usableSample } from './context-reading';
import { useTranscriptTail } from './tail-resource';
import './session-context.css';

/** The same cadence the Transcript surface polls a live session at. */
export const CONTEXT_POLL_MS = 5_000;

type Fit = 'wide' | 'medium' | 'narrow';

/** Bar widths (CSS px of `.pn-panelbar`) at which the reading gives up words. */
export const FIT_WIDE_PX = 760;
export const FIT_MEDIUM_PX = 520;

function fitFor(width: number): Fit {
  if (width >= FIT_WIDE_PX) return 'wide';
  if (width >= FIT_MEDIUM_PX) return 'medium';
  return 'narrow';
}

/**
 * Past this the age reads in minutes, and the per-second clock rests; the
 * shared 30s clock carries it from there, so a minute label can trail by up
 * to one tick — a bounded lag, traded for no per-second render on every panel.
 */
const SECONDS_MATTER_MS = 60_000;

export interface SessionContextNumberProps {
  seam: Pick<Seam, 'transcript'>;
  sessionId: EntityId;
  /** Whether the session can still write — decides polling, not rendering. */
  live: boolean;
}

export function SessionContextNumber({ seam, sessionId, live }: SessionContextNumberProps) {
  const snap = useTranscriptTail(seam, sessionId, live ? CONTEXT_POLL_MS : null);

  // The newest usable sample, remembered for the "last known" fallback. Held
  // per session: a sample never outlives the session it was read from.
  const previous = useRef<{ id: EntityId; ctx: SessionTranscriptContext } | null>(null);
  const prior = previous.current?.id === sessionId ? previous.current.ctx : null;
  const current = snap.page?.available ? usableSample(snap.page.context) : null;
  // A compaction or model switch RETIRES what came before it: the fallback
  // must never bring that sample back once the window scrolls past the
  // boundary and reports only "no sample here".
  const retired = snap.page?.context?.unavailableReason === 'awaiting_new_sample';
  useEffect(() => {
    if (current) previous.current = { id: sessionId, ctx: current };
    else if (retired) previous.current = null;
  }, [current, retired, sessionId]);

  const coarse = useNow();
  const observed = Date.parse((current ?? prior)?.observedAt ?? '');
  const young = Number.isFinite(observed) && coarse - observed < SECONDS_MATTER_MS;
  const fine = useNowSeconds(young);
  const reading = readContext(snap, prior, Math.max(coarse, fine));

  const [open, setOpen] = useState(false);
  const [fit, setFit] = useState<Fit>('wide');
  const root = useRef<HTMLSpanElement>(null);
  const detailsId = useId();

  // Measured off the BAR, not this element: the question is how much room the
  // row has, and this element's own width is the answer to a different one.
  // `clientWidth` is layout px, unaffected by the canvas's CSS zoom.
  useLayoutEffect(() => {
    const bar = root.current?.closest('.pn-panelbar');
    if (!(bar instanceof HTMLElement)) return;
    const measure = () => setFit(fitFor(bar.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // The house dismissal: Esc is claimed in the CAPTURE phase, so closing the
  // details never also walks the panel stack down a rung.
  const dismiss = useCallback(() => {
    setOpen(false);
    // Only hand focus back when it was inside — an outside click keeps its own.
    if (root.current?.contains(document.activeElement)) root.current.querySelector('button')?.focus();
  }, []);
  useDismissable(open, root, dismiss);

  const parts: string[] = [];
  if (reading.tone === 'loading' || reading.tone === 'unknown') {
    parts.push(reading.used);
  } else if (fit === 'narrow') {
    parts.push(reading.percent ?? reading.used);
  } else {
    parts.push(reading.used);
    if (reading.percent) parts.push(reading.percent);
    if (fit === 'wide' && reading.cache !== null) parts.push(`cache ${reading.cache}`);
    const age = fit === 'wide' ? reading.age : reading.ageShort;
    if (age) parts.push(age);
  }

  const visible = (reading.lastKnown ? '~' : '') + parts.join(' · ');

  return (
    <span
      ref={root}
      className="pn-context"
      data-testid="session-context"
      data-tone={reading.tone}
      data-fit={fit}
    >
      <button
        type="button"
        className="pn-context__num"
        // Label-in-name: the name OPENS with what is on screen, so a voice
        // user can say it; the full reading follows.
        aria-label={`${visible} — ${reading.label}`}
        title={reading.label}
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {reading.lastKnown ? <span className="pn-context__mark" aria-hidden="true">~</span> : null}
        {parts.join(' · ')}
      </button>
      {open ? (
        <div id={detailsId} className="pn-context__details" role="group" aria-label="Context details">
          <dl>
            {reading.details.map((d) => (
              <div key={d.term} className="pn-context__row">
                <dt>{d.term}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </span>
  );
}
