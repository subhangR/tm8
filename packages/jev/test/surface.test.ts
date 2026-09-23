// What the package IS, held from outside: exactly the root task's public API,
// and no way to reach a database, the filesystem, the environment or a log.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as jev from '../src/index.js';

const SRC = join(__dirname, '..', 'src');
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }));

describe('the public API', () => {
  it('exports exactly the frozen runtime surface', () => {
    expect(Object.keys(jev).sort()).toEqual(
      [
        'createJevClient',
        'jevClientFromEnv',
        'rankByRelevance',
        'adviseModel',
        'levelOf',
        'costOf',
        'JEV_INPUT_USD_PER_TOKEN',
        'ROUTING_QUESTIONS',
        'readSignals',
        'decide',
        'TIER_LADDER',
        'DEFAULT_WEIGHTS',
      ].sort(),
    );
  });
});

describe('purity', () => {
  it('has exactly the six planned source files', () => {
    expect(sources.map((s) => s.file).sort()).toEqual(['client.ts', 'cost.ts', 'index.ts', 'model.ts', 'rank.ts', 'wire.ts']);
  });

  it('imports nothing but its own files and @tm8/contract types', () => {
    for (const { file, text } of sources) {
      const specifiers = [...text.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)].map((m) => ({
        typeOnly: Boolean(m[2]),
        from: m[3]!,
      }));
      for (const s of specifiers) {
        if (s.from.startsWith('./')) continue;
        expect(s.from, `${file} imports ${s.from}`).toBe('@tm8/contract');
        expect(s.typeOnly, `${file} imports @tm8/contract values`).toBe(true);
      }
      expect(text, `${file} has a dynamic import or require`).not.toMatch(/\bimport\(|\brequire\(/);
    }
  });

  it('touches no process environment, filesystem or console', () => {
    for (const { file, text } of sources) {
      expect(text, `${file} reads process`).not.toMatch(/\bprocess\./);
      expect(text, `${file} logs`).not.toMatch(/\bconsole\./);
      expect(text, `${file} names a node builtin`).not.toMatch(/['"]node:/);
    }
  });
});
