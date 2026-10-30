// Node's own module resolution, run in a child process. Inside Jest, require,
// require.resolve and even node:module's createRequire go through Jest's
// module registry and apply jest.config.js's moduleNameMapper, which pins
// `react` to this app's copy. A layout test asked from inside Jest would
// therefore always see the app's React, whatever bun installed.
//
// Usage: node test/node-resolve.cjs <from-dir> <package>
//   prints {"version": "<x.y.z>", "dir": "<the package's real directory>"}
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const [fromDir, name] = process.argv.slice(2);
if (!fromDir || !name) throw new Error('usage: node test/node-resolve.cjs <from-dir> <package>');
const manifest = createRequire(path.join(path.resolve(fromDir), 'package.json')).resolve(`${name}/package.json`);
const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
process.stdout.write(JSON.stringify({ version, dir: fs.realpathSync(path.dirname(manifest)) }));
