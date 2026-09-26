/**
 * `node.mode.set` refusals that the Postgres run (test/w3/node-mode-set.test.ts)
 * cannot reach cheaply: an AGENT session holding the owner's account, a `cli`
 * owner session, and a corrupt recorded file. Identity resolution is faked at
 * the pg-auth seam; everything else is the real handler.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollabError } from '@tm8/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ isOwner: true, kind: 'browser' as string, claimed: true }));

vi.mock('../../src/identity/pg-auth.js', () => ({
  nodeIsClaimed: async () => session.claimed,
  resolveBearerIdentity: async () => ({ isOwner: session.isOwner, kind: session.kind }),
}));

import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2NodeModeHandlers } from '../../src/facade/handlers/w2/node-mode.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { OperationHandler, RequestContext, RequestIdentity } from '../../src/http/types.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-mode-set-'));
  Object.assign(session, { isOwner: true, kind: 'browser', claimed: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function handler(config: Partial<ServerConfig> = {}): OperationHandler {
  const registry = new HandlerRegistry();
  const deps = {
    db: {} as FacadeDeps['db'],
    config: { dataDir, nodeMode: 'personal', nodeModeSource: 'file', nodeModeSet: true, ...config } as ServerConfig,
    owner: async () => { throw new Error('unused'); },
  } satisfies FacadeDeps;
  registerW2NodeModeHandlers(registry, deps);
  const h = registry.get('node.mode.set');
  if (!h) throw new Error('node.mode.set is not registered');
  return h;
}

function ctx(mode: string, identity: RequestIdentity): RequestContext {
  return { body: { mode }, identity, requestId: 'req_test' } as unknown as RequestContext;
}

const bearer: RequestIdentity = { kind: 'bearer', token: 'tm8s_test' };
const autoOwner: RequestIdentity = { kind: 'auto-owner', authKind: 'browser' };

async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CollabError) return { code: err.code, reason: err.details?.['reason'] };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('node.mode.set — the caller', () => {
  it('refuses an AGENT session on the owner account, even to tighten', async () => {
    for (const kind of ['agent', 'agent_runtime']) {
      session.kind = kind;
      expect(await refusal(Promise.resolve(handler()(ctx('server', bearer))))).toEqual({
        code: 'forbidden',
        reason: 'owner_session_required',
      });
    }
  });

  it('admits the owner\'s cli session to loosen server → personal', async () => {
    await writeFile(join(dataDir, 'mode'), 'server\n');
    session.kind = 'cli';
    const result = await handler({ nodeMode: 'server' })(ctx('personal', bearer));
    expect(result).toEqual({ previous: 'server', mode: 'personal', source: 'file', restartRequired: true });
    expect(await readFile(join(dataDir, 'mode'), 'utf8')).toBe('personal\n');
  });

  it('pins: refuses the owner\'s own session when the env set the mode', async () => {
    expect(await refusal(Promise.resolve(handler({ nodeModeSource: 'env' })(ctx('server', bearer))))).toEqual({
      code: 'conflict',
      reason: 'mode_pinned',
    });
  });

  it('checks the pin before the claim: an unclaimed pinned node answers mode_pinned', async () => {
    session.claimed = false;
    expect((await refusal(Promise.resolve(handler({ nodeModeSource: 'env' })(ctx('peer', autoOwner))))).reason)
      .toBe('mode_pinned');
  });

  it('refuses EVERY mode on an unclaimed node, Personal included (decision 34), and writes nothing', async () => {
    session.claimed = false;
    for (const mode of ['personal', 'peer', 'server']) {
      for (const identity of [autoOwner, bearer]) {
        expect(await refusal(Promise.resolve(handler({ nodeModeSet: false, nodeModeSource: 'default' })(ctx(mode, identity)))))
          .toEqual({ code: 'conflict', reason: 'node_unclaimed' });
      }
    }
    await expect(stat(join(dataDir, 'mode'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('node.mode.set — judging from the recorded file', () => {
  it('treats a CORRUPT recorded file as server: the auto-owner cannot loosen from it', async () => {
    await writeFile(join(dataDir, 'mode'), 'garbage');
    expect(await refusal(Promise.resolve(handler()(ctx('peer', autoOwner))))).toEqual({
      code: 'forbidden',
      reason: 'owner_session_required',
    });
  });

  it('lets the auto-owner overwrite a corrupt file only with server (tightening)', async () => {
    await writeFile(join(dataDir, 'mode'), 'garbage');
    const result = await handler()(ctx('server', autoOwner));
    expect(result).toMatchObject({ mode: 'server', restartRequired: true });
    expect(await readFile(join(dataDir, 'mode'), 'utf8')).toBe('server\n');
  });

  it('restartRequired follows the arm, not the name: personal ↔ peer needs none', async () => {
    const result = await handler({ nodeMode: 'personal' })(ctx('peer', autoOwner));
    expect(result).toMatchObject({ previous: 'personal', mode: 'peer', restartRequired: false });
  });
});

describe('reportedNodeMode — what auth.claim.status says', () => {
  it('reads the recorded file now, not the boot-time config', async () => {
    const { reportedNodeMode } = await import('../../src/facade/handlers/w2/node-mode.js');
    const booted = { dataDir, nodeMode: 'personal', nodeModeSource: 'default', nodeModeSet: false } as ServerConfig;
    expect(reportedNodeMode(booted)).toEqual({ mode: 'personal', modeSet: false, modeSource: 'default' });
    await writeFile(join(dataDir, 'mode'), 'peer\n');
    expect(reportedNodeMode(booted)).toEqual({ mode: 'peer', modeSet: true, modeSource: 'file' });
    // A corrupt file does not fail the claim-free read: the boot answer stands.
    await writeFile(join(dataDir, 'mode'), 'garbage');
    expect(reportedNodeMode(booted)).toEqual({ mode: 'personal', modeSet: false, modeSource: 'default' });
    // A pin is the env, whatever the file says.
    await writeFile(join(dataDir, 'mode'), 'personal\n');
    expect(reportedNodeMode({ ...booted, nodeMode: 'server', nodeModeSource: 'env', nodeModeSet: true } as ServerConfig))
      .toEqual({ mode: 'server', modeSet: true, modeSource: 'env' });
  });
});
