import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GATE 4 (spec doc 01a0e248 §9): ONE FORMATTER BUILDS THE CREDENTIAL LINE.
 *
 * `credentials/credentialLine.ts` is the only file that may write the phrases
 * that make up a session's credential sentence (§6), or read the fields of the
 * server's masked `credential` block to build one. SC-5 put a second builder in
 * `SessionDebugBody.tsx` and fed it from the human-only `credentials.space.list`.
 * That is the reinvention this test exists to stop: a second builder is a
 * second place to get the masking or the wording wrong.
 *
 * Tests are exempt, because they assert the phrases. `src/data/` is not exempt,
 * because a fixture that renders the line would be a builder too.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = `credentials${sep}credentialLine.ts`;

const PHRASES: readonly { name: string; pattern: RegExp }[] = [
  { name: '"Running on" / "Ran on" (the line\'s opening)', pattern: /['"`]\s*(?:Running|Ran) on\b/ },
  { name: '"git as" (the git segment)', pattern: /\bgit as\b/ },
  { name: '"… rung" (the legacy rung names)', pattern: /\((?:member|node) rung\)/ },
  { name: '"goes away at release 2" (the legacy future)', pattern: /go(?:es)? away at release 2/ },
  { name: '"No vendor credential" (the none line)', pattern: /No vendor credential/ },
  { name: '"space credential" (the ownership word)', pattern: /['"`]space credential['"`]/ },
  { name: '"private, yours" / "private, owned by" (ownership words)', pattern: /private, (?:yours|owned by)\b/ },
  { name: 'reading the block\'s providers (.credential?.providers / .providers.map over a view)', pattern: /credential\??\.providers\b/ },
  { name: 'the SC-5 builder (launchCredentialFacts)', pattern: /\blaunchCredentialFacts\b/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function hits(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const { name, pattern } of PHRASES) {
        if (pattern.test(line)) found.push(`${relative(HERE, file)}:${index + 1} — ${name}`);
      }
    });
  }
  return found;
}

describe('credential line ban (gate 4)', () => {
  const files = walk(HERE);
  const owner = files.filter((file) => relative(HERE, file) === OWNER);
  const outside = files.filter((file) => relative(HERE, file) !== OWNER);

  it('scans the package (a ban over an empty set passes vacuously)', () => {
    expect(owner).toHaveLength(1);
    expect(outside.length).toBeGreaterThan(100);
  });

  it('finds the phrases where they do live, so the patterns are not dead', () => {
    // POSITIVE CONTROL: every pattern except the two "must not exist" ones
    // matches inside the owner.
    const inOwner = hits(owner).join('\n');
    for (const { name } of PHRASES) {
      if (name.includes('launchCredentialFacts') || name.includes('.credential?.providers')) continue;
      expect(inOwner, name).toContain(name);
    }
  });

  it('the patterns catch a planted second builder', () => {
    // NEGATIVE CONTROL: a copy of the SC-5 shape and of the new line both trip it.
    const planted = [
      'const s = `Running on "${label}" · ${provider}`;',
      "facts.push(...launchCredentialFacts(launch));",
      "return 'git as ' + login;",
      'const l = view.credential?.providers.map(fmt);',
    ];
    for (const line of planted) {
      expect(PHRASES.some(({ pattern }) => pattern.test(line)), line).toBe(true);
    }
  });

  it('no file outside credentials/credentialLine.ts builds the credential line', () => {
    expect(hits(outside)).toEqual([]);
  });
});
