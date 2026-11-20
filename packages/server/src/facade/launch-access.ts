import { McpSelectionsSchema, type EntityId, type McpCredentialView, type SessionConnectorAccounts } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';

function maskLabel(value: string): string {
  return value.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}/gi,
    (email) => `${email.slice(0, 1)}***@${email.slice(email.indexOf('@') + 1)}`);
}

/**
 * Work sessions persist RESOLVED pins in bind_mcp_session, including accounts
 * selected through defaults. Do not resolve defaults on this read: they may
 * have changed. Unlike a chat's row, this is a record of what was bound.
 *
 * Every read uses the VIEWER's claims. The metadata RPC does not open secrets;
 * its result is copied field-by-field so future additions cannot leak here.
 */
export async function projectConnectorAccounts(
  db: Db,
  claims: DbClaims,
  sessionId: EntityId,
): Promise<SessionConnectorAccounts> {
  const unavailable = (reason: 'not_recorded' | 'read_failed'): SessionConnectorAccounts => ({
    available: false, unavailableReason: reason, entries: [], hiddenCount: 0,
  });
  try {
    const raw = await db.rpc<unknown>(claims, 'read_mcp_launch_selections', [sessionId]);
    if (raw == null) return unavailable('not_recorded');
    const parsed = McpSelectionsSchema.safeParse(raw);
    if (!parsed.success) return unavailable('read_failed');
    const picks = parsed.data;
    if (picks.length === 0) {
      return { available: true, unavailableReason: null, entries: [], hiddenCount: 0 };
    }
    const visible = await db.query<{ id: string; name: string }>(claims,
      `select e.id, coalesce(m.definition->>'name', 'Connector') as name
         from public.entities e join public.mcp_servers m on m.entity_id = e.id
        where e.id = any($1::uuid[]) and e.deleted_at is null`,
      [picks.map((pick) => pick.serverId)],
    );
    const names = new Map(visible.map((row) => [row.id, row.name]));
    const entries: SessionConnectorAccounts['entries'] = [];
    let hiddenCount = 0;
    for (const pick of picks) {
      const name = names.get(pick.serverId);
      if (name === undefined) { hiddenCount += 1; continue; }
      let account: SessionConnectorAccounts['entries'][number]['account'] = null;
      if (pick.credentialId) {
        // Same metadata gate as mcp.credentials.readiness; never read_mcp_credential.
        const rows = await db.rpc<McpCredentialView[]>(claims, 'list_mcp_credentials',
          [pick.serverId, pick.credentialId]).catch(() => []);
        const row = rows.find((candidate) => candidate.id === pick.credentialId && candidate.serverId === pick.serverId);
        if (row) {
          account = {
            id: row.id, label: maskLabel(row.label), accountLabel: row.accountLabel ? maskLabel(row.accountLabel) : null,
            grantedScopes: (row.grantedScopes ?? []).map(maskLabel), usable: row.usable,
            status: row.status ?? null, reason: row.reason,
          };
        }
      }
      entries.push({ serverId: pick.serverId as EntityId, serverName: maskLabel(name),
        credentialRequired: Boolean(pick.credentialId), account });
    }
    return { available: true, unavailableReason: null, entries, hiddenCount };
  } catch {
    // A metadata failure must not discard the recorded posture or prompts.
    return unavailable('read_failed');
  }
}
