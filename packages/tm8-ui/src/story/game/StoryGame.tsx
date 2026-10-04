/**
 * THE GAME VIEW of a story (task 01a107e7): the story's page as a WORLD. The
 * story is the hub, its roots are landmarks on a ring, every trail node a
 * place behind its root, the child stories portals on the rim; the edges are
 * roads. A player walks it (WASD / arrows, or click to go), places rise out
 * of the fog as they come within reach, and opening one hands the entity to
 * the page's own `open` port — the detail panel beside the story shows it,
 * and the world stays where it was (the save lives in store.ts).
 *
 * This file is the DOM half: the HUD (switch, quest log, approach card, the
 * hint line) and the keyboard. The 3D half (`scene.tsx`, three.js) is loaded
 * lazily; without WebGL the same world is drawn as a list of places, so the
 * walk-and-open loop still works and tests can drive it.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { KindIcon } from '../../domain';
import { getKind } from '../../domain/registry';
import { Pill } from '../../kit';
import { TONE_WORD, statusWord, type StoryView } from '../model';
import type { StoryLive } from '../props';
import { ModeSwitch } from './ModeSwitch';
import { createControl, WALK_KEYS, walkTo } from './control';
import { hasWebGL, readPalette, type Palette } from './palette';
import { HOME, storyGameStore, useStoryGameSave, type StoryViewMode } from './store';
import { buildWorld, type Place, type World } from './world';
import './story-game.css';

const Scene = lazy(() => import('./scene'));

export interface StoryGameProps {
  view: StoryView;
  live?: StoryLive | null;
  open?: ((entityId: string) => void) | undefined;
  mode: StoryViewMode;
  onMode: (mode: StoryViewMode) => void;
}

const EMPTY: ReadonlySet<string> = new Set();
const OPEN_KEYS: ReadonlySet<string> = new Set(['e', 'enter', ' ']);

export function StoryGame({ view, live, open, mode, onMode }: StoryGameProps) {
  const storyId = view.id;
  const world = useMemo(() => buildWorld(view), [view]);
  const save = useStoryGameSave(storyId);
  /* The hub is always known; everything else is earned by walking. */
  const revealed = useMemo(() => new Set([world.hubId, ...save.revealed]), [world.hubId, save.revealed]);
  const visited = useMemo(() => new Set(save.visited), [save.visited]);
  const landed = live?.landed ?? EMPTY;

  const control = useRef(createControl()).current;
  const host = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [webgl] = useState(hasWebGL);
  const [nearId, setNearId] = useState<string | null>(null);
  const [startAt] = useState(() => ({ x: save.x, z: save.z }));

  useEffect(() => {
    if (host.current) setPalette(readPalette(host.current));
  }, []);
  useEffect(() => {
    host.current?.focus({ preventScroll: true });
  }, []);

  const reveal = useCallback((ids: string[]) => storyGameStore.getState().reveal(storyId, ids), [storyId]);
  const position = useCallback((x: number, z: number) => storyGameStore.getState().savePosition(storyId, x, z), [storyId]);
  const openPlace = useCallback(
    (placeId: string) => {
      if (placeId === storyId) return;
      storyGameStore.getState().visit(storyId, placeId);
      open?.(placeId);
    },
    [open, storyId],
  );
  const arrive = useCallback((placeId: string, doOpen: boolean) => { if (doOpen) openPlace(placeId); }, [openPlace]);
  const goTo = useCallback(
    (place: Place, doOpen = false) => walkTo(control, place.x, place.z, place.id, doOpen),
    [control],
  );
  const onGround = useCallback((x: number, z: number) => walkTo(control, x, z, null, false), [control]);
  const onPlaceClick = useCallback(
    (placeId: string, doOpen: boolean) => {
      const p = world.byId.get(placeId);
      if (!p) return;
      if (doOpen && nearId === placeId) openPlace(placeId);
      else goTo(p, doOpen);
    },
    [world, nearId, openPlace, goTo],
  );

  const near = nearId ? world.byId.get(nearId) ?? null : null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const k = e.key.toLowerCase();
    if (WALK_KEYS.has(k)) {
      control.keys.add(k);
      e.preventDefault();
    } else if (OPEN_KEYS.has(k)) {
      if (near && near.id !== storyId) { openPlace(near.id); e.preventDefault(); }
    }
  };
  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    control.keys.delete(e.key.toLowerCase());
  };
  const onBlur = (): void => control.keys.clear();

  const explored = world.places.filter((p) => revealed.has(p.id)).length;
  const roots = world.places.filter((p) => p.root);
  const portals = world.places.filter((p) => p.portal);
  const progress = Math.round((world.byId.get(world.hubId)?.progress ?? 0) * 100);

  return (
    <div
      ref={host}
      className={`sgm${webgl ? '' : ' sgm--flat'}`}
      data-testid="story-game"
      tabIndex={0}
      role="application"
      aria-label={`${view.title} as a game`}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
    >
      <div className="sgm-stage">
        {webgl && palette ? (
          <Suspense fallback={<div className="sgm-loading">Raising the world…</div>}>
            <Scene
              world={world}
              palette={palette}
              control={control}
              revealed={revealed}
              visited={visited}
              landed={landed}
              start={startAt}
              onReveal={reveal}
              onNear={setNearId}
              onArrive={arrive}
              onPosition={position}
              onGround={onGround}
              onPlaceClick={onPlaceClick}
            />
          </Suspense>
        ) : webgl ? null : (
          <FlatWorld world={world} revealed={revealed} visited={visited} onOpen={openPlace} />
        )}
      </div>

      <div className="sgm-hud">
        <div className="sgm-hud__lead">
          <ModeSwitch mode={mode} onChange={onMode} />
          <div className="sgm-title" title={view.title}>
            <KindIcon kind={world.byId.get(world.hubId)?.kind ?? ''} size={14} />
            <span className="sgm-title__text">{view.title}</span>
            <Pill tone={progress === 100 ? 'run' : 'info'}>{progress}% done</Pill>
          </div>
        </div>

        <aside className="sgm-quest" aria-label="Quest log">
          <div className="sgm-quest__head">
            <span className="kit-eyebrow">Quests</span>
            <span className="sgm-quest__count">{explored} / {world.places.length} found</span>
          </div>
          <ul className="sgm-quest__list">
            {roots.map((r) => (
              <QuestRow key={r.id} place={r} seen={revealed.has(r.id)} done={visited.has(r.id)} onGo={() => goTo(r)} />
            ))}
            {portals.length ? <li className="sgm-quest__sub">Other stories</li> : null}
            {portals.map((p) => (
              <QuestRow key={p.id} place={p} seen={revealed.has(p.id)} done={visited.has(p.id)} onGo={() => goTo(p)} />
            ))}
          </ul>
        </aside>

        {near ? (
          <div className="sgm-approach" data-testid="story-game-approach">
            <KindIcon kind={near.kind} size={16} />
            <div className="sgm-approach__text">
              <div className="sgm-approach__title">{near.title}</div>
              <div className="sgm-approach__sub">
                {near.id === storyId ? `You are here · ${explored} of ${world.places.length} places found` : describe(near)}
              </div>
            </div>
            {near.id !== storyId ? (
              <button type="button" className="sgm-btn sgm-btn--primary" onClick={() => openPlace(near.id)}>
                {near.portal ? 'Enter' : 'Open'} <kbd>E</kbd>
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="sgm-hint">
          <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk</span>
          <span>click a place to go · double-click to go and open</span>
          <span><kbd>E</kbd> opens what you stand at</span>
          <button
            type="button"
            className="sgm-btn"
            onClick={() => { storyGameStore.getState().reset(storyId); walkTo(control, HOME.x, HOME.z, null, false); }}
            title="Forget what you explored and walk back to the hub"
          >
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}

function describe(p: Place): string {
  const row = getKind(p.kind);
  const kind = row.kind === p.kind ? row.label : p.kind.replace(/_/g, ' ');
  const bits = [kind.toLowerCase()];
  if (p.tone) bits.push(TONE_WORD[p.tone]);
  else if (p.status) bits.push(statusWord(p.status));
  if (p.live) bits.push('live now');
  else if (p.recent) bits.push('active this hour');
  if (p.progress !== null && !p.root) bits.push(`${Math.round(p.progress * 100)}% done`);
  return bits.join(' · ');
}

function QuestRow({ place, seen, done, onGo }: { place: Place; seen: boolean; done: boolean; onGo: () => void }) {
  return (
    <li className={`sgm-quest__row${done ? ' sgm-quest__row--done' : seen ? ' sgm-quest__row--seen' : ''}`}>
      <button type="button" className="sgm-quest__go" onClick={onGo} title={`Walk to ${place.title}`}>
        <span className={`sgm-dot sgm-dot--${place.tone ?? 'none'}`} aria-hidden />
        <span className="sgm-quest__title">{place.title}</span>
        {place.progress !== null ? <span className="sgm-quest__pct">{Math.round(place.progress * 100)}%</span> : null}
        <span className="sgm-quest__mark" aria-label={done ? 'visited' : seen ? 'found' : 'unexplored'}>{done ? '✓' : seen ? '◦' : '?'}</span>
      </button>
    </li>
  );
}

/**
 * The world without WebGL: every place as a row under its root, revealed
 * places first. Same open loop, same save.
 */
function FlatWorld({ world, revealed, visited, onOpen }: { world: World; revealed: ReadonlySet<string>; visited: ReadonlySet<string>; onOpen: (id: string) => void }) {
  const groups = useMemo(() => {
    const byAnchor = new Map<string, Place[]>();
    for (const p of world.places) {
      if (p.id === world.hubId) continue;
      const key = p.root || p.portal ? p.id : p.rootIds[0] ?? p.anchorId ?? world.hubId;
      byAnchor.set(key, [...(byAnchor.get(key) ?? []), p]);
    }
    return byAnchor;
  }, [world]);
  return (
    <div className="sgm-flat" data-testid="story-game-flat">
      <p className="sgm-flat__note">No 3D here — the world as a list. Open a place to mark it visited.</p>
      {[...groups.entries()].map(([key, places]) => (
        <section key={key} className="sgm-flat__land">
          <h4>{world.byId.get(key)?.title ?? 'The commons'}</h4>
          <ul>
            {places.map((p) => (
              <li key={p.id} className={visited.has(p.id) ? 'sgm-flat__row--done' : revealed.has(p.id) ? 'sgm-flat__row--seen' : ''}>
                <button type="button" className="sgm-flat__open" onClick={() => onOpen(p.id)}>
                  <KindIcon kind={p.kind} size={14} /> <span>{p.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
