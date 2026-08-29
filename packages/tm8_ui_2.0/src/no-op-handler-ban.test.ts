import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A HANDLER THAT DOES NOTHING IS NOT "NO HANDLER" — a package law, because the
 * failure it prevents is invisible in the component that suffers it.
 *
 * Several screens here decide how honest to look by asking whether a callback
 * EXISTS. `EntityChip` renders an inert badge without `onOpen` and a button with
 * it; `InboxScreen` renders its rows disabled-with-reason without
 * `onOpenNotification` and clickable with it. That is a good pattern — the
 * component cannot navigate, so it says so — and it has exactly one way to fail:
 * a host that cannot navigate passing `() => undefined` anyway. The prop is then
 * present, the honest state switches itself off, and the viewer gets a live-
 * looking control that swallows every press.
 *
 * `MobileShell` did this to BOTH of them at once, and no test could see it: the
 * screens were green (they were handed a handler), the shell was green (it
 * rendered), and the only artefact was a button on a phone that did nothing.
 * Nothing about that is visible in a diff either — `() => undefined` reads as a
 * deliberate default rather than as a disabled feature.
 *
 * So the ban is stated once, here, over the whole package. Passing NOTHING is
 * how a host says "I cannot do this"; if a host later can, it passes a real
 * handler and this stays quiet.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The props whose ABSENCE the receiving screen reads as a ruling. Each entry
 * names the screen that reads it, so a future addition is a decision rather
 * than a guess.
 */
const HONEST_ABSENCE_PROPS: readonly { prop: string; readBy: string }[] = [
  { prop: 'onOpenEntity', readBy: 'EntityChip / LiveGraphStrip — inert badge and unpressable node' },
  { prop: 'onOpenNotification', readBy: 'InboxScreen — rows disabled WITH REASON' },
  { prop: 'onResumeSession', readBy: 'SessionFallback — "not wired on this surface"' },
  { prop: 'onMarkExited', readBy: 'StaleFallback — chip disabled WITH REASON' },
  { prop: 'onMarkSessionExited', readBy: 'EntityDetailPanel — forwards the above' },
  { prop: 'onRespond', readBy: 'CrewCard — "Answer" disabled WITH REASON' },
  { prop: 'onHelperAction', readBy: "CrewCard — a stuck row's one button, disabled WITH REASON" },
  { prop: 'onOpenCrew', readBy: 'LiveDock — no link rather than a dead one' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const sourceFiles = walk(HERE)
  .filter((f) => /\.tsx?$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

describe('no host fakes a capability it does not have', () => {
  it('scans the package, not one directory', () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
    expect(sourceFiles.map((f) => relative(HERE, f))).toContain('views/MobileShell.tsx');
  });

  it('never passes a no-op to a prop whose absence is the honest answer', () => {
    const names = HONEST_ABSENCE_PROPS.map((p) => p.prop).join('|');
    // Both arrow shapes, with or without `async`, and tolerant of whitespace:
    // `onOpenEntity={() => undefined}`, `={async () => undefined}`, `={() => {}}`.
    const noop = new RegExp(
      String.raw`\b(${names})=\{\s*(?:async\s*)?\(\s*[^)]*\)\s*=>\s*(?:undefined|\{\s*\}|void 0)\s*\}`,
      'g',
    );
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const hit of readFileSync(file, 'utf8').matchAll(noop)) {
        offenders.push(`${relative(HERE, file)} → ${hit[0]}`);
      }
    }
    expect(
      offenders,
      `pass nothing instead — the receiving screen renders its honest state:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
