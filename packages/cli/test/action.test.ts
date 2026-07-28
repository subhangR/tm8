/**
 * `tm8 action list` — group 7, G09 capability discovery.
 *
 * THIS COMMAND IS THE PERMISSION AXIS, AND THE TESTS HERE EXIST TO STOP IT
 * ANSWERING A DIFFERENT QUESTION. Three axes are kept apart across this CLI,
 * and conflating them is a recorded defect class in this program:
 *
 *   exposure     public|composite|internal|reserved — static, contract-level.
 *   availability per NODE. Is this operation implemented here? An honest 501
 *                is its signal; `/health` is a cache epoch, never a claim.
 *   permission   per ACTOR. `actions.list` -> capabilityEpoch + descriptors.
 *
 * `action list` returns operations for an actor and a target. It would be very
 * easy — and wrong — to feed those operation names into the availability
 * ledger: "the server listed it, so it must be implemented here." That is
 * exactly the conflation, and one test below asserts the ledger stays untouched
 * after a call that named a dozen operations. An operation can be
 * implemented-but-forbidden or unimplemented-but-permitted.
 *
 * WHAT THIS COMMAND DOES NOT RENDER, AND WHY. The harness design doc (§7.5)
 * proposes a `DiscoveredAction` carrying `allowed: boolean` and
 * `reasonCode: ROLE|STATE|TRUST|ASSOCIATION|POLICY`. The FROZEN contract does
 * not have them: `PaletteAction` (contract.ts:762) has no `allowed` and no
 * `reasonCode`, and neither does `ActionDiscoveryResult`. The CLI therefore
 * renders the DTO the contract actually defines and fabricates neither field —
 * a synthesised `allowed: true` would be the CLI inventing an authorization
 * decision the Server owns.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { run } from '../src/run.js';
import { isRegisteredPath } from '../src/commands/registry.js';
import { ledger, resolveAvailability } from '../src/discovery/availability.js';

/**
 * Drive the REAL kernel router — `run()` — including the registry lookup this
 * slot does not own. Group 7's modules are wired into `commands/registry.ts`
 * now, so nothing about dispatch is substituted here: this is the same path the
 * shipped binary takes, minus the process-exiting entry wrapper.
 */
async function tm8(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

const TARGET = '66666666-6666-7666-8666-666666666666';
const ACTOR = '44444444-4444-7444-8444-444444444444';
const EPOCH = 'cap:8f14e45fceea167a5a36dedd4bea2543';

function result(actions: unknown[]): unknown {
  return {
    data: {
      actorId: ACTOR,
      targetEntityId: TARGET,
      targetVersion: 7,
      capabilityEpoch: EPOCH,
      actions,
    },
    requestId: 'req_t',
  };
}

const ACTION = {
  id: `action:entities.patch:${TARGET}`,
  label: 'entities patch',
  kind: 'status',
  operation: 'entities.patch',
  targetEntityId: TARGET,
  targetVersion: 7,
  capabilityEpoch: EPOCH,
  authzTarget: 'entity',
  exposure: 'public',
  helpRef: 'tm8://help/operation/entities.patch',
};

let reply: unknown = result([ACTION]);

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      recorded.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams });
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  recorded = [];
  reply = result([ACTION]);
  process.env.TM8_BASE_URL = baseUrl;
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_CONFIG_PATH;
  ledger.clear();
});

afterEach(() => {
  ledger.clear();
});

describe('tm8 action list — actions.list', () => {
  it('binds GET /v2/actions from the catalog', async () => {
    const r = await tm8(['action', 'list', '--format', 'json']);
    expect(r.code).toBe(0);
    expect(recorded[0]?.method).toBe('GET');
    expect(recorded[0]?.path).toBe('/v2/actions');
  });

  it('sends --for as contextEntityId, the query field the operation defines', async () => {
    await tm8(['action', 'list', '--for', TARGET]);
    expect(recorded[0]?.query.get('contextEntityId')).toBe(TARGET);
  });

  it('omits contextEntityId entirely when --for is absent', async () => {
    await tm8(['action', 'list']);
    expect(recorded[0]?.query.has('contextEntityId')).toBe(false);
  });

  it('refuses --mutation-id on a read', async () => {
    const r = await tm8(['action', 'list', '--mutation-id', 'x']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });
});

describe('permission is rendered as permission, and never as availability', () => {
  /**
   * The load-bearing test of this file. `actions.list` named `entities.patch`;
   * that says something about THIS ACTOR, not about whether this NODE
   * implements the operation. The availability ledger must be exactly as
   * ignorant afterwards as it was before.
   */
  it('does not teach the availability ledger anything about the operations it names', async () => {
    expect(resolveAvailability('entities.patch', 'v1').availability).toBe('unknown');

    const r = await tm8(['action', 'list', '--for', TARGET]);
    expect(r.code).toBe(0);

    // `entities.patch` was named in the response. It stays UNKNOWN: a listed
    // action is an authorization answer, not an implementation claim.
    expect(resolveAvailability('entities.patch', 'v1').availability).toBe('unknown');
    expect(ledger.observed('entities.patch')).toBeUndefined();
  });

  /**
   * `actions.list` ITSELF is a different matter: the CLI just called it and it
   * answered, so a handler demonstrably ran. That is an observation of the call
   * the caller already made — the one thing the ledger is allowed to learn.
   */
  it('does record that actions.list itself was handled — that call really happened', async () => {
    await tm8(['action', 'list']);
    expect(ledger.observed('actions.list')).toBe('handled');
  });

  it('emits the contract DTO verbatim, fabricating no allowed or reasonCode field', async () => {
    const r = await tm8(['action', 'list', '--for', TARGET, '--format', 'json']);
    const dto = JSON.parse(r.stdout) as {
      capabilityEpoch: string;
      actions: Array<Record<string, unknown>>;
    };
    expect(dto.capabilityEpoch).toBe(EPOCH);
    expect(dto.actions[0]).not.toHaveProperty('allowed');
    expect(dto.actions[0]).not.toHaveProperty('reasonCode');
    expect(dto.actions[0]).toEqual(ACTION);
  });

  it('surfaces capabilityEpoch in human output — the answer is epoch-bound and goes stale', async () => {
    const r = await tm8(['action', 'list', '--for', TARGET]);
    expect(r.stdout).toContain(EPOCH);
  });

  it('keeps each operation name in human output — it is the id a follow-up needs', async () => {
    const r = await tm8(['action', 'list', '--for', TARGET]);
    expect(r.stdout).toContain('entities.patch');
  });

  /**
   * `reasonCode`'s enum is exactly ROLE|STATE|TRUST|ASSOCIATION|POLICY and has
   * no not-implemented member BY DESIGN, so permission can never be made to
   * answer availability. The CLI must not supply the missing member either — in
   * prose or otherwise.
   */
  it('never describes a listed action in availability vocabulary', async () => {
    const r = await tm8(['action', 'list', '--for', TARGET]);
    expect(r.stdout).not.toMatch(/not implemented|unavailable|available/i);
  });

  it('renders an empty action set as empty rather than as "nothing is implemented"', async () => {
    reply = result([]);
    const r = await tm8(['action', 'list', '--for', TARGET]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/not implemented|unavailable/i);
  });
});
