/**
 * W11-migrate job entry (see w11-migrate.ts). Run once per node, by the node's
 * operator, against the node database:
 *
 *   TM8_DATABASE_URL=postgres://… node packages/server/dist/projects/w11-migrate-cli.js --mapping <file.json> --dry-run
 *     [--as-of <iso>] [--window-days 30] [--format md|json]
 *   TM8_DATABASE_URL=postgres://… node packages/server/dist/projects/w11-migrate-cli.js --mapping <file.json>
 *
 * --mapping is REQUIRED on every run: the owner's `{ "<folder id>": "<owning
 * space id>" }` (K13, form 01a0db32-d438). Nothing picks an owner without it.
 * --dry-run prints the report (an unmapped folder shows as refused) and exits
 * 0. Without it the job is a real run: it REFUSES (exit 2) any folder the
 * mapping does not name, maps outside its grants, or that has a live session,
 * and it stops there (exit 3) even when nothing refuses — the real run is an
 * owner step not built into this job.
 *
 * Every read runs in one READ ONLY transaction. The database URL is read from
 * the environment and never printed.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import pg from 'pg';

import {
  DEFAULT_WINDOW_DAYS,
  buildW11Report,
  formatW11Report,
  loadNodeOwnerIdentity,
  loadW11Evidence,
  parseOwningSpaceMapping,
  realRunRefusals,
} from './w11-migrate.js';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      mapping: { type: 'string' },
      'as-of': { type: 'string' },
      'window-days': { type: 'string' },
      format: { type: 'string', default: 'md' },
    },
    strict: true,
  });
  const url = env.TM8_DATABASE_URL;
  if (!url) {
    process.stderr.write('w11-migrate: TM8_DATABASE_URL is not set\n');
    return 64;
  }
  if (!values.mapping) {
    process.stderr.write('w11-migrate: --mapping <file.json> is required (folder id -> owning space id)\n');
    return 64;
  }
  const mapping = parseOwningSpaceMapping(readFileSync(values.mapping, 'utf8'));
  const asOf = new Date(values['as-of'] ?? Date.now()).toISOString();
  const windowDays = values['window-days'] ? Number(values['window-days']) : DEFAULT_WINDOW_DAYS;
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    process.stderr.write('w11-migrate: --window-days must be a positive integer\n');
    return 64;
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let report;
  try {
    await client.query('begin transaction isolation level repeatable read, read only');
    const evidence = await loadW11Evidence(client, asOf, windowDays);
    const nodeOwnerIdentity = await loadNodeOwnerIdentity(client);
    await client.query('commit');
    report = buildW11Report({ evidence, mapping, nodeOwnerIdentity, asOf, windowDays });
  } finally {
    await client.end();
  }

  const out = values.format === 'json' ? JSON.stringify(report, null, 2) : formatW11Report(report);
  process.stdout.write(`${out}\n`);
  if (values['dry-run']) return 0;

  const refusals = realRunRefusals(report);
  if (refusals.length > 0) {
    process.stderr.write(`w11-migrate: REFUSED\n${refusals.map((r) => `  ${JSON.stringify(r)}`).join('\n')}\n`);
    return 2;
  }
  process.stderr.write('w11-migrate: preconditions hold; the real run is an owner step and is not built into this job\n');
  return 3;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
    process.stderr.write(`w11-migrate: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
