// The per-session Codex home after its process (mcp-home.ts).
//
// Pins the two steps a home is cleaned in:
//
//   - the scrub (PTY exit, kill, failed launch, boot sweep) removes the login
//     copy and the rebuildable caches and keeps the conversation, and a later
//     `isolateCodexMcpHome` (resume) copies the login back over it;
//   - the reclaim removes a whole home only when its session cannot be
//     resumed: no row, a deleted row, or a worktree that is gone. With the
//     operator's retention set, a session that ended long enough ago goes too.
//     A live session and a resumable one are always kept.
//
// The PTY-exit, stop and resume wiring through SpawnService is pinned in
// space-credential-spawn.test.ts.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  codexHomeReclaimReason,
  codexMcpSessionDir,
  isolateCodexMcpHome,
  reclaimCodexMcpHomes,
  scrubCodexMcpHome,
  sweepCodexMcpHomeSecrets,
  type CodexHomeSessionFacts,
} from '../src/spawn/mcp-home.js';

const LIVE = '11111111-1111-4111-8111-111111111111';
const RESUMABLE = '22222222-2222-4222-8222-222222222222';
const DELETED = '33333333-3333-4333-8333-333333333333';
const ORPHAN = '44444444-4444-4444-8444-444444444444';
const WORKTREE_GONE = '55555555-5555-4555-8555-555555555555';
const WORKTREE_KEPT = '66666666-6666-4666-8666-666666666666';
const OLD_ENDED = '77777777-7777-4777-8777-777777777777';
const LIVE_DELETED = '88888888-8888-4888-8888-888888888888';

const LOGIN = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"fixture-refresh"}}';
const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 24 * 60 * 60_000;

describe('Codex session homes after the process', () => {
  let dataDir: string;
  let source: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-codex-home-'));
    source = join(dataDir, 'operator-codex');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'auth.json'), LOGIN, 'utf8');
    await writeFile(join(source, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A home as a finished Codex run leaves it: login copy, caches, logs and a conversation. */
  async function seedHome(sessionId: string): Promise<string> {
    const env: Record<string, string> = { CODEX_HOME: source };
    await isolateCodexMcpHome(join(dataDir, 'manifests', `${sessionId}.json`), env);
    const home = env.CODEX_HOME!;
    await mkdir(join(home, 'sessions', '2026', '10', '19'), { recursive: true });
    await writeFile(join(home, 'sessions', '2026', '10', '19', 'rollout.jsonl'), '{"turn":1}\n', 'utf8');
    await writeFile(join(home, 'state_5.sqlite'), 'state', 'utf8');
    await writeFile(join(home, 'state_5.sqlite-wal'), 'state-wal', 'utf8');
    await writeFile(join(home, 'logs_2.sqlite'), 'log', 'utf8');
    await writeFile(join(home, 'logs_2.sqlite-wal'), 'log-wal', 'utf8');
    await writeFile(join(home, 'models_cache.json'), '{}', 'utf8');
    await mkdir(join(home, 'cache', 'codex_apps_tools'), { recursive: true });
    await writeFile(join(home, 'cache', 'codex_apps_tools', 'x.json'), '{}', 'utf8');
    await mkdir(join(home, 'plugins', 'cache', 'curated'), { recursive: true });
    await mkdir(join(home, '.tmp', 'marketplaces', 'curated'), { recursive: true });
    await writeFile(join(home, '.tmp', 'rollout-maintenance.lock'), '', 'utf8');
    await mkdir(join(home, 'chatgpt-meetings', 'versions', 'darwin-arm64-abc'), { recursive: true });
    await writeFile(join(home, 'chatgpt-meetings', 'active'), '{}', 'utf8');
    await mkdir(join(home, 'tmp', 'arg0'), { recursive: true });
    return home;
  }

  async function gone(path: string): Promise<void> {
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }

  describe('the scrub', () => {
    it('removes the login copy, caches and log database, and keeps the conversation and state', async () => {
      const home = await seedHome(RESUMABLE);
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(LOGIN);

      expect(await scrubCodexMcpHome(dataDir, RESUMABLE)).toBe(true);

      await gone(join(home, 'auth.json'));
      await gone(join(home, 'logs_2.sqlite'));
      await gone(join(home, 'logs_2.sqlite-wal'));
      await gone(join(home, 'models_cache.json'));
      await gone(join(home, 'cache'));
      await gone(join(home, 'plugins', 'cache'));
      await gone(join(home, '.tmp', 'marketplaces'));
      await gone(join(home, 'chatgpt-meetings', 'versions'));
      expect(await readFile(join(home, 'chatgpt-meetings', 'active'), 'utf8')).toBe('{}');
      await gone(join(home, 'tmp'));
      expect((await stat(join(home, '.tmp', 'rollout-maintenance.lock'))).isFile()).toBe(true);
      expect(await readFile(join(home, 'sessions', '2026', '10', '19', 'rollout.jsonl'), 'utf8')).toBe('{"turn":1}\n');
      expect(await readFile(join(home, 'state_5.sqlite'), 'utf8')).toBe('state');
      expect(await readFile(join(home, 'state_5.sqlite-wal'), 'utf8')).toBe('state-wal');
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('gpt-5.5');
      // The operator's own login is never touched.
      expect(await readFile(join(source, 'auth.json'), 'utf8')).toBe(LOGIN);
    });

    it('is idempotent and a no-op for a session that never ran Codex', async () => {
      await seedHome(RESUMABLE);
      expect(await scrubCodexMcpHome(dataDir, RESUMABLE)).toBe(true);
      expect(await scrubCodexMcpHome(dataDir, RESUMABLE)).toBe(false);
      expect(await scrubCodexMcpHome(dataDir, ORPHAN)).toBe(false);
      expect(await scrubCodexMcpHome(dataDir, 'not-a-session')).toBe(false);
    });

    it('a resume after the scrub copies the login back and keeps the conversation', async () => {
      const home = await seedHome(RESUMABLE);
      await scrubCodexMcpHome(dataDir, RESUMABLE);

      const env: Record<string, string> = { CODEX_HOME: source };
      await isolateCodexMcpHome(join(dataDir, 'manifests', `${RESUMABLE}.json`), env);

      expect(env.CODEX_HOME).toBe(home);
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(LOGIN);
      expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(home, 'sessions', '2026', '10', '19', 'rollout.jsonl'), 'utf8')).toBe('{"turn":1}\n');
    });

    it('the boot sweep scrubs every home except a live one', async () => {
      const dead = await seedHome(RESUMABLE);
      const live = await seedHome(LIVE);

      expect(await sweepCodexMcpHomeSecrets(dataDir, (id) => id === LIVE)).toEqual({ scrubbed: [RESUMABLE], errors: [] });

      await gone(join(dead, 'auth.json'));
      expect(await readFile(join(live, 'auth.json'), 'utf8')).toBe(LOGIN);
      expect(await readFile(join(live, 'logs_2.sqlite'), 'utf8')).toBe('log');
      expect(await sweepCodexMcpHomeSecrets(dataDir, (id) => id === LIVE)).toEqual({ scrubbed: [], errors: [] });
    });

    it('the boot sweep is a no-op on a node that never ran Codex', async () => {
      expect(await sweepCodexMcpHomeSecrets(dataDir, () => false)).toEqual({ scrubbed: [], errors: [] });
    });
  });

  describe('which sessions can still use their home', () => {
    const ended = (over: Partial<CodexHomeSessionFacts> = {}): CodexHomeSessionFacts => ({
      sessionId: RESUMABLE,
      status: 'exited',
      deleted: false,
      workdirMode: 'project',
      workdirPath: null,
      exitedAt: NOW - DAY,
      ...over,
    });
    const keepForever = { now: NOW, retentionMs: null, worktreeExists: true };

    it('reclaims only when resume would refuse, unless a retention window is set', () => {
      expect(codexHomeReclaimReason(undefined, keepForever)).toBe('no_session');
      expect(codexHomeReclaimReason(ended({ deleted: true }), keepForever)).toBe('deleted');
      expect(codexHomeReclaimReason(ended({ workdirMode: 'worktree' }), { ...keepForever, worktreeExists: false }))
        .toBe('worktree_gone');
      expect(codexHomeReclaimReason(ended(), keepForever)).toBeNull();
      expect(codexHomeReclaimReason(ended({ status: 'failed' }), keepForever)).toBeNull();
      expect(codexHomeReclaimReason(ended({ exitedAt: NOW - 400 * DAY }), keepForever)).toBeNull();
    });

    it('never reclaims a live status, even on a deleted row, and keeps an unknown status', () => {
      for (const status of ['spawning', 'running', 'idle']) {
        expect(codexHomeReclaimReason(ended({ status, deleted: true }), keepForever)).toBeNull();
        expect(codexHomeReclaimReason(ended({ status, exitedAt: NOW - 400 * DAY }), { ...keepForever, retentionMs: DAY }))
          .toBeNull();
      }
      expect(codexHomeReclaimReason(ended({ status: 'something-new' }), keepForever)).toBeNull();
    });

    it('a retention window reclaims ended sessions older than it, and never one with no recorded ending', () => {
      const week = { ...keepForever, retentionMs: 7 * DAY };
      expect(codexHomeReclaimReason(ended({ exitedAt: NOW - 8 * DAY }), week)).toBe('retention');
      expect(codexHomeReclaimReason(ended({ exitedAt: NOW - 6 * DAY }), week)).toBeNull();
      expect(codexHomeReclaimReason(ended({ exitedAt: null }), week)).toBeNull();
    });
  });

  describe('the reclaim', () => {
    async function seedAll(): Promise<Map<string, CodexHomeSessionFacts>> {
      const existing = join(dataDir, 'worktrees', 'still-here');
      await mkdir(existing, { recursive: true });
      const facts: CodexHomeSessionFacts[] = [
        { sessionId: LIVE, status: 'running', deleted: false, workdirMode: 'project', workdirPath: null, exitedAt: null },
        { sessionId: RESUMABLE, status: 'exited', deleted: false, workdirMode: 'project', workdirPath: null, exitedAt: NOW - DAY },
        { sessionId: DELETED, status: 'exited', deleted: true, workdirMode: 'project', workdirPath: null, exitedAt: NOW - DAY },
        { sessionId: WORKTREE_GONE, status: 'failed', deleted: false, workdirMode: 'worktree', workdirPath: join(dataDir, 'worktrees', 'reclaimed'), exitedAt: NOW - DAY },
        { sessionId: WORKTREE_KEPT, status: 'exited', deleted: false, workdirMode: 'worktree', workdirPath: existing, exitedAt: NOW - DAY },
        { sessionId: OLD_ENDED, status: 'exited', deleted: false, workdirMode: 'project', workdirPath: null, exitedAt: NOW - 40 * DAY },
        { sessionId: LIVE_DELETED, status: 'idle', deleted: true, workdirMode: 'project', workdirPath: null, exitedAt: null },
      ];
      for (const id of [...facts.map((f) => f.sessionId), ORPHAN]) await seedHome(id);
      return new Map(facts.map((f) => [f.sessionId, f]));
    }

    function factsFrom(rows: Map<string, CodexHomeSessionFacts>, calls?: string[][]) {
      return async (ids: string[]) => {
        calls?.push(ids);
        return ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []));
      };
    }

    async function exists(sessionId: string): Promise<boolean> {
      return stat(codexMcpSessionDir(dataDir, sessionId)).then(() => true, () => false);
    }

    it('keeps live and resumable homes, and removes orphaned, deleted and worktree-gone ones', async () => {
      const rows = await seedAll();
      // LIVE is also live on this node; the rest are judged by the graph alone.
      const report = await reclaimCodexMcpHomes({
        dataDir,
        isLive: (id) => id === LIVE,
        facts: factsFrom(rows),
        retentionMs: null,
        now: NOW,
      });

      expect(report.errors).toEqual([]);
      expect(new Map(report.reclaimed.map((r) => [r.sessionId, r.reason]))).toEqual(new Map([
        [ORPHAN, 'no_session'],
        [DELETED, 'deleted'],
        [WORKTREE_GONE, 'worktree_gone'],
      ]));
      for (const id of [ORPHAN, DELETED, WORKTREE_GONE]) expect(await exists(id)).toBe(false);
      for (const id of [LIVE, RESUMABLE, WORKTREE_KEPT, OLD_ENDED, LIVE_DELETED]) expect(await exists(id)).toBe(true);
      // The live one is not even asked about.
      expect(report.examined).toBe(7);
    });

    it('with a retention window, also removes a session that ended longer ago than it', async () => {
      const rows = await seedAll();
      const report = await reclaimCodexMcpHomes({
        dataDir,
        isLive: () => false,
        facts: factsFrom(rows),
        retentionMs: 30 * DAY,
        now: NOW,
      });

      expect(report.reclaimed.find((r) => r.sessionId === OLD_ENDED)?.reason).toBe('retention');
      expect(await exists(OLD_ENDED)).toBe(false);
      for (const id of [LIVE, RESUMABLE, WORKTREE_KEPT, LIVE_DELETED]) expect(await exists(id)).toBe(true);
    });

    it('a session that turns live between the read and the removal keeps its home', async () => {
      const rows = await seedAll();
      let resumed = false;
      const report = await reclaimCodexMcpHomes({
        dataDir,
        // ORPHAN looks dead when the batch is listed, then a resume claims it.
        isLive: (id) => id === ORPHAN && resumed,
        facts: async (ids) => {
          resumed = true;
          return factsFrom(rows)(ids);
        },
        retentionMs: null,
        now: NOW,
      });

      expect(report.reclaimed.map((r) => r.sessionId)).not.toContain(ORPHAN);
      expect(await exists(ORPHAN)).toBe(true);
    });

    it('asks the graph in bounded batches and stops at the per-call cap', async () => {
      const rows = await seedAll();
      const calls: string[][] = [];
      const first = await reclaimCodexMcpHomes({
        dataDir,
        isLive: () => false,
        facts: factsFrom(rows, calls),
        retentionMs: null,
        now: NOW,
        batchSize: 3,
        maxReclaims: 1,
      });

      expect(first.reclaimed).toHaveLength(1);
      expect(calls.every((batch) => batch.length <= 3)).toBe(true);
      // The next tick picks up where the cap stopped it.
      const rest = await reclaimCodexMcpHomes({
        dataDir,
        isLive: () => false,
        facts: factsFrom(rows),
        retentionMs: null,
        now: NOW,
      });
      expect(first.reclaimed.length + rest.reclaimed.length).toBe(3);
    });

    it('a failed graph read throws before anything is removed', async () => {
      await seedAll();
      await expect(reclaimCodexMcpHomes({
        dataDir,
        isLive: () => false,
        facts: async () => { throw new Error('node admin required'); },
        retentionMs: null,
        now: NOW,
      })).rejects.toThrow('node admin required');
      expect(await exists(ORPHAN)).toBe(true);
    });

    it('is a no-op on a node that never ran Codex', async () => {
      expect(await reclaimCodexMcpHomes({
        dataDir,
        isLive: () => false,
        facts: async () => [],
        retentionMs: null,
      })).toEqual({ examined: 0, reclaimed: [], errors: [] });
    });
  });
});
