/**
 * W5 E-3 regression: the built `session spawn` CLI carries model, agentTool,
 * and title into the strict execution.spawn body. The recorder is deliberately
 * a local HTTP stub: this measures the wire without starting an agent session.
 * Plain string values are covered; this suite does not assign semantics to a
 * hypothetical `--model none` spelling.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../../integration/harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const CLI = join(REPO_ROOT, 'packages/cli/dist/index.js');
const SPACE = '019fa297-64e3-7000-8000-000000000010';
const TEAMMATE = '019fa297-64e3-7000-8000-000000000012';
const MUT = '019fa297-64e3-7000-8000-0000000000ff';

interface Capture { body: string }

let server: Server;
let base = '';
let captures: Capture[] = [];
const measured: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      captures.push({ body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { sessionId: TEAMMATE } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no recorder address');
  base = `http://127.0.0.1:${addr.port}`;
  measured['recorder'] = base;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('[w5-e][spawn-unexpressible]', JSON.stringify(measured, null, 2));
});

async function drive(extra: readonly string[] = []): Promise<{ code: number; stderr: string }> {
  captures = [];
  const argv = [
    'session', 'spawn',
    '--space', SPACE,
    '--teammate', TEAMMATE,
    '--mutation-id', MUT,
    ...extra,
  ];
  return await new Promise((resolve) => {
    const child = spawn('node', [CLI, ...argv], {
      env: { ...process.env, TM8_BASE_URL: base, TM8_SPACE_ID: SPACE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

function bodyOf(): Record<string, unknown> {
  expect(captures.length, 'the recorder captured NOTHING — every negative here would be void').toBeGreaterThan(0);
  return JSON.parse(captures[0]!.body) as Record<string, unknown>;
}

// ── CONTROLS ──────────────────────────────────────────────────────────────

describe('CONTROL — the recorder is reached and the body is real', () => {
  it('a known-reachable field IS on the wire', async () => {
    const r = await drive(['--mode', 'worker']);
    measured['control.exit'] = r.code;
    if (r.code !== 0) measured['control.stderr'] = r.stderr.trim().slice(0, 300);
    expect(r.code, `spawn did not reach the wire: ${r.stderr}`).toBe(0);

    const body = bodyOf();
    measured['control.bodyKeys'] = Object.keys(body);
    measured['control.body'] = body;
    expect(body['mode']).toBe('worker');
    expect(body['teamMemberId']).toBe(TEAMMATE);
  });

  /**
   * A SECOND positive control on the SAME optional-field mechanism the three
   * flags under test would use — `--context` reaches `promptExtra`
   * (`packages/cli/src/commands/session.ts:143`). It proves the body-building
   * path for OPTIONAL spawn fields works, so a missing `model` cannot be blamed
   * on that path being broken generally. This is the difference between "these
   * three are missing" and "optional spawn fields don't work".
   *
   * ⚠ THE VALUE IS A BARE STRING, AND MY FIRST VERSION GOT THIS WRONG.
   * I passed `literal:hello` expecting the prefix to be stripped. It is not:
   * `parseSource` (`packages/cli/src/args.ts:412-419`) recognises exactly two
   * forms — `-` for stdin and `@path` for a file — and treats EVERYTHING ELSE
   * as an inline literal. So `literal:` was my own invention and the CLI was
   * correctly round-tripping it. The control failed on my expectation while the
   * mechanism it exists to prove was working the whole time.
   */
  it('another OPTIONAL spawn field reaches the wire — the mechanism is not broken', async () => {
    const r = await drive(['--context', 'hello']);
    measured['control.promptExtra.exit'] = r.code;
    const body = bodyOf();
    measured['control.promptExtra.body'] = body;
    expect(r.code, r.stderr).toBe(0);
    expect(body['promptExtra'], '--context -> promptExtra is the working comparator').toBe('hello');
  });
});

// ── THE ASSERTIONS ────────────────────────────────────────────────────────

const EXPRESSIBLE = [
  { field: 'model', flag: '--model', value: 'claude-opus-5', where: 'schemas.ts:1216 · manifest.ts:112' },
  { field: 'agentTool', flag: '--agent-tool', value: 'claude-code', where: 'schemas.ts:1217' },
  { field: 'title', flag: '--title', value: 'W5E spawn title', where: 'schemas.ts:1218' },
];

describe('E-3 — frozen-contract spawn fields reach the wire', () => {
  for (const row of EXPRESSIBLE) {
    it(`${row.flag} <value> puts ${row.field} on the wire (${row.where})`, async () => {
      const r = await drive([row.flag, row.value]);
      const body = bodyOf();
      measured[`e3.${row.field}.exit`] = r.code;
      measured[`e3.${row.field}.bodyKeys`] = Object.keys(body);

      expect(
        body[row.field],
        `${row.flag} parsed and never reached the body: commands/session.ts reads no '${row.field}'`,
      ).toBe(row.value);
    });
  }

  it('all three observably change the body while the mutation id stays pinned', async () => {
    const without = await drive();
    const withoutBody = captures[0]?.body ?? '';

    const withAll = await drive([
      '--model', 'claude-opus-5',
      '--agent-tool', 'claude-code',
      '--title', 'W5E spawn title',
    ]);
    const withBody = captures[0]?.body ?? '';

    measured['harm.withoutBody'] = withoutBody;
    measured['harm.withBody'] = withBody;
    measured['harm.exits'] = [without.code, withAll.code];

    const identical = withoutBody === withBody && without.code === withAll.code;
    measured['harm.identical'] = identical;

    expect(
      identical,
      'the populated spawn body must differ from one that omits model, agentTool, and title',
    ).toBe(false);
  });
});
