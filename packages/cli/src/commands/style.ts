/**
 * `tm8 style` — personal styles, space styles, push / pull / use (styles spec
 * 01a0fc22 v8 §5, migration 284).
 *
 * TWO KINDS OF STYLE, ONE NOUN. A PERSONAL style belongs to the caller's
 * identity and is edited in place (`create`, `set`, `unset`, `update`,
 * `delete`). A SPACE style is a read-only `style` entity: it is born and
 * re-versioned only by `push`, copied back out by `pull`, and removed by an
 * admin with `remove`. `use` writes the caller's own preference and `default`
 * reads or sets the space default.
 *
 * REFERENCES ARE TYPED: `builtin:<slug>`, `personal:<uuid>`, `space:<uuid>`. A
 * bare uuid is looked up as a personal style first, then as a space style, so
 * an agent holding only an id still gets the right thing — but the typed form
 * is what every output prints, so the lookup is a convenience, not the norm.
 *
 * STYLE VARIABLES ARE FLAGS. `--pn-brand=#4F7DF3` sets a variable and a bare
 * `--pn-paper` names one (`unset`); `args.ts` parses any `--pn-*` option that
 * way. The `=` is required for a value, because a bare `--pn-*` is a name.
 */
import type {
  PersonalStylesListResult,
  PersonalStyleWriteResult,
  SpaceStyleDefaultView,
  SpaceStyleWriteResult,
  StyleGetResult,
  StylePrefsGetResult,
  StylePrefsSetResult,
  StylesExportResult,
  StylesListResult,
  StylesResolveResult,
} from '@tm8/contract';
import { readJsonSource, readTextSource } from '../args.js';
import { requireSpace } from '../context.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, pageQuery, renderPage, requireArg } from './entity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPED_REF = /^(builtin:[a-z0-9-]{1,64}|(personal|space):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const VAR_NAME = /^--pn-[a-z0-9-]{1,64}$/;

/** `--strict` with warnings. The spec fixes the number; it shares 2 with usage. */
const EXIT_STRICT_WARNINGS = EXIT_USAGE;

type Origin = 'builtin' | 'personal' | 'space';

interface Ref {
  origin: Origin;
  /** The slug-bearing id for a built-in, the uuid otherwise. */
  id: string;
  /** The typed form, as the wire takes it. */
  ref: string;
}

function typed(raw: string): Ref | null {
  if (!TYPED_REF.test(raw)) return null;
  const at = raw.indexOf(':');
  const origin = raw.slice(0, at).toLowerCase() as Origin;
  const rest = raw.slice(at + 1);
  return origin === 'builtin'
    ? { origin, id: raw, ref: raw }
    : { origin, id: rest.toLowerCase(), ref: `${origin}:${rest.toLowerCase()}` };
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden');
}

/**
 * A typed ref as written, or a bare uuid looked up personal-first. The lookup
 * is two reads at most; a typed ref costs none.
 */
async function resolveRef(cmd: CommandContext, raw: string, what: string): Promise<Ref> {
  const t = typed(raw);
  if (t) return t;
  if (!UUID.test(raw)) {
    throw new CliError(
      `${what} must be builtin:<slug>, personal:<uuid>, space:<uuid> or a bare uuid (got ${JSON.stringify(raw)})`,
      EXIT_USAGE,
    );
  }
  const client = clientFor(cmd.ctx);
  const id = raw.toLowerCase();
  for (const origin of ['personal', 'space'] as const) {
    try {
      await observedInvoke<StyleGetResult>(client, 'styles.get', { params: { ref: `${origin}:${id}` } });
      return { origin, id, ref: `${origin}:${id}` };
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  throw new CliError(`no personal or space style you can read has id ${id}`, EXIT_NOT_FOUND);
}

async function requireOrigin(
  cmd: CommandContext,
  raw: string,
  what: string,
  allowed: readonly Origin[],
): Promise<Ref> {
  const ref = await resolveRef(cmd, raw, what);
  if (!allowed.includes(ref.origin)) {
    const hint = ref.origin === 'space'
      ? 'a space style is read-only: `tm8 style pull <space-ref>` copies it into a personal style you can edit'
      : ref.origin === 'builtin'
        ? 'a built-in is read-only: `tm8 style pull <builtin-ref>` copies it into a personal style'
        : 'name a space style (space:<uuid>) or a built-in (builtin:<slug>)';
    throw new CliError(`${what} must be a ${allowed.join(' or ')} style, not ${ref.ref}`, EXIT_USAGE, { hint });
  }
  return ref;
}

// ── variables from flags ──────────────────────────────────────────────────

/** Every `--pn-*=value` option, in the shape `vars` takes. A bare one is refused. */
function varOptions(cmd: CommandContext): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of cmd.options.names()) {
    if (!name.startsWith('pn-')) continue;
    const key = `--${name}`;
    if (!VAR_NAME.test(key)) throw new CliError(`${key} is not a style variable name (--pn-[a-z0-9-]+)`, EXIT_USAGE);
    const values = cmd.options.values(name);
    if (values.length === 0) {
      throw new CliError(`${key} needs a value: write ${key}=<value>`, EXIT_USAGE, {
        hint: 'to remove a variable use `tm8 style unset <personal-ref> ' + key + '`',
      });
    }
    if (values.length > 1) throw new CliError(`${key} may be given only once`, EXIT_USAGE);
    vars[key] = values[0] as string;
  }
  return vars;
}

/** Every bare `--pn-*` option — the names `unset` removes. */
function varNames(cmd: CommandContext): string[] {
  const names: string[] = [];
  for (const name of cmd.options.names()) {
    if (!name.startsWith('pn-')) continue;
    const key = `--${name}`;
    if (!VAR_NAME.test(key)) throw new CliError(`${key} is not a style variable name (--pn-[a-z0-9-]+)`, EXIT_USAGE);
    if (cmd.options.values(name).length > 0) {
      throw new CliError(`unset takes variable NAMES only: write ${key}, not ${key}=<value>`, EXIT_USAGE);
    }
    names.push(key);
  }
  return names;
}

/** `--set <name>=<value>` (repeatable); the name may be written with or without `--`. */
function setOptions(cmd: CommandContext): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of cmd.options.values('set')) {
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new CliError(`--set expects <name>=<value>, got ${JSON.stringify(raw)}`, EXIT_USAGE);
    const name = raw.slice(0, eq);
    const key = name.startsWith('--') ? name : `--${name}`;
    if (!VAR_NAME.test(key)) throw new CliError(`${name} is not a style variable name (--pn-[a-z0-9-]+)`, EXIT_USAGE);
    vars[key] = raw.slice(eq + 1);
  }
  return vars;
}

function knownWithVars(cmd: CommandContext, allowed: readonly string[]): void {
  assertKnownOptions(cmd, [...allowed, ...cmd.options.names().filter((n) => n.startsWith('pn-'))]);
}

async function jsonObject(raw: string, flag: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonSource(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${flag} must be a JSON object`, EXIT_USAGE);
  }
  return parsed as Record<string, unknown>;
}

async function varsSource(raw: string, flag: string): Promise<Record<string, string>> {
  const obj = await jsonObject(raw, flag);
  for (const [k, v] of Object.entries(obj)) {
    if (!VAR_NAME.test(k)) throw new CliError(`${flag}: ${k} is not a style variable name`, EXIT_USAGE);
    if (typeof v !== 'string') throw new CliError(`${flag}: ${k} must be a string value`, EXIT_USAGE);
  }
  return obj as Record<string, string>;
}

/** `--css @file|-|<text>|none`. */
async function cssOption(cmd: CommandContext): Promise<string | null | undefined> {
  const raw = cmd.options.value('css');
  if (raw === undefined) return undefined;
  if (raw === 'none') return null;
  return readTextSource(raw);
}

// ── rendering ─────────────────────────────────────────────────────────────

function varCount(doc: { vars?: Record<string, unknown> } | undefined): number {
  return doc?.vars ? Object.keys(doc.vars).length : 0;
}

function renderStyle(dto: StyleGetResult): string {
  const lines = [
    `${dto.ref}  ${dto.title}  v${dto.version}`,
    `foundation: ${dto.doc.foundation}`,
    `vars: ${varCount(dto.doc as never)}${dto.doc && (dto.doc as { css?: unknown }).css ? ' · has css' : ''}`,
  ];
  const vars = (dto.doc as { vars?: Record<string, string> }).vars ?? {};
  for (const key of Object.keys(vars).sort()) lines.push(`  ${key}: ${vars[key]}`);
  for (const w of dto.warnings ?? []) lines.push(`warning: ${JSON.stringify(w)}`);
  return lines.join('\n');
}

function renderWrite(dto: PersonalStyleWriteResult | SpaceStyleWriteResult): string {
  const s = dto.style as { ref: string; title: string; version: number };
  const lines = [`${s.ref}  ${s.title}  v${s.version}`];
  for (const c of dto.clamped ?? []) lines.push(`clamped: ${c.key} ${c.from} -> ${c.to}`);
  for (const w of dto.warnings ?? []) lines.push(`warning: ${JSON.stringify(w)}`);
  return lines.join('\n');
}

function renderPrefs(prefs: { currentStyle: string; darkStyle: string | null; followOs: boolean; revision: number } | null): string {
  if (!prefs) return 'No style chosen: the space default applies, else builtin:atelier-light.';
  return [
    `current: ${prefs.currentStyle}`,
    `dark: ${prefs.darkStyle ?? '-'}`,
    `follow OS: ${prefs.followOs ? 'yes' : 'no'}`,
    `revision: ${prefs.revision}`,
  ].join('\n');
}

// ── reads ─────────────────────────────────────────────────────────────────

async function styleList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('style list', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['mine', 'space-only', 'tag']);
  if (cmd.args.length > 0) throw new CliError('tm8 style list takes no arguments', EXIT_USAGE);
  const mine = cmd.options.bool('mine');
  const spaceOnly = cmd.options.bool('space-only');
  if (mine && spaceOnly) throw new CliError('--mine and --space-only are mutually exclusive', EXIT_USAGE);
  const tag = cmd.options.value('tag');
  const client = clientFor(cmd.ctx);

  let personal: PersonalStylesListResult['items'] | null = null;
  if (!spaceOnly) {
    const res = await observedInvoke<PersonalStylesListResult>(client, 'styles.personal.list');
    personal = tag === undefined ? res.items : res.items.filter((s) => s.tags.includes(tag));
  }
  let space: StylesListResult | null = null;
  if (!mine) {
    // Without a Space in context the personal half still answers; asking for
    // the space half explicitly makes the missing Space an error.
    const spaceId = spaceOnly ? requireSpace(cmd.ctx) : cmd.ctx.space?.value;
    if (spaceId !== undefined) {
      space = await observedInvoke<StylesListResult>(client, 'styles.list', {
        params: { spaceId },
        query: tag === undefined ? {} : { tag },
      });
    }
  }
  const data = { personal, space };
  cmd.out.data(data, (d) => {
    const lines: string[] = [];
    if (d.personal !== null) {
      lines.push('personal:');
      if (d.personal.length === 0) lines.push('  (none)');
      for (const s of d.personal) {
        lines.push(`  ${s.ref}  ${s.title}  v${s.version}  ${s.varCount} vars${s.hasCss ? ' +css' : ''}` +
          `${s.publishedAs ? `  pushed as space:${s.publishedAs}` : ''}`);
      }
    }
    if (d.space !== null) {
      lines.push(`space (default ${d.space.defaultStyle}${d.space.defaultDangling ? ', removed' : ''}):`);
      for (const s of d.space.items) {
        const marks = [s.isDefault ? 'default' : '', s.inUseByMe ? 'in use' : ''].filter(Boolean).join(', ');
        lines.push(`  ${s.ref}  ${s.title}  v${s.version}${marks ? `  (${marks})` : ''}`);
      }
    } else if (!mine) {
      lines.push('space: (no Space in context — pass --space <space-id>)');
    }
    return lines.join('\n');
  });
  return EXIT_OK;
}

async function styleGet(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('style get', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['resolved']);
  const ref = await resolveRef(cmd, requireArg(cmd, 0, '<ref>'), '<ref>');
  const data = await observedInvoke<StyleGetResult>(clientFor(cmd.ctx), 'styles.get', { params: { ref: ref.ref } });
  if (cmd.options.bool('resolved')) {
    cmd.out.data(data, (d) => [
      renderStyle(d),
      'resolved:',
      ...Object.entries(d.resolved.cssVars).map(([k, v]) => `  ${k}: ${v}`),
    ].join('\n'));
  } else {
    // The resolved table is ~119 keys a caller did not ask for.
    const { resolved: _resolved, ...rest } = data;
    cmd.out.data(rest as StyleGetResult, renderStyle);
  }
  return EXIT_OK;
}

async function styleResolve(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('style resolve', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['strict']);
  const raw = requireArg(cmd, 0, '<ref|json-source>');
  const client = clientFor(cmd.ctx);
  let doc: unknown;
  if (TYPED_REF.test(raw) || UUID.test(raw)) {
    const ref = await resolveRef(cmd, raw, '<ref>');
    doc = (await observedInvoke<StyleGetResult>(client, 'styles.get', { params: { ref: ref.ref } })).doc;
  } else {
    const obj = await jsonObject(raw, '<json-source>');
    doc = 'doc' in obj && typeof obj.doc === 'object' ? obj.doc : obj;
  }
  const data = await observedInvoke<StylesResolveResult>(client, 'styles.resolve', { body: { doc } });
  for (const w of data.warnings) cmd.out.warn(`${(w as { code?: string }).code ?? 'warning'}: ${(w as { message?: string }).message ?? JSON.stringify(w)}`);
  for (const c of data.clamped ?? []) cmd.out.warn(`clamped: ${c.key} ${c.from} -> ${c.to}`);
  cmd.out.data(data, (d) => `${d.resolved.hash}  ${Object.keys(d.resolved.cssVars).length} vars  ${d.warnings.length} warning(s)`);
  return cmd.options.bool('strict') && data.warnings.length > 0 ? EXIT_STRICT_WARNINGS : EXIT_OK;
}

async function styleExport(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('style export', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['type', 'only']);
  const ref = await resolveRef(cmd, requireArg(cmd, 0, '<ref>'), '<ref>');
  const type = cmd.options.value('type') ?? 'css';
  if (type !== 'css' && type !== 'json') throw new CliError('--type expects css|json', EXIT_USAGE);
  const only = cmd.options.value('only') ?? 'set';
  if (only !== 'set' && only !== 'all') throw new CliError('--only expects set|all', EXIT_USAGE);
  const data = await observedInvoke<StylesExportResult>(clientFor(cmd.ctx), 'styles.export', {
    params: { ref: ref.ref },
    query: { format: type, only },
  });
  cmd.out.data(data, (d) => d.text.replace(/\n$/, ''));
  return EXIT_OK;
}

async function styleVersions(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('style versions', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['limit', 'cursor']);
  const ref = await requireOrigin(cmd, requireArg(cmd, 0, '<space-ref>'), '<space-ref>', ['space']);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.versions', {
    params: { id: ref.id },
    query: pageQuery(cmd),
  });
  cmd.out.data(data, renderPage);
  return EXIT_OK;
}

// ── personal writes ───────────────────────────────────────────────────────

async function styleCreate(cmd: CommandContext): Promise<ExitCode> {
  knownWithVars(cmd, ['foundation', 'set', 'vars', 'css', 'tag', 'from', 'description', 'mutation-id']);
  const from = cmd.options.value('from');
  const title = cmd.args[0];
  if (cmd.args.length > 1) throw new CliError('tm8 style create takes one <title>; quote a title with spaces', EXIT_USAGE);
  const body: Record<string, unknown> = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };
  if (from !== undefined) {
    body.from = (await resolveRef(cmd, from, '--from')).ref;
  } else {
    if (title === undefined) requireArg(cmd, 0, '<title>');
    body.foundation = cmd.options.require('foundation');
  }
  if (title !== undefined) body.title = title;
  if (from !== undefined && cmd.options.has('foundation')) body.foundation = cmd.options.require('foundation');
  const varsFlag = cmd.options.value('vars');
  const vars = {
    ...(varsFlag === undefined ? {} : await varsSource(varsFlag, '--vars')),
    ...setOptions(cmd),
    ...varOptions(cmd),
  };
  if (Object.keys(vars).length > 0) body.vars = vars;
  const css = await cssOption(cmd);
  if (css !== undefined) body.css = css;
  const tags = cmd.options.values('tag');
  if (tags.length > 0) body.tags = tags;
  const description = cmd.options.value('description');
  if (description !== undefined) body.description = description;
  const data = await observedInvoke<PersonalStyleWriteResult>(clientFor(cmd.ctx), 'styles.personal.create', { body });
  cmd.out.data(data, renderWrite);
  return EXIT_OK;
}

/**
 * A personal-style patch. With `--expect-version` it is one guarded write.
 * Without, it reads the current version, writes, and on a version conflict
 * retries EXACTLY ONCE (spec §6.4): two of the owner's sessions setting
 * disjoint keys both land, because `vars` is a merge patch.
 */
async function patchPersonal(
  cmd: CommandContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<PersonalStyleWriteResult> {
  const client = clientFor(cmd.ctx);
  const explicit = cmd.options.integer('expect-version');
  const mutationId = cmd.options.value('mutation-id');
  const write = (expectedVersion: number, attempt: number) =>
    observedInvoke<PersonalStyleWriteResult>(client, 'styles.personal.update', {
      params: { id },
      body: {
        ...patch,
        expectedVersion,
        // A retry is a DIFFERENT write (new expected version), so it must not
        // replay the first attempt's ledger entry.
        clientMutationId: attempt === 0 ? resolveMutationId(mutationId) : resolveMutationId(undefined),
      },
    });
  if (explicit !== undefined) return write(explicit, 0);
  const current = await observedInvoke<StyleGetResult>(client, 'styles.get', { params: { ref: `personal:${id}` } });
  try {
    return await write(current.version, 0);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'version_conflict') throw err;
    const again = err.currentVersion
      ?? (await observedInvoke<StyleGetResult>(client, 'styles.get', { params: { ref: `personal:${id}` } })).version;
    return write(again, 1);
  }
}

async function styleSet(cmd: CommandContext): Promise<ExitCode> {
  knownWithVars(cmd, ['expect-version', 'mutation-id']);
  const ref = await requireOrigin(cmd, requireArg(cmd, 0, '<personal-ref>'), '<personal-ref>', ['personal']);
  const vars = varOptions(cmd);
  if (Object.keys(vars).length === 0) {
    throw new CliError('tm8 style set needs at least one --pn-<name>=<value>', EXIT_USAGE);
  }
  const data = await patchPersonal(cmd, ref.id, { vars });
  cmd.out.data(data, renderWrite);
  return EXIT_OK;
}

async function styleUnset(cmd: CommandContext): Promise<ExitCode> {
  knownWithVars(cmd, ['expect-version', 'mutation-id']);
  const ref = await requireOrigin(cmd, requireArg(cmd, 0, '<personal-ref>'), '<personal-ref>', ['personal']);
  const names = varNames(cmd);
  if (names.length === 0) throw new CliError('tm8 style unset needs at least one --pn-<name>', EXIT_USAGE);
  const data = await patchPersonal(cmd, ref.id, { vars: Object.fromEntries(names.map((n) => [n, null])) });
  cmd.out.data(data, renderWrite);
  return EXIT_OK;
}

async function styleUpdate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [
    'expect-version', 'title', 'description', 'foundation', 'vars', 'vars-replace', 'css', 'tag', 'mutation-id',
  ]);
  const ref = await requireOrigin(cmd, requireArg(cmd, 0, '<personal-ref>'), '<personal-ref>', ['personal']);
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) throw new CliError('--expect-version is required', EXIT_USAGE);
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion,
  };
  const title = cmd.options.value('title');
  if (title !== undefined) body.title = title;
  const description = cmd.options.value('description');
  if (description !== undefined) body.description = description === 'none' ? null : description;
  const foundation = cmd.options.value('foundation');
  if (foundation !== undefined) body.foundation = foundation;
  const vars = cmd.options.value('vars');
  const replace = cmd.options.value('vars-replace');
  if (vars !== undefined && replace !== undefined) {
    throw new CliError('--vars (merge) and --vars-replace are mutually exclusive', EXIT_USAGE);
  }
  if (vars !== undefined) {
    const patch = await jsonObject(vars, '--vars');
    for (const [k, v] of Object.entries(patch)) {
      if (!VAR_NAME.test(k)) throw new CliError(`--vars: ${k} is not a style variable name`, EXIT_USAGE);
      if (v !== null && typeof v !== 'string') throw new CliError(`--vars: ${k} must be a string or null`, EXIT_USAGE);
    }
    body.vars = patch;
  }
  if (replace !== undefined) body.varsReplace = await varsSource(replace, '--vars-replace');
  const css = await cssOption(cmd);
  if (css !== undefined) body.css = css;
  const tags = cmd.options.values('tag');
  if (tags.length > 0) body.tags = tags;
  const data = await observedInvoke<PersonalStyleWriteResult>(clientFor(cmd.ctx), 'styles.personal.update', {
    params: { id: ref.id },
    body,
  });
  cmd.out.data(data, renderWrite);
  return EXIT_OK;
}

async function styleDelete(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const ref = await requireOrigin(cmd, requireArg(cmd, 0, '<personal-ref>'), '<personal-ref>', ['personal']);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'styles.personal.delete', {
    params: { id: ref.id },
    body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, () => `Deleted ${ref.ref}. A space style pushed from it stays.`);
  return EXIT_OK;
}

/** `import`: a `.css` file's `--pn-*` declarations, or a `.tm8style.json`. */
async function styleImport(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['title', 'foundation', 'mutation-id']);
  const file = requireArg(cmd, 0, '<file>');
  const text = await readTextSource(file === '-' || file.startsWith('@') ? file : `@${file}`);
  const body: Record<string, unknown> = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };
  let title = cmd.options.value('title');
  if (text.trimStart().startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      throw new CliError(`invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`, EXIT_USAGE);
    }
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const doc = (typeof obj.doc === 'object' && obj.doc !== null ? obj.doc : obj) as Record<string, unknown>;
    title ??= typeof obj.title === 'string' ? obj.title : undefined;
    body.foundation = cmd.options.value('foundation') ?? doc.foundation;
    if (doc.vars !== undefined) body.vars = doc.vars;
    if (typeof doc.css === 'string') body.css = doc.css;
  } else {
    // Comments first, so a commented-out declaration is not imported.
    const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const vars: Record<string, string> = {};
    for (const m of css.matchAll(/(--pn-[a-z0-9-]{1,64})\s*:\s*([^;}]+)/gi)) {
      vars[(m[1] as string).toLowerCase()] = (m[2] as string).trim();
    }
    if (Object.keys(vars).length === 0) {
      throw new CliError(`${file} declares no --pn-* variables`, EXIT_USAGE);
    }
    body.vars = vars;
    body.foundation = cmd.options.value('foundation') ?? 'builtin:atelier-light';
  }
  if (title === undefined) throw new CliError('--title is required (the file carries none)', EXIT_USAGE);
  if (typeof body.foundation !== 'string') throw new CliError('--foundation is required (the file carries none)', EXIT_USAGE);
  body.title = title;
  const data = await observedInvoke<PersonalStyleWriteResult>(clientFor(cmd.ctx), 'styles.personal.create', { body });
  cmd.out.data(data, renderWrite);
  return EXIT_OK;
}

// ── space styles ──────────────────────────────────────────────────────────

async function stylePush(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['to', 'expect-version', 'title', 'mutation-id']);
  const source = await requireOrigin(cmd, requireArg(cmd, 0, '<personal-ref>'), '<personal-ref>', ['personal']);
  const client = clientFor(cmd.ctx);
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    personalStyleId: source.id,
    spaceId: requireSpace(cmd.ctx),
  };
  const to = cmd.options.value('to');
  if (to !== undefined) {
    body.targetStyleId = (await requireOrigin(cmd, to, '--to', ['space'])).id;
  } else {
    // Without --to, the style this one was pushed as before is the target;
    // a style never pushed makes a NEW space style.
    const current = await observedInvoke<StyleGetResult>(client, 'styles.get', { params: { ref: source.ref } });
    const publishedAs = current.personal?.publishedAs ?? null;
    if (publishedAs !== null) body.targetStyleId = publishedAs;
  }
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;
  const title = cmd.options.value('title');
  if (title !== undefined) body.title = title;
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  const data = await observedInvoke<SpaceStyleWriteResult>(client, 'styles.push', { body });
  cmd.out.data(data, renderWrite);
  return EXIT_OK;
}

async function stylePull(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['title', 'mutation-id']);
  const ref = await requireOrigin(cmd, requireArg(cmd, 0, '<space-ref>'), '<space-ref>', ['space', 'builtin']);
  const body: Record<string, unknown> = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };
  const title = cmd.options.value('title');
  if (title !== undefined) body.title = title;
  const data = await observedInvoke<PersonalStyleWriteResult>(clientFor(cmd.ctx), 'styles.pull', {
    params: { ref: ref.ref },
    body,
  });
  cmd.out.data(data, renderWrite);
  return EXIT_OK;
}

async function styleRemove(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'mutation-id']);
  const ref = await requireOrigin(cmd, requireArg(cmd, 0, '<space-ref>'), '<space-ref>', ['space']);
  const body: Record<string, unknown> = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'styles.remove', {
    params: { ref: ref.ref },
    body,
  });
  cmd.out.data(data, () => `Removed ${ref.ref}. Members on it keep their snapshot.`);
  return EXIT_OK;
}

// ── selection ─────────────────────────────────────────────────────────────

async function styleUse(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['dark', 'follow-os', 'no-follow-os', 'trust-css', 'mutation-id']);
  const client = clientFor(cmd.ctx);
  const raw = cmd.args[0];
  const writes = raw !== undefined || ['dark', 'follow-os', 'no-follow-os', 'trust-css'].some((n) => cmd.options.has(n));
  if (!writes) {
    // No argument: what am I using? (identity.stylePrefs.get)
    refuseMutationId('style use', cmd.options.value('mutation-id'));
    const data = await observedInvoke<StylePrefsGetResult>(client, 'identity.stylePrefs.get');
    cmd.out.data(data, (d) => renderPrefs(d.prefs));
    return EXIT_OK;
  }
  if (cmd.options.bool('follow-os') && cmd.options.bool('no-follow-os')) {
    throw new CliError('--follow-os and --no-follow-os are mutually exclusive', EXIT_USAGE);
  }
  const body: Record<string, unknown> = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };
  let current: { ref: string; origin: Origin; id: string } | undefined;
  if (raw !== undefined) {
    current = await resolveRef(cmd, raw, '<ref>');
    body.currentStyle = current.ref;
  }
  const dark = cmd.options.value('dark');
  if (dark !== undefined) body.darkStyle = dark === 'none' ? null : (await resolveRef(cmd, dark, '--dark')).ref;
  if (cmd.options.bool('follow-os')) body.followOs = true;
  if (cmd.options.bool('no-follow-os')) body.followOs = false;
  if (cmd.options.bool('trust-css')) {
    if (current?.origin !== 'space') {
      throw new CliError('--trust-css allows a SPACE style\'s css: name one as <ref>', EXIT_USAGE, {
        hint: 'a personal style\'s css always runs for its owner; built-ins carry none',
      });
    }
    body.trustedCss = { add: [current.id] };
  }
  const data = await observedInvoke<StylePrefsSetResult>(client, 'identity.stylePrefs.set', { body });
  cmd.out.data(data, (d) => renderPrefs(d.prefs));
  return EXIT_OK;
}

async function styleDefault(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const spaceId = requireSpace(cmd.ctx);
  const client = clientFor(cmd.ctx);
  const raw = cmd.args[0];
  if (raw === undefined) {
    refuseMutationId('style default', cmd.options.value('mutation-id'));
    const data = await observedInvoke<SpaceStyleDefaultView>(client, 'spaces.styleDefault.get', { params: { spaceId } });
    cmd.out.data(data, (d) => `${d.defaultStyle}${d.revision === 0 ? ' (no default set)' : `  revision ${d.revision}`}`);
    return EXIT_OK;
  }
  const ref = await requireOrigin(cmd, raw, '<ref>', ['space', 'builtin']);
  const data = await observedInvoke<SpaceStyleDefaultView>(client, 'spaces.styleDefault.set', {
    params: { spaceId },
    body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')), defaultStyle: ref.ref },
  });
  cmd.out.data(data, (d) => `${d.defaultStyle}  revision ${d.revision}`);
  return EXIT_OK;
}

export const STYLE_COMMANDS: CommandModule[] = [
  { path: ['style', 'list'], run: styleList },
  { path: ['style', 'get'], run: styleGet },
  { path: ['style', 'create'], run: styleCreate },
  { path: ['style', 'set'], run: styleSet },
  { path: ['style', 'unset'], run: styleUnset },
  { path: ['style', 'update'], run: styleUpdate },
  { path: ['style', 'delete'], run: styleDelete },
  { path: ['style', 'push'], run: stylePush },
  { path: ['style', 'pull'], run: stylePull },
  { path: ['style', 'remove'], run: styleRemove },
  { path: ['style', 'use'], run: styleUse },
  { path: ['style', 'default'], run: styleDefault },
  { path: ['style', 'resolve'], run: styleResolve },
  { path: ['style', 'export'], run: styleExport },
  { path: ['style', 'import'], run: styleImport },
  { path: ['style', 'versions'], run: styleVersions },
];
