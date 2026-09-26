/**
 * `tm8 --space <alias|id>` from a session whose Space is another one (W7).
 *
 * The session's own Space is HOME. When `--space` names any other Space, the
 * invocation runs there only through a space link the launching human made:
 *
 *   1. `spaceLinks.list` on home resolves the value — a link alias, a link id
 *      or the target Space id — to one link. No link: the call stops here and
 *      tells the agent to ask its human for `tm8 link add`.
 *   2. The context keeps `space` = the TARGET (commands bind it as usual) and
 *      gains `link`; `Tm8Client` then sends every catalog op as ONE
 *      `spaceLinks.invoke` to home (client.ts `invokeThroughLink`).
 *
 * THERE IS NO SECOND PATH. Nothing here calls the target, and no token is
 * read, held or sent other than the caller's own pass to home: the refused set
 * (SPACE_LINK_REFUSED) and the audit both live on the home server, and a CLI
 * that could reach the target another way would skip both. Commands that open
 * their own transport (a WebSocket, a raw PUT, a byte download, a registry or
 * credential store) are therefore refused up front rather than half-routed.
 *
 * Only a tm8-spawned session has a home (`isAgentContext`: the same marker that
 * keeps the human credential store off-limits). A human shell with no session
 * marker — even one exporting TM8_SPACE_ID — keeps `--space`'s old meaning.
 */
import type { SpaceLinkView } from '@tm8/contract';
import { Tm8Client } from './client.js';
import { isAgentContext } from './credentials.js';
import type { CliContext, SpaceLinkRoute } from './context.js';
import { CliError, EXIT_NOT_FOUND, EXIT_USAGE } from './exit.js';

/**
 * Commands that never run through a link, by path prefix: each opens its own
 * transport or acts on local or home-only state, so routing it would either
 * bypass the home guards or quietly act on the wrong Space.
 */
export const LINK_REFUSED_COMMANDS: readonly (readonly string[])[] = [
  ['event', 'watch'],
  ['session', 'attach'],
  ['file', 'upload'],
  ['file', 'download'],
  ['auth'],
  ['server'],
  ['doctor'],
  ['link'],
];

function refusedCommand(path: readonly string[]): readonly string[] | undefined {
  return LINK_REFUSED_COMMANDS.find((prefix) => prefix.every((part, i) => path[i] === part));
}

/** The session's own Space, or undefined when this is not a tm8 session with one. */
export function homeSpaceOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isAgentContext(env)) return undefined;
  return env.TM8_SPACE_ID?.trim() || undefined;
}

/** True when `--space` names a Space other than the session's own. */
export function needsLink(ctx: CliContext, home: string | undefined): home is string {
  return home !== undefined && ctx.space?.source === 'flag' && ctx.space.value !== home;
}

/** The link `ref` names among home's links: alias, link id or target Space id. */
export function matchLink(views: readonly SpaceLinkView[], ref: string): SpaceLinkView | undefined {
  const wanted = ref.trim().toLowerCase();
  return (
    views.find((v) => v.mine?.alias?.toLowerCase() === wanted) ??
    views.find((v) => v.id.toLowerCase() === wanted) ??
    views.find((v) => v.targetSpaceId.toLowerCase() === wanted)
  );
}

/**
 * Step 1 and 2 above. Returns the context unchanged when no link is needed,
 * or with `space` = target and `link` set. `--server` and a link are exclusive:
 * the link IS the route to the other Space.
 */
export async function routeThroughSpaceLink(
  ctx: CliContext,
  path: readonly string[],
  opts: { home?: string | undefined; serverFlag?: string | undefined } = {},
): Promise<CliContext> {
  const home = 'home' in opts ? opts.home : homeSpaceOf();
  if (!needsLink(ctx, home)) return ctx;
  const ref = (ctx.space as { value: string }).value;

  const refused = refusedCommand(path);
  if (refused) {
    throw new CliError(
      `\`tm8 ${refused.join(' ')}\` cannot run through a space link; --space ${ref} is not this session's Space`,
      EXIT_USAGE,
      { hint: 'drop --space to act on this session\'s own Space' },
    );
  }
  if (opts.serverFlag !== undefined) {
    throw new CliError('--server and a linked --space are exclusive: the space link is the route', EXIT_USAGE);
  }

  // A DIRECT client: the lookup itself is a home read, never routed.
  const direct = new Tm8Client({
    baseUrl: ctx.baseUrl.value,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs,
    fresh: true,
  });
  const views = await direct.invoke<SpaceLinkView[]>('spaceLinks.list', { params: { spaceId: home } });
  const view = matchLink(views ?? [], ref);
  if (!view) {
    throw new CliError(
      `no space link from this session's Space to ${JSON.stringify(ref)}; ask your human to run \`tm8 link add\``,
      EXIT_NOT_FOUND,
      { hint: 'a human in this Space runs `tm8 link add <target-space-id>` then `tm8 link login <alias|link-id>`' },
    );
  }
  const link: SpaceLinkRoute = { homeSpaceId: home, linkId: view.id, targetSpaceId: view.targetSpaceId };
  return { ...ctx, space: { value: view.targetSpaceId, source: 'flag' }, link };
}
