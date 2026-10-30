// Learn more https://docs.expo.dev/guides/monorepos/
//
// Expo SDK 58 detects the bun workspace on its own: getDefaultConfig sets
// watchFolders and nodeModulesPaths, and the CLI turns on autolinking module
// resolution, which bundles exactly one react, react-dom, react-native,
// react-native-web and native module — the app's — whichever linker laid out
// node_modules. Do not set resolver.disableHierarchicalLookup: bun's isolated
// linker keeps transitive dependencies under node_modules/.bun, and only
// hierarchical lookup reaches them.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
