/**
 * The `doctor` gate's verdict (scripts/doctor.cjs; DoD G5). expo-doctor cannot
 * pass in this workspace, so the gate allows exactly what G5 allows and fails
 * on everything else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the gate is a CommonJS node script
const { parseDoctor, verdict } = require('./doctor.cjs') as typeof import('./doctor.cjs');

const ISOLATED = readFileSync(join(__dirname, '__fixtures__', 'expo-doctor-isolated.txt'), 'utf8');
const REACT_SPLIT = { react: ['19.2.8', '19.3.0'], 'react-dom': ['19.2.8', '19.3.0'] };

function doctorOutput(failed: string[], body = ''): string {
  return [
    `Running 20 checks on your project...`,
    `${20 - failed.length}/20 checks passed. ${failed.length} checks failed. Possible issues detected:`,
    '',
    ...failed.map((title) => `✖ ${title}`),
    body,
  ].join('\n');
}

const DUPLICATES = 'Check that no duplicate dependencies are installed';
const SDK_VERSIONS = 'Check that packages match versions required by installed Expo SDK';

describe('parseDoctor', () => {
  it("reads this app's real output under bun's isolated linker (2026-10-29)", () => {
    const { failed, duplicates } = parseDoctor(ISOLATED);
    expect(failed).toEqual([DUPLICATES]);
    expect(duplicates.size).toBe(13);
    expect([...(duplicates.get('expo') ?? [])]).toEqual(['58.0.21']);
    expect([...(duplicates.get('react-native') ?? [])]).toEqual(['0.88.1']);
    expect([...(duplicates.get('@expo/metro-runtime') ?? [])]).toEqual(['58.0.15']);
  });
});

describe('verdict', () => {
  it('passes the isolated layout: every duplicate is one version kept once per peer set', () => {
    expect(verdict({ doctorOutput: ISOLATED, offlineCheckOk: true, reactSplit: REACT_SPLIT })).toMatchObject({ ok: true, problems: [] });
  });

  it("passes the React split as bun's hoisted linker reports it (probe §D)", () => {
    const output = doctorOutput(
      [DUPLICATES],
      [
        'Found duplicates for react:',
        '  ├─ react@19.3.0 (at: node_modules/react)',
        '  └─ react@19.2.8 (at: ../../node_modules/react)',
        'Found duplicates for react-dom:',
        '  ├─ react-dom@19.3.0 (at: node_modules/react-dom)',
        '  └─ react-dom@19.2.8 (at: ../../node_modules/react-dom)',
      ].join('\n'),
    );
    expect(verdict({ doctorOutput: output, offlineCheckOk: true, reactSplit: REACT_SPLIT }).ok).toBe(true);
  });

  it('fails a React that is neither catalog version', () => {
    const output = doctorOutput(
      [DUPLICATES],
      ['Found duplicates for react:', '  ├─ react@19.3.0 (at: node_modules/react)', '  └─ react@19.3.1 (at: ../../node_modules/react)'].join('\n'),
    );
    expect(verdict({ doctorOutput: output, offlineCheckOk: true, reactSplit: REACT_SPLIT })).toMatchObject({
      ok: false,
      problems: ['react is installed at 19.3.0, 19.3.1'],
    });
  });

  it('fails a native module installed at two versions', () => {
    const output = doctorOutput(
      [DUPLICATES],
      [
        'Found duplicates for expo-modules-core:',
        '  ├─ expo-modules-core@58.0.28 (at: node_modules/expo-modules-core)',
        '  └─ expo-modules-core@58.0.27 (at: ../../node_modules/.bun/x/node_modules/expo-modules-core)',
      ].join('\n'),
    );
    expect(verdict({ doctorOutput: output, offlineCheckOk: true, reactSplit: REACT_SPLIT }).problems).toEqual([
      'expo-modules-core is installed at 58.0.28, 58.0.27',
    ]);
  });

  it('fails the duplicate check when it lists nothing it can read', () => {
    expect(verdict({ doctorOutput: doctorOutput([DUPLICATES]), offlineCheckOk: true, reactSplit: REACT_SPLIT }).ok).toBe(false);
  });

  it("tolerates the SDK-versions check only while the SDK's own bundledNativeModules.json agrees (versions API lag)", () => {
    const output = doctorOutput([SDK_VERSIONS]);
    expect(verdict({ doctorOutput: output, offlineCheckOk: true, reactSplit: REACT_SPLIT }).ok).toBe(true);
    expect(verdict({ doctorOutput: output, offlineCheckOk: false, reactSplit: REACT_SPLIT })).toMatchObject({
      ok: false,
      problems: [SDK_VERSIONS],
    });
  });

  it('fails any other check', () => {
    const output = doctorOutput(['Check for app config fields that may not be synced in a non-CNG project']);
    expect(verdict({ doctorOutput: output, offlineCheckOk: true, reactSplit: REACT_SPLIT })).toMatchObject({
      ok: false,
      problems: ['Check for app config fields that may not be synced in a non-CNG project'],
    });
  });

  it('fails output it cannot read at all', () => {
    expect(verdict({ doctorOutput: 'Error: something else entirely', offlineCheckOk: true, reactSplit: REACT_SPLIT }).ok).toBe(false);
  });
});
