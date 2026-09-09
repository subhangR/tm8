import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { executionDirectory } from './execution.mjs';
process.umask(0o077);
const dir = executionDirectory(process.argv[2]);
const command = JSON.parse(await fs.readFile(`${dir}/launch.json`, 'utf8'));
if (!['/usr/local/bin/claude', '/usr/local/bin/codex'].includes(command.binary)) throw new Error('unsupported_agent_tool');
const child = spawn(command.binary, command.args, { cwd: command.cwd, detached: true, stdio: 'inherit',
  env: { ...process.env, HOME: '/home/user', BROWSER: '/bin/true', DISABLE_AUTOUPDATER: '1' } });
const exited = new Promise(resolve => { child.once('exit', code => resolve(code ?? 137)); child.once('error', () => resolve(1)); });
const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
let started = null;
try {
  const stat = await fs.readFile(`/proc/${child.pid}/stat`, 'utf8');
  started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  await fs.writeFile(`${dir}/process.json`, JSON.stringify({ pid: child.pid, started }), { mode: 0o600 });
} catch { stop(); }
const code = await exited;
stop(); // do not leave subprocesses behind when the provider exits
await fs.writeFile(`${dir}/process.json`, JSON.stringify({ pid: child.pid, started, finished: true, exitCode: code }), { mode: 0o600 });
process.exitCode = code;
