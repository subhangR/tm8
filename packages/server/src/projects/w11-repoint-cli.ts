/**
 * W11-repoint dry-run entry (see w11-repoint.ts). Run by the node's operator,
 * against the node database, AFTER W11-migrate's real run and BEFORE 245:
 *
 *   TM8_DATABASE_URL=postgres://… node packages/server/dist/projects/w11-repoint-cli.js --dry-run
 *     [--migration db/migrations/245_w11_repoint_project_entity.sql]
 *     [--confirmed <file.json>] [--format md|json]
 *
 * Applies 245 inside one transaction between two counts and ROLLS BACK. Exit
 * 0 when 245 would apply, 2 when it refuses (the refusal is printed verbatim).
 * There is no real-run mode: the real run is `node db/migrate.mjs up`, an
 * owner step. `--confirmed` takes W11-migrate's owner-confirmed table
 * (`{ "<folder id>": "<owning space id>" }`) and shows it against each folder
 * still granted to more than one space; it derives no owner.
 *
 * The database URL is read from the environment and never printed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import pg from 'pg';

import { dryRunRepoint, formatRepointReport, type W11ConfirmedTable } from './w11-repoint.js';

export const MIGRATION_FILE = '245_w11_repoint_project_entity.sql';

/** packages/server/{src,dist}/projects -> repo root db/migrations. */
export function defaultMigrationPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations', MIGRATION_FILE);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      migration: { type: 'string' },
      confirmed: { type: 'string' },
      format: { type: 'string', default: 'md' },
    },
    strict: true,
  });
  if (!values['dry-run']) {
    process.stderr.write('w11-repoint: only --dry-run is built; the real run is `node db/migrate.mjs up`, an owner step\n');
    return 64;
  }
  const url = env.TM8_DATABASE_URL;
  if (!url) {
    process.stderr.write('w11-repoint: TM8_DATABASE_URL is not set\n');
    return 64;
  }
  const sql = readFileSync(values.migration ?? defaultMigrationPath(), 'utf8');
  const confirmed: W11ConfirmedTable | null = values.confirmed
    ? JSON.parse(readFileSync(values.confirmed, 'utf8')) as W11ConfirmedTable
    : null;

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let run;
  try {
    run = await dryRunRepoint(client, sql, confirmed);
  } finally {
    await client.end();
  }
  const out = values.format === 'json' ? JSON.stringify(run, null, 2) : formatRepointReport(run);
  process.stdout.write(`${out}\n`);
  return run.refusal === null ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
    process.stderr.write(`w11-repoint: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
