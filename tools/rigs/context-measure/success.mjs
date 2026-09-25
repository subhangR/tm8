#!/usr/bin/env node
// Task success for one I10a lane (§7.2): the deliverable is right, it was
// committed, and the lane closed out in the graph.
//
//   TM8_CLI=<dev-node wrapper> node success.mjs --task-key fee --worktree <path> --base <sha> \
//     --task-id <id> --actor <teammate-id> --since <iso> [--until <iso>]
//
// The deliverable is judged at the lane's COMMITTED head (git archive), never
// the dirty tree, and against the needle's hidden checks in fixture-data.mjs.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { devCli } from './dev-cli.mjs';
import { TASKS } from './fixture-data.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

// `checks` (optional) supplies the hidden checks directly — context-eval's
// fixture carries its own per-task list — else they are looked up by key in
// fixture-data.mjs. `checks: []` is allowed only with `allowNoChecks` (a
// replica has no known deliverable); otherwise a task with no checks would
// pass `passed === total` at 0 === 0.
export async function laneSuccess({ taskKey, worktree, base, taskId, actor, since, until, tm8, checks, allowNoChecks = false }) {
  const task = checks ? { key: taskKey, check: checks } : TASKS.find((t) => t.key === taskKey);
  if (!task?.check?.length && !allowNoChecks) throw new Error(`task ${taskKey}: no hidden checks in fixture-data.mjs`);
  if (!task) throw new Error(`task ${taskKey}: unknown`);
  const git = (...a) => execFileSync('git', ['-C', worktree, ...a], { encoding: 'utf8' }).trim();
  const out = { committed: false, commits: 0, checks: { passed: 0, total: task.check.length, failures: [] }, testsPass: false, closeout: false, ticked: false };

  try {
    out.commits = Number(git('rev-list', '--count', `${base}..HEAD`));
    out.committed = out.commits > 0;
  } catch {
    /* worktree gone */
  }

  if (out.committed) {
    const dir = mkdtempSync(join(tmpdir(), 'i10a-success-'));
    try {
      execFileSync('sh', ['-c', `git -C '${worktree}' archive HEAD | tar -x -C '${dir}'`]);
      try {
        execFileSync('npm', ['test', '--silent'], { cwd: dir, stdio: 'pipe', timeout: 60_000 });
        out.testsPass = true;
      } catch {
        out.testsPass = false;
      }
      const mod = task.check.length ? await import(pathToFileURL(join(dir, 'src', 'ledger.js')).href + `?t=${Date.now()}`) : {};
      for (const [expr, want] of task.check) {
        let got;
        try {
          got = new Function(...Object.keys(mod), `return (${expr});`)(...Object.values(mod));
        } catch (e) {
          got = `throw: ${e.message}`;
        }
        if (Object.is(got, want) || (typeof want === 'number' && typeof got === 'number' && Math.abs(got - want) < 1e-9)) out.checks.passed++;
        else out.checks.failures.push({ expr, want, got });
      }
    } catch (e) {
      out.checks.failures.push({ error: String(e.message ?? e) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (tm8) {
    const list = tm8('message', 'list', '--for', taskId, '--order', 'newest', '--limit', '50');
    const items = list.items ?? list.page?.items;
    if (!Array.isArray(items)) throw new Error(`message list for ${taskId}: no items array (${Object.keys(list)})`);
    const t0 = Date.parse(since);
    const t1 = until ? Date.parse(until) : Infinity;
    if (!Number.isFinite(t0)) throw new Error(`--since ${since} is not a date`);
    out.closeout = items.some((m) => {
      // A listed message carries no timestamp; its uuidv7 id does (first 48 bits, ms).
      const at = parseInt(m.id.replace(/-/g, '').slice(0, 12), 16);
      // `createdBy` is the display NAME on a listed message; the id is state.author.id.
      const author = m.state?.author?.id ?? m.createdBy?.id ?? m.author?.id;
      return author === actor && at >= t0 && at <= t1;
    });
    const got = tm8('entity', 'get', taskId, '--full');
    const criteria = got.content?.acceptanceCriteria ?? [];
    out.ticked = criteria.length > 0 && criteria.every((c) => c.done);
  }

  out.success = out.committed && out.checks.passed === out.checks.total && out.closeout && out.ticked;
  out.deliverableCorrect = out.committed && out.checks.passed === out.checks.total;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const row = await laneSuccess({
    taskKey: arg('task-key'),
    worktree: arg('worktree'),
    base: arg('base'),
    taskId: arg('task-id'),
    actor: arg('actor'),
    since: arg('since'),
    until: arg('until'),
    tm8: process.env.TM8_CLI ? devCli() : null,
  });
  process.stdout.write(JSON.stringify(row) + '\n');
}
