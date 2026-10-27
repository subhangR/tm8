import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE INSTRUMENTS MEASURE THE REAL THING. Two ways a layout probe passed
 * without measuring anything, pinned so neither comes back.
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const audit = read('../../e2e/mobile-audit.mjs');
const keyboard = read('../../e2e/capture-keyboard-geometry.mjs');

describe('audit:mobile', () => {
  it('fails the run when a row lands in the wrong shell', () => {
    /* Unbuilt packages: vite 500s, every row is shell 'none', gates pass vacuously. */
    expect(audit).toMatch(/if \(!shellOk\) \{[\s\S]*?wrongShell\.push/);
    expect(audit).toMatch(/if \(wrongShell\.length\) \{[\s\S]*?process\.exitCode = 1;/);
  });
});

describe('capture-keyboard-geometry', () => {
  it('nests its .mobile-frame inside .cv2-root instead of marking the root', () => {
    /* The surface's parent IS `.cv2-root`; classing it made the root the frame
       and `.cv2-root .mobile-frame[data-keyboard]` matched nothing. */
    expect(keyboard).not.toMatch(/surface\.parentElement\.classList\.add\('mobile-frame'\)/);
    expect(keyboard).toMatch(/frame\.className = 'mobile-frame';[\s\S]*frame\.append\(surface\)/);
  });

  it('refuses to report an "up" row the keyboard rules did not reach', () => {
    expect(keyboard).toMatch(/\.mobile-frame\[data-keyboard='up'\] \.tch-composer-wrap"\)\);\s*if \(!matched\) throw/);
  });
});
