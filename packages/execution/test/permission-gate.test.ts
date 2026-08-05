// The permission-gate bridge, tested for the property that actually matters.
//
// This module can cause exactly one unrecoverable outcome: granting a permission
// nobody granted. Every other failure it can have -- asking twice, blocking too
// long, giving up early -- costs a person a walk to the terminal, where the
// agent's own prompt is still sitting. So the tests below are weighted almost
// entirely toward "does any failure path ever produce an allow", rather than
// toward the happy path, which is one line.
//
// The clock and the network are injected. A loop whose whole purpose is waiting
// ten minutes cannot be tested by waiting ten minutes.

import { describe, expect, it } from 'vitest';
import {
  renderDecision,
  runPermissionGate,
  type GateDecision,
  type HookPayload,
  type PermissionGateEnv,
} from '../src/spawn/permission-gate.js';

const ENV: PermissionGateEnv = {
  TM8_BASE_URL: 'http://127.0.0.1:17777',
  TM8_SESSION_ID: '11111111-1111-4111-8111-111111111111',
  TM8_AGENT_TOKEN: 'tok',
  TM8_AGENT_TOOL: 'claude-code',
};

const PAYLOAD: HookPayload = {
  tool_name: 'Bash',
  tool_use_id: 'toolu_abc',
  tool_input: { command: 'rm -rf /tmp/x' },
};

/** A fake node: one open response, then a scripted sequence of poll statuses. */
function node(opts: {
  openOk?: boolean;
  openStatus?: number;
  statuses?: string[];
  throwOnPoll?: boolean;
}) {
  let poll = 0;
  const fetchImpl = (async (url: string, init?: { method?: string }) => {
    const isOpen = (init?.method ?? 'GET') === 'POST';
    if (isOpen) {
      if (opts.openOk === false) {
        return { ok: false, status: opts.openStatus ?? 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { promptId: 'p1' } }) };
    }
    if (opts.throwOnPoll) throw new Error('ECONNREFUSED');
    const status = opts.statuses?.[Math.min(poll++, (opts.statuses?.length ?? 1) - 1)] ?? 'pending';
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [{ promptId: 'p1', status, decisionReason: null }] } }),
    };
  }) as unknown as typeof fetch;

  // A clock that jumps a second per sleep, so a ten-minute deadline is reached
  // in however many iterations the test needs rather than in ten minutes.
  let t = 0;
  return {
    fetchImpl,
    now: () => t,
    sleepImpl: async (ms: number) => {
      t += ms;
    },
  };
}

const isAllow = (d: GateDecision) => d.kind === 'allow';

describe('the permission gate never invents an allow', () => {
  it('abstains when the node cannot be reached at all', async () => {
    const deps = node({ throwOnPoll: true });
    const d = await runPermissionGate(PAYLOAD, ENV, {
      ...deps,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(d.kind).toBe('abstain');
    expect(isAllow(d)).toBe(false);
  });

  it('abstains when opening the gate is refused', async () => {
    const d = await runPermissionGate(PAYLOAD, ENV, node({ openOk: false, openStatus: 403 }));
    expect(d.kind).toBe('abstain');
  });

  it('abstains -- never allows -- when nobody answers before the window closes', async () => {
    // The single most dangerous path: a question asked, a person who never came.
    const d = await runPermissionGate(PAYLOAD, ENV, node({ statuses: ['pending'] }), 5000);
    expect(d.kind).toBe('abstain');
    expect(isAllow(d)).toBe(false);
  });

  it('abstains when the server expires the prompt underneath it', async () => {
    const d = await runPermissionGate(PAYLOAD, ENV, node({ statuses: ['pending', 'expired'] }));
    expect(d.kind).toBe('abstain');
  });

  it('abstains when the prompt disappears rather than assuming consent', async () => {
    let poll = 0;
    const deps = node({});
    const d = await runPermissionGate(PAYLOAD, ENV, {
      ...deps,
      fetchImpl: (async (_u: string, init?: { method?: string }) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return { ok: true, status: 200, json: async () => ({ data: { promptId: 'p1' } }) };
        }
        poll++;
        return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
      }) as unknown as typeof fetch,
    });
    expect(d.kind).toBe('abstain');
    expect(poll).toBeGreaterThan(0);
  });

  it('abstains when the session has no credential -- a hand-run agent has no gate', async () => {
    const d = await runPermissionGate(PAYLOAD, {}, node({}));
    expect(d.kind).toBe('abstain');
  });

  it('abstains when the hook payload carries no tool identity', async () => {
    const d = await runPermissionGate({}, ENV, node({}));
    expect(d.kind).toBe('abstain');
  });

  it('rides out a transient poll failure instead of abstaining on the first blip', async () => {
    let poll = 0;
    const deps = node({});
    const d = await runPermissionGate(PAYLOAD, ENV, {
      ...deps,
      fetchImpl: (async (_u: string, init?: { method?: string }) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return { ok: true, status: 200, json: async () => ({ data: { promptId: 'p1' } }) };
        }
        poll++;
        // Two blips, then a real answer. A momentary 503 is not a decision.
        if (poll <= 2) return { ok: false, status: 503, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { items: [{ promptId: 'p1', status: 'denied', decisionReason: 'no' }] },
          }),
        };
      }) as unknown as typeof fetch,
    });
    expect(d).toEqual({ kind: 'deny', reason: 'no' });
  });
});

describe('the gate reports a real human decision faithfully', () => {
  it('carries an allow, with the reason the person gave', async () => {
    const deps = node({ statuses: ['pending', 'allowed'] });
    const d = await runPermissionGate(PAYLOAD, ENV, deps);
    expect(d.kind).toBe('allow');
  });

  it('carries a deny', async () => {
    const d = await runPermissionGate(PAYLOAD, ENV, node({ statuses: ['denied'] }));
    expect(d.kind).toBe('deny');
  });
});

describe('what the provider actually receives', () => {
  it('prints NOTHING when abstaining -- silence is what returns the agent to its own prompt', () => {
    expect(renderDecision({ kind: 'abstain', why: 'whatever' })).toBe('');
  });

  it('emits the provider decision shape the CLI honours', () => {
    const out = JSON.parse(renderDecision({ kind: 'deny', reason: 'not this one' }));
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('not this one');
  });

  it('never emits a decision without a reason a human could read', () => {
    const out = JSON.parse(renderDecision({ kind: 'allow', reason: null }));
    expect(String(out.hookSpecificOutput.permissionDecisionReason).length).toBeGreaterThan(0);
  });
});
