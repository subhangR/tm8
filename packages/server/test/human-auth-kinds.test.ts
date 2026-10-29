/**
 * One allow-list for "is this session human" (task 01a0e24d, doc 01a0e257 v2
 * correction A). `HUMAN_AUTH_KINDS` in @tm8/contract mirrors
 * `internal.require_human_auth_kind()` (083, widened by the mobile auth kind
 * migration); every server guard imports it. Three pins keep it that way:
 *   1. the export equals the SQL literal in the function's latest definition;
 *   2. no server source holds a private copy (an array/set literal of the
 *      kinds, or an `authKind === 'browser' || …` / `!==` chain);
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
  it('equals the allow-list in the latest internal.require_human_auth_kind()', () => {
    // The last migration that defines it, by file order: 083, then whatever
    // restated it (the mobile auth kind). Found by scanning, never by number.
    const dir = join(ROOT, 'db/migrations');
    let body: string | undefined;
    for (const file of readdirSync(dir).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const definitions = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+internal\.require_human_auth_kind\s*\(/g)];
      const last = definitions.at(-1);
      if (last) body = sql.slice(last.index);
    }
    const literal = /not in \(([^)]*)\)/.exec(body ?? '')?.[1];
    expect(literal).toBeDefined();
    const kinds = literal!.split(',').map((part) => part.trim().replace(/^'|'$/g, ''));
    expect([...HUMAN_AUTH_KINDS].sort()).toEqual(kinds.sort());
  });

  it('fails closed and does not admit a link session', () => {
    for (const kind of ['link', 'agent', 'agent_runtime', '', null, undefined, 'Browser', 'Mobile']) {
      expect(isHumanAuthKind(kind)).toBe(false);
    }
    expect(isHumanAuthKind('browser')).toBe(true);
    expect(isHumanAuthKind('cli')).toBe(true);
    expect(isHumanAuthKind('mobile')).toBe(true);
  });

  it('has no private copy anywhere in server src', () => {
    const copies: string[] = [];
    for (const file of sources(SERVER_SRC)) {
      const text = readFileSync(file, 'utf8');
      if (/['"](browser|cli|mobile)['"]\s*,\s*['"](browser|cli|mobile)['"]/.test(text)
        || /authKind\s*[!=]==\s*['"](browser|cli|mobile)['"]/.test(text)) {
        copies.push(file.slice(ROOT.length));
      }
    }
    expect(copies).toEqual([]);
  });
});

describe('catalog humanOnly ⇔ registered through a human guard', () => {
  const FILES = [
    'packages/server/src/facade/handlers/w2/credentials.ts',
    'packages/server/src/facade/handlers/w2/inbox-read-marks.ts',
    'packages/server/src/facade/handlers/w2/space-links.ts',
    'packages/server/src/facade/handlers/w2/servers.ts',
    // 284: only `spaces.styleDefault.set` is human-only; the style reads and
    // personal writes stay open to agents (spec §7).
    'packages/server/src/facade/handlers/w2/styles.ts',
    // 345: `mcp.servers.request` is the one human-only operation registered
    // from the DEFINITIONS file rather than the runtime one — it needs no MCP
    // runtime bridge, only a member and a Space.
    'packages/server/src/mcp/definitions.ts',
    'packages/server/src/mcp/handlers.ts',
    // §5.5 (357): all three `mcp.tokens.*` are human-only. A token that acts as
    // a member is minted and revoked by that member at a keyboard — never by
    // their agent carrying their identity, and never by another MCP token.
    'packages/server/src/mcp/tokens.ts',
    // §5.6 (346): the audit read is a human oversight surface (lead ruling on #1321).
    'packages/server/src/mcp/audit.ts',
    'packages/server/src/tools/handlers.ts',
    // §10.4: `chat.getMcpSelections` is the one chat operation registered
    // through `requireHumanSession`. Its siblings rely on the family's own
    // `refuseChatRuntimeBearer` plus a human gate inside their RPC, and
    // `read_mcp_launch_selections` has no such gate — so this door carries the
    // wrapper for real and the catalog flags it.
    'packages/server/src/chat/handlers.ts',
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
    for (const op of ['spaceLinks.list', 'spaceLinks.audit', 'spaceLinks.invoke', 'servers.get', 'servers.list', 'servers.probe',
      'spaces.styleDefault.get', 'styles.push']) {
      expect(flagged.has(op)).toBe(false);
    }
  });
});
