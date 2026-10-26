// @vitest-environment jsdom
/**
 * ENTER vs INSPECT (task 01a1090f). A portal's approach card says Enter and
 * moves the navStore onto the child story, which then opens in game mode;
 * every other place says Inspect and hands its id to the page's `open` port
 * exactly as before; the hub offers nothing. Esc from a child climbs back to
 * the parent, whose map starts from its own save. The flat (no-WebGL) world
 * makes the same split.
 */
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { navStore, resetNav } from '../../stores/navStore';
import { StoryPage } from '../StoryPage';
import { STORY_FIXTURE } from '../fixture';
import type { StoryView } from '../model';
import { StoryGame } from './StoryGame';
import { resetEntry } from './enter';
import type { SceneProps } from './scene';
import { storyGameStore } from './store';
import type { Place } from './world';

const scene = vi.hoisted(() => ({ webgl: true, near: (_places: readonly Place[]): string | null => null, start: null as { x: number; z: number } | null }));
const members = vi.hoisted(() => ({ on: null as ((places: readonly Place[]) => Place) | null, list: [] as { id: string; kind: string; title: string }[] }));

vi.mock('./palette', async (original) => ({ ...await original<typeof import('./palette')>(), hasWebGL: () => scene.webgl }));
vi.mock('./scene', () => ({ default: ({ world, onNear, start }: SceneProps) => {
  scene.start = start;
  useEffect(() => { onNear(scene.near(world.places)); }, [world, onNear]);
  return <div data-testid="mock-world" />;
} }));
/* The aggregate places (Library / Code Factory) arrive with a sibling unit;
   until then a member list is grafted onto one place to drive the card. */
vi.mock('./world', async (original) => {
  const real = await original<typeof import('./world')>();
  return {
    ...real,
    buildWorld: (view: StoryView) => {
      const world = real.buildWorld(view);
      if (members.on) Object.assign(members.on(world.places), { members: members.list });
      return world;
    },
  };
});

const story = STORY_FIXTURE;
const child = story.page.childStories[0]!;
const root = story.page.roots[0]!;
const parent = story.page.parent!;
const childView: StoryView = { ...story, id: child.id, title: child.title, page: { ...story.page, parent: { id: story.id, title: story.title } } };
const plain = (places: readonly Place[]) => places.find((p) => !p.portal && !p.root && p.id !== story.id && !p.encounters.length)!;

function routeTo(id: string): void {
  resetNav('', { view: 'entity', entityId: id as EntityId, origin: { slug: 'stories', mode: null } });
}

beforeEach(() => {
  storyGameStore.getState().resetAll();
  resetEntry();
  routeTo(story.id);
  scene.webgl = true;
  scene.start = null;
  members.on = null;
  members.list = [];
});
afterEach(() => vi.restoreAllMocks());

describe('the approach card', () => {
  it('Enter on a portal moves the navStore to the child story, which opens in game mode', async () => {
    scene.near = () => child.id;
    const open = vi.fn();
    const first = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={open} />);
    const card = await first.findByTestId('story-game-approach');
    fireEvent.click(within(card).getByRole('button', { name: /^Enter/ }));
    expect(navStore.getState().view).toEqual({ view: 'entity', entityId: child.id, origin: { slug: 'stories', mode: null } });
    expect(storyGameStore.getState().mode[child.id]).toBe('game');
    expect(open).not.toHaveBeenCalled();

    /* What the routed host mounts next: the child's page, already a game. */
    first.unmount();
    const page = render(<StoryPage view={childView} actions={{ open }} />);
    expect(page.getByTestId('story-game').getAttribute('aria-label')).toBe(`${child.title} as a game`);
  });

  it('E on a portal enters too', async () => {
    scene.near = () => child.id;
    const { findByTestId, getByTestId } = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={vi.fn()} />);
    await findByTestId('story-game-approach');
    fireEvent.keyDown(getByTestId('story-game'), { key: 'e' });
    expect(navStore.getState().view).toMatchObject({ view: 'entity', entityId: child.id });
    expect(storyGameStore.getState().mode[child.id]).toBe('game');
    expect(storyGameStore.getState().saves[story.id]!.visited).toContain(child.id);
  });

  it('an ordinary place says Inspect and opens through the page port, by click and by E', async () => {
    let id = '';
    scene.near = (places) => (id = plain(places).id);
    const open = vi.fn();
    const navigate = vi.spyOn(navStore.getState(), 'navigate');
    const { findByTestId, getByTestId } = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={open} />);
    const card = await findByTestId('story-game-approach');
    fireEvent.click(within(card).getByRole('button', { name: /^Inspect/ }));
    expect(open).toHaveBeenCalledWith(id);
    fireEvent.keyDown(getByTestId('story-game'), { key: 'e' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
    expect(storyGameStore.getState().saves[story.id]!.visited).toContain(id);
  });

  it('the hub offers no action', async () => {
    scene.near = () => story.id;
    const open = vi.fn();
    const { findByTestId, getByTestId } = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={open} />);
    const card = await findByTestId('story-game-approach');
    expect(within(card).queryByRole('button', { name: /^(Enter|Inspect|Open)/ })).toBeNull();
    fireEvent.keyDown(getByTestId('story-game'), { key: 'e' });
    expect(open).not.toHaveBeenCalled();
    expect(navStore.getState().view).toMatchObject({ entityId: story.id });
  });

  it('an aggregate place lists up to six members, each with its own Inspect', async () => {
    let id = '';
    scene.near = (places) => (id = plain(places).id);
    members.on = plain;
    members.list = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, kind: root.kind, title: `Member ${i}` }));
    const open = vi.fn();
    const { findByTestId } = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={open} />);
    const card = await findByTestId('story-game-approach');
    const list = within(card).getByRole('list');
    expect(within(list).getAllByRole('button', { name: /^Inspect Member/ })).toHaveLength(6);
    expect(within(list).getByText('and 2 more')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Inspect Member 3' }));
    expect(open).toHaveBeenCalledWith('m3');
    expect(open).not.toHaveBeenCalledWith(id);
  });

  it('an aggregate place offers no action of its own: its id is a landmark, not an entity', async () => {
    let id = '';
    scene.near = (places) => (id = plain(places).id);
    members.on = plain;
    members.list = [{ id: 'm0', kind: root.kind, title: 'Member 0' }];
    const open = vi.fn();
    const { findByTestId, getByTestId } = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={open} />);
    const card = await findByTestId('story-game-approach');
    expect(within(card).queryByRole('button', { name: /^(Enter|Inspect|Open)$/ })).toBeNull();
    fireEvent.keyDown(getByTestId('story-game'), { key: 'e' });
    expect(open).not.toHaveBeenCalled();
    expect(storyGameStore.getState().saves[story.id]!.visited).toContain(id);
  });
});

describe('Esc climbs out of a child story', () => {
  it('back to the parent after entering, which restarts from its own save', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => routeTo(story.id));
    storyGameStore.getState().savePosition(story.id, 7, -4);
    scene.near = () => child.id;
    const first = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={vi.fn()} />);
    fireEvent.click(within(await first.findByTestId('story-game-approach')).getByRole('button', { name: /^Enter/ }));
    first.unmount();

    scene.near = () => null;
    const inChild = render(<StoryGame view={childView} mode="game" onMode={vi.fn()} open={vi.fn()} />);
    await inChild.findByTestId('mock-world');
    fireEvent.keyDown(inChild.getByTestId('story-game'), { key: 'Escape' });
    expect(back).toHaveBeenCalledTimes(1);
    expect(navStore.getState().view).toMatchObject({ entityId: story.id });
    expect(storyGameStore.getState().mode[story.id]).toBe('game');
    inChild.unmount();

    const again = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={vi.fn()} />);
    await again.findByTestId('mock-world');
    expect(scene.start).toEqual({ x: 7, z: -4 });
  });

  it('a cold arrival goes up to the parent through the navStore', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    routeTo(story.id);
    scene.near = () => null;
    const { getByTestId, findByTestId } = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={vi.fn()} />);
    await findByTestId('mock-world');
    act(() => { fireEvent.keyDown(getByTestId('story-game'), { key: 'Escape' }); });
    expect(back).not.toHaveBeenCalled();
    expect(navStore.getState().view).toEqual({ view: 'entity', entityId: parent.id, origin: { slug: 'stories', mode: null } });
    expect(storyGameStore.getState().mode[parent.id]).toBe('game');
  });

  it('leaves Esc to the host where the story is not the routed page', async () => {
    resetNav('', { view: 'home' });
    scene.near = () => null;
    const { getByTestId, findByTestId } = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={vi.fn()} />);
    await findByTestId('mock-world');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    getByTestId('story-game').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(navStore.getState().view).toEqual({ view: 'home' });
  });
});

describe('the flat world', () => {
  it('makes the same split: portal rows Enter, other rows Inspect', () => {
    scene.webgl = false;
    const open = vi.fn();
    const { getByTestId } = render(<StoryGame view={story} mode="game" onMode={vi.fn()} open={open} />);
    const flat = getByTestId('story-game-flat');
    fireEvent.click(within(flat).getByRole('button', { name: new RegExp(root.title) }));
    expect(open).toHaveBeenCalledWith(root.id);
    const portal = within(flat).getByRole('button', { name: new RegExp(child.title) });
    expect(portal.getAttribute('data-action')).toBe('enter');
    fireEvent.click(portal);
    expect(open).toHaveBeenCalledTimes(1);
    expect(navStore.getState().view).toMatchObject({ view: 'entity', entityId: child.id });
    expect(storyGameStore.getState().mode[child.id]).toBe('game');
  });
});

