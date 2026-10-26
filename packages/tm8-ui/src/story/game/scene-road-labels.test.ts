// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createRoadSignPool, hideRoadSign, paintRoadSign } from './scene-road-labels';
import { blankRoadLabel, type RoadLabel } from './road-labels';

const label = (over: Partial<RoadLabel>): RoadLabel => ({ ...blankRoadLabel(), placeId: 'p1', title: 'Harbour', kind: 'task', end: 'to', steps: 12, opacity: .5, ...over });

describe('road sign pool', () => {
  it('builds a fixed pool once and reuses its nodes on every paint', () => {
    const layer = document.createElement('div');
    const pool = createRoadSignPool(layer);
    expect(layer.querySelectorAll('.sgm-roadsign')).toHaveLength(2);
    const nodes = pool.map((s) => s.node);
    for (let i = 0; i < 30; i++) paintRoadSign(pool[0]!, label({ steps: 12 - (i % 3) }), 100 + i, 50, 90, false);
    hideRoadSign(pool[1]!);
    expect(layer.querySelectorAll('.sgm-roadsign')).toHaveLength(2);
    expect(pool.map((s) => s.node)).toEqual(nodes);
    expect(pool[0]!.node.style.display).toBe('flex');
    expect(pool[1]!.node.style.display).toBe('none');
  });

  it('writes destination, steps, direction and fade', () => {
    const [slot] = createRoadSignPool(document.createElement('div'), 1);
    paintRoadSign(slot!, label({ steps: 1 }), 10.4, 20.6, -44.6, false);
    expect(slot!.title.textContent).toBe('Harbour');
    expect(slot!.steps.textContent).toBe('1 step');
    expect(slot!.node.dataset.placeId).toBe('p1');
    expect(slot!.node.style.getPropertyValue('--sgm-dir')).toBe('-45deg');
    expect(slot!.node.style.transform).toBe('translate(10px, 21px) translate(-50%, -50%)');
    expect(slot!.node.style.opacity).toBe('0.5');
  });

  it('toggles without fading under reduced motion', () => {
    const [slot] = createRoadSignPool(document.createElement('div'), 1);
    paintRoadSign(slot!, label({ opacity: .2 }), 0, 0, 0, true);
    expect(slot!.node.style.opacity).toBe('1');
    hideRoadSign(slot!);
    expect(slot!.node.style.display).toBe('none');
  });

  it('leaves the DOM alone when nothing changed', () => {
    const [slot] = createRoadSignPool(document.createElement('div'), 1);
    paintRoadSign(slot!, label({}), 5, 5, 0, false);
    slot!.node.style.transform = 'none';
    slot!.title.textContent = 'sentinel';
    paintRoadSign(slot!, label({}), 5.2, 4.9, .3, false);
    expect(slot!.node.style.transform).toBe('none');
    expect(slot!.title.textContent).toBe('sentinel');
  });
});
