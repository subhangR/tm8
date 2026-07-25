import { describe, expect, it } from 'vitest';
import goldenFrames from './golden-frames.json';
import { parseControlFrame } from '../src/index';

describe('PTY protocol golden frames', () => {
  for (const [index, vector] of goldenFrames.entries()) {
    it(`matches golden vector ${index + 1}`, () => {
      expect(parseControlFrame(vector.input)).toEqual(vector.expected);
    });
  }
});
