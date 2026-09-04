/**
 * The merged Home page's rail composition — the ONE place its kinds are named.
 *
 * §15.2 makes a kind literal outside `domain/` and `fixtures/` a build
 * failure, and the Home page needs to say which collections ride its glance
 * rails and which kind fills the presence row. That is registry-adjacent DATA,
 * exactly like `SHIPPED_DEFAULT_MENU` (the D18 precedent), so it lives here
 * and `home-page/` imports it.
 *
 * The rails are deliberately the DAILY collections only — tasks, sessions,
 * docs. Channels are NOT a rail (user ruling 2026-08-14: "channels is accessed
 * differently, chat is different" — conversation surfaces live in the rail's
 * Chats cluster, not on the home canvas), and the occasional collections
 * (memories, artifacts, loops, files…) stay one click away in Workspace.
 */
export const HOME_RAIL_KINDS = ['task', 'work_session', 'doc'] as const;

/** The presence row's kind: the space's agent teammates. */
export const HOME_PRESENCE_KIND = 'team_member';

/**
 * The chat strip's kind (176). It lives HERE and not in `src/home` because
 * §15.2 forbids a kind literal outside `domain/`, and `home-guards.test.ts`
 * enforces it — Home reaches kinds through the registry, never by name.
 */
export const HOME_CHAT_KIND = 'chat';
