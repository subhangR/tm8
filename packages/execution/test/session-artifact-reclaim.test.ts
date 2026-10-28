// The session artifact reclaim beyond the Codex home (session-artifact-reclaim.ts).
//
// Pins the two sibling leaks the Codex home reclaim now also sweeps, and the
// rules that differ from it because their readers differ:
//
//   - THE SPACE-KEY HOME (`credentials/sessions/<id>/`) goes on a deleted row
//     or an id that is no entity at all, and, opted in, past the retention.
//     A worktree that is gone keeps it (the transcript door still reads it),
//     and so does a CHAT's home, which lives at the same path under its id.
//   - THE MANIFEST FILE (`manifests/<id>.json`) goes whenever its session is
//     not running: no row, deleted, or ended. Resume writes a fresh one.
//
// A live session is never touched, and liveness flipping mid-run keeps
// everything. The Codex home rules are pinned in codex-home-reclaim.test.ts.

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { materializeSpaceApiKeyHome, scrubSpaceSessionSecrets, spaceSessionHomeDir } from '../src/spawn/space-credential-session-home.js';
import {
  manifestReclaimReason,
  reclaimSessionArtifacts,
  spaceHomeReclaimReason,
  type SessionHomeFacts,
  type SessionHomeOwnerFacts,
} from '../src/spawn/session-artifact-reclaim.js';

const LIVE = '11111111-1111-4111-8111-111111111111';
const RESUMABLE = '22222222-2222-4222-8222-222222222222';
const DELETED = '33333333-3333-4333-8333-333333333333';
const ORPHAN = '44444444-4444-4444-8444-444444444444';
const WORKTREE_GONE = '55555555-5555-4555-8555-555555555555';
const OLD_ENDED = '77777777-7777-4777-8777-777777777777';
const LIVE_DELETED = '88888888-8888-4888-8888-888888888888';
const CHAT = '99999999-9999-4999-8999-999999999999';
const DELETED_CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const KEEP = { codexHomeMs: null, spaceHomeMs: null };

describe('session artifacts beyond the Codex home', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-session-artifacts-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A space-key home as a finished run leaves it: secret scrubbed, transcript kept. */
  async function seedSpaceHome(id: string): Promise<void> {
    const home = await materializeSpaceApiKeyHome({
      dataDir, sessionId: id, provider: 'anthropic', credentialId: 'cred-1', apiKey: 'sk-ant-fixture-0123456789abcdefghij',
    });
    await mkdir(join(home.configDir, 'projects', '-tmp-x'), { recursive: true });
    await writeFile(join(home.configDir, 'projects', '-tmp-x', 'transcript.jsonl'), '{"turn":1}\n', 'utf8');
    await scrubSpaceSessionSecrets(dataDir, id);
  }

  async function seedManifest(id: string, stale = false): Promise<void> {
    await mkdir(join(dataDir, 'manifests'), { recursive: true });
    await writeFile(join(dataDir, 'manifests', `${id}.json`), '{"sessionId":"x"}\n', 'utf8');
    if (stale) await writeFile(join(dataDir, 'manifests', `${id}.json.tmp`), '{"sess', 'utf8');
  }

  const exists = (path: string) => stat(path).then(() => true, () => false);
  const spaceHome = (id: string) => exists(spaceSessionHomeDir(dataDir, id));
  const manifest = (id: string) => exists(join(dataDir, 'manifests', `${id}.json`));

  const row = (sessionId: string, over: Partial<SessionHomeFacts> = {}): SessionHomeFacts => ({
    sessionId,
    status: 'exited',
    deleted: false,
    workdirMode: 'project',
    workdirPath: null,
    exitedAt: NOW - DAY,
    ...over,
  });

  function graph(rows: SessionHomeFacts[], owners: SessionHomeOwnerFacts[] = []) {
    const factsCalls: string[][] = [];
    const ownerCalls: string[][] = [];
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    const ownersById = new Map(owners.map((o) => [o.id, o]));
    return {
      factsCalls,
      ownerCalls,
      facts: async (ids: string[]) => {
        factsCalls.push(ids);
        return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      },
      owners: async (ids: string[]) => {
        ownerCalls.push(ids);
        return ids.flatMap((id) => (ownersById.has(id) ? [ownersById.get(id)!] : []));
      },
    };
  }

  describe('the rules', () => {
    it('a manifest goes whenever no agent can be running, and never on a live or unknown status', () => {
      expect(manifestReclaimReason(undefined)).toBe('no_session');
      expect(manifestReclaimReason(row(RESUMABLE))).toBe('ended');
      expect(manifestReclaimReason(row(RESUMABLE, { status: 'failed' }))).toBe('ended');
      expect(manifestReclaimReason(row(RESUMABLE, { deleted: true }))).toBe('deleted');
      for (const status of ['spawning', 'running', 'idle']) {
        expect(manifestReclaimReason(row(RESUMABLE, { status, deleted: true }))).toBeNull();
      }
      expect(manifestReclaimReason(row(RESUMABLE, { status: 'something-new' }))).toBeNull();
    });

    it('a space-key home goes on a deleted row or no entity, and keeps a resumable, worktree-gone or chat home', () => {
      const keep = { now: NOW, retentionMs: null };
      expect(spaceHomeReclaimReason(undefined, undefined, keep)).toBe('no_session');
      expect(spaceHomeReclaimReason(row(DELETED, { deleted: true }), undefined, keep)).toBe('deleted');
      expect(spaceHomeReclaimReason(row(RESUMABLE), undefined, keep)).toBeNull();
      // The transcript door still reads it for a session that is still listed.
      expect(spaceHomeReclaimReason(row(WORKTREE_GONE, { workdirMode: 'worktree', workdirPath: '/gone' }), undefined, keep))
        .toBeNull();
      expect(spaceHomeReclaimReason(undefined, { id: CHAT, kind: 'chat', deleted: false }, keep)).toBeNull();
      expect(spaceHomeReclaimReason(undefined, { id: DELETED_CHAT, kind: 'chat', deleted: true }, keep)).toBeNull();
      // The owner could not be asked: keep.
      expect(spaceHomeReclaimReason(undefined, null, keep)).toBeNull();
      for (const status of ['spawning', 'running', 'idle']) {
        expect(spaceHomeReclaimReason(row(LIVE, { status, deleted: true }), undefined, keep)).toBeNull();
      }
    });

    it('a retention window removes an ended session\'s space-key home past it, never one with no ending', () => {
      const week = { now: NOW, retentionMs: 7 * DAY };
      expect(spaceHomeReclaimReason(row(OLD_ENDED, { exitedAt: NOW - 8 * DAY }), undefined, week)).toBe('retention');
      expect(spaceHomeReclaimReason(row(OLD_ENDED, { exitedAt: NOW - 6 * DAY }), undefined, week)).toBeNull();
      expect(spaceHomeReclaimReason(row(OLD_ENDED, { exitedAt: null }), undefined, week)).toBeNull();
      expect(spaceHomeReclaimReason(row(LIVE, { status: 'running', exitedAt: NOW - 30 * DAY }), undefined, week)).toBeNull();
    });
  });

  describe('the reclaim', () => {
    const rows = (): SessionHomeFacts[] => [
      row(LIVE, { status: 'running', exitedAt: null }),
      row(RESUMABLE),
      row(DELETED, { deleted: true }),
      row(WORKTREE_GONE, { status: 'failed', workdirMode: 'worktree', workdirPath: '/nowhere/reclaimed' }),
      row(OLD_ENDED, { exitedAt: NOW - 40 * DAY }),
      row(LIVE_DELETED, { status: 'idle', deleted: true, exitedAt: null }),
    ];
    const chats: SessionHomeOwnerFacts[] = [
      { id: CHAT, kind: 'chat', deleted: false },
      { id: DELETED_CHAT, kind: 'chat', deleted: true },
    ];

    async function seedAll(): Promise<void> {
      for (const id of [LIVE, RESUMABLE, DELETED, ORPHAN, WORKTREE_GONE, OLD_ENDED, LIVE_DELETED]) {
        await seedSpaceHome(id);
        await seedManifest(id);
      }
      await seedSpaceHome(CHAT);
      await seedSpaceHome(DELETED_CHAT);
    }

    it('keeps live, resumable, worktree-gone and chat homes; removes deleted and orphaned ones; drops every ended manifest', async () => {
      await seedAll();
      const g = graph(rows(), chats);
      const report = await reclaimSessionArtifacts({
        dataDir, isLive: (id) => id === LIVE, facts: g.facts, owners: g.owners, retention: KEEP, now: NOW,
      });

      expect(report.errors).toEqual([]);
      const got = (artifact: string) => new Map(
        report.reclaimed.filter((r) => r.artifact === artifact).map((r) => [r.sessionId, r.reason]),
      );
      expect(got('space_home')).toEqual(new Map([[DELETED, 'deleted'], [ORPHAN, 'no_session']]));
      expect(got('manifest')).toEqual(new Map([
        [RESUMABLE, 'ended'], [DELETED, 'deleted'], [ORPHAN, 'no_session'], [WORKTREE_GONE, 'ended'], [OLD_ENDED, 'ended'],
      ]));
      for (const id of [DELETED, ORPHAN]) expect(await spaceHome(id)).toBe(false);
      for (const id of [LIVE, RESUMABLE, WORKTREE_GONE, OLD_ENDED, LIVE_DELETED, CHAT, DELETED_CHAT]) {
        expect(await spaceHome(id)).toBe(true);
      }
      for (const id of [RESUMABLE, DELETED, ORPHAN, WORKTREE_GONE, OLD_ENDED]) expect(await manifest(id)).toBe(false);
      for (const id of [LIVE, LIVE_DELETED]) expect(await manifest(id)).toBe(true);
      // The live one is not even asked about; the owner door is asked only
      // about space-key homes with no work-session row.
      expect(g.factsCalls.flat()).not.toContain(LIVE);
      expect(g.ownerCalls.flat().sort()).toEqual([ORPHAN, CHAT, DELETED_CHAT].sort());
    });

    it('without an owner door, a space-key home with no work-session row is kept, never guessed an orphan', async () => {
      await seedAll();
      const g = graph(rows(), chats);
      const report = await reclaimSessionArtifacts({
        dataDir, isLive: () => false, facts: g.facts, retention: KEEP, now: NOW,
      });
      expect(report.reclaimed.filter((r) => r.artifact === 'space_home').map((r) => r.sessionId)).toEqual([DELETED]);
      for (const id of [ORPHAN, CHAT, DELETED_CHAT]) expect(await spaceHome(id)).toBe(true);
      // The manifest of a session with no row still goes: no agent can be reading it.
      expect(await manifest(ORPHAN)).toBe(false);
    });

    it('with a retention window, an ended session past it loses its space-key home too', async () => {
      await seedAll();
      const g = graph(rows(), chats);
      const report = await reclaimSessionArtifacts({
        dataDir, isLive: () => false, facts: g.facts, owners: g.owners,
        retention: { codexHomeMs: null, spaceHomeMs: 30 * DAY }, now: NOW,
      });
      expect(report.reclaimed.find((r) => r.artifact === 'space_home' && r.sessionId === OLD_ENDED)?.reason)
        .toBe('retention');
      expect(await spaceHome(OLD_ENDED)).toBe(false);
      for (const id of [LIVE, RESUMABLE, WORKTREE_GONE, LIVE_DELETED, CHAT]) expect(await spaceHome(id)).toBe(true);
    });

    it('the Codex-only retention does not reach space-key homes', async () => {
      await seedAll();
      const g = graph(rows(), chats);
      await reclaimSessionArtifacts({
        dataDir, isLive: () => false, facts: g.facts, owners: g.owners,
        retention: { codexHomeMs: 30 * DAY, spaceHomeMs: null }, now: NOW,
      });
      expect(await spaceHome(OLD_ENDED)).toBe(true);
    });

    it('a session that turns live between the read and the removal keeps every artifact', async () => {
      await seedAll();
      const g = graph(rows(), chats);
      let resumed = false;
      const report = await reclaimSessionArtifacts({
        dataDir,
        // DELETED and RESUMABLE look dead when the batch is listed, then a resume claims them.
        isLive: (id) => resumed && (id === DELETED || id === RESUMABLE),
        facts: async (ids) => {
          resumed = true;
          return g.facts(ids);
        },
        owners: g.owners,
        retention: KEEP,
        now: NOW,
      });
      expect(report.reclaimed.map((r) => r.sessionId)).not.toContain(DELETED);
      expect(report.reclaimed.map((r) => r.sessionId)).not.toContain(RESUMABLE);
      expect(await spaceHome(DELETED)).toBe(true);
      expect(await manifest(DELETED)).toBe(true);
      expect(await manifest(RESUMABLE)).toBe(true);
    });

    it('takes a crashed write\'s stale .json.tmp with the manifest, and leaves non-session files alone', async () => {
      await seedManifest(ORPHAN, true);
      await mkdir(join(dataDir, 'manifests', 'mcp-homes'), { recursive: true });
      await writeFile(join(dataDir, 'manifests', 'README'), 'not a session', 'utf8');
      const g = graph([]);
      await reclaimSessionArtifacts({ dataDir, isLive: () => false, facts: g.facts, retention: KEEP, now: NOW });
      expect((await readdir(join(dataDir, 'manifests'))).sort()).toEqual(['README', 'mcp-homes']);
    });

    it('a failed read throws before anything is removed', async () => {
      await seedAll();
      await expect(reclaimSessionArtifacts({
        dataDir, isLive: () => false, retention: KEEP, now: NOW,
        facts: async () => { throw new Error('node admin required'); },
      })).rejects.toThrow('node admin required');
      expect(await manifest(ORPHAN)).toBe(true);
      expect(await spaceHome(ORPHAN)).toBe(true);

      const g = graph(rows());
      await expect(reclaimSessionArtifacts({
        dataDir, isLive: () => false, retention: KEEP, now: NOW, facts: g.facts,
        owners: async () => { throw new Error('function public.session_home_owner_facts does not exist'); },
      })).rejects.toThrow('session_home_owner_facts');
      expect(await manifest(ORPHAN)).toBe(true);
      expect(await spaceHome(ORPHAN)).toBe(true);
    });

    it('stops at the per-call cap and the next tick finishes', async () => {
      await seedAll();
      const g = graph(rows(), chats);
      const first = await reclaimSessionArtifacts({
        dataDir, isLive: () => false, facts: g.facts, owners: g.owners, retention: KEEP, now: NOW, maxReclaims: 2, batchSize: 3,
      });
      expect(first.reclaimed).toHaveLength(2);
      const rest = await reclaimSessionArtifacts({
        dataDir, isLive: () => false, facts: g.facts, owners: g.owners, retention: KEEP, now: NOW,
      });
      // 2 space-key homes + 5 manifests in all.
      expect(first.reclaimed.length + rest.reclaimed.length).toBe(7);
    });

    it('is a no-op on a node with nothing on disk', async () => {
      expect(await reclaimSessionArtifacts({
        dataDir, isLive: () => false, facts: async () => [], retention: KEEP,
      })).toEqual({ examined: 0, reclaimed: [], errors: [] });
    });
  });
});
