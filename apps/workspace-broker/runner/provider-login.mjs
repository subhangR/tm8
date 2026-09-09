// This supervisor runs only in the owner's container. A detached process
// group lets expiration and cancellation stop the CLI and all its children.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { providerConfig, loginFile } from './providers.mjs';
const [provider, sessionId] = process.argv.slice(2);
const config = providerConfig(provider);
const file = loginFile(sessionId);
process.umask(0o077);
await fs.mkdir('/home/user/.config/tm8', { recursive: true, mode: 0o700 });
const child = spawn(config.binary, config.login, { cwd: '/home/user', detached: true, stdio: 'inherit', env: { ...process.env, BROWSER: '/bin/true', DISABLE_AUTOUPDATER: '1' } });
const exited = new Promise(resolve => { child.once('exit', code => resolve(code)); child.once('error', () => resolve(1)); });
if (!child.pid) throw new Error('provider_start_failed');
await fs.writeFile(file, JSON.stringify({ pid: child.pid }), { mode: 0o600 });
const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
const timer = setTimeout(stop, 600000);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
const code = await exited;
clearTimeout(timer);
await fs.writeFile(file, JSON.stringify({ pid: child.pid, finished: true }), { mode: 0o600 });
process.exitCode = code ?? 1;
