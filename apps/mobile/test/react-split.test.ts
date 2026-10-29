/**
 * The React split (apps/mobile/README.md, "The React split"; scaffold probe
 * findings §B attempt 4). React 19 needs exact versions: React Native's
 * prebuilt renderer works only with the React it was built against, and
 * react-dom only with its own version. So the app takes the React its renderer
 * was built for (catalog "mobile"), tm8-ui keeps the React its react-dom
 * matches (catalog "web"), and the two never meet. When this fails the phone
 * app throws at launch while tsc and the rest of jest stay green.
 *
 * Resolution here is Node's own, run in a child process from each package's
 * real directory (test/node-resolve.cjs says why it cannot run inside Jest),
 * so the assertions see the layout bun actually installed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(__dirname, '..');
const REPO = join(APP, '..', '..');
const TM8_UI = join(REPO, 'packages', 'tm8-ui');

interface Resolved {
  version: string;
  /** The package's real directory (bun's isolated linker symlinks into node_modules/.bun). */
  dir: string;
}

function resolveFrom(fromDir: string, name: string): Resolved {
  const out = execFileSync(process.execPath, [join(__dirname, 'node-resolve.cjs'), fromDir, name], { encoding: 'utf8' });
  return JSON.parse(out) as Resolved;
}

/** The React each prebuilt renderer build records it was built against. */
function rendererBuiltFor(reactNativeDir: string): string[] {
  const builds = ['ReactFabric-dev.js', 'ReactFabric-prod.js', 'ReactFabric-profiling.js'];
  return builds.map((file) => {
    const source = readFileSync(join(reactNativeDir, 'Libraries', 'Renderer', 'implementations', file), 'utf8');
    const match = /reconcilerVersion:\s*"([^"]+)"/.exec(source);
    if (!match?.[1]) throw new Error(`no reconcilerVersion in react-native's ${file}`);
    return match[1];
  });
}

interface RootManifest {
  workspaces: { catalogs: Record<'web' | 'mobile', Record<'react' | 'react-dom', string>> };
  devDependencies: Record<string, string>;
  overrides?: Record<string, string>;
}

const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as RootManifest;

describe('apps/mobile runs the React its React Native renderer was built for', () => {
  const reactNative = resolveFrom(APP, 'react-native');
  const builtFor = rendererBuiltFor(reactNative.dir);
  const expected = builtFor[0];

  it('every prebuilt renderer build names the same React', () => {
    expect(new Set(builtFor).size).toBe(1);
  });

  it("the app's react is that exact version", () => {
    expect(resolveFrom(APP, 'react').version).toBe(expected);
  });

  it("react-native's own react (what its renderer imports) is that version", () => {
    expect(resolveFrom(reactNative.dir, 'react').version).toBe(expected);
  });

  it('react-dom for the RN-web QA harness matches it, and sees the same react', () => {
    const reactDom = resolveFrom(APP, 'react-dom');
    expect(reactDom.version).toBe(expected);
    expect(resolveFrom(reactDom.dir, 'react').dir).toBe(resolveFrom(APP, 'react').dir);
  });

  it('the renderer RN Testing Library renders with sees the same react', () => {
    const rntl = resolveFrom(APP, '@testing-library/react-native');
    const testRenderer = resolveFrom(rntl.dir, 'test-renderer');
    const reconciler = resolveFrom(testRenderer.dir, 'react-reconciler');
    expect(resolveFrom(reconciler.dir, 'react').dir).toBe(resolveFrom(APP, 'react').dir);
  });

  it('the react these tests load is that version', () => {
    // Through jest.config.js's moduleNameMapper: the copy every RNTL render uses.
    expect((jest.requireActual('react') as { version: string }).version).toBe(expected);
  });

  it('is the catalog "mobile" pin', () => {
    expect(root.workspaces.catalogs.mobile.react).toBe(expected);
    expect(root.workspaces.catalogs.mobile['react-dom']).toBe(expected);
  });
});

describe('packages/tm8-ui keeps one React, the one its react-dom matches', () => {
  const react = resolveFrom(TM8_UI, 'react');
  const reactDom = resolveFrom(TM8_UI, 'react-dom');

  it("tm8-ui's react equals its react-dom", () => {
    expect(react.version).toBe(reactDom.version);
  });

  it("react-dom and @testing-library/react resolve tm8-ui's own copy of react", () => {
    expect(resolveFrom(reactDom.dir, 'react').dir).toBe(react.dir);
    expect(resolveFrom(resolveFrom(TM8_UI, '@testing-library/react').dir, 'react').dir).toBe(react.dir);
  });

  it('is the catalog "web" pin, which the root devDependencies hold too', () => {
    expect(react.version).toBe(root.workspaces.catalogs.web.react);
    expect(reactDom.version).toBe(root.workspaces.catalogs.web['react-dom']);
    expect(root.devDependencies.react).toBe('catalog:web');
    expect(root.devDependencies['react-dom']).toBe('catalog:web');
  });

  it('no root override forces one React on both sides', () => {
    expect(root.overrides?.react).toBeUndefined();
    expect(root.overrides?.['react-dom']).toBeUndefined();
  });
});
