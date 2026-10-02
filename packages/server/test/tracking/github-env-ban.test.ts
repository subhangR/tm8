/**
 * Gate 6 (doc 01a0e248 §11): NO SERVER PATH READS A GITHUB ENV VAR.
 *
 * `resolveGithubToken` read `TM8_GITHUB_TOKEN` → `GITHUB_TOKEN` → `GH_TOKEN`
 * from the server's own environment for every poller and hydration call. That
 * was a second node rung (§2.4 item 8), and §10.5 deletes it: the pollers read
 * the space-owned credential of the project's space, else anonymously.
 *
 * Two halves, because a source scan alone proves only that nobody SPELLS the
 * names, and a behaviour test alone proves only the paths it drives:
 *
 *   1. SOURCE. Every package that runs inside the server process is scanned
 *      for the three names outside comments. The only files allowed to name
 *      them are listed below with the line shapes they may use: composeEnv's
 *      isolation (which WRITES a child's env and never reads the server's),
 *      the probe's refusal to run with them present, the secret-name
 *      classifier, and the config registry's row for the CLI's own knob. Each allowance must still match, so the list cannot rot
 *      into a blanket exemption.
 *   2. BEHAVIOUR. With all three set to a token in the server's environment,
 *      the observer and the watcher call GitHub with no `authorization`
 *      header — and with the space's own token when the space has one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import { runForgeWatchTick } from '../../src/tracking/loops.js';
import { runTrackingObserverTick } from '../../src/tracking/observer.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** The packages loaded into the server process. cli, mcp and tm8-ui run elsewhere. */
const SERVER_PACKAGES = ['server', 'execution', 'contract', 'jev', 'prompt', 'pty-protocol'];
const NAMES = /\b(TM8_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN)\b/;

/**
 * File → the only line shapes allowed to name a GitHub env var there, and why.
 * None of them reads the server's environment.
 */
const ALLOWED: Record<string, { why: string; lines: RegExp[] }> = {
  'packages/execution/src/spawn/manifest.ts': {
    why: "composeEnv's isolation: blanks, then sets, the CHILD's GH_TOKEN/GITHUB_TOKEN from the bound credential",
    lines: [/^\s*env\.(GH_TOKEN|GITHUB_TOKEN) = (''|credential\.token);$/, /\$GH_TOKEN"; \}; f';$/],
  },
  'packages/server/src/facade/services/w2/credential-probe.ts': {
    why: 'the probe REFUSES to run when a probe child env carries them (finding D6)',
    lines: [/^export const GH_TOKEN_ENV_NAMES = \['GH_TOKEN', 'GITHUB_TOKEN'\] as const;$/],
  },
  'packages/server/src/configs/registry.ts': {
    why: "the CLI's knob, documented: CLI_ENV values are never read by the server (registry.test.ts 'never reports a CLI env value')",
    lines: [/^\{ name: 'TM8_GITHUB_TOKEN', group: 'CLI', /],
  },
  'packages/contract/src/schemas.ts': {
    why: 'the secret-name classifier: names that must never be stored as plain env',
    lines: [/^\s*'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'TM8_AGENT_TOKEN',$/],
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Code lines only: block comments blanked (line count kept), `//` and ` * ` lines dropped. */
function codeLines(text: string): { line: number; text: string }[] {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  return blanked
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\*)/.test(t));
}

describe('gate 6 — source: no server path names a GitHub env var outside the isolation', () => {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const pkg of SERVER_PACKAGES) {
    for (const path of sourceFiles(join(REPO, 'packages', pkg, 'src'))) {
      const file = relative(REPO, path);
      for (const { line, text } of codeLines(readFileSync(path, 'utf8'))) {
        if (NAMES.test(text)) hits.push({ file, line, text: text.trim() });
      }
    }
  }

  it('scanned the server packages, and the deleted env chain is gone', () => {
    expect(hits.length).toBeGreaterThan(0); // the allowed isolation lines, at least
    expect(readFileSync(join(REPO, 'packages/server/src/tracking/github.ts'), 'utf8')).not.toMatch(/resolveGithubToken/);
  });

  it('every mention is an allowed isolation line, never a read', () => {
    const offending = hits.filter(({ file, text }) => {
      const allowed = ALLOWED[file];
      return !allowed || !allowed.lines.some((re) => re.test(text));
    });
    expect(offending).toEqual([]);
  });

  it('each allowance still matches something, so the list cannot rot', () => {
    for (const [file, { lines }] of Object.entries(ALLOWED)) {
      for (const re of lines) {
        expect(hits.some((hit) => hit.file === file && re.test(hit.text)), `${file} ${String(re)}`).toBe(true);
      }
    }
  });

  it('NEGATIVE CONTROL: the scan catches the deleted chain and a dynamic read', () => {
    const deleted = 'return env.TM8_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();';
    const dynamic = "const keys = { github: ['GH_TOKEN', 'GITHUB_TOKEN'] };";
    for (const text of [deleted, dynamic]) {
      expect(codeLines(text).some((l) => NAMES.test(l.text))).toBe(true);
    }
    expect(codeLines('// GH_TOKEN in a comment\n/* GITHUB_TOKEN */').some((l) => NAMES.test(l.text))).toBe(false);
  });
});

// ─── behaviour ─────────────────────────────────────────────────────────────

const SPACE_OWNED = '11111111-1111-7111-8111-111111111111';
const SPACE_NONE = '22222222-2222-7222-8222-222222222222';
const NODE_TOKEN = 'ghp_node_env_token_must_never_be_sent';
const SPACE_TOKEN = 'ghp_space_owned_token';

function stubNodeEnv(): void {
  vi.stubEnv('TM8_GITHUB_TOKEN', NODE_TOKEN);
  vi.stubEnv('GITHUB_TOKEN', NODE_TOKEN);
  vi.stubEnv('GH_TOKEN', NODE_TOKEN);
}

/** Global fetch, recorded: the pollers build their clients on it. */
function recordFetch(): { url: string; authorization: string | null }[] {
  const seen: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), authorization: headers.get('authorization') });
    return new Response(JSON.stringify({ title: 't', state: 'open', head: { sha: 'a'.repeat(40), ref: 'h' }, base: { ref: 'main' } }), {
      status: 200,
      headers: { etag: '"e"' },
    });
  }) as typeof fetch);
  return seen;
}

function observerDb(): Db {
  const target = (n: number) => ({ entityId: `3333333${n}-3333-7333-8333-333333333333`, kind: 'pull_request', provider: 'github', repo: 'o/r', number: n, sha: null });
  return {
    rpc: async (_c: DbClaims, fn: string) => {
      if (fn === 'public.claim_tracking_refresh') {
        return {
          claimed: [
            { requestId: 'r1', spaceId: SPACE_OWNED, attempts: 0, targets: [target(1)] },
            { requestId: 'r2', spaceId: SPACE_NONE, attempts: 0, targets: [target(2)] },
          ],
        };
      }
      return {};
    },
  } as unknown as Db;
}

const reader = {
  readPollToken: vi.fn(async (_claims: DbClaims, spaceId: string) =>
    spaceId === SPACE_OWNED
      ? { ok: true as const, token: SPACE_TOKEN, credentialId: 'cred-space', label: 'Space GitHub' }
      : { ok: false as const, reason: 'the space has no space-owned GitHub credential' }),
};

describe('gate 6 — behaviour: a GitHub token in the server env is never sent', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    reader.readPollToken.mockClear();
  });

  it('the observer with no reader calls GitHub anonymously, whatever the env holds', async () => {
    stubNodeEnv();
    const seen = recordFetch();
    const outcome = await runTrackingObserverTick({ db: observerDb(), claims: async () => ({ identityId: 'i' }) });
    expect(seen.length).toBe(2);
    expect(seen.every((call) => call.authorization === null)).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(NODE_TOKEN);
  });

  it("the observer sends each space's own token, and reads anonymously where there is none", async () => {
    stubNodeEnv();
    const seen = recordFetch();
    const outcome = await runTrackingObserverTick({
      db: observerDb(),
      claims: async () => ({ identityId: 'i' }),
      githubCredentials: reader,
    });
    expect(seen.map((call) => call.authorization)).toEqual([`Bearer ${SPACE_TOKEN}`, null]);
    expect(reader.readPollToken.mock.calls.map((call) => call[1])).toEqual([SPACE_OWNED, SPACE_NONE]);
    const detail = (outcome as { detail: { github: Record<string, string> } }).detail;
    expect(detail.github[SPACE_OWNED]).toBe('space credential cred-space (Space GitHub)');
    expect(detail.github[SPACE_NONE]).toMatch(/^anonymous: the space has no space-owned GitHub credential/);
    expect(JSON.stringify(outcome)).not.toContain(SPACE_TOKEN);
  });

  it('the watcher reads one credential per space per tick, never the env', async () => {
    stubNodeEnv();
    const seen = recordFetch();
    const pr = (n: number, spaceId: string) => ({ prEntityId: `4444444${n}-4444-7444-8444-444444444444`, spaceId, provider: 'github', repo: 'o/r', number: n, state: 'open' });
    const db = {
      rpc: async (_c: DbClaims, fn: string) => {
        if (fn === 'public.observer_watch_targets') {
          return { targets: [pr(1, SPACE_OWNED), pr(2, SPACE_OWNED), pr(3, SPACE_NONE)] };
        }
        if (fn === 'public.claim_pending_nudges') return { pending: [] };
        return {};
      },
    } as unknown as Db;
    await runForgeWatchTick({ db, claims: async () => ({ identityId: 'i' }), githubCredentials: reader });
    expect(reader.readPollToken).toHaveBeenCalledTimes(2);
    const byPr = (n: number) => seen.filter((call) => call.url.includes(`/pulls/${String(n)}`)).map((call) => call.authorization);
    expect(byPr(1).every((a) => a === `Bearer ${SPACE_TOKEN}`)).toBe(true);
    expect(byPr(3).every((a) => a === null)).toBe(true);
    expect(seen.some((call) => call.authorization?.includes(NODE_TOKEN))).toBe(false);
  });
});
