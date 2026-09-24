import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDGE_VERBS, edgeVerb, edgeVerbBoth, isConversationEdge } from './edge-verbs';

/**
 * THE COVERAGE GUARD. The raw `authored_from (incoming)` on the Connections tab
 * was not a styling bug: it was a label map that covered fifteen of the
 * registered edge types, with nothing to notice the other twenty-eight. The
 * registry is the `edge_types` table, and the migrations are its only writer,
 * so this reads the migrations and holds the verb map to exactly that set.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

/**
 * Every type an `insert into edge_types … values (…), (…)` statement
 * registers: the first string literal of each top-level tuple. A small scanner
 * rather than a regex, because the tuples carry `array[…]`, jsonb with nested
 * parentheses, and descriptions containing `;` and `--`.
 */
function registeredEdgeTypes(): Set<string> {
  const types = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const head = /insert\s+into\s+(?:public\.)?edge_types\s*\([^)]*\)\s*values/gi;
    let match: RegExpExecArray | null;
    while ((match = head.exec(sql))) {
      let depth = 0;
      let firstLiteralTaken = false;
      for (let i = head.lastIndex; i < sql.length; i += 1) {
        const ch = sql[i];
        if (ch === "'") {
          let end = i + 1;
          while (end < sql.length) {
            if (sql[end] === "'" && sql[end + 1] === "'") end += 2;
            else if (sql[end] === "'") break;
            else end += 1;
          }
          if (depth === 1 && !firstLiteralTaken) {
            types.add(sql.slice(i + 1, end));
            firstLiteralTaken = true;
          }
          i = end;
        } else if (ch === '-' && sql[i + 1] === '-') {
          while (i < sql.length && sql[i] !== '\n') i += 1;
        } else if (ch === '(') {
          depth += 1;
          if (depth === 1) firstLiteralTaken = false;
        } else if (ch === ')') {
          depth -= 1;
        } else if (ch === ';' && depth === 0) {
          break;
        }
      }
    }
  }
  return types;
}

describe('edge verbs cover the edge registry', () => {
  const registered = registeredEdgeTypes();

  it('the scanner finds the registry (a green run over zero types proves nothing)', () => {
    // One type from the first migration, one from the middle, one from the
    // newest block of registrations — a scanner that silently stopped early
    // would miss at least one of them.
    for (const type of ['depends_on', 'tracks', 'messaged', 'created_in', 'controls']) {
      expect(registered, type).toContain(type);
    }
    expect(registered.size).toBeGreaterThanOrEqual(40);
  });

  it('every registered edge type has a verb for both directions', () => {
    const missing = [...registered].filter((type) => !EDGE_VERBS[type]).sort();
    expect(missing, 'add these to EDGE_VERBS in domain/edge-verbs.ts').toEqual([]);
    for (const [type, verb] of Object.entries(EDGE_VERBS)) {
      expect(verb.out.trim(), `${type}.out`).not.toBe('');
      expect(verb.in.trim(), `${type}.in`).not.toBe('');
    }
  });

  it('carries no verb for a type nothing registers', () => {
    const stale = Object.keys(EDGE_VERBS).filter((type) => !registered.has(type)).sort();
    expect(stale).toEqual([]);
  });

  it('never prints an edge id or "(incoming)" for a registered type', () => {
    for (const type of registered) {
      for (const direction of ['outgoing', 'incoming'] as const) {
        const verb = edgeVerb(type, direction);
        expect(verb).not.toContain('_');
        expect(verb).not.toContain('(incoming)');
      }
    }
  });
});

describe('edge verbs read from the open entity’s side', () => {
  it('puts direction into the words', () => {
    expect(edgeVerb('created_in', 'incoming')).toBe('Created here');
    expect(edgeVerb('working_on', 'outgoing')).toBe('Working on');
    expect(edgeVerb('depends_on', 'outgoing')).toBe('Depends on');
    expect(edgeVerb('depends_on', 'incoming')).toBe('Needed by');
    expect(edgeVerbBoth('messaged')).toBe('Talked with');
    expect(edgeVerbBoth('depends_on')).toBeNull();
  });

  it('falls back to spaced words for a type this build does not know, arrow on the incoming side', () => {
    expect(edgeVerb('future_edge', 'outgoing')).toBe('future edge');
    expect(edgeVerb('future_edge', 'incoming')).toBe('← future edge');
  });

  it('treats only INCOMING message edges as conversation', () => {
    expect(isConversationEdge('authored_from', 'incoming', 'message')).toBe(true);
    expect(isConversationEdge('anchored_to', 'incoming', 'message')).toBe(true);
    // An artifact or memory authored in a session is something it made — a row.
    expect(isConversationEdge('authored_from', 'incoming', 'artifact')).toBe(false);
    // On a message's own panel, where it was written is a real connection.
    expect(isConversationEdge('authored_from', 'outgoing', 'work_session')).toBe(false);
    // Evidence edges from a message are not traffic.
    expect(isConversationEdge('verifies', 'incoming', 'message')).toBe(false);
  });
});
