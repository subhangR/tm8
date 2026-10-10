import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE } from '../../fixture';
import { buildWorld } from '../world';
import { walkingMapModel, walkingWorld } from './walking';

describe('walking renderer geometry boundary', () => {
  it('preserves navigation, portals, encounters and exact scene geometry', () => {
    const navigation = buildWorld(STORY_FIXTURE, 0);
    expect(walkingWorld(walkingMapModel(navigation), navigation)).toEqual(navigation);
  });
  it('renders changed model geometry rather than stale navigation positions', () => {
    const navigation = buildWorld(STORY_FIXTURE, 0);
    const model = walkingMapModel(navigation);
    const root = model.places.find(p => p.kind === 'task')!;
    root.x += 15; root.z += 9;
    const world = walkingWorld(model, navigation);
    expect(world.byId.get(root.id)).toMatchObject({ x: root.x, z: root.z });
    expect(world.byId.get(root.id)?.encounters).toEqual(navigation.byId.get(root.id)?.encounters);
    expect(navigation.byId.get(root.id)?.x).not.toBe(root.x);
  });
});
