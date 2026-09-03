/**
 * `tm8 container …` — the machine noun (TM8-CONTAINERS-DESIGN §14).
 *
 * A container is an entity, so its READS are not here: `entity get`,
 * `entity children`, `entity connections` and `entity query --kind container`
 * already answer them, and §4.5 is explicit that only `containers.logs` and
 * `containers.providers.list` are family-specific reads — because their truth
 * is on the node, not in the graph. THERE IS NO `containers.get`. A verb here
 * that re-spelled `entity get` would be a second way to ask a question the
 * graph already answers, which is how a closed catalog stops being closed.
 *
 * WHY EVERY VERB EXISTS EVEN THOUGH TEN OF THEM ANSWER 501 IN P0.
 * Fifteen of the twenty-five operations have no runtime behind them yet. They
 * are still registered server-side and they still have a verb here, because
 * the alternative is a 404 — and a `status: 'v1'` catalog row that 404s breaks
 * DEV-13. A caller who runs `tm8 container snapshot` today gets an honest
 * `not_implemented` naming the reason, which is a fact they can act on; a
 * missing command would tell them the capability does not exist, which is
 * false. The parse, the closed-set checks and the bounds below all run BEFORE
 * the request, so a caller learns about a typo from the CLI and about the
 * missing runtime from the node — never one disguised as the other.
 *
 * THE BOUNDS IN THIS FILE ARE THE SERVER'S OWN, RESTATED (§4.2 zod table).
 * `--cpus 64` is refused here rather than sent, and the refusal names the
 * range. That is not the CLI second-guessing the Server: the numbers come from
 * the same frozen table the `.strict()` schemas are built from, and a caller
 * who gets `invalid_spec` back after a round trip has learned the same thing
 * more slowly. Where a question is genuinely the SERVER'S — whether a provider
 * satisfies the isolation policy, whether this actor may drive the surface,
 * whether the node has budget — nothing is pre-judged here.
 *
 * SECRETS ARE REFUSED BY KEY AND THE VALUE IS NEVER ECHOED (§12.3). `--env`
 * takes non-secret configuration only. A key that looks like a credential is
 * refused with the KEY named and the value absent from the message, the
 * diagnostic, and the journal — a refusal that printed the secret to explain
 * why it was refused would be worse than sending it.
 *
 * `--expect-version` IS MANDATORY WHERE THE CATALOG SAYS SO and absent
 * everywhere else. The eleven record-changing verbs (start, stop, pause,
 * resume, destroy, update, policy, expose, unexpose, snapshot, pool) require
 * it; create, run, terminal, attach, computer, fork and attention do not,
 * because they either mint the record or act on the runtime without moving the
 * entity's version. Reads refuse `--mutation-id` outright.
 *
 * A MOUNT CANNOT BE ROUND-TRIPPED, DELIBERATELY (ruling R5, lane B's
 * AMENDMENT 1). `--mount <host>:<guest>[:ro]` still takes a host path, because
 * the INPUT side still has one — but `internal.command_entity` embeds the
 * entity content in the command result a client receives, so host paths and
 * native runtime ids are subtracted server-side and never come back. Nothing
 * here renders a host path read from an entity, and nothing should: after
 * create, `entity get` shows `{ guest, ro }` and that is the whole truth a
 * client is given.
 */
import { readTextSource } from '../args.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { assertKnownOptions } from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

// ── the closed vocabularies (§4.2) ─────────────────────────────────────────
//
// Every one is checked HERE with the whole set named in the diagnostic. A
// caller who wrote `--network strict` has a wrong model of the vocabulary, and
// telling them only that `strict` is wrong leaves them guessing a second time.

/** §9's profiles. The only positional `container create` takes. */
const PROFILES = ['shell', 'desktop', 'browser', 'android', 'ios', 'dind', 'custom'] as const;

const NETWORK_PRESETS = ['open', 'balanced', 'locked'] as const;

/**
 * The work_session share vocabulary, deliberately reused (§4.2) so one share
 * widget serves both kinds. NOT the port-share vocabulary below — `explicit`
 * and `link` are different words for different things and merging them would
 * silently widen an exposed port's audience.
 */
const SHARE_MODES = ['none', 'space', 'explicit'] as const;

/** Exposed-port sharing. `link` has no work_session analogue. */
const PORT_SHARES = ['none', 'space', 'link'] as const;

/** What `containers.attach` may grant. NOT `terminal` (that is the exec PTY,
 *  reached through `container terminal`) and NOT `http` (that is the proxy). */
const ATTACH_SURFACES = ['screen', 'browser', 'adb', 'docker'] as const;

const ATTACH_MODES = ['view', 'drive'] as const;

/**
 * §7.2's action vocabulary — deliberately the intersection of Anthropic's
 * computer-use tool, Playwright and adb, so a computer-use-capable model can
 * be wired in without translation. One vocabulary, three drivers.
 */
const COMPUTER_ACTIONS = [
  'screenshot', 'click', 'double_click', 'right_click', 'move',
  'drag', 'type', 'key', 'scroll', 'wait', 'goto', 'text',
] as const;

/** The browser sub-verbs. `endpoint` is its own operation; `goto` and `text`
 *  are `containers.computer` actions with a friendlier spelling. */
const BROWSER_ACTIONS = ['endpoint', 'goto', 'text'] as const;

const ATTENTION_REASONS = ['login', 'captcha', '2fa', 'payment', 'approval', 'other'] as const;

/**
 * A closed-set option, with the whole set in the diagnostic.
 * Same helper shape as `session.ts`'s — one vocabulary for one job.
 */
function closed<T extends string>(
  flag: string,
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined) return undefined;
  const found = allowed.find((a) => a === raw);
  if (found === undefined) {
    throw new CliError(`--${flag} expects ${allowed.join('|')}, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return found;
}

/** The positional flavour of the same check, for `<profile>` and `<action>`. */
function closedArg<T extends string>(
  command: string,
  label: string,
  raw: string | undefined,
  allowed: readonly T[],
): T {
  if (raw === undefined) {
    throw new CliError(`tm8 ${command} requires ${label} (${allowed.join('|')})`, EXIT_USAGE);
  }
  const found = allowed.find((a) => a === raw);
  if (found === undefined) {
    throw new CliError(
      `${label} expects ${allowed.join('|')}, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return found;
}

// ── bounds, restated from the frozen zod table (§4.2) ──────────────────────

/** A bounded integer option. Absent stays absent — an omitted flag is not a
 *  default being sent, it is the Server's default being left alone. */
function boundedInt(
  cmd: CommandContext,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  const value = cmd.options.integer(flag);
  if (value === undefined) return undefined;
  if (value < min || value > max) {
    throw new CliError(`--${flag} must be between ${min} and ${max}, got ${value}`, EXIT_USAGE);
  }
  return value;
}

/** The one fractional bound in the table (`cpus`, `scale`). */
function boundedNumber(
  cmd: CommandContext,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  const raw = cmd.options.value(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError(`--${flag} expects a number, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  if (value < min || value > max) {
    throw new CliError(`--${flag} must be between ${min} and ${max}, got ${raw}`, EXIT_USAGE);
  }
  return value;
}

/**
 * §12.3's secret-env refusal, restated key-for-key from the frozen table.
 *
 * THE VALUE IS NEVER IN THE MESSAGE. A diagnostic that printed the secret to
 * explain why it refused the secret would put it in the caller's scrollback,
 * their shell history and this process's journal — three places it was never
 * going to reach if the command had simply succeeded.
 */
const SECRET_KEY_PATTERN =
  /(^|_)(SECRET|SECRETS|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|SESSION_KEY|AUTH|BEARER)(_|$)/;

const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'TM8_AGENT_TOKEN',
]);

function isSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_KEY_NAMES.has(upper) || SECRET_KEY_PATTERN.test(upper);
}

/**
 * `--env K=V`, repeatable. At most 256 keys, and a credential-looking key is
 * refused rather than carried into the machine — secrets reach a machine
 * through the credential path, never through `spec.env`.
 */
function parseEnv(values: readonly string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const pair of values) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new CliError(`--env expects K=V, got ${JSON.stringify(pair)}`, EXIT_USAGE);
    }
    const key = pair.slice(0, eq);
    if (isSecretKey(key)) {
      throw new CliError(
        `--env ${key} looks like a credential and is refused; its value was not read, sent, or logged`,
        EXIT_USAGE,
        {
          hint:
            'secrets reach a machine through the credential path, never through spec.env (§12.3) — ' +
            'pass non-secret configuration here and nothing else',
        },
      );
    }
    env[key] = pair.slice(eq + 1);
  }
  const count = Object.keys(env).length;
  if (count > 256) {
    throw new CliError(`--env accepts at most 256 keys, got ${count}`, EXIT_USAGE);
  }
  return env;
}

/** `--label K=V`, repeatable. No secret check: labels are metadata the node
 *  writes onto the runtime object, and `tm8.container`/`tm8.space` are added
 *  server-side whatever a caller sends. */
function parseLabels(values: readonly string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const labels: Record<string, string> = {};
  for (const pair of values) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new CliError(`--label expects K=V, got ${JSON.stringify(pair)}`, EXIT_USAGE);
    }
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

/**
 * `--mount <host>:<guest>[:ro]`, repeatable, at most 16.
 *
 * The `host` half is WRITE-ONLY by law (R5): it is accepted here, it reaches
 * the node, and it never comes back through `entity get`. `guest` must be
 * absolute — a relative guest path has no meaning inside a machine whose
 * working directory the caller does not control.
 */
function parseMounts(values: readonly string[]): Array<Record<string, unknown>> | undefined {
  if (values.length === 0) return undefined;
  if (values.length > 16) {
    throw new CliError(`--mount accepts at most 16 entries, got ${values.length}`, EXIT_USAGE);
  }
  return values.map((raw) => {
    const parts = raw.split(':');
    if (parts.length < 2 || parts.length > 3) {
      throw new CliError(
        `--mount expects <host>:<guest>[:ro], got ${JSON.stringify(raw)}`,
        EXIT_USAGE,
      );
    }
    const [host, guest, flag] = parts as [string, string, string | undefined];
    if (host.length === 0 || guest.length === 0) {
      throw new CliError(`--mount host and guest must both be non-empty: ${JSON.stringify(raw)}`, EXIT_USAGE);
    }
    if (!guest.startsWith('/')) {
      throw new CliError(
        `--mount guest path must be absolute, got ${JSON.stringify(guest)}`,
        EXIT_USAGE,
      );
    }
    if (flag !== undefined && flag !== 'ro') {
      throw new CliError(
        `--mount third field must be \`ro\` when present, got ${JSON.stringify(flag)}`,
        EXIT_USAGE,
      );
    }
    return { host, guest, ro: flag === 'ro' };
  });
}

/** `--port <n>`, repeatable, at most 32, each 1–65535. */
function parsePorts(values: readonly string[]): number[] | undefined {
  if (values.length === 0) return undefined;
  if (values.length > 32) {
    throw new CliError(`--port accepts at most 32 entries, got ${values.length}`, EXIT_USAGE);
  }
  return values.map((raw) => port(raw, '--port'));
}

function port(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliError(`${label} expects an integer, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  const value = Number(raw);
  if (value < 1 || value > 65535) {
    throw new CliError(`${label} must be between 1 and 65535, got ${raw}`, EXIT_USAGE);
  }
  return value;
}

/** `--allow <host>`, repeatable: at most 256 entries, each at most 253 chars
 *  (the DNS name limit — an "allowlist entry" longer than a legal hostname is
 *  a typo, not a rule). */
function parseAllow(values: readonly string[]): string[] {
  if (values.length > 256) {
    throw new CliError(`--allow accepts at most 256 entries, got ${values.length}`, EXIT_USAGE);
  }
  for (const host of values) {
    if (host.length > 253) {
      throw new CliError(`--allow entries must be at most 253 characters, got ${host.length}`, EXIT_USAGE);
    }
  }
  return [...values];
}

// ── shared argument shapes ─────────────────────────────────────────────────

function requireContainerId(command: string, raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`tm8 ${command} requires a <container-id>`, EXIT_USAGE, {
      hint: 'a container is an entity — list them with `tm8 entity query --kind container`',
    });
  }
  return raw;
}

/**
 * The version guard, MANDATORY on every record-changing verb.
 *
 * Not defaulted from a read, and deliberately so: a CLI that fetched the
 * current version and sent it back would defeat the guard entirely — the
 * guard's whole job is to fail when the caller's belief about the record is
 * stale, and a freshly-read version is never stale.
 */
function requireExpectVersion(command: string, cmd: CommandContext): number {
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) {
    throw new CliError(`\`tm8 ${command}\` requires --expect-version <n>`, EXIT_USAGE, {
      hint: 'read the current version with `tm8 entity get <container-id>`',
    });
  }
  if (expectedVersion < 0) {
    throw new CliError(`--expect-version expects a non-negative version, got ${expectedVersion}`, EXIT_USAGE);
  }
  return expectedVersion;
}

/** `--ephemeral` and `--persistent` are the two halves of one boolean. Passing
 *  both is a caller who believes two contradictory things about the machine's
 *  lifetime, so it is refused rather than resolved by precedence. */
function ephemeralFrom(cmd: CommandContext): boolean | undefined {
  const ephemeral = cmd.options.bool('ephemeral');
  const persistent = cmd.options.bool('persistent');
  if (ephemeral && persistent) {
    throw new CliError('--ephemeral and --persistent are opposites; pass at most one', EXIT_USAGE);
  }
  if (ephemeral) return true;
  if (persistent) return false;
  return undefined;
}

/** The lifecycle sub-object, shared by `create` and `update`. Omitted entirely
 *  when the caller named none of its parts. */
function lifecycleFrom(cmd: CommandContext): Record<string, unknown> | undefined {
  const lifecycle: Record<string, unknown> = {};
  const ephemeral = ephemeralFrom(cmd);
  if (ephemeral !== undefined) lifecycle.ephemeral = ephemeral;
  const ttl = boundedInt(cmd, 'ttl', 60, 604800);
  if (ttl !== undefined) lifecycle.ttlSeconds = ttl;
  const idle = boundedInt(cmd, 'idle-hibernate', 60, 604800);
  if (idle !== undefined) lifecycle.idleHibernateSeconds = idle;
  const grace = boundedInt(cmd, 'grace', 0, 86400);
  if (grace !== undefined) lifecycle.graceSeconds = grace;
  if (cmd.options.bool('snapshot-on-stop')) lifecycle.snapshotOnStop = true;
  return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
}

/** Every mutation carries the caller's actor when one resolved, exactly as the
 *  other noun modules do. */
function withActor(cmd: CommandContext, body: Record<string, unknown>): Record<string, unknown> {
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  return body;
}

// ── renderers ──────────────────────────────────────────────────────────────

/**
 * `--format json` and the human view render the SAME DTO — the renderer only
 * chooses what to show, never re-fetches or re-computes. Every field is read
 * defensively from both the camelCase projection and the detail row's
 * snake_case, for the reason `worktree.ts` gives: a renderer that guessed one
 * shape prints "unknown" for every field and looks like a data problem.
 */
interface ContainerFacts {
  status?: unknown;
  profile?: unknown;
  provider?: unknown;
  isolation?: unknown;
  nodeId?: unknown;
  node_id?: unknown;
  image?: unknown;
  surfaces?: unknown;
  startedAt?: unknown;
  started_at?: unknown;
  expiresAt?: unknown;
  expires_at?: unknown;
  error?: unknown;
}

function factsOf(row: Record<string, unknown>): ContainerFacts {
  return {
    ...((row.state ?? {}) as ContainerFacts),
    ...((row.content ?? {}) as ContainerFacts),
  };
}

function entityOf(dto: unknown): Record<string, unknown> {
  const record = (dto ?? {}) as Record<string, unknown>;
  // A CommandResult carries the entity under `entity`; a plain read is the
  // entity. Both shapes reach this renderer, so both are read.
  const nested = record.entity;
  return (nested && typeof nested === 'object' ? nested : record) as Record<string, unknown>;
}

function renderContainer(dto: unknown): string {
  const row = entityOf(dto);
  const f = factsOf(row);
  const lines = [
    `${String(row.id ?? '(no id)')}  ${String(f.status ?? 'unknown')}`,
    `profile:   ${String(f.profile ?? 'unknown')}`,
    `provider:  ${String(f.provider ?? 'unknown')}  isolation ${String(f.isolation ?? 'unknown')}`,
    `node:      ${String(f.nodeId ?? f.node_id ?? 'unknown')}`,
  ];
  if (row.version !== undefined) lines.push(`version:   ${String(row.version)}`);
  const surfaces = Array.isArray(f.surfaces) ? f.surfaces : [];
  if (surfaces.length > 0) lines.push(`surfaces:  ${surfaces.map(String).join(', ')}`);
  const expires = f.expiresAt ?? f.expires_at;
  if (expires) lines.push(`expires:   ${String(expires)}`);
  if (f.error) lines.push(`error:     ${String(f.error)}`);
  // The next act, named. A caller who just created a machine has one obvious
  // next question and the version guard makes it a two-step.
  lines.push('', 'read it live: tm8 entity get <container-id>');
  return lines.join('\n');
}

function renderProviders(dto: unknown): string {
  const data = (dto ?? {}) as {
    nodeId?: unknown;
    providers?: Array<Record<string, unknown>>;
    images?: Array<Record<string, unknown>>;
    caps?: Record<string, unknown>;
  };
  const providers = Array.isArray(data.providers) ? data.providers : [];
  if (providers.length === 0) {
    return `node ${String(data.nodeId ?? 'unknown')} has no container providers`;
  }
  const lines = [`node ${String(data.nodeId ?? 'unknown')}`, ''];
  for (const p of providers) {
    const probe = (p.probe ?? {}) as Record<string, unknown>;
    // The probe verdict FIRST, because it is the only field produced by
    // actually creating and destroying a container rather than by declaration.
    const ok = probe.ok === true ? 'ok' : 'FAILING';
    lines.push(`${String(p.id ?? '?')}  ${ok}  isolation ${String(p.isolation ?? '?')}`);
    const profiles = Array.isArray(p.profiles) ? p.profiles : [];
    if (profiles.length > 0) lines.push(`  profiles: ${profiles.map(String).join(', ')}`);
    const surfaces = Array.isArray(p.surfaces) ? p.surfaces : [];
    if (surfaces.length > 0) lines.push(`  surfaces: ${surfaces.map(String).join(', ')}`);
    if (probe.detail) lines.push(`  probe:    ${String(probe.detail)}`);
    if (probe.measuredAt) lines.push(`  measured: ${String(probe.measuredAt)}`);
  }
  const caps = data.caps ?? {};
  if (Object.keys(caps).length > 0) {
    lines.push('', `capacity: ${String(caps.live ?? '?')} live of ${String(caps.containers ?? '?')}`);
  }
  return lines.join('\n');
}

function renderRun(dto: unknown): string {
  const r = (dto ?? {}) as {
    exitCode?: unknown; stdout?: unknown; stderr?: unknown;
    truncated?: unknown; durationMs?: unknown; timedOut?: unknown;
  };
  const lines: string[] = [];
  if (typeof r.stdout === 'string' && r.stdout.length > 0) lines.push(r.stdout.replace(/\n$/, ''));
  if (typeof r.stderr === 'string' && r.stderr.length > 0) lines.push(r.stderr.replace(/\n$/, ''));
  // The exit code is ALWAYS printed, including 0: a caller reading a human
  // rendering has no other way to tell "produced no output" from "failed
  // silently", and `null` (killed) from `0`.
  const exit = r.exitCode === null ? 'null (no exit code — the process was killed)' : String(r.exitCode);
  lines.push(`exit ${exit}${r.timedOut === true ? ' (timed out)' : ''}`);
  if (r.truncated === true) lines.push('output truncated — the full stream is in `tm8 container logs`');
  return lines.join('\n');
}

function renderLogs(dto: unknown): string {
  const page = (dto ?? {}) as { lines?: Array<Record<string, unknown>>; truncated?: unknown };
  const entries = Array.isArray(page.lines) ? page.lines : [];
  if (entries.length === 0) return 'no log lines';
  const rendered = entries.map((line) => {
    const stream = String(line.stream ?? '?');
    // stderr is MARKED rather than coloured: a rendering that separated the
    // streams only by colour loses the distinction in every pipe and log file.
    const mark = stream === 'stderr' ? '!' : ' ';
    return `${String(line.ts ?? '')}${mark} ${String(line.text ?? '')}`;
  });
  if (page.truncated === true) rendered.push('', '(truncated — narrow the window with --since or --tail)');
  return rendered.join('\n');
}

function renderGrant(dto: unknown): string {
  const g = (dto ?? {}) as Record<string, unknown>;
  return [
    `surface:  ${String(g.surface ?? '?')} (${String(g.encoding ?? '?')}), mode ${String(g.mode ?? '?')}`,
    `url:      ${String(g.url ?? '?')}`,
    `expires:  ${String(g.expiresAt ?? '?')}`,
    '',
    // The token is in the DTO under `--format json` because a client needs it;
    // it is NOT printed in the human view, and the rule that governs it is
    // stated here rather than left for a caller to discover by failing.
    'the grant token travels ONLY in the `tm8-grant.<token>` websocket subprotocol,',
    'never in the URL — a token-bearing URL is refused by the transport.',
  ].join('\n');
}

function renderTerminal(dto: unknown): string {
  const r = (dto ?? {}) as Record<string, unknown>;
  const sessionId = String(r.workSessionId ?? '?');
  return [
    `exec session: ${sessionId}`,
    '',
    `attach with:  tm8 session attach ${sessionId}`,
  ].join('\n');
}

// ── verbs ──────────────────────────────────────────────────────────────────

/**
 * `tm8 container create <profile>` — the birth verb.
 *
 * NOT `tm8 entity create container`: that is refused server-side, exactly as
 * `work_session` is, because a container's record and its runtime object are
 * born together by a saga the graph door cannot run.
 *
 * `--no-start` is the only way to get a machine that exists and is not
 * running; the default is create-and-start, because "make me a machine" almost
 * always means "and start it", and the design says so (`start` defaults true).
 */
async function containerCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [
    'title', 'space', 'project', 'image', 'provider', 'node',
    'cpus', 'mem', 'disk', 'mount', 'env', 'port', 'network', 'allow',
    'ephemeral', 'persistent', 'ttl', 'idle-hibernate', 'grace', 'snapshot-on-stop',
    'share', 'parent', 'template', 'label', 'no-start', 'confirm-untrusted', 'mutation-id',
  ]);
  const profile = closedArg('container create', '<profile>', cmd.args[0], PROFILES);

  const spec: Record<string, unknown> = {};
  const image = cmd.options.value('image');
  if (image !== undefined) spec.image = image;
  const cpus = boundedNumber(cmd, 'cpus', 0.25, 16);
  if (cpus !== undefined) spec.cpus = cpus;
  const mem = boundedInt(cmd, 'mem', 128, 65536);
  if (mem !== undefined) spec.memMiB = mem;
  const disk = boundedInt(cmd, 'disk', 512, 512000);
  if (disk !== undefined) spec.diskMiB = disk;
  const mounts = parseMounts(cmd.options.values('mount'));
  if (mounts !== undefined) spec.mounts = mounts;
  const env = parseEnv(cmd.options.values('env'));
  if (env !== undefined) spec.env = env;
  const ports = parsePorts(cmd.options.values('port'));
  if (ports !== undefined) spec.ports = ports;
  const labels = parseLabels(cmd.options.values('label'));
  if (labels !== undefined) spec.labels = labels;

  // `--allow` is meaningless without a preset to attach it to: the policy is
  // {preset, allow} and a bare allowlist would have no rule to widen. Said
  // here rather than sent, because the schema is `.strict()` and the server's
  // refusal would name a field the caller never typed.
  const preset = closed('network', cmd.options.value('network'), NETWORK_PRESETS);
  const allow = parseAllow(cmd.options.values('allow'));
  if (preset !== undefined) {
    spec.network = { preset, allow };
  } else if (allow.length > 0) {
    throw new CliError('--allow needs --network <preset> to widen', EXIT_USAGE, {
      hint: 'the network policy is a preset plus an allowlist; an allowlist alone has no rule to attach to',
    });
  }

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    spaceId: requireSpace(cmd.ctx),
    profile,
  };
  const title = cmd.options.value('title');
  if (title !== undefined) body.title = title;
  const provider = cmd.options.value('provider');
  if (provider !== undefined) body.provider = provider;
  const node = cmd.options.value('node');
  if (node !== undefined) body.nodeId = node;
  // The image is BOTH a spec member and a top-level override in the frozen
  // input; sending the one the caller typed at the top level keeps a `custom`
  // profile's required image where the schema expects it.
  if (image !== undefined) body.image = image;
  if (Object.keys(spec).length > 0) body.spec = spec;
  const lifecycle = lifecycleFrom(cmd);
  if (lifecycle !== undefined) body.lifecycle = lifecycle;
  const share = closed('share', cmd.options.value('share'), SHARE_MODES);
  if (share !== undefined) body.shareMode = share;
  const parent = cmd.options.value('parent');
  if (parent !== undefined) body.parentId = parent;
  const template = cmd.options.value('template');
  if (template !== undefined) body.templateId = template;
  const project = cmd.options.value('project');
  if (project !== undefined) body.projectId = project;
  // The same gate `session spawn` uses, for the same reason: mounting an
  // untrusted project's working directory into a machine is a decision, not a
  // default. The flag is only meaningful alongside --project.
  if (cmd.options.bool('confirm-untrusted')) {
    if (project === undefined) {
      throw new CliError('--confirm-untrusted applies only with --project <project-resource-id>', EXIT_USAGE);
    }
    body.confirmUntrusted = true;
  }
  if (cmd.options.bool('no-start')) body.start = false;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.create', {
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/**
 * start | stop | pause | resume — one shape, four operations.
 *
 * Written once rather than four times because the four differ ONLY in the
 * operation they name: same input schema, same guard, same rendering. Four
 * copies would be four places for the version guard to be forgotten in.
 */
function lifecycleVerb(
  verb: 'start' | 'stop' | 'pause' | 'resume',
  operation: 'containers.start' | 'containers.stop' | 'containers.pause' | 'containers.resume',
): (cmd: CommandContext) => Promise<ExitCode> {
  return async (cmd) => {
    assertKnownOptions(cmd, ['expect-version', 'timeout-ms', 'mutation-id']);
    const containerId = requireContainerId(`container ${verb}`, cmd.args[0]);
    const body: Record<string, unknown> = {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      expectedVersion: requireExpectVersion(`container ${verb}`, cmd),
    };
    // `--timeout-ms`, NOT `--timeout`, and the rename is a defect fix rather
    // than a preference. `timeout` is a GLOBAL option: `parseInvocation`
    // strips it into `globals.timeoutMs` wherever it appears, so a per-command
    // `--timeout` would never reach this bag at all — the flag would parse,
    // change the TRANSPORT deadline, and silently not set the provider budget.
    // That is the `--version` defect this package already paid for once. The
    // spelling also carries its own unit, which the global (in SECONDS) does
    // not share: two clocks, two owners, two names.
    const timeoutMs = boundedInt(cmd, 'timeout-ms', 1000, 600000);
    if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;

    const data = await observedInvoke<unknown>(clientFor(cmd.ctx), operation, {
      params: { containerId },
      body: withActor(cmd, body),
    });
    cmd.out.data(data, renderContainer);
    return EXIT_OK;
  };
}

/**
 * `tm8 container destroy <id> --expect-version <n>`.
 *
 * NO `--yes`. Destroy is destructive, and §7.5 says a destructive operation is
 * never inferred from context — but `--expect-version <n>` already IS the
 * deliberate act: the caller must read the record's current version and name
 * it, which cannot be typed by accident and cannot be scripted over a machine
 * the caller has not looked at. Adding `--yes` on top would be a second
 * confirmation of the same intent, and Design §14 does not spell one.
 * `--force` changes HOW the machine is stopped, never WHO may stop it, so it
 * adds no confirmation of its own — the same distinction `session terminate`
 * draws.
 */
async function containerDestroy(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'force', 'keep-snapshot', 'timeout-ms', 'mutation-id']);
  const containerId = requireContainerId('container destroy', cmd.args[0]);
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion: requireExpectVersion('container destroy', cmd),
  };
  if (cmd.options.bool('force')) body.force = true;
  if (cmd.options.bool('keep-snapshot')) body.keepSnapshot = true;
  const timeoutMs = boundedInt(cmd, 'timeout-ms', 1000, 600000);
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.destroy', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/** `tm8 container update <id> --expect-version <n>` — title, lifecycle,
 *  share mode and labels. Everything else about a machine is either runtime
 *  (a lifecycle verb) or policy (`container policy`). */
async function containerUpdate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [
    'expect-version', 'title', 'ephemeral', 'persistent', 'ttl', 'idle-hibernate',
    'grace', 'snapshot-on-stop', 'share', 'label', 'mutation-id',
  ]);
  const containerId = requireContainerId('container update', cmd.args[0]);
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion: requireExpectVersion('container update', cmd),
  };
  const title = cmd.options.value('title');
  if (title !== undefined) body.title = title;
  const lifecycle = lifecycleFrom(cmd);
  if (lifecycle !== undefined) body.lifecycle = lifecycle;
  const share = closed('share', cmd.options.value('share'), SHARE_MODES);
  if (share !== undefined) body.shareMode = share;
  const labels = parseLabels(cmd.options.values('label'));
  if (labels !== undefined) body.labels = labels;

  // A version-guarded PATCH that changes nothing still bumps the version and
  // still burns the caller's guard, so an empty update is refused here rather
  // than sent — a caller who typed only the guard meant to type something else.
  if (Object.keys(body).length === 2) {
    throw new CliError('`tm8 container update` needs at least one of --title, --share, --label, or a lifecycle flag', EXIT_USAGE);
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.update', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/** `tm8 container policy <id> --expect-version <n> --network <preset>` — the
 *  egress rule. `--network` is REQUIRED here (unlike on create, where the
 *  profile supplies a default): this verb exists only to set it. */
async function containerPolicy(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'network', 'allow', 'mutation-id']);
  const containerId = requireContainerId('container policy', cmd.args[0]);
  const preset = closed('network', cmd.options.value('network'), NETWORK_PRESETS);
  if (preset === undefined) {
    throw new CliError(
      `\`tm8 container policy\` requires --network ${NETWORK_PRESETS.join('|')}`,
      EXIT_USAGE,
    );
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion: requireExpectVersion('container policy', cmd),
    network: { preset, allow: parseAllow(cmd.options.values('allow')) },
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.policy.set', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/**
 * `tm8 container run <id> [flags] -- <argv…>`.
 *
 * The argv is PASSTHROUGH, after a literal `--`, and it has to be: a command
 * line for another machine contains flags this parser must never interpret.
 * `tm8 container run c1 -- ls --format json` runs `ls --format json` inside
 * the machine and does not change THIS process's output format.
 */
async function containerRun(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['cwd', 'env', 'timeout-ms', 'stdin', 'user', 'mutation-id']);
  const containerId = requireContainerId('container run', cmd.args[0]);
  const argv = [...cmd.passthrough];
  if (argv.length === 0) {
    throw new CliError('tm8 container run requires an argv after `--`', EXIT_USAGE, {
      hint: 'example: tm8 container run <container-id> -- ls -la /workspace',
    });
  }

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    argv,
  };
  const cwd = cmd.options.value('cwd');
  if (cwd !== undefined) body.cwd = cwd;
  const env = parseEnv(cmd.options.values('env'));
  if (env !== undefined) body.env = env;
  const timeoutMs = boundedInt(cmd, 'timeout-ms', 1000, 600000);
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
  const user = cmd.options.value('user');
  if (user !== undefined) body.user = user;
  const stdin = cmd.options.value('stdin');
  if (stdin !== undefined) body.stdin = await readTextSource(stdin);

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.run', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderRun);
  return EXIT_OK;
}

/**
 * `tm8 container adb <id> -- <adb args…>` — sugar over `containers.run`.
 *
 * The node prefixes `adb -s <the container's serial>`; the caller never names
 * a serial, because the serial is node-local runtime truth a client is not
 * given (R5) and a caller who could name one could reach another machine's
 * emulator.
 */
async function containerAdb(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['timeout-ms', 'mutation-id']);
  const containerId = requireContainerId('container adb', cmd.args[0]);
  const args = [...cmd.passthrough];
  if (args.length === 0) {
    throw new CliError('tm8 container adb requires adb arguments after `--`', EXIT_USAGE, {
      hint: 'example: tm8 container adb <container-id> -- shell input tap 100 200',
    });
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    argv: ['adb', ...args],
  };
  const timeoutMs = boundedInt(cmd, 'timeout-ms', 1000, 600000);
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.run', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderRun);
  return EXIT_OK;
}

/**
 * `tm8 container terminal <id>` — a PTY inside the machine, as a work session.
 *
 * THERE IS NO `--argv`, AND THERE WILL NOT BE. The shell is the image's login
 * shell, which is the same RCE boundary `execution.terminal.start` draws: a
 * caller who may open a terminal may already run anything, but a caller who
 * may pass an argv can be made to run something by a request they did not
 * write. Same reason, same answer.
 */
async function containerTerminal(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['title', 'cwd', 'cols', 'rows', 'mutation-id']);
  const containerId = requireContainerId('container terminal', cmd.args[0]);
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const title = cmd.options.value('title');
  if (title !== undefined) body.title = title;
  const cwd = cmd.options.value('cwd');
  if (cwd !== undefined) body.cwd = cwd;
  const cols = boundedInt(cmd, 'cols', 1, 1000);
  if (cols !== undefined) body.cols = cols;
  const rows = boundedInt(cmd, 'rows', 1, 1000);
  if (rows !== undefined) body.rows = rows;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.terminal.start', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderTerminal);
  return EXIT_OK;
}

/**
 * `tm8 container attach <id> --surface <s> [--mode view|drive]` — mint a grant.
 *
 * This prints a grant and opens nothing. Unlike `session attach`, there is no
 * streaming branch: the surfaces are RFB, frame, CDP, adb and docker streams,
 * none of which is terminal bytes a shell can render. A caller gets the grant
 * and dials it with a client that speaks the encoding.
 */
async function containerAttach(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['surface', 'mode', 'mutation-id']);
  const containerId = requireContainerId('container attach', cmd.args[0]);
  const surface = closed('surface', cmd.options.value('surface'), ATTACH_SURFACES);
  if (surface === undefined) {
    throw new CliError(
      `\`tm8 container attach\` requires --surface ${ATTACH_SURFACES.join('|')}`,
      EXIT_USAGE,
      {
        hint: 'a terminal is not an attachable surface — use `tm8 container terminal <container-id>`',
      },
    );
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    surface,
    mode: closed('mode', cmd.options.value('mode'), ATTACH_MODES) ?? 'view',
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.attach', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderGrant);
  return EXIT_OK;
}

/**
 * The shared body builder for the three commands that all invoke
 * `containers.computer`: `computer`, `screenshot`, and `browser goto|text`.
 *
 * Coordinates are in SCREENSHOT PIXELS at the scale the last screenshot
 * reported (§7.2) — the node keeps the mapping, so nothing here converts.
 */
function computerBody(
  cmd: CommandContext,
  action: (typeof COMPUTER_ACTIONS)[number],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    action,
    ...extra,
  };
  const scale = boundedNumber(cmd, 'scale', 0.25, 1);
  if (scale !== undefined) body.scale = scale;
  if (cmd.options.bool('keep')) body.keep = true;
  if (cmd.options.bool('no-screenshot')) body.screenshot = false;
  return withActor(cmd, body);
}

/**
 * Write the returned screenshot to `--out <file>`, and say so on stderr rather
 * than stdout: stdout carries the DTO, and a "wrote 41 KiB to shot.png" line
 * mixed into it would corrupt `--format json` for every caller who pipes it.
 */
async function emitComputer(cmd: CommandContext, data: unknown, out: string | undefined): Promise<void> {
  if (out !== undefined) {
    const shot = (data as { screenshot?: { base64?: unknown } } | undefined)?.screenshot;
    const base64 = shot?.base64;
    if (typeof base64 !== 'string') {
      throw new CliError('the node returned no screenshot to write to --out', EXIT_USAGE, {
        hint: '--no-screenshot suppresses the image; drop it, or drop --out',
      });
    }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, Buffer.from(base64, 'base64'));
    cmd.out.note(`wrote screenshot to ${out}`);
  }
  cmd.out.data(data, renderComputer);
}

function renderComputer(dto: unknown): string {
  const r = (dto ?? {}) as {
    ok?: unknown;
    text?: unknown;
    screenshot?: { w?: unknown; h?: unknown; scale?: unknown; mime?: unknown };
    artifactRevision?: { artifactId?: unknown; revisionNumber?: unknown };
  };
  const lines = [r.ok === true ? 'ok' : 'failed'];
  if (typeof r.text === 'string' && r.text.length > 0) lines.push('', r.text);
  const shot = r.screenshot;
  if (shot) {
    // The DIMENSIONS and the scale, never the base64: a megabyte of image
    // bytes in a terminal is not a rendering, and the scale is what a caller
    // needs to convert their next click's coordinates.
    lines.push('', `screenshot ${String(shot.w ?? '?')}×${String(shot.h ?? '?')} at scale ${String(shot.scale ?? '?')} (${String(shot.mime ?? '?')})`);
    lines.push('write it to a file with --out <file>');
  }
  const revision = r.artifactRevision;
  if (revision) {
    lines.push('', `kept as artifact ${String(revision.artifactId ?? '?')} revision ${String(revision.revisionNumber ?? '?')}`);
  }
  return lines.join('\n');
}

/** `tm8 container computer <id> <action> [args]` — one action, one screenshot. */
async function containerComputer(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [
    'x', 'y', 'to', 'text', 'keys', 'dx', 'dy', 'ms', 'url',
    'no-screenshot', 'keep', 'out', 'scale', 'mutation-id',
  ]);
  const containerId = requireContainerId('container computer', cmd.args[0]);
  const action = closedArg('container computer', '<action>', cmd.args[1], COMPUTER_ACTIONS);

  const extra: Record<string, unknown> = {};
  const x = cmd.options.integer('x');
  if (x !== undefined) extra.x = x;
  const y = cmd.options.integer('y');
  if (y !== undefined) extra.y = y;
  const to = cmd.options.value('to');
  if (to !== undefined) {
    const match = /^(-?\d+),(-?\d+)$/.exec(to);
    if (!match) {
      throw new CliError(`--to expects X,Y, got ${JSON.stringify(to)}`, EXIT_USAGE);
    }
    extra.to = { x: Number(match[1]), y: Number(match[2]) };
  }
  const text = cmd.options.value('text');
  if (text !== undefined) extra.text = text;
  const keys = cmd.options.value('keys');
  if (keys !== undefined) extra.keys = keys;
  const dx = cmd.options.integer('dx');
  if (dx !== undefined) extra.dx = dx;
  const dy = cmd.options.integer('dy');
  if (dy !== undefined) extra.dy = dy;
  const ms = cmd.options.integer('ms');
  if (ms !== undefined) extra.ms = ms;
  const url = cmd.options.value('url');
  if (url !== undefined) extra.url = url;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.computer', {
    params: { containerId },
    body: computerBody(cmd, action, extra),
  });
  await emitComputer(cmd, data, cmd.options.value('out'));
  return EXIT_OK;
}

/** `tm8 container screenshot <id>` — sugar for `computer screenshot`, because
 *  it is the action agents call most and `computer screenshot` reads like a
 *  category error. Same operation, same ledger row. */
async function containerScreenshot(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['out', 'keep', 'scale', 'mutation-id']);
  const containerId = requireContainerId('container screenshot', cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.computer', {
    params: { containerId },
    body: computerBody(cmd, 'screenshot'),
  });
  await emitComputer(cmd, data, cmd.options.value('out'));
  return EXIT_OK;
}

/**
 * `tm8 container browser <id> endpoint|goto|text` — the browser surface.
 *
 * The sub-verb comes AFTER the container id, which is what Design §14 spells
 * and is not an accident: `container browser` is one command with three
 * shapes, not three commands, and the id is what they share.
 *
 * `endpoint` is `containers.browser.endpoint` — the ONE documented exception
 * to subprotocol-only token carriage (§16.1), because Playwright's
 * `connectOverCDP` cannot send a websocket subprotocol. `goto` and `text` are
 * ordinary `containers.computer` actions.
 */
async function containerBrowser(cmd: CommandContext): Promise<ExitCode> {
  const containerId = requireContainerId('container browser', cmd.args[0]);
  const action = closedArg('container browser', '<action>', cmd.args[1], BROWSER_ACTIONS);

  if (action === 'endpoint') {
    assertKnownOptions(cmd, ['ttl', 'mutation-id']);
    const body: Record<string, unknown> = {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    };
    const ttl = boundedInt(cmd, 'ttl', 1, 3600);
    if (ttl !== undefined) body.ttlSeconds = ttl;
    const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.browser.endpoint', {
      params: { containerId },
      body: withActor(cmd, body),
    });
    cmd.out.data(data, (dto) => {
      const r = (dto ?? {}) as Record<string, unknown>;
      return [
        `ws endpoint: ${String(r.wsEndpoint ?? '?')}`,
        `expires:     ${String(r.expiresAt ?? '?')}`,
        `cdp:         ${String(r.cdpVersion ?? '?')}`,
        '',
        'this URL is bearer-bound — it is the one endpoint whose grant rides the URL,',
        'because connectOverCDP cannot send a websocket subprotocol.',
      ].join('\n');
    });
    return EXIT_OK;
  }

  if (action === 'goto') {
    assertKnownOptions(cmd, ['no-screenshot', 'keep', 'out', 'scale', 'mutation-id']);
    const url = cmd.args[2];
    if (url === undefined || url.length === 0) {
      throw new CliError('tm8 container browser <container-id> goto requires <url>', EXIT_USAGE);
    }
    const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.computer', {
      params: { containerId },
      body: computerBody(cmd, 'goto', { url }),
    });
    await emitComputer(cmd, data, cmd.options.value('out'));
    return EXIT_OK;
  }

  assertKnownOptions(cmd, ['no-screenshot', 'keep', 'out', 'scale', 'mutation-id']);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.computer', {
    params: { containerId },
    body: computerBody(cmd, 'text'),
  });
  await emitComputer(cmd, data, cmd.options.value('out'));
  return EXIT_OK;
}

/**
 * `tm8 container cp <id> <src> <dst>` — one verb, TWO operations, and which
 * one runs is decided by which side carries the `ctr:` prefix.
 *
 * That is also why the mutation-id rule is not uniform here: copying INTO a
 * machine is `containers.files.put`, a command that accepts a mutation id;
 * copying OUT is `containers.files.get`, a read, and a read refuses one. A
 * single blanket rule for the verb would be wrong in one direction whichever
 * way it was written.
 */
async function containerCp(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const containerId = requireContainerId('container cp', cmd.args[0]);
  const src = cmd.args[1];
  const dst = cmd.args[2];
  if (src === undefined || dst === undefined) {
    throw new CliError('tm8 container cp requires <container-id> <src> <dst>', EXIT_USAGE, {
      hint: 'exactly one side is prefixed `ctr:` — `ctr:/etc/hosts ./hosts` copies out, `./app.tar ctr:/srv` copies in',
    });
  }
  const srcInside = src.startsWith('ctr:');
  const dstInside = dst.startsWith('ctr:');
  if (srcInside === dstInside) {
    throw new CliError(
      srcInside
        ? 'tm8 container cp cannot copy from a machine to itself; exactly one side carries `ctr:`'
        : 'tm8 container cp needs exactly one side prefixed `ctr:`',
      EXIT_USAGE,
    );
  }

  if (dstInside) {
    const client = clientFor(cmd.ctx);
    // A tar stream, not a zod body: the operation's input is octet-stream, so
    // the mutation id rides the header the transport already carries rather
    // than a JSON field there is no room for.
    const data = await observedInvoke<unknown>(client, 'containers.files.put', {
      params: { containerId },
      query: { path: dst.slice(4) },
      body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')), source: src },
    });
    cmd.out.data(data, () => `copied ${src} into ${dst}`);
    return EXIT_OK;
  }

  refuseMutationId('container cp (copying out of a machine is a read)', cmd.options.value('mutation-id'));
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.files.get', {
    params: { containerId },
    query: { path: src.slice(4) },
  });
  cmd.out.data(data, () => `copied ${src} to ${dst}`);
  return EXIT_OK;
}

/** `tm8 container logs <id>` — a READ, so `--mutation-id` is refused. */
async function containerLogs(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('container logs', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['since', 'tail', 'follow']);
  const containerId = requireContainerId('container logs', cmd.args[0]);
  const query: Record<string, string> = {};
  const since = cmd.options.value('since');
  if (since !== undefined) query.since = since;
  const tail = boundedInt(cmd, 'tail', 1, 10000);
  if (tail !== undefined) query.tail = String(tail);
  if (cmd.options.bool('follow')) query.follow = 'true';

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.logs', {
    params: { containerId },
    query,
  });
  cmd.out.data(data, renderLogs);
  return EXIT_OK;
}

/** `tm8 container expose <id> <port> --expect-version <n>`. */
async function containerExpose(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'share', 'mutation-id']);
  const containerId = requireContainerId('container expose', cmd.args[0]);
  const value = cmd.args[1];
  if (value === undefined) {
    throw new CliError('tm8 container expose requires <container-id> <port>', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion: requireExpectVersion('container expose', cmd),
    port: port(value, '<port>'),
  };
  // The PORT share vocabulary, not the container's. `link` means a bearer URL
  // anyone holding it may open, and it exists on no other kind.
  const share = closed('share', cmd.options.value('share'), PORT_SHARES);
  if (share !== undefined) body.share = share;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.expose', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, (dto) => {
    const r = (dto ?? {}) as Record<string, unknown>;
    const lines = [`port ${String(r.port ?? '?')} → ${String(r.url ?? '?')}`];
    // The share token is in the JSON DTO for a caller who needs it and is NOT
    // printed here: a bearer token echoed into a terminal is a bearer token in
    // the scrollback of whoever reads that terminal next.
    if (r.shareToken !== undefined) lines.push('a share token was minted; read it with --format json');
    return lines.join('\n');
  });
  return EXIT_OK;
}

/** `tm8 container unexpose <id> <port> --expect-version <n>`. */
async function containerUnexpose(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'mutation-id']);
  const containerId = requireContainerId('container unexpose', cmd.args[0]);
  const value = cmd.args[1];
  if (value === undefined) {
    throw new CliError('tm8 container unexpose requires <container-id> <port>', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion: requireExpectVersion('container unexpose', cmd),
    port: port(value, '<port>'),
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.unexpose', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/** `tm8 container snapshot <id> --expect-version <n>`. */
async function containerSnapshot(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'name', 'make-template', 'mutation-id']);
  const containerId = requireContainerId('container snapshot', cmd.args[0]);
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion: requireExpectVersion('container snapshot', cmd),
  };
  const name = cmd.options.value('name');
  if (name !== undefined) body.name = name;
  // `--make-template`, not `--template`: `container create --template <id>`
  // already spells a VALUE flag of that name, and one name cannot be both a
  // boolean and a value-taker — the boolean allowlist is global to the parser,
  // so `--template` as a bare flag would make `create --template abc` drop
  // `abc` into the positionals. Matching the schema field is the honest fix.
  if (cmd.options.bool('make-template')) body.makeTemplate = true;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.snapshot', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/** `tm8 container fork <id>` — a new machine from this one's snapshot. No
 *  version guard: the fork does not change the source record, it reads it. */
async function containerFork(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [
    'title', 'ephemeral', 'persistent', 'ttl', 'idle-hibernate', 'grace',
    'snapshot-on-stop', 'cpus', 'mem', 'disk', 'mutation-id',
  ]);
  const containerId = requireContainerId('container fork', cmd.args[0]);
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const title = cmd.options.value('title');
  if (title !== undefined) body.title = title;
  const lifecycle = lifecycleFrom(cmd);
  if (lifecycle !== undefined) body.lifecycle = lifecycle;
  const spec: Record<string, unknown> = {};
  const cpus = boundedNumber(cmd, 'cpus', 0.25, 16);
  if (cpus !== undefined) spec.cpus = cpus;
  const mem = boundedInt(cmd, 'mem', 128, 65536);
  if (mem !== undefined) spec.memMiB = mem;
  const disk = boundedInt(cmd, 'disk', 512, 512000);
  if (disk !== undefined) spec.diskMiB = disk;
  if (Object.keys(spec).length > 0) body.spec = spec;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.fork', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/** `tm8 container attention <id> --reason <r>` — ask a human to take over
 *  (§12.5). The same bounded-points shape `attentionRequests.create` uses. */
async function containerAttention(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['reason', 'detail', 'points', 'mutation-id']);
  const containerId = requireContainerId('container attention', cmd.args[0]);
  const reason = closed('reason', cmd.options.value('reason'), ATTENTION_REASONS);
  if (reason === undefined) {
    throw new CliError(
      `\`tm8 container attention\` requires --reason ${ATTENTION_REASONS.join('|')}`,
      EXIT_USAGE,
    );
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    reason,
  };
  const detail = cmd.options.value('detail');
  if (detail !== undefined) body.detail = detail;
  const points = boundedInt(cmd, 'points', 1, 100);
  if (points !== undefined) body.points = points;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.attention', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/** `tm8 container pool <template-id> --expect-version <n> --warm <n>` — how
 *  many machines to keep warm from a TEMPLATE container. The positional is the
 *  template's id and the guard is the template's version. */
async function containerPool(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'warm', 'mutation-id']);
  const containerId = requireContainerId('container pool', cmd.args[0]);
  const warm = boundedInt(cmd, 'warm', 0, 8);
  if (warm === undefined) {
    throw new CliError('`tm8 container pool` requires --warm <n> (0–8)', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion: requireExpectVersion('container pool', cmd),
    warm,
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.pools.set', {
    params: { containerId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderContainer);
  return EXIT_OK;
}

/**
 * `tm8 container providers` — a READ, so `--mutation-id` is refused.
 *
 * This is one of the two family-specific reads (§4.5) and the reason it exists
 * is that its truth is on the NODE: which providers are installed, which
 * images are cached, and — the field that matters — a probe result produced by
 * actually creating and destroying a container, not by checking a PATH.
 */
async function containerProviders(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('container providers', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['node']);
  const query: Record<string, string> = {};
  const node = cmd.options.value('node');
  if (node !== undefined) query.node = node;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'containers.providers.list', {
    query,
  });
  cmd.out.data(data, renderProviders);
  return EXIT_OK;
}

export const CONTAINER_COMMANDS: CommandModule[] = [
  { path: ['container', 'create'], run: containerCreate },
  { path: ['container', 'start'], run: lifecycleVerb('start', 'containers.start') },
  { path: ['container', 'stop'], run: lifecycleVerb('stop', 'containers.stop') },
  { path: ['container', 'pause'], run: lifecycleVerb('pause', 'containers.pause') },
  { path: ['container', 'resume'], run: lifecycleVerb('resume', 'containers.resume') },
  { path: ['container', 'destroy'], run: containerDestroy },
  { path: ['container', 'update'], run: containerUpdate },
  { path: ['container', 'policy'], run: containerPolicy },
  { path: ['container', 'run'], run: containerRun },
  { path: ['container', 'adb'], run: containerAdb },
  { path: ['container', 'terminal'], run: containerTerminal },
  { path: ['container', 'attach'], run: containerAttach },
  { path: ['container', 'computer'], run: containerComputer },
  { path: ['container', 'screenshot'], run: containerScreenshot },
  { path: ['container', 'browser'], run: containerBrowser },
  { path: ['container', 'cp'], run: containerCp },
  { path: ['container', 'logs'], run: containerLogs },
  { path: ['container', 'expose'], run: containerExpose },
  { path: ['container', 'unexpose'], run: containerUnexpose },
  { path: ['container', 'snapshot'], run: containerSnapshot },
  { path: ['container', 'fork'], run: containerFork },
  { path: ['container', 'attention'], run: containerAttention },
  { path: ['container', 'pool'], run: containerPool },
  { path: ['container', 'providers'], run: containerProviders },
];
