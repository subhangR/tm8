/**
 * Review F03: the agent-side boundary probe (design doc 01a1fe13, section 2), checked without being
 * run.
 *
 * deploy/vault/boundary-probe.py must not run on this host or any other until the owner approves a
 * staging run. Nothing here runs it. boundary-probe-check.py reads its source from stdin and only
 * parses and compiles it. This test runs that checker under GUARD, which ends the process before
 * anything executes code from outside the checker and the standard library. It then compares the
 * probe's lists with the constants they mirror here.
 *
 * A missing python3 fails every test here. None is skipped.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONTAINER_SOCKETS } from '@tm8/vault/relay';
import { FORBIDDEN_AGENT_GROUPS } from '../../src/vault/boundary.js';

const REPO = resolve(__dirname, '../../../..');
const PROBE = join(REPO, 'deploy/vault/boundary-probe.py');
const CHECKER = join(__dirname, 'boundary-probe-check.py');
const BROKER_MAIN = join(REPO, 'packages/vault/src/broker/main.ts');

/** The design's checks in its order. The doc calls it a 24-check probe; its table has these 23. */
const DESIGN_CHECKS = ['I1', 'I2', 'I3', 'K1', 'K2', 'K3', 'K4', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6',
  'H1', 'H2', 'H3', 'H4', 'D1', 'D2', 'D3', 'W1', 'N1', 'N2'];
const STATIC_CHECKS = ['checks_table', 'counts', 'detail_formats', 'error_names', 'imports', 'metadata',
  'module_attributes', 'names', 'object_attributes', 'parses', 'pinned_calls', 'pinned_functions',
  'positive_control', 'ptrace', 'reads', 'refusals', 'top_level'];
const CHECKER_IMPORTS = ['ast', 'builtins', 'ctypes', 'errno', 'glob', 'grp', 'http.client', 'json', 'os', 're',
  'shutil', 'socket', 'ssl', 'stat', 'subprocess', 'symtable', 'sys', 'tempfile', 'warnings'];

/**
 * Runs the script named in argv[1] and calls its main(), under audit hooks (PEP 578) added after
 * the imports below and before the script's code runs. The process ends with exit 97, before the
 * act, if code from anywhere but that script and the standard library would execute, a function or
 * code object would be constructed directly (types.FunctionType, types.CodeType), a process, signal,
 * socket or library call would start, a file would be removed or changed, or a file would be opened
 * outside those two places or for writing.
 */
const GUARD_EXIT = 97;
const GUARD = String.raw`
import ast, builtins, ctypes, errno, glob, grp, http.client, inspect, json, os, re, shutil, socket, ssl, stat
import subprocess, symtable, sys, sysconfig, tempfile, types, warnings

script = os.path.realpath(sys.argv[1])
with open(script, 'rb') as handle:
    code = compile(handle.read(), script, 'exec', dont_inherit=True)
roots = tuple(sorted({os.path.join(os.path.realpath(sysconfig.get_paths()[key]), '') for key in ('stdlib', 'platstdlib')}))
DENIED = ('code.', 'function.', 'subprocess.', 'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.fork',
          'pty.', 'os.kill', 'signal.', 'socket.', 'http.', 'urllib.', 'ctypes.', 'os.remove', 'os.rename',
          'os.rmdir', 'os.mkdir', 'os.chmod', 'os.chown', 'os.truncate', 'os.symlink', 'os.link', 'os.utime',
          'os.putenv', 'os.unsetenv', 'shutil.', 'tempfile.', 'webbrowser.', 'marshal.', 'pickle.')
WRITE = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND


def refuse(event):
    os.write(2, ('boundary probe guard: refused ' + event + '\n').encode())
    os._exit(97)


def inside(path):
    if not isinstance(path, (str, bytes)):
        return False
    path = os.path.realpath(os.fsdecode(path))
    return path == script or path.startswith(roots)


def hook(event, args):
    if event.startswith(DENIED):
        refuse(event)
    if event == 'exec':
        name = getattr(args[0], 'co_filename', None)
        if not (isinstance(name, str) and (name.startswith('<frozen ') or inside(name))):
            refuse(event)
    if event == 'open':
        path, mode, flags = args
        if not inside(path) or (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (isinstance(flags, int) and flags & WRITE):
            refuse(event)


sys.dont_write_bytecode = True
sys.addaudithook(hook)
namespace = {'__name__': 'boundary_probe_check', '__file__': script, '__builtins__': builtins}
exec(code, namespace)
sys.exit(namespace['main']())
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-probe-check-'));
  dirs.push(dir);
  return dir;
}

function guarded(script: string, input: Buffer | string, cwd: string) {
  return spawnSync('python3', ['-I', '-c', GUARD, script], {
    input,
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 60_000,
    encoding: 'utf8',
  });
}

interface Report { checks: Record<string, string[]>; facts: Record<string, unknown> }
let report: Report | undefined;

/** The checker's report on the probe, made once. Not getting one fails the test that asked. */
function probeReport(): Report {
  if (report === undefined) {
    const run = guarded(CHECKER, readFileSync(PROBE), scratch());
    expect(run.error, 'python3 must run: a missing interpreter fails this test').toBeUndefined();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    report = JSON.parse(run.stdout) as Report;
  }
  return report;
}

describe('the boundary probe (F03), checked without being run', () => {
  it('is a plain file: not executable, with no interpreter line', () => {
    expect(statSync(PROBE).mode & 0o111).toBe(0);
    expect(readFileSync(PROBE, 'utf8').startsWith('#!')).toBe(false);
  });

  it('gets exactly the static checks this test expects', () => {
    expect(Object.keys(probeReport().checks).sort()).toEqual([...STATIC_CHECKS].sort());
  });

  it.each(STATIC_CHECKS)('passes the static check %s', (name) => {
    expect(probeReport().checks[name]).toEqual([]);
  });

  it("runs the design's 23 checks in its order, with K1, P1 and D1 as the positive control", () => {
    const { facts } = probeReport();
    expect(facts.check_ids).toEqual(DESIGN_CHECKS);
    expect(facts.control_checks).toEqual(['K1', 'P1', 'D1']);
  });

  it('looks for the groups, container sockets and vault sockets the relay and the broker use', () => {
    const { facts } = probeReport();
    expect(facts.forbidden_groups).toEqual([...FORBIDDEN_AGENT_GROUPS]);
    expect(facts.container_sockets).toEqual([...CONTAINER_SOCKETS]);
    const docker = facts.docker_sockets as string[];
    expect(docker.length).toBeGreaterThan(0);
    for (const path of docker) expect(CONTAINER_SOCKETS).toContain(path);
    const main = readFileSync(BROKER_MAIN, 'utf8');
    const broker = /^export const DEFAULT_BROKER_SOCKET = '([^']+)';$/m.exec(main)?.[1];
    const fill = /^export const DEFAULT_FILL_SOCKET = '([^']+)';$/m.exec(main)?.[1];
    expect(broker).toBeDefined();
    expect(fill).toBeDefined();
    expect(facts.default_vault_sockets).toEqual([broker, fill]);
  });

  it("asks the metadata server for the service account's email only, and seizes rather than attaches", () => {
    const { facts } = probeReport();
    expect(facts.metadata_path).toBe('/computeMetadata/v1/instance/service-accounts/default/email');
    expect(facts.ptrace_seize).toBe(0x4206);
  });
});

/** Scripts the guard must stop, with the audit event it names. None of them is the probe. */
const GUARD_CONTROLS: [string, string, string][] = [
  ['executes code it compiled', "def main():\n    exec(compile('value = 1', '<string>', 'exec'), {})\n    return 0\n", 'exec'],
  ['builds a function from a code object',
    "import types\n\n\ndef main():\n    code = compile('def f():\\n    return 1\\n', 'other.py', 'exec')\n"
    + "    inner = [c for c in code.co_consts if hasattr(c, 'co_code')][0]\n    types.FunctionType(inner, {})()\n    return 0\n",
    'function.__new__'],
  ['starts a process', "import subprocess\n\n\ndef main():\n    subprocess.run(['true'])\n    return 0\n", 'subprocess.Popen'],
  ['loads a library', "import ctypes\n\n\ndef main():\n    ctypes.CDLL(None)\n    return 0\n", 'ctypes.dlopen'],
  ['reads a file it was not given', "def main():\n    open('other.txt', 'rb').close()\n    return 0\n", 'open'],
  ['writes a file', "def main():\n    open('written.txt', 'w').close()\n    return 0\n", 'open'],
  ['opens a socket', "import socket\n\n\ndef main():\n    socket.socket()\n    return 0\n", 'socket.__new__'],
  ['sends a signal', "import os\n\n\ndef main():\n    os.kill(os.getpid(), 0)\n    return 0\n", 'os.kill'],
  ['removes a file', "import os\n\n\ndef main():\n    os.remove('other.txt')\n    return 0\n", 'os.remove'],
];

describe('the checker cannot run the probe', () => {
  it('imports only the standard library, at the top, and has no way to execute code', () => {
    const text = readFileSync(CHECKER, 'utf8');
    expect([...text.matchAll(/^import ([\w.]+)$/gm)].map((match) => match[1])).toEqual(CHECKER_IMPORTS);
    expect(text).not.toMatch(/^[ \t]*from[ \t]/m);
    expect(text).not.toMatch(/^[ \t]+import[ \t]/m);
    for (const pattern of [/(?<![\w.])(?:exec|eval)\s*\(/, /\brunpy\b/, /\bimportlib\b/, /__import__/, /\bspec_from/,
      /\bexec_module\b/, /\bload_module\b/, /\bsys\.path\b/, /\bmarshal\b/, /\bpickle\b/, /\bFunctionType\b/,
      /\bCodeType\b/, /^\s*import types\b/m]) {
      expect(text, String(pattern)).not.toMatch(pattern);
    }
  });

  it('the guard lets through a script that only reads its stdin and writes its stdout', () => {
    const dir = scratch();
    const script = join(dir, 'plain.py');
    writeFileSync(script, 'import sys\n\n\ndef main():\n    sys.stdout.write(sys.stdin.read().upper())\n    return 0\n');
    const run = guarded(script, 'synthetic', dir);
    expect(run.error).toBeUndefined();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('SYNTHETIC');
  });

  it.each(GUARD_CONTROLS)('the guard ends a script that %s, before it does', (_what, source, event) => {
    const dir = scratch();
    const script = join(dir, 'control.py');
    writeFileSync(script, source);
    writeFileSync(join(dir, 'other.txt'), 'synthetic\n');
    const run = guarded(script, '', dir);
    expect(run.error).toBeUndefined();
    expect(run.stderr).toBe(`boundary probe guard: refused ${event}\n`);
    expect(run.status).toBe(GUARD_EXIT);
    expect(run.stdout).toBe('');
    expect(existsSync(join(dir, 'written.txt'))).toBe(false);
    expect(existsSync(join(dir, 'other.txt'))).toBe(true);
  });
});
