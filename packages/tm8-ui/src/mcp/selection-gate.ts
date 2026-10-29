/**
 * THE LAUNCH GATE FOR A CONNECTOR SELECTION — would `bind` refuse this explicit
 * selection, and the sentence that says why.
 *
 * Input: the viewer's catalog and the selection a launch or a chat turn would
 * send (`undefined` = the Space's defaults, `[]` = none, a list = exactly these).
 * Output: `selectionGate` → `{ blocked, problem }`, computed once per render by
 * `McpPicker`, which reports it as `onReady(!blocked, problem)`. Every host shows
 * `problem` as its refusal, so the words a person reads are this module's, for
 * every kind of problem, and no press ever surfaces the server's raw refusal.
 *
 * Invariants a reviewer can check:
 *  - `undefined` is never blocked. The server resolves defaults itself, at
 *    launch, under the provenance root's claims, and SKIPS a default it cannot
 *    open (`bind`, §7.3), so an untouched picker asserts nothing that could fail.
 *  - An explicit pick is blocked for exactly what `bind` refuses, each with its
 *    own sentence: a connector that no longer exists, one awaiting approval,
 *    one disabled, an untrusted local command, and an account problem — a dead
 *    pin, or no pin when §3's own-then-shared order has nothing to open.
 *  - The catalog's own loading, refreshing and failed states never reach here:
 *    with no catalog there is nothing to judge, and the gate is open.
 *  - The target's attach permission is not a problem here. `bind` does not
 *    refuse an explicit pick for it, and a viewer who may not attach is shown
 *    no picker at all.
 *  - A hint computed from what the viewer can read. The server's resolver is
 *    the authority; nothing here is sent.
 */
import { connectorAction, pickedAccount } from './row-model';
import type { McpCatalog, McpSelection, McpServer } from './port';

export interface SelectionGate {
  blocked: boolean;
  /** Why it is blocked, in words a host shows as its refusal. Null exactly when open. */
  problem: string | null;
}

export const OPEN_GATE: SelectionGate = { blocked: false, problem: null };

/**
 * Why `bind` would open NO account for this pick, or null.
 *
 * A pin must name a connected account the viewer may use. A pick with NO pin
 * is fine whenever §3 has something to open — the viewer's own connection,
 * else the Space's shared one — because the server picks it. This gate used to
 * demand a pin on every explicit pick, which held launches the server would
 * have run and made the account picker's "Choose for me" an option that could
 * never be sent.
 */
export function accountProblem(server: McpServer, selection: McpSelection): string | null {
  if (server.auth === 'none' || pickedAccount(server, selection.credentialId)) return null;
  const usable = server.accounts.some(a => a.canUse && a.status === 'connected');
  if (selection.credentialId) {
    return usable
      ? `Choose a connected account for ${server.title}.`
      : `The account picked for ${server.title} needs reconnecting. Reconnect it, or switch ${server.title} off.`;
  }
  if (usable) return `Choose an account for ${server.title}: a connection shared with you is used only when you pick it.`;
  return connectorAction(server) === 'reconnect'
    ? `Reconnect ${server.title}, or switch it off.`
    : `Connect an account for ${server.title}, or switch it off.`;
}

function pickProblem(server: McpServer | undefined, selection: McpSelection): string | null {
  if (!server) return 'A connector picked here no longer exists. Reset the connectors to drop it.';
  if (!server.approved) return `${server.title} is awaiting approval and would be refused. Switch it off.`;
  if (!server.enabled) return `${server.title} is disabled by an admin and would be refused. Switch it off.`;
  if (server.transport === 'stdio' && server.source?.stdioTrusted === false) {
    return `${server.title} runs a local command this node does not trust and would be refused. Switch it off.`;
  }
  return accountProblem(server, selection);
}

/** The gate for one selection: the first pick `bind` would refuse, named. */
export function selectionGate(catalog: McpCatalog, value: readonly McpSelection[] | undefined): SelectionGate {
  for (const selected of value ?? []) {
    const problem = pickProblem(catalog.servers.find(s => s.id === selected.serverId), selected);
    if (problem) return { blocked: true, problem };
  }
  return OPEN_GATE;
}
