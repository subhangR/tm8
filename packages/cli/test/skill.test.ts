import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { parseInvocation } from '../src/args.js';
import { resolveContext } from '../src/context.js';
import { createOutput } from '../src/output.js';
import { SKILL_COMMANDS } from '../src/commands/skill.js';
const SPACE = '00000000-0000-7000-8000-0000000000aa';
const ID = '00000000-0000-7000-8000-0000000000bb';
let server: Server;
let baseUrl: string;
const requests: Array<{ method?: string; path: string; body: unknown }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      requests.push({ method: req.method, path: req.url!, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: {}, requestId: 'test' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
async function invoke(args: string[]) {
  const parsed = parseInvocation(['--space', SPACE, ...args]);
  const mod = SKILL_COMMANDS.find(c => c.path.every((p, i) => p === parsed.positionals[i]))!;
  return mod.run({ path: mod.path, args: parsed.positionals.slice(2), options: parsed.options, passthrough: parsed.passthrough,
    ctx: resolveContext({ globals: parsed.globals, session: { baseUrl }, config: {} }),
    out: createOutput({ format: 'json', streams: { stdout() {}, stderr() {} } }),
  });
}
it('routes scan/list/show through server operations and rejects conflicting scope', async () => {
  expect(await invoke(['skill', 'scan', '--all'])).toBe(0);
  expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/v2/spaces/${SPACE}/skills/scan`, body: { all: true } });
  expect(await invoke(['skill', 'list', '--limit', '2'])).toBe(0);
  expect(requests.at(-1)?.path).toBe(`/v2/spaces/${SPACE}/skills?limit=2`);
  expect(await invoke(['skill', 'show', ID])).toBe(0);
  expect(requests.at(-1)?.path).toBe(`/v2/skills/${ID}`);
  await expect(invoke(['skill', 'scan', '--all', '--root', ID])).rejects.toThrow('mutually exclusive');
});
