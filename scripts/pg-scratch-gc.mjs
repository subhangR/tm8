#!/usr/bin/env node
/**
 * Garbage-collect scratch databases leaked by the test harnesses.
 *
 *   node scripts/pg-scratch-gc.mjs                  # dry run: list what WOULD be dropped
 *   node scripts/pg-scratch-gc.mjs --apply          # drop them
 *   node scripts/pg-scratch-gc.mjs --min-age-hours 24 --url postgres://tm8@127.0.0.1:5442/postgres
 *
 * The harnesses create one database per suite and drop it in teardown, but a
 * worker killed mid-suite (a hook timeout, Ctrl-C, an OOM) never reaches that
 * teardown, and until the `with (force)` fix a drop that raced the suite's own
 * still-closing connections failed quietly. Those databases pile up on the
 * long-lived local cluster (141 of 290 on 2026-09-24) that also serves the live
 * node's `tm8_stable`, so this script is deliberately narrow.
 *
 * A database is dropped only when ALL of these hold:
 *
 *   1. its name matches a scratch pattern exactly (the names the harnesses
 *      and db/scratch-template.mjs generate, and nothing else: `tm8_stable`, `postgres`, the templates and
 *      every hand-made database fail this test by construction);
 *   2. it is older than --min-age-hours (default 6; a published template
 *      `tm8_tpl_*` at least 24), measured from the
 *      mtime of its `PG_VERSION`, which Postgres writes once at CREATE DATABASE.
 *      An unreadable creation time means "not eligible", never "old";
 *   3. no session is connected to it (pg_stat_activity);
 *   4. when the name encodes the creating pid, that pid is not alive on this
 *      host. A reused pid makes us skip a database we could have dropped,
 *      never the reverse. The pid check only means something when the cluster
 *      is on this machine, so a non-loopback --url is refused.
 *
 * The drop itself is a plain `drop database` WITHOUT `(force)`: if a suite
 * connects between the check and the drop, Postgres refuses the drop rather
 * than terminating the suite's sessions.
 */
import { spawnSync } from 'node:child_process';

const SCRATCH_PATTERNS = [
  // packages/server/test/db/w1-pg.ts and packages/cli/test/integration/harness.ts:
  //   tm8_w1_<label>_<pid>_<12 hex>  /  tm8_w4_<label>_<pid>_<12 hex>
  { re: /^tm8_w[14]_[a-z0-9_]+_(\d+)_[0-9a-f]{12}$/, pid: 1 },
  // db/scratch-template.mjs: an abandoned template build (its builder died).
  { re: /^tm8_tplbuild_[0-9a-f]{16}_(\d+)_[0-9a-f]{12}$/, pid: 1 },
  // db/scratch-template.mjs: a published template. No pid; a live chain simply
  // rebuilds one on next use, so the only guard needed is age (TEMPLATE_MIN_AGE_HOURS).
  { re: /^tm8_tpl_[0-9a-f]{16}$/, pid: null, template: true },
  // packages/tm8-ui/src/data/integration/node-fixture.ts:
  //   tm8ui_b4_<label>_<counter>_<Date.now() base36>
  { re: /^tm8ui_b4_[a-z0-9_]+_\d+_[0-9a-z]+$/, pid: null },
];
// A template is rebuilt on demand, but a rebuild costs one full migration run,
// so one still in daily use is left alone.
const TEMPLATE_MIN_AGE_HOURS = 24;
const NEVER = new Set(['postgres', 'template0', 'template1', 'tm8_stable', 'tm8_dev']);

function parseArgs(argv) {
  const opts = {
    apply: false,
    minAgeHours: 6,
    url: process.env.TM8_MIGRATION_DATABASE_URL ?? 'postgres://tm8@127.0.0.1:5442/postgres',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--min-age-hours') opts.minAgeHours = Number(argv[++i]);
    else if (arg === '--url') opts.url = argv[++i];
    else if (arg === '-h' || arg === '--help') {
      console.log('usage: node scripts/pg-scratch-gc.mjs [--apply] [--min-age-hours N] [--url postgres://…/postgres]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(opts.minAgeHours) || opts.minAgeHours < 1) {
    console.error('--min-age-hours must be a number >= 1');
    process.exit(2);
  }
  return opts;
}

function adminUrl(raw) {
  const url = new URL(raw);
  url.pathname = '/postgres';
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    console.error(`refusing ${url.hostname}: the pid-liveness guard only holds for a cluster on this host`);
    process.exit(2);
  }
  return url.toString();
}

function psql(url, sql) {
  const res = spawnSync('psql', ['--no-psqlrc', '-X', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', url, '-c', sql], {
    encoding: 'utf8',
  });
  return { ok: res.status === 0, out: res.stdout ?? '', err: (res.stderr ?? '').trim() };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else, so it is alive.
    return error?.code === 'EPERM';
  }
}

function classify(name) {
  if (NEVER.has(name)) return null;
  for (const p of SCRATCH_PATTERNS) {
    const m = p.re.exec(name);
    if (m) return { pid: p.pid === null ? null : Number(m[p.pid]), template: p.template === true };
  }
  return null;
}

const opts = parseArgs(process.argv.slice(2));
const url = adminUrl(opts.url);

// One snapshot of every database with its creation time and live session count.
// pg_stat_file(..., true) returns NULL instead of raising for a database dropped
// mid-query, and needs superuser or pg_read_server_files; NULL means ineligible.
const listing = psql(
  url,
  `select d.datname,
          coalesce(extract(epoch from (pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification)::bigint::text, ''),
          (select count(*) from pg_stat_activity a where a.datid = d.oid)
     from pg_database d
    where (d.datallowconn and not d.datistemplate) or d.datname ~ '^tm8_tpl(build)?_'
    order by 1`,
);
if (!listing.ok) {
  console.error(`could not list databases: ${listing.err}`);
  process.exit(1);
}

const now = Date.now() / 1000;
const eligible = [];
const skipped = { young: 0, connected: 0, pidAlive: 0, unknownAge: 0 };
let scratch = 0;
for (const line of listing.out.split('\n').filter(Boolean)) {
  const [name, createdRaw, sessionsRaw] = line.split('\t');
  const info = classify(name);
  if (!info) continue;
  scratch++;
  if (createdRaw === '') { skipped.unknownAge++; continue; }
  const ageHours = (now - Number(createdRaw)) / 3600;
  if (ageHours < Math.max(opts.minAgeHours, info.template ? TEMPLATE_MIN_AGE_HOURS : 0)) { skipped.young++; continue; }
  if (Number(sessionsRaw) > 0) { skipped.connected++; continue; }
  if (info.pid !== null && pidAlive(info.pid)) { skipped.pidAlive++; continue; }
  eligible.push({ name, ageHours, template: info.template });
}

console.log(
  `${scratch} scratch databases; ${eligible.length} eligible (older than ${opts.minAgeHours}h, no sessions, creator gone); ` +
    `skipped: ${skipped.young} younger, ${skipped.connected} connected, ${skipped.pidAlive} creator pid alive, ${skipped.unknownAge} unknown age`,
);
for (const { name, ageHours } of eligible) {
  console.log(`  ${opts.apply ? 'drop' : 'would drop'}  ${name}  (${ageHours.toFixed(1)}h)`);
}
if (!opts.apply) {
  if (eligible.length) console.log('dry run: re-run with --apply to drop these');
  process.exit(0);
}

let failed = 0;
for (const { name, template } of eligible) {
  // Postgres refuses to drop a database marked as a template. Nothing can be
  // connected to one (allow_connections false), and a clone in flight holds a
  // lock the drop waits for.
  if (template) psql(url, `alter database "${name}" with is_template false`);
  // Plain drop, no (force): a session that appeared since the snapshot makes
  // Postgres refuse, and that database is left for the next run.
  const res = psql(url, `drop database if exists "${name}"`);
  if (!res.ok) {
    failed++;
    console.error(`  kept ${name}: ${res.err}`);
  }
}
console.log(`dropped ${eligible.length - failed}, kept ${failed}`);
process.exit(failed ? 1 : 0);
