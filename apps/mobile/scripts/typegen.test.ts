/**
 * scripts/typegen.cjs calls a module internal to Expo (the one `expo start`
 * calls to write typed routes). This pins that path, so an SDK bump that moves
 * it fails here with its name rather than as a typecheck that silently stops
 * knowing the routes, and checks that the declarations name this app's routes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TYPEGEN = join(__dirname, 'typegen.cjs');

it("reaches @expo/router-server's typed-routes module through @expo/cli", () => {
  const resolved = execFileSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(TYPEGEN)}).typedRoutesModulePath())`], {
    encoding: 'utf8',
  });
  expect(resolved).toMatch(/[\\/]@expo[\\/]router-server[\\/]build[\\/]typed-routes[\\/]index\.js$/);
});

it("writes router.d.ts declaring this app's routes", () => {
  const typesDir = mkdtempSync(join(tmpdir(), 'tm8-mobile-typegen-'));
  try {
    execFileSync(process.execPath, [TYPEGEN, typesDir], { encoding: 'utf8' });
    const declarations = readFileSync(join(typesDir, 'router.d.ts'), 'utf8');
    expect(declarations).toContain("declare module 'expo-router'");
    expect(declarations).toContain('pathname: `/`');
  } finally {
    rmSync(typesDir, { recursive: true, force: true });
  }
});
