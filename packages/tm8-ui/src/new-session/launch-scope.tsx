import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { craftTeammateId } from '../chat-home/default-teammate';

/**
 * WHERE A LAUNCH CARD WAS OPENED. Inside a craft (owner decisions §5) every
 * Run — the craft's own, the overview's, a page tab's — starts with the
 * Crafter; anywhere else Auto stays the roster's front row. A context rather
 * than a prop because the cards are mounted by the entity panels the craft
 * hosts, which know nothing of the craft around them.
 */
const CraftLaunchScopeContext = createContext<{ craftId: string } | null>(null);

export function CraftLaunchScope({ craftId, children }: { craftId: string; children: ReactNode }) {
  const value = useMemo(() => ({ craftId }), [craftId]);
  return <CraftLaunchScopeContext.Provider value={value}>{children}</CraftLaunchScopeContext.Provider>;
}

export function useCraftLaunchScope(): { craftId: string } | null {
  return useContext(CraftLaunchScopeContext);
}

/**
 * The roster a launch card resolves Auto against: unchanged outside a craft;
 * inside one, the Crafter (`craftTeammateId`) moved to the front, so Auto
 * names it and the person can still pick anyone.
 */
export function rosterForLaunchScope<T extends { id: string; label: string }>(
  teammates: readonly T[],
  scope: { craftId: string } | null,
): readonly T[] {
  if (!scope) return teammates;
  const crafter = craftTeammateId(teammates);
  if (!crafter || teammates[0]?.id === crafter) return teammates;
  return [...teammates.filter((t) => t.id === crafter), ...teammates.filter((t) => t.id !== crafter)];
}
