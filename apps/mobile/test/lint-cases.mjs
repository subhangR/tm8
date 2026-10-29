// Lints in-memory snippets with this app's real ESLint config, in a child
// process: ESLint loads eslint.config.mjs with a dynamic import(), which Jest's
// module sandbox cannot run. Nothing is written to disk; each snippet is linted
// as if it sat at its filePath.
//
// Usage: node test/lint-cases.mjs < cases.json
//   cases.json:  [{ "filePath": "src/ui/x.ts", "code": "…" }, …]
//   prints:      [{ "filePath": …, "messages": [{ "ruleId", "message", "line" }] }, …]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(0, 'utf8'));
const eslint = new ESLint({ cwd: appRoot });

const results = [];
for (const { filePath, code } of cases) {
  const [result] = await eslint.lintText(code, { filePath: path.join(appRoot, filePath) });
  results.push({ filePath, messages: result.messages.map(({ ruleId, message, line }) => ({ ruleId, message, line })) });
}
process.stdout.write(JSON.stringify(results));
