/**
 * S6 (server_only_space_credentials): WHO CAN REACH `read_space_service_key`. The database half — only
 * `tm8_app` may EXECUTE it, and it runs under the caller's claims — is
 * test/db/server-only-credentials.pg.test.ts. This is the code half:
 *
 *   · exactly one source file names the RPC: the space credential store;
 *   · exactly one source file calls the store's `readServiceKey`: main.ts,
 *     wiring it into the Ask Jev resolver — no facade handler, catalog
 *     service, CLI or MCP tool;
 *   · no catalog operation binds it or reads a service key from a space.
 *
 * NEGATIVE CONTROL: the same scan finds the spawn reader's RPC literal where
 * the store calls it, so a silence above is a measurement, not a blind spot.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPERATIONS } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

async function filesNaming(needle: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const pkg of ['server', 'cli', 'mcp', 'contract', 'execution']) {
    for (const file of await sourceFiles(join(ROOT, pkg, 'src'))) {
      if (needle.test(await readFile(file, 'utf8'))) hits.push(relative(ROOT, file));
    }
  }
  return hits.sort();
}

describe('read_space_service_key has one caller path: the server’s Ask Jev resolver', () => {
  it('only the space credential store calls the RPC (a string literal; comments may mention it)', async () => {
    expect(await filesNaming(/['"]read_space_service_key['"]/)).toEqual(['server/src/credentials/space-credential-store.ts']);
  });

  it('only main.ts calls readServiceKey, and it feeds the Jev resolver', async () => {
    const callers = (await filesNaming(/\.readServiceKey\(/));
    expect(callers).toEqual(['server/src/main.ts']);
    const main = await readFile(join(ROOT, 'server/src/main.ts'), 'utf8');
    const call = main.indexOf('.readServiceKey(');
    const resolver = main.lastIndexOf('createJevAdvisorResolver(', call);
    expect(resolver).toBeGreaterThan(-1);
    expect(main.slice(resolver, call)).toMatch(/readSpaceKey:/);
  });

  it('no catalog operation binds it', () => {
    const catalog = JSON.stringify(OPERATIONS);
    expect(catalog).not.toMatch(/read_space_service_key|readServiceKey|serviceKey\.read/i);
  });

  it('control: the scan does see a spawn-reader RPC where it is named', async () => {
    const hits = await filesNaming(/['"]read_space_credential_for_spawn['"]/);
    expect(hits).toContain('server/src/credentials/space-credential-store.ts');
  });
});
