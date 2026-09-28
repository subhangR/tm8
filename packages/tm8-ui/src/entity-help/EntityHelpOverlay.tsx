/**
 * THE ENTITY HELP OVERLAY — one kind's page, over region B only.
 *
 * WHERE IT SITS. `position: absolute; inset: 0` inside whatever host mounts
 * it: Home's `.tch-conversation` (region B) and the Workspace's
 * `.shell-ws__center`. It never covers the list column, by ruling: the reader
 * keeps browsing while the page is open, and pressing another kind's (?) in
 * the list simply turns the page.
 *
 * THE SHELL'S OBLIGATIONS, and where each is met:
 *   open / close animation   `eh-overlay--enter` / `--leave` (CSS); the leave
 *                            waits for `animationend` and falls back to a
 *                            timer, and under reduced motion neither runs;
 *   Esc and the ✕            `onKeyDown` on the dialog — stopped there, so
 *                            Home's own Esc (leave the stage) does not fire
 *                            underneath; the ✕ is the first control;
 *   focus in, focus back     the first tab takes focus on open; the (?) that
 *                            opened it (`takeOpener`) gets it back on close;
 *   focus stays              Tab and Shift+Tab wrap inside the dialog;
 *   tabs by keyboard         a roving tablist — arrows move and select,
 *                            Home/End jump, per the ARIA tabs pattern;
 *   deep links               NOT offered. The route codec is a hand-written
 *                            grammar with its own test suite, and adding a
 *                            segment to it is not cheap; the store is the
 *                            address for now (task 01a0e7d6, W0 close-out).
 *
 * It is not `aria-modal`: the list beside it is, deliberately, still live.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { KindIcon } from '../domain';
import { entityHelpStore, takeOpener, useEntityHelp } from './entityHelpStore';
import { MotionProvider, useMotion } from './motion/MotionContext';
import { Reveal } from './motion/Reveal';
import { resolveHelp } from './resolve';
import { ConstellationTab } from './tabs/ConstellationTab';
import { StoryTab } from './tabs/StoryTab';
import { ToolkitTab } from './tabs/ToolkitTab';
import { HELP_TABS, type HelpTab } from './types';
import './entity-help.css';

const LEAVE_FALLBACK_MS = 320;

export interface EntityHelpOverlayProps {
  /** Force the reduced-motion fallback regardless of the OS preference. */
  reducedMotion?: boolean | undefined;
}

/**
 * The host-facing mount. Renders nothing while closed; keeps the last page
 * on screen through the leave animation.
 */
export function EntityHelpOverlay({ reducedMotion }: EntityHelpOverlayProps = {}) {
  const kind = useEntityHelp((s) => s.kind);
  const [shown, setShown] = useState<string | null>(kind);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (kind !== null) {
      setShown(kind);
      setLeaving(false);
      return;
    }
    if (shown !== null) setLeaving(true);
  }, [kind, shown]);

  const settle = useCallback(() => {
    setShown(null);
    setLeaving(false);
  }, []);

  if (shown === null) return null;
  return (
    <MotionProvider reduced={reducedMotion}>
      <Surface kind={shown} leaving={leaving} onLeft={settle} />
    </MotionProvider>
  );
}

function Surface({ kind, leaving, onLeft }: { kind: string; leaving: boolean; onLeft: () => void }) {
  const { reduced } = useMotion();
  const tab = useEntityHelp((s) => s.tab);
  const trail = useEntityHelp((s) => s.trail);
  const page = resolveHelp(kind);
  const root = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<HelpTab, HTMLButtonElement | null>>({ story: null, toolkit: null, constellation: null });
  const titleId = `eh-title-${kind.replace(/[^a-z0-9]/gi, '-')}`;

  /* FOCUS IN on open and on a page turn; FOCUS BACK when the surface is gone. */
  useLayoutEffect(() => {
    tabRefs.current[entityHelpStore.getState().tab]?.focus();
  }, [kind]);
  useEffect(() => {
    return () => {
      const opener = takeOpener();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  /* THE LEAVE: wait for the animation, or not at all under reduced motion. */
  useEffect(() => {
    if (!leaving) return;
    if (reduced) {
      onLeft();
      return;
    }
    const timer = setTimeout(onLeft, LEAVE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [leaving, reduced, onLeft]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      entityHelpStore.getState().close();
      return;
    }
    if (event.key === 'Tab' && root.current) {
      const focusable = [
        ...root.current.querySelectorAll<HTMLElement>(
          'button:not([tabindex="-1"]), a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hasAttribute('disabled') && !el.closest('[aria-hidden="true"]'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: HelpTab) => {
    const order = HELP_TABS.map((t) => t.id);
    const index = order.indexOf(current);
    let next: HelpTab | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = order[(index + 1) % order.length] ?? null;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = order[(index - 1 + order.length) % order.length] ?? null;
    else if (event.key === 'Home') next = order[0] ?? null;
    else if (event.key === 'End') next = order[order.length - 1] ?? null;
    if (next === null) return;
    event.preventDefault();
    entityHelpStore.getState().setTab(next);
    tabRefs.current[next]?.focus();
  };

  const previous = trail.length > 0 ? trail[trail.length - 1] : null;
  const activeIndex = HELP_TABS.findIndex((t) => t.id === tab);

  return (
    <div
      ref={root}
      className={['eh-overlay', leaving ? 'eh-overlay--leave' : 'eh-overlay--enter', reduced ? 'eh-overlay--still' : '']
        .filter(Boolean)
        .join(' ')}
      role="dialog"
      aria-labelledby={titleId}
      data-testid="entity-help-overlay"
      data-kind={kind}
      data-tab={tab}
      data-motion={reduced ? 'reduced' : 'rich'}
      onKeyDown={onKeyDown}
      onAnimationEnd={(event) => {
        if (leaving && event.target === root.current) onLeft();
      }}
    >
      <div className="eh-overlay__film" aria-hidden />

      <header className="eh-head">
        <div className="eh-head__row">
          <span className="eh-eyebrow eh-head__eyebrow">
            Entity help · reel {HELP_TABS[activeIndex]?.reel ?? '01'} / 03
          </span>
          <div className="eh-head__controls">
            {previous ? (
              <button type="button" className="eh-back" onClick={() => entityHelpStore.getState().back()}>
                <span aria-hidden>←</span> Back to {resolveHelp(previous).labelPlural}
              </button>
            ) : null}
            <button
              type="button"
              className="eh-close"
              aria-label="Close help"
              title="Close help (Esc)"
              onClick={() => entityHelpStore.getState().close()}
            >
              <span aria-hidden>✕</span>
            </button>
          </div>
        </div>
        <Reveal className="eh-head__title" delay={40}>
          <span className="eh-head__mark" aria-hidden>
            <KindIcon kind={kind} size={28} />
          </span>
          <h2 id={titleId} className="eh-title">
            {page.labelPlural}
          </h2>
        </Reveal>
        <Reveal as="p" className="eh-logline" delay={140}>
          {page.story.logline}
        </Reveal>
        <div className="eh-tabs" role="tablist" aria-label={`${page.label} help sections`} style={{ ['--eh-tab' as string]: activeIndex }}>
          {HELP_TABS.map((spec) => {
            const selected = spec.id === tab;
            const authored = page.authored[spec.id];
            return (
              <button
                key={spec.id}
                ref={(el) => {
                  tabRefs.current[spec.id] = el;
                }}
                type="button"
                role="tab"
                id={`eh-tab-${spec.id}`}
                aria-selected={selected}
                aria-controls={`eh-panel-${spec.id}`}
                tabIndex={selected ? 0 : -1}
                className={selected ? 'eh-tab eh-tab--selected' : 'eh-tab'}
                onClick={() => entityHelpStore.getState().setTab(spec.id)}
                onKeyDown={(event) => onTabKey(event, spec.id)}
                data-authored={authored ? 'true' : 'baseline'}
              >
                <span className="eh-tab__reel" aria-hidden>
                  {spec.reel}
                </span>
                {spec.label}
              </button>
            );
          })}
          <span className="eh-tabs__ink" aria-hidden />
        </div>
      </header>

      <div
        key={`${kind}:${tab}`}
        className="eh-body"
        role="tabpanel"
        id={`eh-panel-${tab}`}
        aria-labelledby={`eh-tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'story' ? <StoryTab page={page} /> : null}
        {tab === 'toolkit' ? <ToolkitTab page={page} /> : null}
        {tab === 'constellation' ? (
          <ConstellationTab page={page} onPick={(next) => entityHelpStore.getState().openNeighbour(next)} />
        ) : null}
      </div>
    </div>
  );
}
