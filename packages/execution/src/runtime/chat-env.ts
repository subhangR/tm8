// @tm8/execution — the environment a HEADLESS CHAT RUNTIME runs in.
//
// Fourth sibling of `composeEnv` (agent sessions), `composeCredentialEnv`
// (vendor logins) and `composeShellEnv` (vanilla terminals). It exists for the
// reason the other three do, arrived at the same way: by someone noticing that
// a child was being handed `process.env` wholesale.
//
// WHAT THIS FIXES, AND WHY IT WAS SURVIVABLE UNTIL NOW.
//
// `ClaudeHeadlessAdapter` built its child environment as
// `{ ...process.env, ...config.env }`. On a deployed node the server's own
// environment carries `TM8_DATABASE_URL` and `TM8_DELIVERY_DATABASE_URL`
// (measured 2026-08-21 on the production node: `tr '\0' '\n' <
// /proc/<pid>/environ`). That connection string authenticates as the `tm8`
// role, and `select rolsuper from pg_roles where rolname = current_user`
// answers **true** — so it is not merely an `tm8_app` principal that could
// impersonate an identity through `set_config('tm8.identity_id', …)`; it is a
// SUPERUSER connection, for which every RLS policy on this node is advisory.
//
// That was harmless for exactly as long as chat had no way to read an
// environment variable. Before the working-directory change, chat on the
// production node ran with `['WebFetch','WebSearch','TodoWrite','Skill']` — no
// `Bash`, no `Read`, no filesystem at all — because the git-root inference it
// depended on failed for every thread ever started. The omission cost nothing
// because the capability to exploit it did not exist.
//
// Giving chat the full tool set is what turns it from dormant into live: one
// `env` in one Bash call is a superuser database URL. THE ENV WAS LOAD-BEARING
// BY ACCIDENT, and this file is what makes it load-bearing on purpose.
//
// THE ARGUMENT IS NOT NEW — it is quoted from `PtyHostService` via
// `shell-env.ts:19-23`: "the caller supplies the COMPLETE child environment and
// ... merging `process.env` would leak database URLs and operator secrets."
// That reasoning was applied to the terminal lane and to spawn, both of which
// have a passing test for it. It was never applied to chat, because when chat
// was written chat had no shell.
//
// WHAT THIS DOES **NOT** BUY, stated here so it is never cited as more than it
// is. `HOME` is the server's own and must be: the runtime authenticates from
// `~/.claude`, so redirecting it would break every chat turn. Every
// filesystem-reachable credential under that home therefore remains reachable —
// `~/.git-credentials`, `~/.config/gh/hosts.yml`, `~/.claude/.credentials.json`,
// `~/.ssh`. This allow-list stops the chat child from carrying TM8'S OWN
// SECRETS, which is worth doing and is all it does. It is not a sandbox. The
// honest posture remains: a chat thread with Bash is a shell as the tm8 OS
// user, with that user's home and everything reachable from it.

/**
 * The MAXIMAL key set of a chat runtime's environment, before the per-thread
 * `config.env` (which tm8 composes itself and which carries no ambient value)
 * is layered on top.
 *
 * Exported so a test can assert the WHOLE SET rather than the absence of
 * particular names. That distinction is the point, and `shell-env.ts` states
 * why: `expect(env.TM8_DATABASE_URL).toBeUndefined()` keeps passing on the day
 * someone adds a new secret to the server's environment. An allow-list
 * regression is precisely the failure that would ship unnoticed.
 */
export const CHAT_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'XDG_CACHE_HOME',
] as const;

/**
 * `SAFE_BASE_ENV_KEYS` in manifest.ts is the same list today, and is
 * deliberately NOT reused — the same rule `shell-env.ts` follows for the same
 * reason. That list serves a different process with a different threat model,
 * and growing it there must not silently grow this.
 *
 * NOTE WHAT IS ABSENT AND WHY, since every absence here is a decision:
 *
 *   * every `TM8_*` name. The chat child needs none of them: the MCP server's
 *     own `env` block in the per-thread config carries `TM8_BASE_URL`, the
 *     runtime token, the mode, the Space and the project root. Nothing reaches
 *     the model through the ambient environment, so nothing needs to be there.
 *   * `GH_TOKEN` / `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`. Neither is set on
 *     the production node today, so excluding them costs nothing now and is
 *     the point of an allow-list rather than a deny-list: it stays correct when
 *     one of them IS set later.
 */
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * Build the chat child's environment KEY BY KEY from the server's own.
 *
 * `parentEnv` is read, never copied wholesale. A key absent from the parent is
 * absent from the result rather than present-and-empty: an empty `HOME` is a
 * different and worse failure than no `HOME`, because it resolves relative
 * paths somewhere real.
 */
export function composeChatEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHAT_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  // PATH is the one key whose absence is not survivable — without it the child
  // cannot find `git`, `node`, or anything Bash is asked to run — so it falls
  // back rather than being omitted, exactly as `composeShellEnv` does.
  if (!env['PATH']) env['PATH'] = FALLBACK_PATH;
  return env;
}
