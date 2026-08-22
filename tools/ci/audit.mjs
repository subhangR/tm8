#!/usr/bin/env node
// tm8 dependency audit gate.
//
// `bun audit` reports EVERY advisory that matches the lockfile, and this repo
// starts with a backlog of 13 that cannot be cleared without major upgrades
// (vitest 2 -> 4 across six workspaces, vite 5 -> 7 for the esbuild advisory).
// A gate that simply fails on a non-empty report would be red on main from the
// first commit, and a gate that is always red is a gate nobody reads.
//
// So the gate is differential: every advisory currently known is written down in
// .github/audit-baseline.json with a reason and a review-by date, and the build
// fails only on an advisory that is NOT in that file. That makes "a PR added a
// vulnerable package" a hard red while the known backlog stays visible and
// dated instead of silently suppressed.
//
// Usage:
//   node tools/ci/audit.mjs                  # gate at the default level (high)
//   node tools/ci/audit.mjs --level=moderate # stricter
//   node tools/ci/audit.mjs --update-baseline
//
// Exit codes: 0 clean, 1 un-baselined advisory at/above the level, 2 tool error.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BASELINE = resolve(REPO, '.github/audit-baseline.json')

const ORDER = ['low', 'moderate', 'high', 'critical']
const argv = process.argv.slice(2)
const levelArg = argv.find((a) => a.startsWith('--level='))
const LEVEL = levelArg ? levelArg.slice('--level='.length) : 'high'
const UPDATE = argv.includes('--update-baseline')

if (!ORDER.includes(LEVEL)) {
  console.error(`audit: unknown --level=${LEVEL} (expected one of ${ORDER.join(', ')})`)
  process.exit(2)
}

// --- collect -----------------------------------------------------------------

// `bun audit` resolves straight from bun.lock, so this needs no node_modules and
// no install step in CI. It exits non-zero when it finds anything, which is not
// an error here — only a failure to produce JSON is.
const run = spawnSync('bun', ['audit', '--json'], { cwd: REPO, encoding: 'utf8' })
if (run.error) {
  console.error(`audit: could not run \`bun audit\`: ${run.error.message}`)
  process.exit(2)
}

let report
try {
  report = JSON.parse(run.stdout)
} catch {
  console.error('audit: `bun audit --json` did not produce JSON')
  console.error(run.stdout?.slice(0, 2000) || run.stderr?.slice(0, 2000) || '(no output)')
  process.exit(2)
}

/** @type {{key: string, pkg: string, ghsa: string, severity: string, title: string, url: string, versions: string}[]} */
const found = []
for (const [pkg, advisories] of Object.entries(report ?? {})) {
  for (const a of advisories ?? []) {
    const ghsa = String(a.url ?? '').split('/').pop() || `id-${a.id}`
    found.push({
      key: `${pkg}:${ghsa}`,
      pkg,
      ghsa,
      severity: String(a.severity ?? 'unknown'),
      title: String(a.title ?? ''),
      url: String(a.url ?? ''),
      versions: String(a.vulnerable_versions ?? ''),
    })
  }
}
found.sort((a, b) => ORDER.indexOf(b.severity) - ORDER.indexOf(a.severity) || a.key.localeCompare(b.key))

// --- baseline ----------------------------------------------------------------

if (UPDATE) {
  const today = new Date().toISOString().slice(0, 10)
  const reviewBy = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10)
  const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { accepted: {} }
  const accepted = {}
  for (const f of found) {
    accepted[f.key] = prev.accepted?.[f.key] ?? {
      severity: f.severity,
      title: f.title,
      url: f.url,
      vulnerableVersions: f.versions,
      reason: 'TODO: why this is accepted, and what unblocks the fix',
      acceptedOn: today,
      reviewBy,
    }
  }
  writeFileSync(BASELINE, JSON.stringify({ accepted }, null, 2) + '\n')
  console.log(`audit: wrote ${Object.keys(accepted).length} entries to ${BASELINE}`)
  process.exit(0)
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { accepted: {} }
const accepted = baseline.accepted ?? {}

const threshold = ORDER.indexOf(LEVEL)
const gated = found.filter((f) => ORDER.indexOf(f.severity) >= threshold)
const unexpected = gated.filter((f) => !accepted[f.key])
const stale = Object.entries(accepted).filter(
  ([, v]) => v.reviewBy && v.reviewBy < new Date().toISOString().slice(0, 10),
)
// An entry that no longer matches any advisory means the dependency was fixed —
// the line should come out of the baseline so the file keeps describing reality.
const obsolete = Object.keys(accepted).filter((k) => !found.some((f) => f.key === k))

// --- report ------------------------------------------------------------------

const lines = []
const say = (s = '') => {
  lines.push(s)
  console.log(s)
}

const counts = ORDER.map((s) => `${found.filter((f) => f.severity === s).length} ${s}`).reverse()
say(`## Dependency audit`)
say('')
say(`${found.length} advisories in \`bun.lock\` (${counts.join(', ')}); gating at **${LEVEL}** and above.`)
say('')

if (unexpected.length) {
  say(`### ❌ ${unexpected.length} un-baselined advisor${unexpected.length === 1 ? 'y' : 'ies'}`)
  say('')
  for (const f of unexpected) say(`- **${f.severity}** \`${f.pkg}\` ${f.versions} — ${f.title} (${f.url})`)
  say('')
  say(
    'Fix the dependency, or — if it genuinely cannot be fixed yet — record it with a reason ' +
      'and a review-by date via `node tools/ci/audit.mjs --update-baseline`.',
  )
  say('')
}

if (stale.length) {
  say(`### ⚠️ ${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} past review-by`)
  say('')
  for (const [k, v] of stale) say(`- \`${k}\` — due ${v.reviewBy}: ${v.reason}`)
  say('')
}

if (obsolete.length) {
  say(`### 🧹 ${obsolete.length} baseline entr${obsolete.length === 1 ? 'y' : 'ies'} no longer reported (drop them)`)
  say('')
  for (const k of obsolete) say(`- \`${k}\``)
  say('')
}

if (!unexpected.length && !stale.length && !obsolete.length) {
  say(`### ✅ No un-baselined advisories at ${LEVEL} or above.`)
  say('')
}

if (found.length) {
  say('<details><summary>Full advisory list</summary>')
  say('')
  for (const f of found) {
    const mark = accepted[f.key] ? 'baselined' : 'NEW'
    say(`- [${mark}] **${f.severity}** \`${f.pkg}\` ${f.versions} — ${f.title}`)
  }
  say('')
  say('</details>')
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
}

process.exit(unexpected.length ? 1 : 0)
