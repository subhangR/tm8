import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * D75 — THE SHELL'S HEIGHT IS A PERCENTAGE, AND NO TEST THAT RENDERS CAN SAY SO.
 *
 * The defect this file exists for: `.shell-root` was sized `calc(100vh / 1.1)`,
 * a compensation for `zoom: 1.1` that is RIGHT in Chrome (which leaves `vh` at
 * the raw viewport) and applied TWICE in Safari (which divides `vh` by the
 * zoom, per the Viewport spec). The shell drew 0.9091 of the viewport in
 * Safari — a ~79 CSS px white band under the app, which is how the user
 * reported it. Measured on their screenshot: 1572 device px of app in a 1729
 * device px viewport.
 *
 * READS THE STYLESHEET, DELIBERATELY, following `mobile-frame.test.ts` and
 * `channel-screen.responsive.test.ts`. jsdom implements NO layout and loads NO
 * stylesheets, so a render test here would report `height` as an empty string
 * and pass against either rule — it cannot distinguish the defect from the fix.
 * The only instrument that can is a real engine, and the cross-engine
 * measurement lives in D75's table rather than in CI.
 *
 * What this file CAN do is keep a viewport unit from coming back, and keep the
 * percentage chain unbroken — those are the two ways the band returns.
 */

/** Stripped for `mobile-frame.test.ts`'s reason: this stylesheet EXPLAINS the
 *  units it forbids, and a negative assertion over raw text would fail on the
 *  explanation instead of on the defect. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const shell = strip(readFileSync(new URL('./shell.css', import.meta.url), 'utf8'));
const app = strip(readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8'));
const gate = strip(readFileSync(new URL('../views/GateApp.tsx', import.meta.url), 'utf8'));

describe('D75 — the shell frame is sized by percentage, never by a viewport unit', () => {
  it('sizes .shell-root with 100%', () => {
    expect(shell).toMatch(/\.shell-root\s*\{[^}]*height:\s*100%/);
  });

  it('names NO viewport unit anywhere in the shell stylesheet', () => {
    // `vh`, `dvh`, `svh`, `lvh` all mean one thing in Chrome and another
    // inside `zoom` in Safari. A percentage is the only length both engines
    // agree on across a zoom boundary, so the whole family is out — including
    // the `calc(100vh / 1.1)` this file was written to keep from returning.
    expect(shell).not.toMatch(/\b\d+(?:\.\d+)?(?:d|s|l)?vh\b/);
  });

  it('keeps the chain that makes the percentage resolve to the viewport', () => {
    // A percentage height is only the viewport if every link above it has one.
    // Break any of these three and `height: 100%` silently degrades to `auto`,
    // which is the content height — no band, but no floor either, and the
    // shell's internal scroll regions stop being bounded.
    expect(app).toMatch(/html[\s\S]{0,40}body[\s\S]{0,40}#root\s*\{[^}]*height:\s*100%/);
    expect(shell).toMatch(/\.cv2-root\.shell-scope\s*\{[^}]*height:\s*100%/);
    expect(gate).toMatch(/className="cv2-root shell-scope"/);
  });

  it('puts the height on .shell-scope and NOT on bare .cv2-root', () => {
    // `.cv2-root` is re-opened as a theme scope INSIDE the shell —
    // EntityDetailPanel's dark work_session panel, AlwaysDark around the
    // terminal — where a 100% height is wrong. Same nesting hazard that
    // `.cv2-root .cv2-root { zoom: 1 }` answers, answered the same way.
    expect(app).not.toMatch(/\.cv2-root\s*\{[^}]*height:/);
    expect(shell).not.toMatch(/\.cv2-root\s*\{[^}]*height:\s*100%/);
  });
});

describe('D75 — the 1.1 literal no longer lives in shell.css', () => {
  it('carries no zoom reciprocal', () => {
    // D63.3 ruled the number lived in THREE sites that must move together.
    // The shell's divisor is gone, so a future scale change cannot move the
    // fold. terminal.css's `calc(1 / 1.1)` stays coupled to the lever — it
    // counters a nested `zoom`, which composes identically in both engines.
    expect(shell).not.toMatch(/\/\s*1\.1\b/);
  });
});
