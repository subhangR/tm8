// `bun run doctor`: Expo's health checks, gated the way DoD G5 reads them
// (apps/mobile/README.md, "Expo health").
//
// expo-doctor cannot pass in this workspace. Its duplicate check reports the
// intended React split under bun's hoisted linker, and same-version copies
// kept once per peer set under the isolated one; Metro's autolinking module
// resolution bundles one copy either way. The check takes no exclusions. So
// this runs expo-doctor and both `expo install --check` forms, prints all
// three, and fails on anything G5 does not allow:
//   - the duplicate check passes only while every package it names has one
//     version, or is react/react-dom at exactly the two catalog versions;
//   - the SDK-versions check passes only while `EXPO_OFFLINE=1 expo install
//     --check` (the SDK's own bundledNativeModules.json) exits 0, because
//     Expo's versions API lags a fresh release;
//   - `EXPO_OFFLINE=1 expo install --check` must exit 0. The online form is
//     reported, not gated: typescript is in expo.install.exclude (README).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const DUPLICATES = 'Check that no duplicate dependencies are installed';
const SDK_VERSIONS = 'Check that packages match versions required by installed Expo SDK';

/**
 * @param {string} output expo-doctor's stdout and stderr
 * @returns {{ failed: string[], duplicates: Map<string, Set<string>> }}
 */
function parseDoctor(output) {
  const failed = [...output.matchAll(/^✖ (.+)$/gm)].map((match) => match[1].trim());
  /** @type {Map<string, Set<string>>} */
  const duplicates = new Map();
  /** @type {Set<string> | undefined} */
  let versions;
  let name = '';
  for (const line of output.split('\n')) {
    const head = /^Found duplicates for (.+):$/.exec(line.trim());
    if (head) {
      name = head[1];
      versions = new Set();
      duplicates.set(name, versions);
      continue;
    }
    const entry = /[├└]─ (.+)@([^@\s]+) \(at: /.exec(line);
    if (versions && entry && entry[1] === name) versions.add(entry[2]);
  }
  return { failed, duplicates };
}

/**
 * @param {{ doctorOutput: string, offlineCheckOk: boolean, reactSplit: Record<string, string[]> }} input
 * @returns {{ ok: boolean, failed: string[], problems: string[] }}
 */
function verdict({ doctorOutput, offlineCheckOk, reactSplit }) {
  const { failed, duplicates } = parseDoctor(doctorOutput);
  /** @type {string[]} */
  const problems = [];
  if (failed.length === 0 && !/\d+\/\d+ checks passed/.test(doctorOutput)) {
    problems.push('expo-doctor printed no result this gate can read');
  }
  for (const title of failed) {
    if (title === DUPLICATES) {
      if (duplicates.size === 0) problems.push(`${DUPLICATES}: listed no duplicate this gate can read`);
      for (const [name, found] of duplicates) {
        const allowed = reactSplit[name];
        const isSplit = allowed !== undefined && [...found].every((version) => allowed.includes(version));
        if (found.size > 1 && !isSplit) problems.push(`${name} is installed at ${[...found].join(', ')}`);
      }
    } else if (!(title === SDK_VERSIONS && offlineCheckOk)) {
      problems.push(title);
    }
  }
  return { ok: problems.length === 0, failed, problems };
}

/** @returns {Record<string, string[]>} react and react-dom at the root's two catalog versions */
function reactSplitFromCatalogs() {
  const root = JSON.parse(fs.readFileSync(path.join(projectRoot, '..', '..', 'package.json'), 'utf8'));
  const { web, mobile } = root.workspaces.catalogs;
  return { react: [web.react, mobile.react], 'react-dom': [web['react-dom'], mobile['react-dom']] };
}

/** @param {string[]} args @param {Record<string, string>} [env] */
function run(args, env = {}) {
  const result = spawnSync('npx', args, { cwd: projectRoot, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function main() {
  const doctor = run(['expo-doctor']);
  const offline = run(['expo', 'install', '--check'], { EXPO_OFFLINE: '1' });
  const online = run(['expo', 'install', '--check']);
  const result = verdict({ doctorOutput: doctor.output, offlineCheckOk: offline.status === 0, reactSplit: reactSplitFromCatalogs() });

  console.log(`── expo-doctor (exit ${doctor.status})\n${doctor.output}\n`);
  console.log(`── EXPO_OFFLINE=1 expo install --check (exit ${offline.status})\n${offline.output}\n`);
  console.log(`── expo install --check (exit ${online.status}, reported, not gated)\n${online.output}\n`);
  console.log(`── doctor: expo-doctor failed ${result.failed.length} check(s): ${result.failed.join('; ') || 'none'}`);
  if (result.problems.length > 0) console.log(`── doctor: FAIL\n${result.problems.map((p) => `  - ${p}`).join('\n')}`);
  if (offline.status !== 0) console.log('── doctor: FAIL, the offline dependency check did not exit 0');
  const ok = result.ok && offline.status === 0;
  if (ok) console.log('── doctor: PASS (only the failures DoD G5 allows)');
  process.exitCode = ok ? 0 : 1;
}

module.exports = { parseDoctor, verdict };

if (require.main === module) main();
