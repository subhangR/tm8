/**
 * THE LAUNCH GATE FOR A CONNECTOR SELECTION — can this explicit selection be
 * honoured, and if not, why.
 *
 * Input: the viewer's catalog and the selection a launch or a chat turn would
 * send (`undefined` = the Space's defaults, `[]` = none, a list = exactly these).
 * Output: `selectionBlocked` — the one boolean every host holds its launch on —
 * and `selectionProblem`, the sentence that explains it. Called by `McpPicker`,
 * which reports the first as `onReady` and draws the second.
 *
 * Invariants a reviewer can check:
 *  - `undefined` is never blocked and never has a problem. The server resolves
 *    defaults itself, at launch, under the provenance root's claims, and SKIPS
 *    a default it cannot open (`bind`, §7.3), so an untouched picker asserts
 *    nothing that could fail.
 *  - Only an ACCOUNT problem blocks: a pick naming a dead account, or naming
 *    none when the server's own-then-shared order (`resolvedAccount`) has
 *    nothing to open. It is the one problem the person can fix where they
 *    stand, and the one every host's refusal is worded for ("Choose a connected
 *    account for each connector").
 *  - Every other problem — the connector is gone, awaiting approval, disabled,
 *    an untrusted local command — is REPORTED and does not block: it is an
 *    admin's to fix, and `bind` refuses such a pick out loud
 *    (`MCP launch unavailable: not_approved`), so the sentence says the launch
 *    will refuse it rather than holding the button under an account reason.
 *  - This is a hint computed from what the viewer can read. The server's
 *    resolver is the authority; nothing here is sent.
 */
import { pickedAccount } from './row-model';
import type { McpCatalog, McpSelection, McpServer } from './port';

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
  if (selection.credentialId) return `Choose a connected account for ${server.title}.`;
  return server.accounts.some(a => a.canUse && a.status === 'connected')
    ? `Choose an account for ${server.title}: a connection shared with you is used only when you pick it.`
    : `Connect an account for ${server.title}, or switch it off.`;
}

interface PickProblem { text: string; blocks: boolean }

function pickProblem(server: McpServer | undefined, selection: McpSelection): PickProblem | null {
  if (!server) return { text: 'A connector picked here is no longer available. Reset the connectors to drop it.', blocks: false };
  if (!server.canAttach) return { text: server.unavailableReason ?? `You cannot attach ${server.title}.`, blocks: false };
  if (!server.approved || !server.enabled) {
    return { text: `${server.title} is awaiting approval or disabled, so the launch will refuse it. Switch it off.`, blocks: false };
  }
  if (server.transport === 'stdio' && server.source?.stdioTrusted === false) {
    return { text: `${server.title} runs a local command this node does not trust, so the launch will refuse it. Switch it off.`, blocks: false };
  }
  const text = accountProblem(server, selection);
  return text ? { text, blocks: true } : null;
}

function pickProblems(catalog: McpCatalog, value: readonly McpSelection[] | undefined): PickProblem[] {
  return (value ?? []).flatMap(selected => {
    const problem = pickProblem(catalog.servers.find(s => s.id === selected.serverId), selected);
    return problem ? [problem] : [];
  });
}

/** Whether an explicit pick has no account the server will open. */
export function selectionBlocked(catalog: McpCatalog, value: readonly McpSelection[] | undefined): boolean {
  return pickProblems(catalog, value).some(p => p.blocks);
}

/**
 * The sentence for the selection's problem, or null. A problem that blocks is
 * reported before one that does not, so the line always explains a held button.
 */
export function selectionProblem(catalog: McpCatalog, value: readonly McpSelection[] | undefined): string | null {
  const problems = pickProblems(catalog, value);
  return (problems.find(p => p.blocks) ?? problems[0])?.text ?? null;
}
