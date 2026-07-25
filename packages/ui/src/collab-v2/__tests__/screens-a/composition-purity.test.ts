// @vitest-environment node
/**
 * THE LAW for L5: screens are COMPOSITION ONLY.
 *
 * A screen may render CollectionView / Thread / entity components / subsystems
 * and wire callbacks. It may NOT branch on entity kind, reach into kind-shaped
 * entity state, or hand-roll entity markup — all kind variation lives in
 * `registry/`, all entity rendering in `entity/`. This test greps the W3a
 * screen source and fails on any of those.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCREENS_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'screens');
const OWNED = ['home', 'inbox', 'tasks'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = OWNED.flatMap((d) => sourceFiles(join(SCREENS_ROOT, d)));

describe('W3a screens are composition only', () => {
  it('covers all three screen directories', () => {
    expect(FILES.length).toBeGreaterThan(8);
    for (const dir of OWNED) {
      expect(FILES.some((f) => f.includes(join('screens', dir)))).toBe(true);
    }
  });

  it('contains no kind conditionals', () => {
    const offenders = FILES.filter((f) => /\bkind\s*===/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('never narrows kind-shaped entity state', () => {
    // `entity.state.*` / `state.kind` is registry + entity-component territory.
    const offenders = FILES.filter((f) => /\.state\.(kind|workStatus|axes|assignees)\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('renders entities only through the entity component system', () => {
    // No screen may build its own chip/card chrome.
    const offenders = FILES.filter((f) => /className=["'`][^"'`]*cv2-(chip|card)__/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('never reaches into the kind registry itself (only its shared formatters)', () => {
    const offenders = FILES.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /\bregistryFor\s*\(/.test(src) || /from '[^']*registry\/KindRegistry'/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('never imports the mock layer (screens speak only to the facade seam)', () => {
    const offenders = FILES.filter((f) => /from '.*\/mock/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
