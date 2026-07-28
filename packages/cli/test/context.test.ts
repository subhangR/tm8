/**
 * §3 context resolution: flag → session → config → implicit local Server.
 *
 * The precedence itself is the contract, but the assertion that matters most
 * is the one about AUTHORITY: `--as` selects an author and never asserts the
 * right to be one. If this layer ever started deciding act-as legitimacy, the
 * Server's answer would become advisory.
 */
import { describe, expect, it } from 'vitest';
import {
  IMPLICIT_LOCAL_BASE_URL,
  loadLocalConfig,
  requireSpace,
  resolveContext,
  sessionContextFromEnv,
  type ConfigIo,
} from '../src/context.js';
import { parseInvocation } from '../src/args.js';
import { CliError } from '../src/exit.js';

const globals = (argv: string[]) => parseInvocation(argv).globals;

describe('the four steps, in order', () => {
  const session = { spaceId: 'sp_session', actorId: 'tm_session', baseUrl: 'http://127.0.0.1:9999' };
  const config = { space: 'sp_config', as: 'tm_config', baseUrl: 'http://config.local' };

  it('1 — an explicit flag wins over everything', () => {
    const ctx = resolveContext({ globals: globals(['--space', 'sp_flag', '--as', 'tm_flag']), session, config });
    expect(ctx.space).toEqual({ value: 'sp_flag', source: 'flag' });
    expect(ctx.actor).toEqual({ value: 'tm_flag', source: 'flag' });
  });

  it('2 — session-injected context wins over local config', () => {
    const ctx = resolveContext({ globals: globals([]), session, config });
    expect(ctx.space).toEqual({ value: 'sp_session', source: 'session' });
    expect(ctx.actor).toEqual({ value: 'tm_session', source: 'session' });
    expect(ctx.baseUrl).toEqual({ value: 'http://127.0.0.1:9999', source: 'session' });
  });

  it('3 — local config is used when nothing was injected', () => {
    const ctx = resolveContext({ globals: globals([]), session: {}, config });
    expect(ctx.space).toEqual({ value: 'sp_config', source: 'config' });
    expect(ctx.baseUrl).toEqual({ value: 'http://config.local', source: 'config' });
  });

  it('4 — the Phase-1 implicit local Server is the last resort, and only for the Server', () => {
    const ctx = resolveContext({ globals: globals([]), session: {}, config: {} });
    expect(ctx.baseUrl).toEqual({ value: IMPLICIT_LOCAL_BASE_URL, source: 'implicit-local' });
    // No Space and no actor are invented: the Server resolves the caller's own.
    expect(ctx.space).toBeUndefined();
    expect(ctx.actor).toBeUndefined();
  });

  it('records WHICH step produced each value — a stale config is otherwise invisible', () => {
    const ctx = resolveContext({ globals: globals(['--space', 'sp_flag']), session, config });
    expect(ctx.space?.source).toBe('flag');
    expect(ctx.actor?.source).toBe('session');
  });
});

describe('--as selects an author, it never asserts authorization', () => {
  it('adds no credential and changes no token', () => {
    const ctx = resolveContext({
      globals: globals(['--as', 'tm_someone_else']),
      session: { token: 'tok_session' },
      config: {},
    });
    expect(ctx.actor).toEqual({ value: 'tm_someone_else', source: 'flag' });
    expect(ctx.token).toBe('tok_session');
  });
});

describe('session context from env', () => {
  it('reads the spawn env and treats blank as absent', () => {
    expect(
      sessionContextFromEnv({
        TM8_SESSION_ID: 'ws_1',
        TM8_SPACE_ID: '  ',
        TM8_BASE_URL: 'http://127.0.0.1:4610',
        TM8_AGENT_TOKEN: 'tok',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      sessionId: 'ws_1',
      spaceId: undefined,
      actorId: undefined,
      baseUrl: 'http://127.0.0.1:4610',
      token: 'tok',
    });
  });
});

describe('local configuration is convenience, not a dependency', () => {
  const throwing: ConfigIo = { readFile: () => { throw new Error('ENOENT'); } };

  it('an absent default config is simply absent', () => {
    expect(loadLocalConfig({ HOME: '/nowhere' } as NodeJS.ProcessEnv, throwing)).toEqual({});
  });

  it('a corrupt default config does not take the session down', () => {
    expect(loadLocalConfig({ HOME: '/nowhere' } as NodeJS.ProcessEnv, { readFile: () => '{oops' })).toEqual({});
  });

  it('but an explicitly named TM8_CONFIG_PATH that cannot be read IS an error', () => {
    expect(() => loadLocalConfig({ TM8_CONFIG_PATH: '/tmp/x.json' } as NodeJS.ProcessEnv, throwing)).toThrowError(CliError);
    expect(() =>
      loadLocalConfig({ TM8_CONFIG_PATH: '/tmp/x.json' } as NodeJS.ProcessEnv, { readFile: () => '{oops' }),
    ).toThrowError(/not valid JSON/);
  });

  it('keeps only known keys and a legal format', () => {
    const io: ConfigIo = {
      readFile: () => JSON.stringify({ space: 'sp_1', as: 'tm_1', format: 'yaml', nonsense: 5 }),
    };
    expect(loadLocalConfig({ TM8_CONFIG_PATH: '/tmp/c.json' } as NodeJS.ProcessEnv, io)).toEqual({
      space: 'sp_1',
      as: 'tm_1',
    });
  });
});

describe('requireSpace', () => {
  it('names all four steps rather than just failing', () => {
    const ctx = resolveContext({ globals: globals([]), session: {}, config: {} });
    try {
      requireSpace(ctx);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).message).toMatch(/--space/);
      expect((err as CliError).message).toMatch(/session/);
      expect((err as CliError).message).toMatch(/config/);
    }
  });

  it('returns the resolved Space when there is one', () => {
    expect(requireSpace(resolveContext({ globals: globals(['--space', 'sp_9']), session: {}, config: {} }))).toBe('sp_9');
  });
});
