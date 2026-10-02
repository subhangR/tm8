/**
 * The enforce gate (W3, T8c) as a pure function. The same refusals over the
 * real server and Postgres live in test/db/cross-space-token.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { CollabError } from '@tm8/contract';

import { assertSpaceGate, gateSessionMayCall, isGateSession } from '../src/http/space-gate.js';
import type { RequestIdentity } from '../src/http/types.js';

const gate = (authKind: RequestIdentity['authKind'] = 'browser'): RequestIdentity =>
  ({ kind: 'bearer', identityId: 'h', authKind, sessionId: 's' }) as RequestIdentity;
const pinned: RequestIdentity =
  ({ kind: 'bearer', identityId: 'h', authKind: 'browser', sessionId: 's', sessionSpaceId: 'a' }) as RequestIdentity;

describe('gateSessionMayCall', () => {
  it('allows the first-space ops, auth.* (including auth.space.enter) and node admin', () => {
    for (const op of ['identity.get', 'spaces.list', 'spaces.create', 'spaces.invites.redeem',
      'auth.invite.resolve', 'auth.space.enter', 'auth.session.get', 'auth.logout',
      'node.credentials.status', 'serverConnections.list']) {
      expect(gateSessionMayCall(op), op).toBe(true);
    }
  });
  it('allows gate.folders.* (L6): a folder is the gate\'s, and only an unpinned node admin may register one', () => {
    // isGateAdmin is nodeAdmin && !sessionSpaceId, so a pinned session can never
    // call these; refusing them at the gate too left enforce with no human caller.
    for (const op of ['gate.folders.list', 'gate.folders.create']) {
      expect(gateSessionMayCall(op), op).toBe(true);
    }
  });
  it('refuses every space operation, including spaces.get and the other invite ops', () => {
    for (const op of ['spaces.get', 'spaces.home', 'spaces.invites.create', 'spaces.invites.list',
      'identity.profile.update', 'entities.get', 'entities.query', 'projects.list', 'events.poll',
      'authx.fake', 'nodes.fake', 'gatex.fake', 'spaces.projects.create']) {
      expect(gateSessionMayCall(op), op).toBe(false);
    }
  });
  it('lets a gate admin decide op requests (L5, 280), but not file or list them', () => {
    for (const op of ['opRequests.get', 'opRequests.approve', 'opRequests.deny']) {
      expect(gateSessionMayCall(op), op).toBe(true);
    }
    for (const op of ['opRequests.create', 'opRequests.list']) {
      expect(gateSessionMayCall(op), op).toBe(false);
    }
  });
});

describe('isGateSession', () => {
  it('is a browser/cli bearer with no space', () => {
    expect(isGateSession(gate('browser'))).toBe(true);
    expect(isGateSession(gate('cli'))).toBe(true);
  });
  it('is not a pinned session, an agent, the auto-owner, or anonymous', () => {
    expect(isGateSession(pinned)).toBe(false);
    expect(isGateSession(gate('agent'))).toBe(false);
    expect(isGateSession({ kind: 'auto-owner', identityId: 'o', authKind: 'browser' } as RequestIdentity)).toBe(false);
    expect(isGateSession({ kind: 'anonymous' } as RequestIdentity)).toBe(false);
  });
});

describe('assertSpaceGate', () => {
  it('enforce: refuses a gate session a space op, and a support route (no op name)', () => {
    expect(() => assertSpaceGate('enforce', gate(), 'entities.get')).toThrow(CollabError);
    expect(() => assertSpaceGate('enforce', gate(), undefined)).toThrow(/auth\.space\.enter/);
  });
  it('enforce: positive — the gate session may enter, and a pinned session passes', () => {
    expect(() => assertSpaceGate('enforce', gate(), 'auth.space.enter')).not.toThrow();
    expect(() => assertSpaceGate('enforce', pinned, 'entities.get')).not.toThrow();
    expect(() => assertSpaceGate('enforce', pinned, undefined)).not.toThrow();
  });
  it('enforce: a gate session reaches gate.folders.list and gate.folders.create (L6)', () => {
    expect(() => assertSpaceGate('enforce', gate(), 'gate.folders.list')).not.toThrow();
    expect(() => assertSpaceGate('enforce', gate('cli'), 'gate.folders.create')).not.toThrow();
  });
  it('off and agents: never refuses (a5)', () => {
    for (const mode of ['off', 'agents', undefined] as const) {
      expect(() => assertSpaceGate(mode, gate(), 'entities.get')).not.toThrow();
      expect(() => assertSpaceGate(mode, gate(), undefined)).not.toThrow();
    }
  });
});
