/**
 * `tm8 device register|update|unregister` — the phones that get your push
 * notifications from this node (migration 392, TM8 Mobile S1; s-lld §11
 * "Registration").
 *
 * The TM8 Mobile app calls these doors over HTTP when it signs in, when the OS
 * rotates its push token, and first thing on sign-out; these verbs let a human
 * script and check the same doors. Human sessions only, like every
 * `credentials.*` row: the Server refuses an agent token, and no `--as` is
 * ever sent — the strict bodies refuse `actorId`.
 *
 * THE TOKEN NEVER TOUCHES ARGV. A push token is a credential to reach a phone,
 * and a command-line value lands in shell history and `ps`. `--token` takes
 * `-` (stdin) or `@<file>` only; an inline value is refused here and never
 * sent. Nothing prints it: the Server answers no token, and the renderers show
 * the device id, version and settings only.
 */
import type { DeviceWriteResult, DevicesUnregisterResult } from '@tm8/contract';

import { parseSource, readTextSource } from '../args.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, requireArg } from './entity.js';

/** Read `--token` from stdin or a file. The value is never echoed, not even in an error. */
async function readToken(cmd: CommandContext): Promise<string | undefined> {
  const raw = cmd.options.value('token');
  if (raw === undefined) return undefined;
  if (parseSource(raw).kind === 'inline') {
    throw new CliError('--token takes - (stdin) or @<file>, never the token itself', EXIT_USAGE, {
      hint: 'a token on the command line lands in shell history and ps; pipe it: printf %s "$TOKEN" | tm8 device register --token - …',
    });
  }
  const token = (await readTextSource(raw)).trim();
  if (token === '') throw new CliError('--token read an empty token', EXIT_USAGE);
  return token;
}

function requireValue(cmd: CommandContext, name: string): string {
  const value = cmd.options.value(name);
  if (value === undefined || value === '') {
    throw new CliError(`\`tm8 ${cmd.path.join(' ')}\` requires --${name}`, EXIT_USAGE);
  }
  return value;
}

/** `--quiet-until <iso>` sets it; `--quiet-until none` clears it (update only). */
function quietUntil(cmd: CommandContext, allowNone: boolean): string | null | undefined {
  const raw = cmd.options.value('quiet-until');
  if (raw === undefined) return undefined;
  if (raw === 'none') {
    if (allowNone) return null;
    throw new CliError('--quiet-until none clears quiet hours on `tm8 device update`; omit it here', EXIT_USAGE);
  }
  return raw;
}

function render(dto: DeviceWriteResult): string {
  const d = dto.device;
  const quiet = d.quietUntil === null ? 'not quiet' : `quiet until ${d.quietUntil}`;
  return [
    `device ${dto.deviceId} v${String(d.version)}`,
    `${d.label} · ${d.platform} · relay ${d.relay} · previews ${d.previews} · ${quiet}`,
  ].join('\n');
}

function renderUnregister(dto: DevicesUnregisterResult): string {
  return dto.unregistered
    ? `unregistered device ${dto.deviceId}`
    : `nothing to unregister: no device ${dto.deviceId} of yours on this server`;
}

async function deviceRegister(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['platform', 'relay', 'token', 'app-version', 'locale', 'label', 'previews', 'quiet-until', 'mutation-id']);
  if (cmd.args.length > 0) throw new CliError('`tm8 device register` takes no positional argument', EXIT_USAGE);
  const token = await readToken(cmd);
  if (token === undefined) throw new CliError('`tm8 device register` requires --token - or --token @<file>', EXIT_USAGE);
  const previews = cmd.options.value('previews');
  const quiet = quietUntil(cmd, false);
  const data = await observedInvoke<DeviceWriteResult>(clientFor(cmd.ctx), 'devices.register', {
    body: {
      platform: requireValue(cmd, 'platform'),
      relay: cmd.options.value('relay') ?? 'expo',
      token,
      appVersion: requireValue(cmd, 'app-version'),
      locale: requireValue(cmd, 'locale'),
      label: requireValue(cmd, 'label'),
      ...(previews === undefined ? {} : { previews }),
      ...(quiet === undefined ? {} : { quietUntil: quiet }),
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    },
  });
  cmd.out.data(data, render);
  return EXIT_OK;
}

async function deviceUpdate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'token', 'app-version', 'locale', 'label', 'previews', 'quiet-until', 'mutation-id']);
  const deviceId = requireArg(cmd, 0, '<device-id>');
  if (cmd.args.length > 1) throw new CliError('`tm8 device update` takes one <device-id>', EXIT_USAGE);
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) {
    throw new CliError('`tm8 device update` requires --expect-version <n>', EXIT_USAGE, {
      hint: 'the version is in the register or update answer (`device <id> v<n>`)',
    });
  }
  const token = await readToken(cmd);
  const quiet = quietUntil(cmd, true);
  const change: Record<string, unknown> = {
    ...(token === undefined ? {} : { token }),
    ...(cmd.options.value('app-version') === undefined ? {} : { appVersion: cmd.options.value('app-version') }),
    ...(cmd.options.value('locale') === undefined ? {} : { locale: cmd.options.value('locale') }),
    ...(cmd.options.value('label') === undefined ? {} : { label: cmd.options.value('label') }),
    ...(cmd.options.value('previews') === undefined ? {} : { previews: cmd.options.value('previews') }),
    ...(quiet === undefined ? {} : { quietUntil: quiet }),
  };
  if (Object.keys(change).length === 0) {
    throw new CliError('`tm8 device update` needs something to change', EXIT_USAGE, {
      hint: 'one of --token, --app-version, --locale, --label, --previews or --quiet-until',
    });
  }
  const data = await observedInvoke<DeviceWriteResult>(clientFor(cmd.ctx), 'devices.update', {
    params: { deviceId },
    body: { ...change, expectedVersion, clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, render);
  return EXIT_OK;
}

async function deviceUnregister(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'mutation-id']);
  const deviceId = requireArg(cmd, 0, '<device-id>');
  if (cmd.args.length > 1) throw new CliError('`tm8 device unregister` takes one <device-id>', EXIT_USAGE);
  const expectedVersion = cmd.options.integer('expect-version');
  const data = await observedInvoke<DevicesUnregisterResult>(clientFor(cmd.ctx), 'devices.unregister', {
    params: { deviceId },
    body: {
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    },
  });
  cmd.out.data(data, renderUnregister);
  return EXIT_OK;
}

export const DEVICE_COMMANDS: CommandModule[] = [
  { path: ['device', 'register'], run: deviceRegister },
  { path: ['device', 'update'], run: deviceUpdate },
  { path: ['device', 'unregister'], run: deviceUnregister },
];
