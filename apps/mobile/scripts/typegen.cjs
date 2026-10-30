// Typed routes for tsc without a dev server (s-lld §1: a typed Href turns a
// bad route into a compile error; scaffold probe findings §I).
//
// `expo start` writes .expo/types/router.d.ts and expo-env.d.ts, but
// `expo export` does not, and Expo CLI 58 has no typegen command, so a clean
// checkout's tsc would see no route types at all. This does what `expo start`
// does (@expo/cli build/src/start/server/type-generation/routes.js and
// expo-env.js): it sets EXPO_ROUTER_APP_ROOT and calls
// @expo/router-server's regenerateDeclarations, reached through @expo/cli's
// own resolution. That module path is internal to Expo, so
// scripts/typegen.test.ts pins it: an SDK bump that moves it fails there.
//
// Usage: node scripts/typegen.cjs [types-dir]   (default .expo/types)
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

// Verbatim from @expo/cli's expo-env.js.
const EXPO_ENV_DTS = `/// <reference types="expo/types" />

// NOTE: This file should not be edited and should be in your git ignore`;

function cliDir() {
  const expoDir = path.dirname(require.resolve('expo/package.json', { paths: [projectRoot] }));
  return path.dirname(require.resolve('@expo/cli/package.json', { paths: [expoDir] }));
}

function typedRoutesModulePath() {
  return require.resolve('@expo/router-server/build/typed-routes', { paths: [cliDir()] });
}

function routerPluginOptions() {
  // `expo start` passes exp.extra.router, which the expo-router config plugin fills.
  const { getConfig } = require(require.resolve('@expo/config', { paths: [cliDir()] }));
  const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });
  return exp.extra?.router;
}

function generate(typesDir) {
  process.env.EXPO_ROUTER_APP_ROOT = path.join(projectRoot, 'app');
  const typedRoutes = require(typedRoutesModulePath());
  fs.mkdirSync(typesDir, { recursive: true });
  typedRoutes.regenerateDeclarations(typesDir, routerPluginOptions());
  fs.writeFileSync(path.join(projectRoot, 'expo-env.d.ts'), EXPO_ENV_DTS);
  return path.join(typesDir, 'router.d.ts');
}

module.exports = { generate, typedRoutesModulePath };

if (require.main === module) {
  const typesDir = path.resolve(process.argv[2] ?? path.join(projectRoot, '.expo', 'types'));
  const written = generate(typesDir);
  console.log(`typegen: wrote ${path.relative(process.cwd(), written)}`);
}
