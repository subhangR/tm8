// The first image of every child the session host spawns (review R8).
//
// node-pty opens a PTY master WITHOUT FD_CLOEXEC (measured: fdinfo flags
// 0104002) and its Linux child path is forkpty -> chdir -> execvp, closing
// nothing (node-pty 1.1.0 src/unix/pty.cc:399-440). child_process.spawn does
// not close them either. So in a host holding N masters, agent N+1 would
// inherit every earlier agent's terminal — read AND write — exactly the leak
// measured on prod on 2026-09-26 (one agent held 23 other agents' masters).
// Node cannot fcntl, so the host cannot mark its masters close-on-exec; this
// shim closes every inherited fd > 2 that lacks O_CLOEXEC and then execve()s
// the real program. execve keeps the pid (node-pty's exit watcher stays valid)
// and the final argv is the real program's, so `ps` and every argv reader see
// the same process they saw before this existed.
//
// argv: node --no-warnings exec-clean.js <file> [args...]
// The environment is passed through untouched, with one exception: node and
// libuv read NODE_* and UV_* before this script runs (NODE_OPTIONS,
// NODE_V8_COVERAGE, NODE_COMPILE_CACHE ...), so the host never lets the SHIM
// see them. `wrapEnvForExecClean` parks them as JSON under RESTORE_KEY; the
// shim puts every one back for the real program.
import { accessSync, closeSync, constants, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const O_CLOEXEC = 0o2000000;

function closeInheritedFds(): void {
  for (const name of readdirSync('/proc/self/fd')) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    let info: string;
    try {
      info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
    } catch {
      continue; // the fd readdir itself held, already gone
    }
    const match = /flags:\s+([0-7]+)/.exec(info);
    if (!match) continue;
    // Node's own descriptors are all CLOEXEC and vanish at execve; closing
    // them here would break the runtime before it gets there.
    if ((parseInt(match[1]!, 8) & O_CLOEXEC) !== 0) continue;
    try {
      closeSync(fd);
    } catch {
      // EBADF: raced with its own close. Nothing to leak.
    }
  }
}

function resolveExecutable(file: string, env: NodeJS.ProcessEnv): string {
  if (file.includes('/')) return file;
  for (const dir of (env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, file);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return file;
}

const RESTORE_KEY = 'TM8_EXEC_CLEAN_ENV';

const [file, ...args] = process.argv.slice(2);
if (!file) {
  process.stderr.write('exec-clean: no program given\n');
  process.exit(127);
}
closeInheritedFds();
const execve = (process as unknown as { execve?: (f: string, a: string[], e: NodeJS.ProcessEnv) => never }).execve;
if (typeof execve !== 'function') {
  process.stderr.write('exec-clean: this node has no process.execve; refusing to run with inherited fds\n');
  process.exit(127);
}
const env: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  // Anything node or libuv set for THIS shim is not the agent's.
  if (key === RESTORE_KEY || key.startsWith('NODE_') || key.startsWith('UV_')) continue;
  env[key] = value;
}
if (process.env[RESTORE_KEY] !== undefined) {
  try {
    Object.assign(env, JSON.parse(process.env[RESTORE_KEY]) as Record<string, string>);
  } catch {
    process.stderr.write('exec-clean: unreadable parked environment; refusing to run\n');
    process.exit(127);
  }
}
const resolved = resolveExecutable(file, env);
try {
  execve(resolved, [file, ...args], env);
} catch (error) {
  process.stderr.write(`exec-clean: execve ${resolved} failed: ${(error as Error).message}\n`);
  process.exit(127);
}
