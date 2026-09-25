/**
 * Per-kind chat defaults (entity-chat design 01a0da4e §3.4): the space-wide
 * teammate + model a new chat about an entity of a kind starts with.
 *
 *   · `useChatDefaults(seam, spaceId, kind?)` — the shared, live read; `set`
 *     writes one kind (the card's "Use for every ‹Kind› chat").
 *   · `resolveChatDefault(entry, ctx)` — the skip-when-default rule.
 *   · `chatDefaultKindRows` — which kinds carry a default, from the registry.
 */
export { useChatDefaults, loadChatDefaults, saveChatDefaults, type ChatDefaultsSeam, type UseChatDefaults } from './useChatDefaults';
export { resolveChatDefault, type ChatDefaultResolution, type ChatDefaultResolveContext } from './resolve';
export { chatDefaultKindRows, customKindLabel, type ChatDefaultKindRow } from './kinds';
export { loadChatDefaultsOptions, type ChatDefaultsOptions, type ChatDefaultsTeammate } from './options';
export { lastChatMode, lastChatPicks, rememberChatMode, rememberChatStart, type LastChatPicks } from './lastUsed';
