/**
 * THE SESSION NAMES ITS CREDENTIAL (spec doc 01a0e248 §6, R1/S2) — the
 * server half: the per-provider `credential` block on a work session's own
 * `entities.get`, masked for the caller before it leaves the server.
 *
 * ONE MASKED SOURCE (agreed with the credential-panel lane, 01a0e24d). Every
 * card comes from `public.read_space_credential(id)` (239 §8), called under
 * the caller's claims, once per `runs_on` edge. That function masks
 * `displayLogin` and `keyHint` through `internal.may_see_space_credential_detail`,
 * which is the masker `list_space_credentials` (the panel's read) also uses. Nothing
 * here reads `space_credentials` directly, calls the spawn reader, or re-derives
 * the mask. The one extra rule is STRICTER: a caller whose auth kind is not a
 * human one (`isHumanAuthKind`, the 083 mirror) gets neither field at all,
 * because `credentials.*` is human-only for exactly that login metadata.
 *
 * Ownership (`you` / `other` / `space`) compares `ownerAccountId` with the
 * caller's own account, never with whether a hint came back: a PUBLIC card
 * shows its hint to every member.
 *
 * `ownerName` is always null in R1. tm8_app has no select on `accounts`, and
 * the release adds no definer to map one (coordinator ruling); the line says
 * "someone else", as the credential panel does.
 */
import { isHumanAuthKind, type SessionCredentialBinding, type SessionCredentialCard,
  type SessionCredentialProviderView, type SessionCredentialView } from '@tm8/contract';

import type { Querier } from '../db/types.js';
import { loadActors } from '../facade/entity-read.js';

const BINDINGS: ReadonlySet<string> = new Set(['pending', 'bound', 'none', 'legacy', 'unrecorded']);

/** Model providers first, then git (§6). Unknown providers sort after, by name. */
const PROVIDER_ORDER = ['anthropic', 'openai', 'gemini', 'github'];
const providerRank = (p: string): number => {
  const i = PROVIDER_ORDER.indexOf(p);
  return i === -1 ? PROVIDER_ORDER.length : i;
};

interface SessionRow {
  binding: string | null;
  none_reason: string | null;
  auth_kind: string | null;
  viewer_account: string | null;
  effective: Record<string, unknown> | null;
  launched_by_viewer: boolean;
  resumed_by: string | null;
}

interface MaskedCard {
  id?: unknown; label?: unknown; provider?: unknown; status?: unknown; visibility?: unknown;
  ownerAccountId?: unknown; displayLogin?: unknown; keyHint?: unknown;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Null when the session row is not readable. Reads sequentially: one Querier is
 * one pooled client. Must run inside the caller's claims transaction.
 */
export async function readSessionCredentialView(
  q: Querier,
  sessionId: string,
  createdBy: string,
  viewerIdentityId: string,
): Promise<SessionCredentialView | null> {
  // `to_jsonb(ws)`, not `ws.credential_binding`: position-pinned suites run this
  // code against a chain that stops before the binding column exists, and an
  // absent key reads as `unrecorded`, which is what such a session is.
  const [row] = await q.query<SessionRow>(
    `select to_jsonb(ws) ->> 'credential_binding' as binding,
            to_jsonb(ws) ->> 'credential_none_reason' as none_reason,
            current_setting('tm8.auth_kind', true) as auth_kind,
            internal.current_account_id()::text as viewer_account,
            sm.manifest -> 'launch' -> 'effectiveCredentialSources' as effective,
            (exists (select 1 from public.members m
                      where m.entity_id = $2 and m.identity_id = $3)
             or exists (select 1 from public.team_members tm
                          join public.members m on m.entity_id = tm.owner_member_id
                         where tm.entity_id = $2 and m.identity_id = $3)) as launched_by_viewer,
            (select a.actor_id::text from public.activity a
              where a.entity_id = $1 and a.summary ->> 'action' = 'resumed'
              order by a.created_at desc, a.id desc limit 1) as resumed_by
       from public.work_sessions ws
       left join public.session_manifests sm on sm.work_session_id = ws.entity_id
      where ws.entity_id = $1`,
    [sessionId, createdBy, viewerIdentityId],
  );
  if (!row) return null;

  const binding: SessionCredentialBinding =
    row.binding !== null && BINDINGS.has(row.binding) ? (row.binding as SessionCredentialBinding) : 'unrecorded';
  const human = isHumanAuthKind(row.auth_kind);

  const providers: SessionCredentialProviderView[] = [];
  const edges = await q.query<{ dst_id: string; provider: string | null }>(
    `select e.dst_id::text as dst_id, e.props ->> 'provider' as provider
       from public.edges e
      where e.src_id = $1 and e.type = 'runs_on'
      order by e.created_at, e.id`,
    [sessionId],
  );
  for (const edge of edges) {
    const card = await readMaskedCard(q, edge.dst_id, row.viewer_account, human);
    const provider = edge.provider ?? card?.provider ?? 'unknown';
    providers.push({ provider, rung: 'space', credential: card });
  }

  // The rungs release 2 removes carry no edge; the manifest records them.
  if (row.effective && typeof row.effective === 'object') {
    for (const [provider, source] of Object.entries(row.effective)) {
      if ((source === 'member' || source === 'node') && !providers.some((p) => p.provider === provider)) {
        providers.push({ provider, rung: source, credential: null });
      }
    }
  }
  providers.sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || a.provider.localeCompare(b.provider));

  let resumedBy: string | null = null;
  if (row.resumed_by) {
    resumedBy = (await loadActors(q, [row.resumed_by])).get(row.resumed_by)?.displayName ?? null;
  }

  return {
    binding,
    noneReason: binding === 'none' ? text(row.none_reason) : null,
    providers,
    launchedByViewer: row.launched_by_viewer === true,
    resumedBy,
  };
}

/**
 * One card through the masker, or null when the caller cannot read it. A raise
 * (non-member, unknown id) is contained by a savepoint so it neither aborts the
 * detail read nor surfaces its text, which would confirm the id exists.
 */
async function readMaskedCard(
  q: Querier,
  credentialId: string,
  viewerAccount: string | null,
  human: boolean,
): Promise<SessionCredentialCard | null> {
  let masked: MaskedCard | null = null;
  await q.query('savepoint session_credential_card');
  try {
    const [r] = await q.query<{ card: MaskedCard | null }>(
      'select public.read_space_credential($1::uuid) as card',
      [credentialId],
    );
    masked = r?.card ?? null;
    await q.query('release savepoint session_credential_card');
  } catch {
    await q.query('rollback to savepoint session_credential_card');
    return null;
  }
  if (!masked) return null;

  const ownerAccountId = text(masked.ownerAccountId);
  const owner: SessionCredentialCard['owner'] =
    ownerAccountId === null ? 'space' : ownerAccountId === viewerAccount ? 'you' : 'other';
  const displayLogin = human ? text(masked.displayLogin) : null;
  const keyHint = human ? text(masked.keyHint) : null;
  const visibility = masked.visibility === 'private' ? 'private' : 'public';
  // The masker's own rule, restated only to say WHY the fields are null.
  const detailHidden = !human || (visibility === 'private' && owner !== 'you');
  return {
    id: text(masked.id) ?? credentialId,
    label: text(masked.label) ?? '',
    provider: text(masked.provider) ?? 'unknown',
    status: text(masked.status) ?? 'active',
    visibility,
    owner,
    ownerName: null,
    displayLogin,
    keyHint,
    detailHidden,
  };
}
