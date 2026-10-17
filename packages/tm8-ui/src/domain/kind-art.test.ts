import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveAction } from './actions';
import { KIND_ART, SURFACE_ART, VIEW_ART, type KindArt } from './kind-art';

/**
 * THE ICON SET HOLDS TWO LAWS (task 01a14b26, Subhang 2026-10-18: "some
 * entities share the same icon … the chat icon should be one good icon, the
 * same everywhere").
 *
 *   1. NO TWO MARKS SHARE ARTWORK — across kinds, rail views and session
 *      surfaces, not just within kinds (`registry.test.ts` covers that). The
 *      only shares are the deliberate ones listed below, each a view that IS
 *      the list of a kind or a surface that IS a view scoped to one session.
 *   2. EVERY MARK IS DRAWN ONCE, HERE. No file outside `kind-art.ts` may carry
 *      a copy of a path from these tables, and none may carry one of the
 *      retired bubble drawings — the private copies are how chat came to be
 *      drawn seven ways.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const MARKS: readonly (readonly [string, KindArt])[] = [
  ...Object.entries(KIND_ART).map(([k, art]) => [`kind:${k}`, art] as const),
  ...Object.entries(VIEW_ART).map(([k, art]) => [`view:${k}`, art] as const),
  ...Object.entries(SURFACE_ART).map(([k, art]) => [`surface:${k}`, art] as const),
];

/** The deliberate shares, each one line in `kind-art.ts` pointing at the other. */
const SHARED: readonly (readonly string[])[] = [
  ['kind:channel', 'view:channels'],
  ['kind:message', 'view:messages'],
  ['kind:craft', 'view:craft'],
  ['view:git', 'surface:git'],
  ['view:graph', 'surface:graph'],
];

/**
 * Drawings this task retired. Each was a bubble that read as chat (or a copy
 * of the chat bubble kept outside the table); any of them reappearing is the
 * defect coming back.
 */
const RETIRED_BUBBLES: readonly string[] = [
  // the old chat kind
  'M5.4 2.6h6.4a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 0 1-1.8 1.8H9.2L6.6 11.4V9.6H5.4a1.8 1.8 0 0 1-1.8-1.8V4.4a1.8 1.8 0 0 1 1.8-1.8z',
  // the old message kind
  'M13.2 9.6a1.9 1.9 0 0 1-1.9 1.9H6.5L3.4 13.8V5.1a1.9 1.9 0 0 1 1.9-1.9h6a1.9 1.9 0 0 1 1.9 1.9z',
  // the old Messages rail view
  'M2.2 6.4a1.6 1.6 0 0 1 1.6-1.6h5.2a1.6 1.6 0 0 1 1.6 1.6v3a1.6 1.6 0 0 1-1.6 1.6H5.1L2.2 13.4z',
  // the old transcript surface
  'M13.2 9.4a1.9 1.9 0 0 1-1.9 1.9H6.6L3.5 13.6V5a1.9 1.9 0 0 1 1.9-1.9h5.9a1.9 1.9 0 0 1 1.9 1.9z',
  // the ActionStrip Chat and Messages buttons
  'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',
  // the phone drawer's Chats row
  'M13.2 9.4a1.6 1.6 0 0 1-1.6 1.6H6l-3 2.4V4.2a1.6 1.6 0 0 1 1.6-1.6h7a1.6 1.6 0 0 1 1.6 1.6z',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Every path-data literal in a file: quoted strings and `d="…"` attributes that start with a moveto. */
function pathLiterals(text: string): string[] {
  return [...text.matchAll(/['"`](M\s?-?[\d.][^'"`\n]*)['"`]/g)].map((m) => m[1]!);
}

describe('kind-art: one distinct mark per thing, drawn once', () => {
  it('no two marks share artwork across kinds, views and surfaces, except the deliberate shares', () => {
    const bySignature = new Map<string, string[]>();
    for (const [name, art] of MARKS) {
      const signature = art.join('|');
      bySignature.set(signature, [...(bySignature.get(signature) ?? []), name]);
    }
    const allowed = new Set(SHARED.map((group) => [...group].sort().join(',')));
    for (const names of bySignature.values()) {
      if (names.length < 2) continue;
      expect(allowed.has([...names].sort().join(',')), `${names.join(' and ')} draw the same mark`).toBe(true);
    }
  });

  it('chat is the only bubble: message, Messages and transcript are not drawn with any chat path', () => {
    const chat = new Set(KIND_ART.chat);
    for (const name of ['kind:message', 'view:messages', 'surface:transcript']) {
      const art = MARKS.find(([n]) => n === name)![1];
      for (const d of art) expect(chat.has(d), `${name} reuses a chat path`).toBe(false);
    }
  });

  it('the Chat verb wears the chat mark itself', () => {
    expect(resolveAction('chat-about').art).toBe(KIND_ART.chat);
  });

  it('no file outside kind-art.ts keeps a copy of a shared mark or a retired bubble', () => {
    const shared = new Map<string, string>();
    for (const [name, art] of MARKS) for (const d of art) shared.set(d, name);
    const retired = new Set(RETIRED_BUBBLES);
    const offences: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === join('domain', 'kind-art.ts')) continue;
      for (const literal of pathLiterals(readFileSync(file, 'utf8'))) {
        // An inline `d` may glue several subpaths into one string; check each.
        const parts = new Set([literal, ...literal.split(/\s*(?=M)/)]);
        for (const part of parts) {
          if (retired.has(part)) offences.push(`${rel}: a retired chat/message bubble (${part.slice(0, 24)}…)`);
          else if (shared.has(part)) offences.push(`${rel}: a private copy of ${shared.get(part)} (${part.slice(0, 24)}…)`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
