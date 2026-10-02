/**
 * `styles.*`, `identity.stylePrefs.*`, `spaces.styleDefault.*` — styles spec
 * 01a0fc22 v8 §4 over migration 282.
 *
 * DIVISION OF LABOUR. The database owns WHO and WHEN: ownership, membership,
 * admin rights, readability, versions, caps, history and every event. This
 * file owns WHAT: it runs the shared resolver (`style-validation.ts`) on every
 * document that is written, so the stored form is the normalised one (clamped
 * values clamped, unknown keys dropped, css sanitised) and every write returns
 * the resolver's warnings. Push and pull copy rows inside SQL, so they need no
 * second validation of the document itself — a push still re-resolves, for the
 * warnings it returns and a fresh `resolved_hash`.
 *
 * Personal-style updates are READ-MODIFY-WRITE here: the merge patch (§6.5) is
 * applied to the row as read, and the write carries the version that read saw,
 * so a concurrent edit is a `version_conflict`, never a silent merge.
 */
import {
  BUILTIN_STYLES,
  CollabError,
  PersonalStyleCreateInputSchema,
  PersonalStyleDeleteInputSchema,
  PersonalStyleUpdateInputSchema,
  SpaceStyleDefaultSetInputSchema,
  StylePrefsSetInputSchema,
  StylePullInputSchema,
  StylePushInputSchema,
  StyleRemoveInputSchema,
  StylesResolveInputSchema,
} from '@tm8/contract';
import type {
  PersonalStyleView,
  PersonalStyleWriteResult,
  PersonalStylesListResult,
  SpaceStyleDefaultView,
  SpaceStyleView,
  SpaceStyleWriteResult,
  StyleDoc,
  StyleGetResult,
  StyleListRow,
  StylePrefsGetResult,
  StylePrefsSetResult,
  StylePrefsView,
  StylesExportResult,
  StylesListResult,
  StylesResolveResult,
} from '@tm8/contract';

import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import type { DbClaims } from '../../../db/types.js';
import { claimsFor, commandEnvelope } from '../../context.js';
import { requireHumanSession } from './credentials.js';
import {
  DEFAULT_STYLE_REF,
  assertKnownRef,
  builtinDoc,
  builtinRevision,
  builtinTitle,
  exportDoc,
  isBuiltinId,
  normalizeForWrite,
  parseRefOrUuid,
  resolveDoc,
} from '../../services/w2/style-validation.js';

function param(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (!value) throw new CollabError('invalid_input', `${name} is required`);
  return value;
}

function isNotFound(err: unknown): boolean {
  return err instanceof CollabError && err.code === 'not_found';
}

export class W2StylesService {
  constructor(private readonly deps: FacadeDeps) {}

  private async readClaims(ctx: RequestContext): Promise<DbClaims> {
    return claimsFor(await this.deps.owner(), ctx);
  }

  private async writeClaims(ctx: RequestContext): Promise<DbClaims> {
    const envelope = commandEnvelope(ctx);
    return claimsFor(await this.deps.owner(), ctx, envelope);
  }

  private rpc<T>(claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.deps.db.rpc<T>(claims, fn, args);
  }

  private getPersonal(claims: DbClaims, id: string): Promise<PersonalStyleView> {
    return this.rpc<PersonalStyleView>(claims, 'get_personal_style', [id]);
  }

  private getSpace(claims: DbClaims, id: string): Promise<SpaceStyleView> {
    return this.rpc<SpaceStyleView>(claims, 'get_space_style', [id]);
  }

  /** A path ref to a concrete style; a bare uuid is personal first, then space (§5). */
  private async lookup(claims: DbClaims, raw: string): Promise<
    | { origin: 'builtin'; id: string }
    | { origin: 'personal'; style: PersonalStyleView }
    | { origin: 'space'; style: SpaceStyleView }
  > {
    const ref = parseRefOrUuid(raw);
    if (ref.kind === 'builtin') return { origin: 'builtin', id: ref.id };
    if (ref.kind === 'personal') return { origin: 'personal', style: await this.getPersonal(claims, ref.id) };
    if (ref.kind === 'space') return { origin: 'space', style: await this.getSpace(claims, ref.id) };
    try {
      return { origin: 'personal', style: await this.getPersonal(claims, ref.id) };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return { origin: 'space', style: await this.getSpace(claims, ref.id) };
    }
  }

  /** The space style a path names. Built-ins and personal styles are not space styles. */
  private spaceIdOf(raw: string): string {
    const ref = parseRefOrUuid(raw);
    if (ref.kind === 'bare' || ref.kind === 'space') return ref.id;
    throw new CollabError('invalid_input', `${raw} is not a space style (expected space:<uuid>)`);
  }

  // ── personal ──────────────────────────────────────────────────────────────

  readonly personalList: OperationHandler = async (ctx): Promise<PersonalStylesListResult> =>
    this.rpc<PersonalStylesListResult>(await this.readClaims(ctx), 'list_personal_styles');

  readonly personalCreate: OperationHandler = async (ctx): Promise<PersonalStyleWriteResult> => {
    const input = PersonalStyleCreateInputSchema.parse(ctx.body);
    const claims = await this.writeClaims(ctx);

    if (input.from !== undefined) {
      const source = await this.lookup(claims, input.from);
      // Copying a space style is a pull: same door, so `pulledFrom` is recorded.
      if (source.origin === 'space') {
        return this.pullSpace(claims, source.style.id, input.title, input.clientMutationId);
      }
      const doc = source.origin === 'builtin' ? builtinDoc(source.id) : source.style.doc;
      const title = input.title
        ?? (source.origin === 'builtin' ? builtinTitle(source.id) : source.style.title);
      return this.createPersonal(claims, {
        title,
        description: input.description ?? (source.origin === 'personal' ? source.style.description : null),
        tags: input.tags ?? (source.origin === 'personal' ? source.style.tags : []),
        doc: {
          ...doc,
          ...(input.foundation !== undefined ? { foundation: input.foundation } : {}),
          ...(input.vars !== undefined ? { vars: { ...doc.vars, ...input.vars } } : {}),
          ...(input.css !== undefined ? { css: input.css } : {}),
        } as StyleDoc,
        clientMutationId: input.clientMutationId,
      });
    }

    return this.createPersonal(claims, {
      title: input.title!,
      description: input.description ?? null,
      tags: input.tags ?? [],
      doc: { schemaVersion: 1, foundation: input.foundation!, vars: input.vars ?? {}, css: input.css ?? null } as StyleDoc,
      clientMutationId: input.clientMutationId,
    });
  };

  private async createPersonal(claims: DbClaims, args: {
    title: string; description: string | null; tags: string[]; doc: StyleDoc; clientMutationId: string;
  }): Promise<PersonalStyleWriteResult> {
    const write = normalizeForWrite(args.doc);
    const { style } = await this.rpc<{ style: PersonalStyleView }>(claims, 'create_personal_style', [
      args.title, write.doc.foundation, args.description,
      JSON.stringify(write.doc.vars), write.doc.css ?? null, args.tags,
      write.hash, args.clientMutationId,
    ]);
    return { style, warnings: write.warnings, clamped: write.clamped };
  }

  readonly personalUpdate: OperationHandler = async (ctx): Promise<PersonalStyleWriteResult> => {
    const input = PersonalStyleUpdateInputSchema.parse(ctx.body);
    const id = param(ctx, 'id');
    const claims = await this.writeClaims(ctx);
    const current = await this.getPersonal(claims, id);
    if (current.version !== input.expectedVersion) {
      throw new CollabError('version_conflict', `personal style ${id} is at version ${current.version}`, {
        details: { currentVersion: current.version, current },
      });
    }

    // §6.5: `vars` is a MERGE PATCH (null unsets), `varsReplace` replaces the
    // map; every other member replaces when present and is kept when absent.
    let vars: Record<string, string> = { ...current.doc.vars };
    if (input.varsReplace !== undefined) {
      vars = { ...input.varsReplace };
    } else if (input.vars !== undefined) {
      for (const [key, value] of Object.entries(input.vars)) {
        if (value === null) delete vars[key];
        else vars[key] = value;
      }
    }
    const write = normalizeForWrite({
      schemaVersion: current.doc.schemaVersion,
      foundation: input.foundation ?? current.doc.foundation,
      vars,
      css: input.css !== undefined ? input.css : current.doc.css ?? null,
    });
    const { style } = await this.rpc<{ style: PersonalStyleView }>(claims, 'update_personal_style', [
      id, input.expectedVersion,
      input.title ?? current.title,
      input.description !== undefined ? input.description : current.description,
      write.doc.foundation, JSON.stringify(write.doc.vars), write.doc.css ?? null,
      input.tags ?? current.tags,
      write.hash, input.clientMutationId,
    ]);
    return { style, warnings: write.warnings, clamped: write.clamped };
  };

  readonly personalDelete: OperationHandler = async (ctx) => {
    const input = PersonalStyleDeleteInputSchema.parse(ctx.body ?? {});
    return this.rpc(await this.writeClaims(ctx), 'delete_personal_style', [
      param(ctx, 'id'), input.expectedVersion ?? null, input.clientMutationId,
    ]);
  };

  // ── space styles ──────────────────────────────────────────────────────────

  readonly list: OperationHandler = async (ctx): Promise<StylesListResult> => {
    const spaceId = param(ctx, 'spaceId');
    const claims = await this.readClaims(ctx);
    const space = await this.rpc<StylesListResult>(claims, 'list_space_styles', [spaceId]);
    const { prefs } = await this.rpc<StylePrefsGetResult>(claims, 'get_identity_style_prefs');
    const builtins: StyleListRow[] = Object.keys(BUILTIN_STYLES).map((id) => ({
      origin: 'builtin',
      id,
      ref: id,
      title: builtinTitle(id),
      foundation: id,
      varCount: 0,
      hasCss: false,
      tags: [],
      version: builtinRevision(id),
      resolvedHash: null,
      pushedBy: null,
      pushedAt: null,
      isDefault: space.defaultStyle === id,
      inUseByMe: prefs !== null && (prefs.currentStyle === id || prefs.darkStyle === id),
      canPush: false,
    }));
    const tag = ctx.query.get('tag');
    const rows = [...builtins, ...space.items];
    return {
      items: tag ? rows.filter((row) => row.tags.includes(tag)) : rows,
      defaultStyle: space.defaultStyle,
      defaultDangling: space.defaultDangling,
    };
  };

  readonly get: OperationHandler = async (ctx): Promise<StyleGetResult> => {
    const claims = await this.readClaims(ctx);
    const found = await this.lookup(claims, param(ctx, 'ref'));
    if (found.origin === 'builtin') {
      const doc = builtinDoc(found.id);
      const resolved = resolveDoc(doc);
      return {
        origin: 'builtin', ref: found.id, id: found.id, title: builtinTitle(found.id), description: null,
        tags: [], version: builtinRevision(found.id), doc, resolvedHash: resolved.hash,
        resolved, warnings: resolved.warnings,
      };
    }
    const resolved = resolveDoc(found.style.doc);
    const common = {
      ref: found.style.ref, id: found.style.id, title: found.style.title,
      description: found.style.description, tags: found.style.tags, version: found.style.version,
      doc: found.style.doc, resolvedHash: found.style.resolvedHash, resolved, warnings: resolved.warnings,
    };
    return found.origin === 'personal'
      ? { origin: 'personal', ...common, personal: found.style }
      : { origin: 'space', ...common, space: found.style };
  };

  readonly push: OperationHandler = async (ctx): Promise<SpaceStyleWriteResult> => {
    const input = StylePushInputSchema.parse(ctx.body);
    const claims = await this.writeClaims(ctx);
    // Re-resolve the personal document for the warnings the pusher sees and a
    // hash current with THIS deploy's built-ins (§6.2); SQL copies the row.
    const personal = await this.getPersonal(claims, input.personalStyleId);
    const resolved = resolveDoc(personal.doc);
    const { style } = await this.rpc<{ style: SpaceStyleView }>(claims, 'push_style', [
      input.personalStyleId, input.spaceId, input.targetStyleId ?? null, input.expectedVersion ?? null,
      input.actorId ?? null, input.title ?? null, resolved.hash, input.clientMutationId,
    ]);
    return { style, warnings: resolved.warnings, clamped: [] };
  };

  readonly pull: OperationHandler = async (ctx): Promise<PersonalStyleWriteResult> => {
    const input = StylePullInputSchema.parse(ctx.body ?? {});
    const claims = await this.writeClaims(ctx);
    const ref = parseRefOrUuid(param(ctx, 'ref'));
    if (ref.kind === 'builtin') {
      return this.createPersonal(claims, {
        title: input.title ?? builtinTitle(ref.id), description: null, tags: [],
        doc: builtinDoc(ref.id), clientMutationId: input.clientMutationId,
      });
    }
    if (ref.kind === 'personal') {
      throw new CollabError('invalid_input', 'pull copies a space style or a built-in; to copy your own style use styles.personal.create with `from`');
    }
    return this.pullSpace(claims, ref.id, input.title, input.clientMutationId);
  };

  private async pullSpace(
    claims: DbClaims, entityId: string, title: string | undefined, clientMutationId: string,
  ): Promise<PersonalStyleWriteResult> {
    const { style } = await this.rpc<{ style: PersonalStyleView }>(claims, 'pull_style', [
      entityId, title ?? null, clientMutationId,
    ]);
    return { style, warnings: resolveDoc(style.doc).warnings, clamped: [] };
  }

  readonly remove: OperationHandler = async (ctx) => {
    const input = StyleRemoveInputSchema.parse(ctx.body ?? {});
    return this.rpc(await this.writeClaims(ctx), 'remove_style', [
      this.spaceIdOf(param(ctx, 'ref')), input.expectedVersion ?? null,
      input.actorId ?? null, input.clientMutationId,
    ]);
  };

  readonly resolve: OperationHandler = async (ctx): Promise<StylesResolveResult> => {
    const { doc } = StylesResolveInputSchema.parse(ctx.body);
    // Lint/preview: the same normalisation a save would do, stored nowhere.
    const write = normalizeForWrite(doc);
    const resolved = resolveDoc(write.doc);
    return { resolved, warnings: write.warnings, clamped: write.clamped };
  };

  readonly export: OperationHandler = async (ctx): Promise<StylesExportResult> => {
    const format = ctx.query.get('format') ?? 'css';
    const only = ctx.query.get('only') ?? 'set';
    if (format !== 'css' && format !== 'json') throw new CollabError('invalid_input', 'format is css or json');
    if (only !== 'set' && only !== 'all') throw new CollabError('invalid_input', 'only is set or all');
    const claims = await this.readClaims(ctx);
    const found = await this.lookup(claims, param(ctx, 'ref'));
    const doc = found.origin === 'builtin' ? builtinDoc(found.id) : found.style.doc;
    const ref = found.origin === 'builtin' ? found.id : found.style.ref;
    return { ref, format, only, text: exportDoc(doc, format, only) };
  };

  // ── selection ─────────────────────────────────────────────────────────────

  readonly prefsGet: OperationHandler = async (ctx): Promise<StylePrefsGetResult> =>
    this.rpc<StylePrefsGetResult>(await this.readClaims(ctx), 'get_identity_style_prefs');

  readonly prefsSet: OperationHandler = async (ctx): Promise<StylePrefsSetResult> => {
    const input = StylePrefsSetInputSchema.parse(ctx.body);
    const claims = await this.writeClaims(ctx);
    const { prefs: existing } = await this.rpc<StylePrefsGetResult>(claims, 'get_identity_style_prefs');

    const currentStyle = input.currentStyle ?? existing?.currentStyle ?? DEFAULT_STYLE_REF;
    const darkStyle = input.darkStyle !== undefined ? input.darkStyle : existing?.darkStyle ?? null;
    const followOs = input.followOs ?? existing?.followOs ?? false;
    const trusted = new Set(existing?.trustedCss ?? []);
    for (const id of input.trustedCss?.add ?? []) trusted.add(id.toLowerCase());
    for (const id of input.trustedCss?.remove ?? []) trusted.delete(id.toLowerCase());
    assertKnownRef(currentStyle, 'currentStyle');
    if (darkStyle !== null) assertKnownRef(darkStyle, 'darkStyle');

    // The door verifies readability of both refs NOW (403 otherwise), writes
    // the snapshot from what it read and emits the per-member event.
    const { prefs } = await this.rpc<{ prefs: StylePrefsView }>(claims, 'set_identity_style_prefs', [
      currentStyle, darkStyle, followOs, [...trusted],
      input.expectedRevision ?? null, input.clientMutationId,
    ]);
    const current = prefs.snapshot.current ?? builtinDoc(DEFAULT_STYLE_REF);
    return {
      prefs,
      resolved: {
        current: resolveDoc(current),
        dark: prefs.snapshot.dark ? resolveDoc(prefs.snapshot.dark) : null,
      },
    };
  };

  readonly defaultGet: OperationHandler = async (ctx): Promise<SpaceStyleDefaultView> =>
    this.rpc<SpaceStyleDefaultView>(await this.readClaims(ctx), 'get_space_style_default', [param(ctx, 'spaceId')]);

  readonly defaultSet: OperationHandler = async (ctx): Promise<SpaceStyleDefaultView> => {
    const input = SpaceStyleDefaultSetInputSchema.parse(ctx.body);
    if (input.defaultStyle.startsWith('builtin:') && !isBuiltinId(input.defaultStyle)) {
      throw new CollabError('invalid_input', `no built-in style "${input.defaultStyle}" on this server`);
    }
    return this.rpc<SpaceStyleDefaultView>(await this.writeClaims(ctx), 'set_space_style_default', [
      param(ctx, 'spaceId'), input.defaultStyle, input.expectedRevision ?? null, input.clientMutationId,
    ]);
  };
}

/**
 * Registration. `spaces.styleDefault.set` is the one human-only door
 * (`humanOnly` in the catalog ⇔ wrapped here); the SQL door repeats the rule
 * with `require_human_space_admin`, so an agent is refused twice.
 */
export function registerW2StyleHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  const service = new W2StylesService(deps);
  registry.registerAll({
    'styles.personal.list': service.personalList,
    'styles.personal.create': service.personalCreate,
    'styles.personal.update': service.personalUpdate,
    'styles.personal.delete': service.personalDelete,
    'styles.list': service.list,
    'styles.get': service.get,
    'styles.push': service.push,
    'styles.pull': service.pull,
    'styles.remove': service.remove,
    'styles.resolve': service.resolve,
    'styles.export': service.export,
    'identity.stylePrefs.get': service.prefsGet,
    'identity.stylePrefs.set': service.prefsSet,
    'spaces.styleDefault.get': service.defaultGet,
    'spaces.styleDefault.set': requireHumanSession(service.defaultSet),
  });
}
