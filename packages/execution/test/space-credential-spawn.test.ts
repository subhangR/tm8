// SC-2 — the spawn and resume ORCHESTRATION around a space credential.
//
// `space-credential-resolution.test.ts` pins which credential is chosen. This
// file pins WHEN things happen relative to the PTY, because every containment
// property of the design is an ordering property:
//
//   - the manifest (and so 206's session_space_credentials row) is recorded
//     BEFORE the PTY starts, so a delete from then on finds the session;
//   - the credential is re-checked AFTER the PTY exists (M7), so a delete that
//     landed in between finds no survivor;
//   - a resume authorises the RESUMER (resolution under their claims) BEFORE
//     it re-points the recorded launcher to them (C3), and a refused resumer
//     causes no re-point at all — 206's repoint RPC has no status gate of its
//     own, so this gate is the only one;
//   - the node key is deleted before the space key is set (I4).
//
// The same orderings against the real migration are in
// packages/server/test/db/space-credential-spawn.pg.test.ts.

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import {
  SpawnError,
  type GraphAuth,
  type SessionLaunchPosture,
  type SpaceCredentialPort,
  type SpaceCredentialProvider,
  type SpaceCredentialRead,
  type SpaceCredentialRepoint,
  type WorkSessionResumeInfo,
} from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
/** A teammate owned by member B. */
const TEAMMATE_OF_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const ANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OAI = 'bbbbbbbb-0000-4000-8000-000000000001';
const GH = 'cccccccc-0000-4000-8000-000000000001';
const GH_TOKEN = `ghp_${'G'.repeat(36)}`;
const ANT_KEY = `sk-ant-api03-${'S'.repeat(40)}`;
const OAI_KEY = `sk-proj-${'O'.repeat(40)}`;
const NODE_ANT_KEY = `sk-ant-api03-${'N'.repeat(40)}`;
const NODE_ANT_TOKEN = `sk-ant-oat01-${'T'.repeat(40)}`;
const NODE_OAI_KEY = `sk-proj-${'M'.repeat(40)}`;

/** Member A — the launcher / resumer. An agent carries these same claims. */
const A = { identityId: 'identity-A', actorId: 'actor-A' };
/** Member B — owns the teammate; launched the session A resumes. */
const B = { identityId: 'identity-B', actorId: 'actor-B' };

type Event = string;

/**
 * A port that behaves as 206 does for one space whose members are `members`,
 * logging every call into the shared `events` so ordering is assertable.
 */
class FakeSpacePort implements SpaceCredentialPort {
  active = new Set<string>([ANT, OAI]);
  /** Recorded launcher per session, as session_space_credentials holds it. */
  readonly launcher = new Map<string, string>();
  readonly recorded = new Map<string, Array<{ provider: SpaceCredentialProvider; spaceCredentialId: string }>>();
  /** Flip a credential to inactive when this call count of activeIds is reached. */
  revokeOnActiveIds: string | null = null;
  /** A space GitHub token, when the space holds one; github has no default otherwise. */
  githubToken: { id: string; token: string; login: string } | null = null;

  constructor(
    private readonly events: Event[],
    private readonly members: ReadonlySet<string>,
  ) {}

  private who(auth: GraphAuth): string {
    return (auth as typeof A).identityId;
  }

  async readPolicies(auth: GraphAuth) {
    this.events.push(`readPolicies:${this.who(auth)}`);
    // As DbSpaceCredentialPort maps 206's require_space_member refusal.
    if (!this.members.has(this.who(auth))) {
      throw new SpawnError('you are not a member of this space, so you cannot launch or resume a session on its credentials — ask a space admin to add you', 'forbidden');
    }
    return { space: {}, node: {} };
  }

  async read(auth: GraphAuth, _space: string, provider: SpaceCredentialProvider, id: string | null): Promise<SpaceCredentialRead> {
    this.events.push(`read:${provider}:${this.who(auth)}`);
    if (!this.members.has(this.who(auth))) return { ok: false, reason: id ? 'not_found' : 'no_default' };
    if (provider === 'github' && this.githubToken) {
      if (id !== null && id !== this.githubToken.id) return { ok: false, reason: 'not_found' };
      return {
        ok: true,
        grant: { kind: 'secret', credentialId: this.githubToken.id, provider, shape: 'token', label: 'gh', displayLogin: this.githubToken.login, secret: this.githubToken.token },
      };
    }
    const credentialId = id ?? (provider === 'anthropic' ? ANT : provider === 'openai' ? OAI : null);
    if (!credentialId) return { ok: false, reason: 'no_default' };
    if (!this.active.has(credentialId)) return { ok: false, reason: 'revoked' };
    return {
      ok: true,
      grant: {
        kind: 'secret',
        credentialId,
        provider,
        shape: 'api_key',
        label: provider,
        displayLogin: null,
        secret: provider === 'anthropic' ? ANT_KEY : OAI_KEY,
      },
    };
  }

  async activeIds(auth: GraphAuth, ids: readonly string[]) {
    this.events.push(`activeIds:${this.who(auth)}`);
    if (this.revokeOnActiveIds) this.active.delete(this.revokeOnActiveIds);
    return new Set(ids.filter((id) => this.active.has(id)));
  }

  async repointSession(auth: GraphAuth, sessionId: string): Promise<SpaceCredentialRepoint> {
    this.events.push(`repoint:${this.who(auth)}`);
    const rows = this.recorded.get(sessionId) ?? [];
    if (rows.some((r) => !this.active.has(r.spaceCredentialId))) return { ok: false, reason: 'inactive' };
    this.launcher.set(sessionId, this.who(auth));
    return { ok: true, credentials: rows };
  }
}

describe('SC-2 spawn/resume ordering around a space credential', () => {
  let dataDir: string;
  let binDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;
  let events: Event[];
  let logs: unknown[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-sc2-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-sc2-proj-'));
    binDir = await mkdtemp(join(tmpdir(), 'tm8-sc2-bin-'));
    for (const bin of ['claude', 'codex']) {
      await writeFile(join(binDir, bin), '#!/bin/sh\nexec /bin/true\n', 'utf8');
      await chmod(join(binDir, bin), 0o755);
    }
    graph = new FakeGraph({ workingDir: projectDir });
    pty = new PtyHostService();
    events = [];
    logs = [];
    const record = graph.recordManifest.bind(graph);
    graph.recordManifest = async (...args) => {
      events.push('recordManifest');
      return record(...args);
    };
    const resumeRpc = graph.resumeWorkSession.bind(graph);
    graph.resumeWorkSession = async (...args) => {
      events.push('resumeWorkSession');
      return resumeRpc(...args);
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    pty.shutdownAll();
    for (const dir of [dataDir, projectDir, binDir]) await rm(dir, { recursive: true, force: true });
  });

  function service(port: SpaceCredentialPort): SpawnService {
    const capture = (message: string, fields?: unknown): void => {
      logs.push(message, fields);
    };
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: `${dataDir}/node-home`,
        // The node's own keys are PRESENT: I4 is only meaningful against them.
        ANTHROPIC_API_KEY: NODE_ANT_KEY,
        ANTHROPIC_AUTH_TOKEN: NODE_ANT_TOKEN,
        OPENAI_API_KEY: NODE_OAI_KEY,
      },
      bootSettlementMs: 5,
      logger: { info: capture, warn: capture, error: capture },
      spaceCredentials: port,
      codexNetworkPreflight: async () => {},
    });
  }

  function spyPty() {
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockImplementation(() => {
      events.push('spawnIfAbsent');
      return { reused: false };
    });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    const kill = vi.spyOn(pty, 'kill').mockImplementation(() => {
      events.push('kill');
      return true as never;
    });
    return { spawnIfAbsent, kill };
  }

  it('t2-3 claude-code: the node ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are gone and the space key is set (I4)', async () => {
    const port = new FakeSpacePort(events, new Set(['identity-A']));
    const { spawnIfAbsent } = spyPty();
    const result = await service(port).spawn(A, {
      spaceId: SPACE_ID,
      teamMemberId: TEAMMATE_OF_B,
      credentialSources: { anthropic: 'space' },
    });
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe(ANT_KEY);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(dataDir, 'credentials', 'sessions', result.sessionId, 'anthropic'));
    // I5: the key is in the child env only — not the manifest row, file, result or logs.
    expect(JSON.stringify(graph.manifests)).not.toContain(ANT_KEY);
    expect(await readFile(result.manifestPath, 'utf8')).not.toContain(ANT_KEY);
    expect(JSON.stringify(result)).not.toContain(ANT_KEY);
    expect(JSON.stringify(logs)).not.toContain(ANT_KEY);
  });

  it('t2-3 codex: the node OPENAI_API_KEY is replaced and CODEX_HOME holds a 0600 auth.json in a 0700 per-session dir', async () => {
    const port = new FakeSpacePort(events, new Set(['identity-A']));
    const { spawnIfAbsent } = spyPty();
    const result = await service(port).spawn(A, {
      spaceId: SPACE_ID,
      teamMemberId: TEAMMATE_OF_B,
      model: 'gpt-5.5',
      agentTool: 'codex',
      credentialSources: { openai: 'space' },
    });
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env.OPENAI_API_KEY).toBe(OAI_KEY);
    const home = join(dataDir, 'credentials', 'sessions', result.sessionId, 'openai');
    expect(env.CODEX_HOME).toBe(home);
    // A10: the per-session dir, never the space's login home.
    expect(home).not.toContain(join('credentials', 'spaces'));
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    const authJson = join(home, 'auth.json');
    expect((await stat(authJson)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(authJson, 'utf8'))).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: OAI_KEY });
  });

  it('records the exact credential in the manifest BEFORE the PTY, and re-checks it AFTER', async () => {
    const port = new FakeSpacePort(events, new Set(['identity-A']));
    spyPty();
    await service(port).spawn(A, {
      spaceId: SPACE_ID,
      teamMemberId: TEAMMATE_OF_B,
      credentialSources: { anthropic: 'space' },
    });
    expect(graph.manifests[0]!.manifest.launch.spaceCredentialIds).toEqual({ anthropic: ANT });
    expect(graph.manifests[0]!.manifest.launch.credentialSources?.anthropic).toBe('space');
    const order = events.filter((e) => ['recordManifest', 'spawnIfAbsent', 'activeIds:identity-A'].includes(e));
    expect(order).toEqual(['recordManifest', 'spawnIfAbsent', 'activeIds:identity-A']);
  });

  it('t2-8 (unit): a delete between read and record — the locked writer refuses — starts no PTY', async () => {
    const port = new FakeSpacePort(events, new Set(['identity-A']));
    const { spawnIfAbsent } = spyPty();
    graph.recordManifest = async () => {
      // 206's record_session_manifest re-checks the credential FOR SHARE and raises.
      throw new Error('space credential is not active');
    };
    await expect(
      service(port).spawn(A, { spaceId: SPACE_ID, teamMemberId: TEAMMATE_OF_B, credentialSources: { anthropic: 'space' } }),
    ).rejects.toThrow();
    expect(spawnIfAbsent).not.toHaveBeenCalled();
    expect(graph.transitions.at(-1)?.status).toBe('failed');
  });

  it('t2-8 / M7 (unit): a delete between record and PTY start kills the session and scrubs its key', async () => {
    const port = new FakeSpacePort(events, new Set(['identity-A']));
    port.revokeOnActiveIds = OAI;
    const { kill } = spyPty();
    const error = await service(port)
      .spawn(A, { spaceId: SPACE_ID, teamMemberId: TEAMMATE_OF_B, model: 'gpt-5.5', agentTool: 'codex', credentialSources: { openai: 'space' } })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect((error as SpawnError).message).toContain(`space credential ${OAI} was deleted or disabled while this session was starting`);
    expect(kill).toHaveBeenCalled();
    expect(events.indexOf('kill')).toBeGreaterThan(events.indexOf('spawnIfAbsent'));
    expect(graph.transitions.at(-1)?.status).toBe('failed');
    const sessionId = graph.manifests[0]!.sessionId;
    await expect(stat(join(dataDir, 'credentials', 'sessions', sessionId, 'openai', 'auth.json'))).rejects.toThrow();
    // I5 canary on the failure path: the key is in none of the error, the
    // logs, or anything written to the graph.
    for (const surface of [
      (error as SpawnError).message,
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      JSON.stringify(logs),
      JSON.stringify(graph.transitions),
      JSON.stringify(graph.manifests),
    ]) {
      expect(surface).not.toContain(OAI_KEY);
    }
  });

  it("t2-10: member A launches B's teammate — resolution runs under A's claims, never B's", async () => {
    // Only A is a member: had anything consulted the persona owner (B), the read would miss.
    const port = new FakeSpacePort(events, new Set(['identity-A']));
    spyPty();
    await service(port).spawn(A, { spaceId: SPACE_ID, teamMemberId: TEAMMATE_OF_B, credentialSources: { anthropic: 'space' } });
    expect(events.filter((e) => e.startsWith('read:'))).toEqual(['read:anthropic:identity-A', 'read:github:identity-A']);
    // An agent-spawned child carries its launcher's claims (A) and the parent's exact id.
    const parent = graph.manifests[0]!.sessionId;
    graph.postures.set(parent, {
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: ANT },
    } as SessionLaunchPosture);
    events.length = 0;
    await service(port).spawn(A, { spaceId: SPACE_ID, teamMemberId: TEAMMATE_OF_B, parentSessionId: parent });
    expect(events).toContain('read:anthropic:identity-A');
    expect(graph.manifests[1]!.manifest.launch.spaceCredentialIds).toEqual({ anthropic: ANT });
  });

  describe('resume (C3): authorise the resumer, then re-point, then the PTY', () => {
    const INFO: WorkSessionResumeInfo = {
      sessionId: SESSION_ID,
      spaceId: SPACE_ID,
      teamMemberId: TEAMMATE_OF_B,
      parentSessionId: null,
      projectId: null,
      taskIds: [],
      workdirMode: 'scratch',
      workdirPath: null,
      mode: 'worker',
      model: 'claude-opus-5',
      agentTool: 'claude-code',
      title: 'B launched this',
      status: 'exited',
      nativeSessionId: '55555555-5555-4555-8555-555555555555',
      agentConfigDir: null,
    };

    function launchedByB(port: FakeSpacePort): void {
      graph.resumeInfo = { ...INFO };
      graph.postures.set(SESSION_ID, {
        credentialSources: { anthropic: 'space' },
        spaceCredentialIds: { anthropic: ANT },
      } as SessionLaunchPosture);
      port.recorded.set(SESSION_ID, [{ provider: 'anthropic', spaceCredentialId: ANT }]);
      port.launcher.set(SESSION_ID, 'identity-B');
    }

    it('t2-11: A resumes a session B launched; repoint runs after the gate and before the PTY; launcher becomes A', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A', 'identity-B']));
      launchedByB(port);
      const { spawnIfAbsent } = spyPty();
      await service(port).resume(A, { sessionId: SESSION_ID });

      const gate = events.indexOf('read:anthropic:identity-A');
      const repoint = events.indexOf('repoint:identity-A');
      const ptyStart = events.indexOf('spawnIfAbsent');
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(repoint).toBeGreaterThan(gate);
      expect(ptyStart).toBeGreaterThan(repoint);
      expect(events.indexOf('activeIds:identity-A')).toBeGreaterThan(ptyStart);
      expect(port.launcher.get(SESSION_ID)).toBe('identity-A');
      // D7: the per-session home is re-seeded from the key read NOW.
      const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
      expect(env.ANTHROPIC_API_KEY).toBe(ANT_KEY);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      // Resume does not re-record the manifest row.
      expect(events).not.toContain('recordManifest');
    });

    it('t2-2: a non-member resumer is refused, and NO repoint happens', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-B']));
      launchedByB(port);
      const { spawnIfAbsent } = spyPty();
      const error = await service(port).resume(A, { sessionId: SESSION_ID }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(SpawnError);
      expect((error as SpawnError).code).toBe('forbidden');
      expect((error as SpawnError).message).toContain('you are not a member of this space');
      expect(events).toContain('readPolicies:identity-A');
      expect(events.some((e) => e.startsWith('repoint:'))).toBe(false);
      expect(port.launcher.get(SESSION_ID)).toBe('identity-B');
      expect(spawnIfAbsent).not.toHaveBeenCalled();
    });

    it('a resume on a deleted credential is refused before the re-point and before the PTY', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A', 'identity-B']));
      launchedByB(port);
      port.active.delete(ANT);
      const { spawnIfAbsent } = spyPty();
      await expect(service(port).resume(A, { sessionId: SESSION_ID })).rejects.toThrow(/has been deleted/);
      expect(events.some((e) => e.startsWith('repoint:'))).toBe(false);
      expect(spawnIfAbsent).not.toHaveBeenCalled();
    });

    it('a resume whose recorded rows disagree with the manifest is refused before the PTY', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A', 'identity-B']));
      launchedByB(port);
      port.recorded.set(SESSION_ID, [{ provider: 'anthropic', spaceCredentialId: OAI }]);
      const { spawnIfAbsent } = spyPty();
      await expect(service(port).resume(A, { sessionId: SESSION_ID })).rejects.toThrow(/do not match its manifest/);
      expect(spawnIfAbsent).not.toHaveBeenCalled();
    });

    it('a resume whose posture cannot be read asks the DB, and refuses if it ran on a space credential', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A', 'identity-B']));
      launchedByB(port);
      graph.postureError = new Error('posture read failed');
      const { spawnIfAbsent } = spyPty();
      await expect(service(port).resume(A, { sessionId: SESSION_ID })).rejects.toThrow(
        /recorded launch could not be read and it ran on a space credential/,
      );
      expect(spawnIfAbsent).not.toHaveBeenCalled();
    });

    it('A8: a manifest re-recorded without a space source resumes off the manifest; a leftover ssc row is never read, re-pointed or injected', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A', 'identity-B']));
      launchedByB(port);
      // 206 leaves the session_space_credentials row behind when the manifest
      // is re-recorded without a space source; resume must not depend on it
      // being gone, nor pick it back up.
      graph.postures.set(SESSION_ID, { credentialSources: { anthropic: 'node' }, spaceCredentialIds: {} } as SessionLaunchPosture);
      port.active.delete(ANT);
      const { spawnIfAbsent } = spyPty();
      await service(port).resume(A, { sessionId: SESSION_ID });
      expect(events.some((e) => e.startsWith('repoint:'))).toBe(false);
      expect(events.some((e) => e.startsWith('read:anthropic'))).toBe(false);
      const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
      expect(env.ANTHROPIC_API_KEY).not.toBe(ANT_KEY);
      expect(port.launcher.get(SESSION_ID)).toBe('identity-B');
    });

    it('B (launcher) resuming keeps B; the recorded launcher is always the resumer', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A', 'identity-B']));
      launchedByB(port);
      spyPty();
      await service(port).resume(B, { sessionId: SESSION_ID });
      expect(port.launcher.get(SESSION_ID)).toBe('identity-B');
    });

    it('M4: a session recorded on auto resumes on auto WITHOUT newly picking the space default, even with one available', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A', 'identity-B']));
      graph.resumeInfo = { ...INFO };
      // Launched on auto, landed on the node: nothing space in the manifest.
      graph.postures.set(SESSION_ID, { credentialSources: {}, spaceCredentialIds: {} } as SessionLaunchPosture);
      const { spawnIfAbsent } = spyPty();
      await service(port).resume(A, { sessionId: SESSION_ID });
      // The space default (ANT) is readable by A, yet resume never asks for it:
      // a credential picked now would have no ssc row for containment (D7).
      expect(events.some((e) => e.startsWith('read:'))).toBe(false);
      expect(events.some((e) => e.startsWith('repoint:'))).toBe(false);
      const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
      expect(env.ANTHROPIC_API_KEY).not.toBe(ANT_KEY);
      expect(env.CLAUDE_CONFIG_DIR ?? '').not.toContain(join('credentials', 'sessions'));
    });
  });

  describe('the space key leaves the disk when the PTY exits; the conversation stays', () => {
    it('codex: a PTY exit removes auth.json and keeps the session dir and its rollouts', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A']));
      spyPty();
      const svc = service(port);
      const { sessionId } = await svc.spawn(A, {
        spaceId: SPACE_ID,
        teamMemberId: TEAMMATE_OF_B,
        model: 'gpt-5.5',
        agentTool: 'codex',
        credentialSources: { openai: 'space' },
      });
      const home = join(dataDir, 'credentials', 'sessions', sessionId, 'openai');
      await mkdir(join(home, 'sessions'), { recursive: true });
      const rollout = join(home, 'sessions', 'rollout.jsonl');
      await writeFile(rollout, '{"turn":1}\n', 'utf8');
      // Control: the key is on disk while the session runs.
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain(OAI_KEY);

      await svc.handlePtyExit(sessionId, 'completed', { exitCode: 0, signal: null });

      await expect(stat(join(home, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(home)).isDirectory()).toBe(true);
      expect(await readFile(rollout, 'utf8')).toBe('{"turn":1}\n');
    });

    it('claude-code: a PTY exit (a kill arrives the same way) drops the approved key suffix and keeps the trust entry and transcripts', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A']));
      spyPty();
      const svc = service(port);
      const { sessionId } = await svc.spawn(A, {
        spaceId: SPACE_ID,
        teamMemberId: TEAMMATE_OF_B,
        credentialSources: { anthropic: 'space' },
      });
      const home = join(dataDir, 'credentials', 'sessions', sessionId, 'anthropic');
      const configPath = join(home, '.claude.json');
      const before = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      // Control: seeded for an unattended start (measured against claude 2.1.280).
      expect(before.hasCompletedOnboarding).toBe(true);
      expect(before.customApiKeyResponses).toEqual({ approved: [ANT_KEY.slice(-20)], rejected: [] });
      expect(Object.keys(before.projects as object).length).toBeGreaterThan(0);
      await mkdir(join(home, 'projects', 'p'), { recursive: true });
      const transcript = join(home, 'projects', 'p', 'conversation.jsonl');
      await writeFile(transcript, '{"turn":1}\n', 'utf8');

      await svc.handlePtyExit(sessionId, 'failed', { exitCode: null, signal: 9 });

      const after = await readFile(configPath, 'utf8');
      expect(after).not.toContain(ANT_KEY.slice(-20));
      const parsed = JSON.parse(after) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('customApiKeyResponses');
      expect(parsed.projects).toEqual(before.projects);
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(transcript, 'utf8')).toBe('{"turn":1}\n');
    });
  });

  // A stop kills the PTY with `kill()`, which finalizes the entry so the late
  // onExit never reaches `handlePtyExit` — the exit path that scrubs. The stop
  // path (`killThenRecordEnding`, shared by terminate and credential
  // containment) scrubs instead, before the ending is written.
  describe('a stop — terminate or a credential containment — takes the space key off the disk', () => {
    /** A codex session on the space OpenAI key, with a rollout to keep. */
    async function codexOnSpaceKey(svc: SpawnService): Promise<{ sessionId: string; home: string; rollout: string }> {
      const { sessionId } = await svc.spawn(A, {
        spaceId: SPACE_ID,
        teamMemberId: TEAMMATE_OF_B,
        model: 'gpt-5.5',
        agentTool: 'codex',
        credentialSources: { openai: 'space' },
      });
      const home = join(dataDir, 'credentials', 'sessions', sessionId, 'openai');
      await mkdir(join(home, 'sessions'), { recursive: true });
      const rollout = join(home, 'sessions', 'rollout.jsonl');
      await writeFile(rollout, '{"turn":1}\n', 'utf8');
      // Control: the key is on disk while the session runs.
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain(OAI_KEY);
      return { sessionId, home, rollout };
    }

    /** `spyPty`, with `kill` answering as the PTY host does for a live session. */
    function spyPtyKilled() {
      const spies = spyPty();
      spies.kill.mockImplementation(() => {
        events.push('kill');
        return 'killed';
      });
      return spies;
    }

    it('a containment kill removes auth.json, keeps the rollout, and records the ending', async () => {
      spyPtyKilled();
      const svc = service(new FakeSpacePort(events, new Set(['identity-A'])));
      const { sessionId, home, rollout } = await codexOnSpaceKey(svc);

      const result = await svc.containCredentialSession(sessionId, 'space_credential_deleted');

      expect(result).toEqual({ outcome: 'killed', recorded: true });
      await expect(stat(join(home, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(rollout, 'utf8')).toBe('{"turn":1}\n');
      expect(graph.statusesFor(sessionId).at(-1)).toBe('exited');
    });

    it('a containment whose transition FAILS still removes auth.json (killed, recorded: false)', async () => {
      spyPtyKilled();
      const svc = service(new FakeSpacePort(events, new Set(['identity-A'])));
      const { sessionId, home } = await codexOnSpaceKey(svc);
      vi.spyOn(graph, 'transition').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: '42501' }));

      const result = await svc.containCredentialSession(sessionId, 'member_removed');

      expect(result).toEqual({ outcome: 'killed', recorded: false, reason: 'transition_failed: 42501' });
      await expect(stat(join(home, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.stringify(logs)).not.toContain(OAI_KEY);
    });

    it('a kill that FAILS leaves the key where it is: the process may still be reading it', async () => {
      const { kill } = spyPty();
      kill.mockImplementation(() => 'error');
      const svc = service(new FakeSpacePort(events, new Set(['identity-A'])));
      const { sessionId, home } = await codexOnSpaceKey(svc);

      expect(await svc.containCredentialSession(sessionId, 'space_credential_deleted')).toEqual({
        outcome: 'error',
        recorded: false,
      });
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain(OAI_KEY);
    });

    it('terminate removes auth.json and keeps the rollout', async () => {
      spyPtyKilled();
      const svc = service(new FakeSpacePort(events, new Set(['identity-A'])));
      const { sessionId, home, rollout } = await codexOnSpaceKey(svc);

      const result = await svc.terminate(A, sessionId);

      expect(result.outcome).toBe('killed');
      await expect(stat(join(home, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(home)).isDirectory()).toBe(true);
      expect(await readFile(rollout, 'utf8')).toBe('{"turn":1}\n');
    });

    it('a resume after terminate re-seeds the key from the live credential and launches — the scrub does not break resume', async () => {
      const port = new FakeSpacePort(events, new Set(['identity-A']));
      const { spawnIfAbsent } = spyPtyKilled();
      const svc = service(port);
      const { sessionId } = await svc.spawn(A, {
        spaceId: SPACE_ID,
        teamMemberId: TEAMMATE_OF_B,
        credentialSources: { anthropic: 'space' },
      });
      const home = join(dataDir, 'credentials', 'sessions', sessionId, 'anthropic');
      const configPath = join(home, '.claude.json');
      await mkdir(join(home, 'projects', 'p'), { recursive: true });
      const transcript = join(home, 'projects', 'p', 'conversation.jsonl');
      await writeFile(transcript, '{"turn":1}\n', 'utf8');
      expect(await readFile(configPath, 'utf8')).toContain(ANT_KEY.slice(-20));

      await svc.terminate(A, sessionId);
      // The stop scrubbed the approved key suffix and kept the conversation.
      expect(await readFile(configPath, 'utf8')).not.toContain(ANT_KEY.slice(-20));
      expect(await readFile(transcript, 'utf8')).toBe('{"turn":1}\n');

      // The session as the graph now reads it: exited, launched by A on ANT.
      graph.resumeInfo = {
        sessionId,
        spaceId: SPACE_ID,
        teamMemberId: TEAMMATE_OF_B,
        parentSessionId: null,
        projectId: null,
        taskIds: [],
        workdirMode: 'scratch',
        workdirPath: null,
        mode: 'worker',
        model: 'claude-opus-5',
        agentTool: 'claude-code',
        title: 'terminated, then resumed',
        status: 'exited',
        nativeSessionId: '55555555-5555-4555-8555-555555555555',
        agentConfigDir: null,
      };
      graph.postures.set(sessionId, {
        credentialSources: { anthropic: 'space' },
        spaceCredentialIds: { anthropic: ANT },
      } as SessionLaunchPosture);
      port.recorded.set(sessionId, [{ provider: 'anthropic', spaceCredentialId: ANT }]);
      port.launcher.set(sessionId, 'identity-A');
      spawnIfAbsent.mockClear();

      await svc.resume(A, { sessionId });

      // Launched, on the same per-session home, with the key read NOW.
      expect(spawnIfAbsent).toHaveBeenCalledTimes(1);
      const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
      expect(env.CLAUDE_CONFIG_DIR).toBe(home);
      expect(env.ANTHROPIC_API_KEY).toBe(ANT_KEY);
      const reseeded = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      expect(reseeded.customApiKeyResponses).toEqual({ approved: [ANT_KEY.slice(-20)], rejected: [] });
      expect(await readFile(transcript, 'utf8')).toBe('{"turn":1}\n');
    });
  });

  it('a space GitHub token reaches the child as GH_TOKEN/GITHUB_TOKEN with the machine helper reset (design §7)', async () => {
    const port = new FakeSpacePort(events, new Set(['identity-A']));
    port.githubToken = { id: GH, token: GH_TOKEN, login: 'space-bot' };
    port.active.add(GH);
    const { spawnIfAbsent } = spyPty();
    await service(port).spawn(A, {
      spaceId: SPACE_ID,
      teamMemberId: TEAMMATE_OF_B,
      credentialSources: { github: 'space' },
    });
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env.GH_TOKEN).toBe(GH_TOKEN);
    expect(env.GITHUB_TOKEN).toBe(GH_TOKEN);
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_AUTHOR_NAME).toBe('space-bot');
    expect(graph.manifests[0]!.manifest.launch.spaceCredentialIds).toMatchObject({ github: GH });
    expect(JSON.stringify(graph.manifests)).not.toContain(GH_TOKEN);
    expect(JSON.stringify(logs)).not.toContain(GH_TOKEN);
  });
});
