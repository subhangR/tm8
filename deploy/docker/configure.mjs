import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
const file = new URL('../../.env', import.meta.url);
let contents = '';
try { contents = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const key of ['TM8_RUNTIME_DB_PASSWORD', 'TM8_DELIVERY_DB_PASSWORD', 'TM8_ENROLLMENT_DB_PASSWORD']) {
  if (!new RegExp(`^${key}=`, 'm').test(contents)) contents += `\n${key}=${randomBytes(32).toString('base64url')}\n`;
}
await writeFile(file, contents, { mode: 0o600 }); await chmod(file, 0o600);
process.stdout.write('Local database credentials configured in the ignored .env file.\n');
