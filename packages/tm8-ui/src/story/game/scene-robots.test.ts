// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { KIT_GEOMETRIES } from './assets/geometry';
import { ASSET_SPECS } from './assets/registry';
import type { Palette } from './palette';
import { robotsFor } from './robots';
import { ROBOT_POSES, robotBuckets, robotPose } from './scene-robots';
import { buildWorld } from './world';

const palette: Palette = { ink: 'rgb(20,20,20)', ink3: 'rgb(100,100,100)', surface: 'rgb(240,240,230)', card: 'rgb(255,255,255)', line: 'rgb(200,200,200)', line2: 'rgb(180,180,180)', brand: 'rgb(160,90,40)', run: 'rgb(50,140,80)', info: 'rgb(50,100,160)', block: 'rgb(180,70,60)', wait: 'rgb(180,150,40)', merged: 'rgb(120,80,160)' };

describe('kit robots', () => {
  it('poses are exactly the registry\'s robot states, and buckets cover every kit solid the robot uses with a constant draw-call count', () => {
    expect([...ROBOT_POSES].sort()).toEqual([...ASSET_SPECS['session-robot'].states].sort());
    const buckets = robotBuckets(palette);
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.length).toBeLessThanOrEqual(Object.keys(KIT_GEOMETRIES).length);
    for (const b of buckets) {
      expect(b.geo in KIT_GEOMETRIES).toBe(true);
      expect(b.capacity).toBe(Math.max(...ROBOT_POSES.map((p) => b.byPose[p].length)));
      expect(b.capacity).toBeGreaterThan(0);
    }
    // The session's own tint lands on the metal shell, never on the ground ring or the visor.
    expect(buckets.some((b) => b.byPose.working.some((p) => p.tinted))).toBe(true);
    expect(buckets.find((b) => b.geo === 'ring')!.byPose.working.every((p) => !p.tinted)).toBe(true);
  });
  it('picks a pose from W2\'s placement: attention waits, a blocked task blocks, a task works, the depot idles', () => {
    const world = buildWorld(STORY_FIXTURE), robots = robotsFor(STORY_FIXTURE, world);
    expect(robots.length).toBeGreaterThan(0);
    const [r] = robots;
    const atTask = { ...r!, attention: false, stand: { ...r!.stand, placeId: world.places.find((p) => p.tone === 'working')!.id } };
    expect(robotPose(atTask, world)).toBe('working');
    expect(robotPose({ ...atTask, attention: true }, world)).toBe('waiting');
    expect(robotPose({ ...atTask, stand: { ...atTask.stand, placeId: world.places.find((p) => p.tone === 'blocked')!.id } }, world)).toBe('blocked');
    expect(robotPose({ ...atTask, stand: { ...atTask.stand, placeId: null } }, world)).toBe('planned');
    for (const robot of robots) expect(ROBOT_POSES).toContain(robotPose(robot, world));
  });
});
