/**
 * The §3 EBNF parser, and the allowlist defense it inherits.
 *
 * The prototype's comment recorded the bug that motivates the allowlist:
 * `tm8 --json task report progress …` silently ate `task` as the value of
 * `--json` and the verb vanished. Under the new grammar the same hole would
 * eat a NOUN, which is worse — the command either 404s or resolves to a
 * different command entirely. Both halves of the defense are tested here:
 * declared booleans never consume, and undeclared options never silently
 * degrade to `true`.
 */
import { describe, expect, it } from 'vitest';
import {
  BOOLEAN_OPTIONS,
  MAX_COMMAND_PATH_DEPTH,
  parseInvocation,
  parseSource,
  readJsonSource,
  readTextSource,
  splitCommandPath,
  type SourceIo,
} from '../src/args.js';
import { CliError } from '../src/exit.js';

function exitOf(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof CliError) return err.exitCode;
    throw err;
  }
  throw new Error('expected a CliError');
}

describe('the boolean allowlist defense', () => {
  it('a declared boolean does NOT eat the noun that follows it', () => {
    const parsed = parseInvocation(['--quiet', 'entity', 'get', 'ent_1']);
    expect(parsed.globals.quiet).toBe(true);
    expect(parsed.positionals).toEqual(['entity', 'get', 'ent_1']);
  });

  it('every §4 confirmation/toggle flag is declared, so none of them eat an argument', () => {
    for (const flag of ['yes', 'off', 'ready', 'unread', 'overwrite', 'force', 'grant-only', 'presence', 'confirm-untrusted', 'allow-tightening']) {
      expect(BOOLEAN_OPTIONS.has(flag), flag).toBe(true);
      const parsed = parseInvocation(['entity', 'delete', 'ent_1', `--${flag}`, 'trailing']);
      expect(parsed.options.bool(flag), flag).toBe(true);
      expect(parsed.positionals, flag).toEqual(['entity', 'delete', 'ent_1', 'trailing']);
    }
  });

  it('an undeclared option missing its value is a usage error, never a silent true', () => {
    expect(exitOf(() => parseInvocation(['entity', 'get', '--limit']))).toBe(2);
    // The prototype turned `--a --b` into `{a: true, b: …}`. Now it says so.
    expect(exitOf(() => parseInvocation(['--space', '--as', 'tm_1']))).toBe(2);
  });

  it('a value that genuinely starts with -- must be written with =', () => {
    const parsed = parseInvocation(['message', 'send', '--body=--not-a-flag']);
    expect(parsed.options.value('body')).toBe('--not-a-flag');
  });

  it('rejects short options outright — the grammar has none', () => {
    expect(exitOf(() => parseInvocation(['-f', 'json']))).toBe(2);
  });
});

describe('global options (§3)', () => {
  it('may appear before or after the command path', () => {
    const before = parseInvocation(['--space', 'sp_1', 'entity', 'get', 'ent_1']);
    const after = parseInvocation(['entity', 'get', 'ent_1', '--space', 'sp_1']);
    expect(before.globals.space).toBe('sp_1');
    expect(after.globals.space).toBe('sp_1');
    expect(before.positionals).toEqual(after.positionals);
  });

  it('are removed from the command options a command sees', () => {
    const parsed = parseInvocation(['entity', 'get', 'ent_1', '--space', 'sp_1', '--as', 'tm_1', '--format', 'json']);
    expect(parsed.options.names()).toEqual([]);
    expect(parsed.globals.as).toBe('tm_1');
    expect(parsed.globals.format).toBe('json');
  });

  it('default to human, colour on, not quiet', () => {
    const parsed = parseInvocation(['entity', 'get', 'ent_1']);
    expect(parsed.globals).toMatchObject({ format: 'human', color: true, quiet: false, space: undefined, as: undefined, timeoutMs: undefined });
  });

  it('--no-color clears colour', () => {
    expect(parseInvocation(['entity', 'get', '--no-color']).globals.color).toBe(false);
  });

  it('--format only accepts human|json|jsonl, and there is no --json flag', () => {
    expect(exitOf(() => parseInvocation(['--format', 'yaml', 'entity', 'get']))).toBe(2);
    // `--json` is retired: it is now just an undeclared option that demands a
    // value, which is exactly what stops it silently eating the noun.
    expect(exitOf(() => parseInvocation(['--json', 'entity', 'get']))).toBe(2);
  });

  it('--timeout is seconds, normalized to ms, and must be positive', () => {
    expect(parseInvocation(['--timeout', '2.5', 'entity', 'get']).globals.timeoutMs).toBe(2500);
    expect(exitOf(() => parseInvocation(['--timeout', '0', 'entity', 'get']))).toBe(2);
    expect(exitOf(() => parseInvocation(['--timeout', 'soon', 'entity', 'get']))).toBe(2);
  });

  it('a repeated scalar global is a usage error, not last-wins', () => {
    expect(exitOf(() => parseInvocation(['--space', 'sp_1', '--space', 'sp_2', 'entity', 'get']))).toBe(2);
  });
});

describe('literal -- and the stdin token', () => {
  it('stops option parsing: globals after it are passthrough, not globals', () => {
    const parsed = parseInvocation(['session', 'attach', 'ws_1', '--', '--space', 'sp_evil']);
    expect(parsed.globals.space).toBeUndefined();
    expect(parsed.passthrough).toEqual(['--space', 'sp_evil']);
  });

  it('bare - is a positional (stdin), not an option', () => {
    const parsed = parseInvocation(['message', 'send', '--to', 'ent_1', '-']);
    expect(parsed.positionals).toEqual(['message', 'send', '-']);
    expect(parsed.options.value('to')).toBe('ent_1');
  });

  it('accepts - as an option value', () => {
    expect(parseInvocation(['file', 'download', 'f_1', '--output', '-']).options.value('output')).toBe('-');
  });
});

describe('option arity', () => {
  it('values() is ordered and repeatable', () => {
    const parsed = parseInvocation(['message', 'send', '--to', 'ent_1', '--to', 'ent_2', 'hello']);
    expect(parsed.options.values('to')).toEqual(['ent_1', 'ent_2']);
  });

  it('value() refuses a repeated scalar', () => {
    const parsed = parseInvocation(['entity', 'update', 'ent_1', '--title', 'a', '--title', 'b']);
    expect(exitOf(() => parsed.options.value('title'))).toBe(2);
  });

  it('integer() validates', () => {
    const parsed = parseInvocation(['entity', 'children', 'ent_1', '--limit', '50']);
    expect(parsed.options.integer('limit')).toBe(50);
    const bad = parseInvocation(['entity', 'children', 'ent_1', '--limit', 'lots']);
    expect(exitOf(() => bad.options.integer('limit'))).toBe(2);
  });

  it('require() names the missing flag', () => {
    const parsed = parseInvocation(['entity', 'move', 'ent_1']);
    expect(exitOf(() => parsed.options.require('parent'))).toBe(2);
  });
});

describe('command-path splitting', () => {
  const known = new Set(['entity get', 'space task-axis create', 'space list', 'message attachment add']);
  const isCommandPath = (p: readonly string[]): boolean => known.has(p.join(' '));

  it('longest-match wins so a 3-token path is never read as a 2-token one plus an argument', () => {
    expect(splitCommandPath(['space', 'task-axis', 'create', 'Lane'], isCommandPath)).toEqual({
      path: ['space', 'task-axis', 'create'],
      args: ['Lane'],
    });
  });

  it('splits arguments off the path', () => {
    expect(splitCommandPath(['entity', 'get', 'ent_1'], isCommandPath)).toEqual({
      path: ['entity', 'get'],
      args: ['ent_1'],
    });
  });

  it('is undefined for an unregistered path — the registry is closed', () => {
    expect(splitCommandPath(['entity', 'yeet', 'ent_1'], isCommandPath)).toBeUndefined();
    expect(splitCommandPath([], isCommandPath)).toBeUndefined();
  });

  it('never consumes more than noun+subnoun+verb', () => {
    expect(MAX_COMMAND_PATH_DEPTH).toBe(3);
    const greedy = (p: readonly string[]): boolean => p.length === 4;
    expect(splitCommandPath(['a', 'b', 'c', 'd'], greedy)).toBeUndefined();
  });
});

describe('sources (§3, §7.3)', () => {
  const io: SourceIo = {
    readFile: (path) => (path === '/tmp/body.txt' ? 'from a file' : (() => { throw new Error('ENOENT'); })()),
    readStdin: async () => 'from stdin',
  };

  it('classifies inline / @path / -', () => {
    expect(parseSource('hello')).toEqual({ kind: 'inline', value: 'hello' });
    expect(parseSource('@/tmp/body.txt')).toEqual({ kind: 'file', path: '/tmp/body.txt' });
    expect(parseSource('-')).toEqual({ kind: 'stdin' });
  });

  it('reads each of the three', async () => {
    expect(await readTextSource('hello', io)).toBe('hello');
    expect(await readTextSource('@/tmp/body.txt', io)).toBe('from a file');
    expect(await readTextSource('-', io)).toBe('from stdin');
  });

  it('an unreadable @path is local validation (exit 2), not a request', async () => {
    await expect(readTextSource('@/nope', io)).rejects.toMatchObject({ exitCode: 2 });
  });

  it('invalid JSON never reaches the wire', async () => {
    await expect(readJsonSource('{not json', io)).rejects.toMatchObject({ exitCode: 2 });
    expect(await readJsonSource('{"a":1}', io)).toEqual({ a: 1 });
  });
});
