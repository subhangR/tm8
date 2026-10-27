// @vitest-environment jsdom
/**
 * The minimap (task 01a1090f): it paints only when what it shows changes, at
 * most MINIMAP_HZ times a second, and a click on revealed land issues the
 * same walk order the scene obeys. jsdom has no 2D canvas, so the context is a
 * recording stub.
 */
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { createControl } from './control';
import { Minimap } from './Minimap';
import { MINIMAP_SIZE, minimapModel } from './minimap';
import { readPalette } from './palette';
import { storyGameStore } from './store';
import { buildWorld } from './world';

const world = buildWorld(STORY_FIXTURE);
const storyId = STORY_FIXTURE.id;
const palette = readPalette(document.body);
const revealed: ReadonlySet<string> = new Set([world.hubId]);

function stubContext() {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => { calls.push(key); return args; }),
    set: (target, key: string, value) => { target[key] = value; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  return calls;
}

const draws = (node: HTMLElement) => Number(node.querySelector('canvas')!.dataset.draws ?? 0);

describe('Minimap', () => {
  beforeEach(() => { storyGameStore.getState().resetAll(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const mount = (props: Partial<Parameters<typeof Minimap>[0]> = {}) => {
    const control = createControl();
    const onToggle = vi.fn(), onTravel = vi.fn();
    const all = { world, storyId, revealed, palette, control, open: true, onToggle, onTravel, ...props };
    const view = render(<Minimap {...all} />);
    return { ...view, control, onToggle, onTravel, rerenderWith: (more: Partial<typeof all>) => view.rerender(<Minimap {...all} {...more} />) };
  };

  it('paints once and skips a re-render that changes nothing', () => {
    const calls = stubContext();
    const { container, rerenderWith } = mount();
    expect(draws(container)).toBe(1);
    expect(calls).toContain('clip');
    rerenderWith({});
    act(() => { vi.advanceTimersByTime(500); });
    expect(draws(container)).toBe(1);
  });

  it('coalesces rapid moves into at most one paint per 100 ms', () => {
    stubContext();
    const { container } = mount();
    expect(draws(container)).toBe(1);
    act(() => { for (let i = 1; i <= 20; i++) storyGameStore.getState().savePosition(storyId, i, i); });
    expect(draws(container)).toBe(1);
    act(() => { vi.advanceTimersByTime(100); });
    expect(draws(container)).toBe(2);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(draws(container)).toBe(2);
  });

  it('walks to a revealed place on click, and not into the fog', () => {
    stubContext();
    const { container, control, onTravel } = mount();
    const canvas = container.querySelector('canvas')!;
    fireEvent.click(canvas, { clientX: 1, clientY: 1 });
    expect(control.order).toBeNull();
    expect(onTravel).not.toHaveBeenCalled();
    const hub = minimapModel(world, revealed, { x: 0, z: 2.6, heading: 0 }).dots.find((d) => d.hub)!;
    fireEvent.click(canvas, { clientX: hub.px, clientY: hub.py });
    expect(control.order).toMatchObject({ x: 0, z: 0, placeId: world.hubId, open: false });
    expect(onTravel).toHaveBeenCalledTimes(1);
  });

  it('toggles through its button with aria-pressed and hides the canvas', () => {
    stubContext();
    const { getByRole, container, onToggle, rerenderWith } = mount();
    const button = getByRole('button', { name: /minimap/i });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(container.querySelector('canvas')!.id);
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerenderWith({ open: false });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('canvas')!.hidden).toBe(true);
    expect(container.querySelector('[data-testid="story-game-minimap"]')!.getAttribute('data-open')).toBe('false');
  });

  it('sizes the backing store for the device pixel ratio', () => {
    stubContext();
    vi.stubGlobal('devicePixelRatio', 2);
    const { container } = mount();
    const canvas = container.querySelector('canvas')!;
    expect(canvas.width).toBe(MINIMAP_SIZE * 2);
    expect(canvas.style.width).toBe(`${MINIMAP_SIZE}px`);
    vi.unstubAllGlobals();
  });
});
