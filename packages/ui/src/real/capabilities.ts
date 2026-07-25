/**
 * The honest gap register.
 *
 * tm8 mounts 80 catalog operations and implements 28 of them. The other 52
 * answer a truthful `501 not_implemented` rather than pretending. This file is
 * the UI-side mirror of that fact, and it exists so that a missing feature
 * looks missing.
 *
 * THE RULE THIS FILE ENFORCES: never fabricate data. A fabricated task is worse
 * than an absent panel, because a user cannot tell it is fake and neither can
 * the next engineer. So the two degradation modes are deliberately different:
 *
 *   READS  → a typed EMPTY (`[]`, an empty Page, zeroed counters). An empty
 *            list is a true statement — "we have nothing to show you here" —
 *            and it lets the surrounding screen render instead of crashing.
 *            Paired with `isUnavailable()` so the screen can label the emptiness
 *            "not built yet" rather than let it read as "you have no tasks".
 *
 *   WRITES → a thrown CollabError('not_implemented'). A write that silently
 *            does nothing while the UI says "saved" is precisely the lie this
 *            lane exists to avoid. Affordances backed by these should be
 *            rendered DISABLED; if one is somehow invoked, it fails loudly.
 *
 * Keep this list in sync with the server by running:
 *   curl -s http://127.0.0.1:4620/health   → {operations, implemented}
 */

/** Facade methods whose backing operation is not implemented on the tm8 node. */
export const UNIMPLEMENTED = {
  reads: [
    // NOTE: getConnections is deliberately NOT here. `edges.list` is a 404 on
    // this node, but `entities.get` returns a fully-populated `connections`
    // block (real edges, both directions, with resolved/hard flags), so the
    // facade serves it from there. That is a different ROUTE for the same real
    // data — not a substitute for missing data — which is why it counts as
    // implemented rather than degraded.
    'getVersions',      // entities.versions
    'getPresence',      // presence.get
    'queryGraph',       // graph traversal has no catalog binding yet
    'getChannelTabs',   // channel.autoTabs is an honest [] server-side
    'getInbox',         // inbox.*
    'getLeaderboard',   // no points aggregation endpoint
    'getAwards',        // points ledger read
    'getTaskAxes',      // spaces.taskAxes
    'getSettings',      // spaces.settings
    'listSavedViews',   // savedViews.*
    'search',           // search.query — DEFERRED by DEV-13 even in the contract
    'getActions',       // actions.list
  ],
  writes: [
    'moveEntity', 'deleteEntity',
    'patchEdge', 'deleteEdge', 'placements', 'undo',
    'patchMessage', 'deleteMessage',
    'setReaction',        // entities.react
    // `grantPoints` was here and was WRONG: entities.points.add is implemented
    // (catalog.ts:65 → facade/index.ts:110 → grant_points RPC, idempotent on
    // clientMutationId). Listing it disabled the points control against a node
    // that would have served it — the only case where this register was more
    // pessimistic than the server.
    'pullEntity',         // entities.commands.pull
    'linkPr', 'trackingRefresh',
    // NOTE: `markRead` is NOT here. It is unbuilt server-side, but the UI calls
    // it automatically on thread view rather than from an affordance, so a
    // throw becomes an unhandled rejection on every open. It resolves as a
    // no-op instead — truthfully, since the unread counters it would clear are
    // hollow zeros anyway. See RealFacade.markRead for the full reasoning.
    'markNotificationRead',
    'createTaskAxis', 'updateTaskAxis', 'deleteTaskAxis',
    'createSavedView', 'updateSavedView', 'deleteSavedView',
  ],
} as const;

/**
 * THE THIRD AND NASTIEST CLASS: fields that are present, structurally valid,
 * correctly typed — and permanently zero or empty, because the computation
 * behind them was trimmed (AM-5) rather than the field.
 *
 * These are more dangerous than a 501, not less. A 501 throws and something
 * catches it. A hollow field renders a confident `0` with nothing to catch and
 * nothing in the console, so the screen looks WORKING-AND-WRONG rather than
 * broken. Critically, a real "0 unread" and an unbuilt "0 unread" are pixel
 * identical to the user, and only one of them is a true statement.
 *
 * RULE: prefer HIDING an affordance driven by one of these to rendering the
 * zero. `isHollow()` is how a screen asks. Sourced from Deneb via Orion and
 * spot-checked against live responses.
 */
export const HOLLOW_FIELDS: Readonly<Record<string, string>> = {
  'channel.state.unreadCount': 'always 0 — unread_counts RPC not built',
  'space.unreadTotal': 'always 0 — unread aggregation not built',
  'navigation.unreadTotal': 'always 0 — unread aggregation not built',
  'member.state.taskDoneCount': 'always 0 — completion tally not built',
  'team_member.state.liveWork': 'always null — live-work projection not built',
  'channel.content.autoTabs': 'always [] — trimmed (AM-5)',
  'channel.content.pinned': 'always [] — pinning not built',
  'member.content.teamMembers': 'always [] — not projected',
  'member.content.work': 'always [] — not projected',
  'team_member.content.equipped': 'always [] — not projected',
  'team_member.content.work': 'always [] — not projected',
  'work_session.content.workingOn': 'always [] — not projected',
  'work_session.content.transcriptDoc': 'always null — no transcript store',
};

/** True when the dotted field path is present-but-permanently-empty. */
export function isHollow(fieldPath: string): boolean {
  return fieldPath in HOLLOW_FIELDS;
}

/** Why a hollow field is hollow, for a tooltip or an empty-state caption. */
export function hollowReason(fieldPath: string): string | null {
  return HOLLOW_FIELDS[fieldPath] ?? null;
}

const ALL: ReadonlySet<string> = new Set<string>([
  ...UNIMPLEMENTED.reads,
  ...UNIMPLEMENTED.writes,
]);

/**
 * True when the named facade method has no server behind it on this node.
 * Screens use this to disable an affordance or caption an empty region, so the
 * absence is stated rather than merely felt.
 */
export function isUnavailable(method: string): boolean {
  return ALL.has(method);
}

/** Human-readable summary for the mode banner. */
export function unavailableCount(): number {
  return ALL.size;
}
