const path = require('path');
const { transformIgnorePatterns } = require('jest-expo/jest-preset');

const reactDir = path.dirname(require.resolve('react/package.json'));
const babelRuntimeDir = path.dirname(require.resolve('@babel/runtime/package.json'));

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // jest-expo's allow-list knows pnpm's store (node_modules/.pnpm) but not bun's
  // isolated one (node_modules/.bun), so React Native's ESM jest setup would
  // reach Jest untransformed.
  transformIgnorePatterns: transformIgnorePatterns.map((pattern) =>
    pattern.replace('(?!(.pnpm|', '(?!(.pnpm|.bun|'),
  ),
  // One React in every test: this app's (catalog "mobile"). Under bun's hoisted
  // linker react-native sits at the workspace root beside tm8-ui's React 19.2.8
  // and would load that one.
  moduleNameMapper: {
    '^react$': path.join(reactDir, 'index.js'),
    '^react/(.*)$': path.join(reactDir, '$1'),
    // Babel adds @babel/runtime helper imports to every file it transforms,
    // including workspace dist such as packages/contract/dist, which cannot
    // resolve them from its own directory under the isolated linker.
    '^@babel/runtime/(.*)$': path.join(babelRuntimeDir, '$1'),
  },
};
