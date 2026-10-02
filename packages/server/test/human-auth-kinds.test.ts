/**
 * One allow-list for "is this session human" (task 01a0e24d, doc 01a0e257 v2
 * correction A). `HUMAN_AUTH_KINDS` in @tm8/contract mirrors 083's
 * `internal.require_human_auth_kind()`; every server guard imports it. Three
 * pins keep it that way:
 *   1. the export equals the SQL literal in 083;
 *   2. no server source holds a private copy (an array/set literal of the two
 *      kinds, or an `authKind === 'browser' || … 'cli'` chain);
 *   3. a catalog binding is `humanOnly` iff its registration is wrapped in
 *      `requireHumanSession` / `requireHumanLinkSession`, per file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUMAN_AUTH_KINDS, OPERATIONS, isHumanAuthKind } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_SRC = join(ROOT, 'packages/server/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('HUMAN_AUTH_KINDS', () => {
  it('equals the allow-list in 083 internal.require_human_auth_kind()', () => {
    const sql = readFileSync(join(ROOT, 'db/migrations/083_credential_sessions.sql'), 'utf8');
    const body = sql.slice(sql.indexOf('function internal.require_human_auth_kind'));
    const literal = /not in \(([^)]*)\)/.exec(body)?.[1];
    expect(literal).toBeDefined();
    const kinds = literal!.split(',').map((part) => part.trim().replace(/^'|'$/g, ''));
    expect([...HUMAN_AUTH_KINDS].sort()).toEqual(kinds.sort());
  });

  it('fails closed and does not admit a link session', () => {
    for (const kind of ['link', 'agent', 'agent_runtime', '', null, undefined, 'Browser']) {
      expect(isHumanAuthKind(kind)).toBe(false);
    }
    expect(isHumanAuthKind('browser')).toBe(true);
    expect(isHumanAuthKind('cli')).toBe(true);
  });

  it('has no private copy anywhere in server src', () => {
    const copies: string[] = [];
    for (const file of sources(SERVER_SRC)) {
      const text = readFileSync(file, 'utf8');
      if (/['"](browser|cli)['"]\s*,\s*['"](browser|cli)['"]/.test(text)
        || /authKind\s*===\s*['"](browser|cli)['"]/.test(text)) {
        copies.push(file.slice(ROOT.length));
      }
    }
    expect(copies).toEqual([]);
  });
});

describe('catalog humanOnly ⇔ registered through a human guard', () => {
  const FILES = [
    'packages/server/src/facade/handlers/w2/credentials.ts',
    'packages/server/src/facade/handlers/w2/space-links.ts',
    'packages/server/src/facade/handlers/w2/servers.ts',
  ];

  it('matches op by op, not by prefix', () => {
    const wrapped = new Set<string>();
    for (const file of FILES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const match of text.matchAll(/'([A-Za-z.]+)':\s*requireHuman(?:Link)?Session\(/g)) {
        wrapped.add(match[1]!);
      }
    }
    const flagged = new Set(OPERATIONS.filter((op) => op.humanOnly === true).map((op) => op.name));
    expect([...flagged].sort()).toEqual([...wrapped].sort());
    // The reads beside them stay open to agents.
    for (const op of ['spaceLinks.list', 'spaceLinks.audit', 'spaceLinks.invoke', 'servers.get', 'servers.list', 'servers.probe']) {
      expect(flagged.has(op)).toBe(false);
    }
  });
});
