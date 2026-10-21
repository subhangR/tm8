import { CollabError, McpSelectionsSchema, isHumanAuthKind, mcpServerKey,
  type McpBoundSelection, type McpSelection } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import { resolveBearerIdentity } from '../identity/pg-auth.js';
import { hashToken, parseToken } from '../identity/crypto.js';
import { resolveMcpSelections } from './definitions.js';

/*
 * WHY NEITHER bind NOR authorize PASSES ITS OWN `credentialReady` ANY MORE.
 *
 * Both used to call `read_mcp_credential` directly, which throws when the row
 * cannot be opened. That was fine while every refusal failed the launch, but
 * §7.3 asks for a default that cannot be opened to be SKIPPED — and a JS
 * try/catch cannot deliver that: `Querier.rpc` is a bare `client.query`, so a
 * raised exception has already aborted the surrounding transaction. Catching it
 * in TypeScript leaves the tx poisoned and the next statement dies with 25P02,
 * turning a skippable default into a failed launch.
 *
 * `mcp_credential_readiness` is the answer. Its plpgsql EXCEPTION block is an
 * implicit SAVEPOINT, so the refusal is contained inside Postgres, and it opens
 * the row under the very same claims. It also reports WHY (revoked, expired,
 * needs_reconnect) instead of a flat 'credential_unavailable'. So the resolver's
 * default path is now the right one for both callers, and this file passes none.
 */

export interface McpBindInput {
  sessionId: string; spaceId: string; teamMemberId: string; targetIds?: string[];
  mcpSelections?: McpSelection[]; agentToken: string; resume?: boolean;
  /**
   * §6's provenance root, derived by the server from `launched_by` — never from
   * anything the session says about itself. Absent means "the launcher claims in
   * force", which is what this file already computes. t-provenance sets it.
   */
  rootMemberId?: string;
}
export interface McpBindingClaims extends DbClaims {
  authSessionId?: string;
  /** Verified source bearer provenance; supplied by server execution handlers. */
  mcpSource?: { authSessionId?: string; sessionId?: string };
}
export interface DurableMcpGrant {
  sessionId: string; spaceId: string; identityId: string; serverId: string;
  credentialId?: string; launcherIdentityId: string; launcherAuthKind: string;
  /** §6's recorded root and chain. Absent on a binding written before 343. */
  rootMemberId?: string | null; rootIdentityId?: string | null;
  chain?: string[]; chainSpaceIds?: string[];
}
interface Binding extends Omit<DurableMcpGrant, 'serverId' | 'credentialId'> {
  selections: McpSelection[]; rootAuthKind?: string | null;
}
/**
 * What `internal.mcp_provenance` (343) answers. `reason` is always present;
 * everything else only when it is `'ready'`. The refusals are values, not
 * exceptions, because `bind` has to tell "skip this default" from "this launch
 * is broken" — and because a raise inside `Querier.rpc` poisons the whole
 * transaction (the lesson `mcp_credential_readiness` was built on).
 */
interface McpProvenance {
  reason: 'ready' | 'session_unavailable' | 'link_session' | 'source_unavailable'
    | 'no_human_provenance' | 'root_not_in_space' | 'depth_exceeded';
  rootMemberId?: string; rootIdentityId?: string; rootAuthKind?: string | null;
  chain?: string[]; chainSpaceIds?: string[]; depth?: number; via?: string; loopId?: string;
}

/** The only writer of runtime grants. Graph metadata is never an authority source. */
export class McpSessionBindings {
  constructor(private readonly db: Db) {}

  async bind(claims: McpBindingClaims, input: McpBindInput): Promise<McpBoundSelection[]> {
    if (!claims.identityId) throw new CollabError('forbidden', 'MCP launch unavailable');
    if (claims.viaLinkId) {
      // A session started through a space link (W7b) launches with NO MCP
      // servers: `authorize` refuses every link-bound caller anyway, so
      // nothing is bound and nothing is lent. Asking for one is refused;
      // asking for none must not refuse the spawn itself (it did, for every
      // link spawn, local and remote alike).
      if (input.mcpSelections?.length) {
        throw new CollabError('forbidden', 'MCP servers are not available to a session started through a space link');
      }
      return [];
    }
    const runtime = await resolveBearerIdentity(this.db, input.agentToken);
    if (runtime.viaLinkId || runtime.spaceId !== input.spaceId ||
        (runtime.workSessionId !== input.sessionId && runtime.runtimeChatId !== input.sessionId)) {
      throw new CollabError('forbidden', 'MCP runtime unavailable');
    }
    const parsed = parseToken(input.agentToken);
    if (!parsed) throw new CollabError('forbidden', 'MCP runtime unavailable');
    const tokenHash = hashToken(parsed.secret);
    /*
     * §6.1 / B17: WHICH BEARER IS BEHIND THIS LAUNCH, and nothing else.
     *
     * The authority at each hop is the SPAWNING BEARER, never a graph edge. A
     * human bearer (browser/cli) is a terminal root. An agent bearer hops to its
     * own session — `mcpSource`, filled by the server execution handlers off the
     * verified token, not off a request body — whose binding already holds its
     * root AND its chain, so one hop reads the whole ancestry. Anything that is
     * NEITHER shape reaches §6's two new terminals in SQL: the human who armed
     * the schedule, or the persona's owning member.
     *
     * `launched_by` is deliberately NOT consulted. `parentSessionId` is
     * client-asserted for every bearer but a chat runtime (`chat/scope.ts`
     * `resolveSpawnParentId` constrains only that one), and `execution_spawn`
     * checks merely that the parent is a live chat or session in the same Space
     * — so a member could spawn naming ANOTHER member's chat as parent and a
     * walk of that edge would hand their worker the other member's personal
     * connections. The edge records report routing; it authorises nothing.
     *
     * THE WALK ITSELF IS IN SQL (`mcp_provenance_for_bind`, 343), and it is
     * authenticated by the FRESHLY MINTED agent token rather than by the claims
     * in force: only this session's spawner holds that token, and the claims at
     * this moment are not yet the root's. That is also what makes the door work
     * for the in-process loop executor, whose claims are the node owner's and
     * which may not be able to read the session as an entity at all.
     */
    const source = ['agent', 'agent_runtime'].includes(claims.authKind ?? '') ? claims.mcpSource : undefined;
    const provenance = await this.db.rpc<McpProvenance>(claims, 'mcp_provenance_for_bind', [
      input.sessionId, tokenHash,
      source?.sessionId ?? null, source?.authSessionId ?? null,
    ]);
    const root = provenance.reason === 'ready' ? provenance : undefined;
    /*
     * Resolution runs under the ROOT's claims, because 341's
     * `resolve_mcp_account` refuses a named root that is not the claims in force
     * (B3) — and because every tier below the pin is "whose connection is this".
     * B19's constraints on synthesizing them: identity = the root only, no
     * actorId, no node admin, `sessionSpaceId` = the target Space, and used only
     * for MCP resolution and credential reads.
     *
     * `rootAuthKind` is REPLAYED, never fabricated: it is the kind the human
     * bearer actually held, carried down the chain. A schedule or teammate root
     * has no bearer, so it is absent and every human-gated door refuses — which
     * is the right answer for those two, and the reason this is not just
     * hard-coded to 'browser'.
     */
    const launcher: DbClaims = root
      ? { identityId: root.rootIdentityId!, sessionSpaceId: input.spaceId,
          ...(root.rootAuthKind ? { authKind: root.rootAuthKind } : {}) }
      : claims;
    // A launch with no root is lent no CONNECTION (§6.1, B19): defaults that
    // need an account are skipped and reported, an explicit pick refuses.
    const noHumanRoot = root === undefined;
    // `source_unavailable` is the one refusal that must not even reach the
    // resolver: a delegated launch whose launcher binding is gone gets no
    // connectors at all, not even the auth-none ones, which is 298's behaviour.
    const sourceUnavailable = provenance.reason === 'source_unavailable';
    // The DERIVED root wins over anything the caller passed: `McpBindInput`'s
    // field is server-set, but there is no reason for two answers to this.
    const rootMemberId = root?.rootMemberId ?? input.rootMemberId;
    return this.db.tx(launcher, async q => {
      const stored = input.resume
        ? await q.rpc<unknown>('read_mcp_launch_selections', [input.sessionId]) : null;
      const picks = stored == null ? input.mcpSelections : McpSelectionsSchema.parse(stored);
      if (sourceUnavailable) {
        // A delegated launch whose launcher binding is gone has no verifiable
        // human behind it, so it gets NO connectors. It must not inherit
        // DEFAULTS either — and crucially, asking for none must not refuse the
        // spawn. Before `defaultOn` existed this was mostly moot, because the
        // default set came only from `equips` edges on the task lineage; a
        // space-wide `defaultOn` connector makes the resolved set non-empty for
        // EVERY launch, which would have turned this from a rare refusal into
        // one that killed every delegated launch in the Space.
        if (picks?.length) {
          throw new CollabError('forbidden', 'MCP delegated launch requires a live launcher binding');
        }
        await q.rpc('bind_mcp_session', [input.sessionId, tokenHash, '[]',
          source?.sessionId ?? null, source?.authSessionId ?? null, rootMemberId ?? null,
          root?.chain ?? null, root?.chainSpaceIds ?? null]);
        return [];
      }
      let targetIds = input.targetIds;
      if (picks === undefined && targetIds === undefined && runtime.runtimeChatId === input.sessionId) {
        // A chat may be about a task. Use only currently readable, same-space
        // attachment targets, under this launcher's claims; arbitrary readers
        // never lend the chat creator's credential authority.
        const about = await q.query<{ id: string }>(`select distinct e.dst_id as id from public.edges e
          join public.entities t on t.id=e.dst_id
          where e.src_id=$1 and e.type='about' and e.space_id=$2 and t.deleted_at is null
            and t.kind in ('task','team_member','work_session') order by e.dst_id limit 33`, [input.sessionId, input.spaceId]);
        targetIds = about.map(row => row.id);
      }
      const resolved = await resolveMcpSelections(q, {
        spaceId: input.spaceId, teamMemberId: input.teamMemberId,
        ...(targetIds ? { targetIds } : {}),
        ...(picks !== undefined ? { mcpSelections: picks } : {}),
      }, {
        ...(rootMemberId !== undefined ? { rootMemberId } : {}),
        ...(noHumanRoot ? { noHumanRoot: true } : {}),
      });
      // Only an EXPLICIT selection can refuse a launch now. Defaults that are
      // not ready have already been dropped into `resolved.skipped`.
      if (!resolved.ready) {
        const reason = resolved.selections.find(s => !s.ready)?.reason;
        // Named out loud, because the operator asked for a connector BY NAME and
        // the answer is not "not connected" — it is "nothing here can say which
        // human this launch acts for" (B19). The walk's own reason rides along:
        // `root_not_in_space` and `depth_exceeded` are very different problems
        // from "there is no bearer", and a launch that fails needs to say which.
        if (resolved.selections.some(s => s.reason === 'no_human_provenance')) {
          throw new CollabError('forbidden',
            `MCP delegated launch requires a human root (${provenance.reason})`);
        }
        throw new CollabError('forbidden', `MCP launch unavailable: ${reason}`);
      }
      // §4.2. The tool prefix is computed HERE, from the definition resolution
      // just read, and is returned to the launcher but deliberately NOT stored:
      // `read_mcp_launch_selections` and `authorize` both parse the stored value
      // with the strict `McpSelectionsSchema`, and a key that outlived a rename
      // would name a connector that no longer answers to it.
      const bound: McpBoundSelection[] = resolved.selections.map(s => ({ serverId: s.server.id,
        ...(s.credentialId ? { credentialId: s.credentialId } : {}),
        serverKey: mcpServerKey(s.server.definition) }));
      const selections: McpSelection[] = bound.map(({ serverKey: _serverKey, ...stored }) => stored);
      /*
       * The root is handed back as a CONSISTENCY CHECK: `bind_mcp_session`
       * derives provenance again, under these very claims, and refuses if it
       * lands on a different root than the accounts above were opened under.
       *
       * The CHAIN, by contrast, is handed over to be RECORDED (F1/B27). It was
       * derived above under the SPAWNING BEARER's claims, which is the only
       * place the hop can be taken — by this point the transaction runs as the
       * root, and a re-derivation here collapses every chain to `[self]`. SQL
       * verifies it rather than trusting it: the head must be this session,
       * every hop's Space must be the one its entity carries, and the tail must
       * equal the source binding's own stored chain.
       *
       * `selections` and not `bound`: the stored array is the bare
       * {serverId, credentialId} pair the strict schema parses on resume, and
       * the verification above runs against exactly what is handed over.
       */
      await q.rpc('bind_mcp_session', [input.sessionId, tokenHash, JSON.stringify(selections),
        source?.sessionId ?? null, source?.authSessionId ?? null, rootMemberId ?? null,
        root?.chain ?? null, root?.chainSpaceIds ?? null]);
      return bound;
    });
  }

  async authorize(claims: McpBindingClaims, sessionId: string, serverId: string): Promise<DurableMcpGrant> {
    if (!claims.authSessionId || !claims.identityId || claims.viaLinkId ||
        !['agent', 'agent_runtime'].includes(claims.authKind ?? '')) {
      throw new CollabError('forbidden', 'MCP runtime unavailable');
    }
    const binding = await this.db.rpc<Binding>(claims, 'read_mcp_session_binding', [sessionId, claims.authSessionId]);
    const selected = McpSelectionsSchema.parse(binding.selections).find(s => s.serverId === serverId);
    if (!selected || binding.identityId !== claims.identityId) throw new CollabError('forbidden', 'MCP connector is not selected');
    /*
     * §6 RE-CHECKED, from what bind RECORDED.
     *
     * `read_mcp_session_binding` has already re-run the whole rule for this
     * call — the root is still an active member of EVERY Space in the chain
     * (§6.2, B18) and still a member of this one — and raised if not. What is
     * left here is to resolve the pinned account AS THE ROOT, which is who the
     * connection belongs to. The recorded root is preferred over the launcher
     * identity: for a bearer chain they are the same human, but for a schedule
     * or teammate root (G3) only the recorded one exists.
     */
    const rootIdentityId = binding.rootIdentityId ?? binding.launcherIdentityId;
    // Replayed, never fabricated, and only ever a HUMAN kind: a schedule or
    // teammate root held no bearer, so it carries none and every human-gated
    // door refuses it.
    const rootAuthKind = binding.rootAuthKind
      ?? (isHumanAuthKind(binding.launcherAuthKind) ? binding.launcherAuthKind : undefined);
    const launcher: DbClaims = { identityId: rootIdentityId, sessionSpaceId: binding.spaceId,
      ...(rootAuthKind ? { authKind: rootAuthKind } : {}) };
    /*
     * A binding with NO recorded root is one written before 343. Its launcher
     * identity was checked against the human auth kinds when it was written and
     * that kind is stored — so a stored kind that is not human is exactly a
     * binding written WITHOUT a root (the loop-executor shape, or one from
     * before #1316 closed it), and it must not come back to life on resume or
     * on any later call. A binding that DOES record a root needs no such
     * inference: the recorded root is the proof.
     */
    const noHumanRoot = binding.rootIdentityId == null && !isHumanAuthKind(binding.launcherAuthKind);
    // Resolution is repeated per proxy operation; no approval or sharing snapshot.
    const resolved = await this.db.tx(launcher, q => resolveMcpSelections(q, {
      spaceId: binding.spaceId, mcpSelections: [selected],
      // `pinnedOnly`: re-check the exact row bind wrote. A live session must
      // never silently move to a different connection because the root
      // connected a new account mid-flight.
    }, { pinnedOnly: true, ...(binding.rootMemberId ? { rootMemberId: binding.rootMemberId } : {}),
         ...(noHumanRoot ? { noHumanRoot: true } : {}) }));
    if (!resolved.ready) throw new CollabError('forbidden', 'MCP connector access has changed');
    return { sessionId, spaceId: binding.spaceId, identityId: binding.identityId, serverId,
      launcherIdentityId: binding.launcherIdentityId, launcherAuthKind: binding.launcherAuthKind,
      ...(binding.rootMemberId ? { rootMemberId: binding.rootMemberId } : {}),
      ...(binding.rootIdentityId ? { rootIdentityId: binding.rootIdentityId } : {}),
      ...(binding.chain?.length ? { chain: binding.chain } : {}),
      ...(binding.chainSpaceIds?.length ? { chainSpaceIds: binding.chainSpaceIds } : {}),
      ...(selected.credentialId ? { credentialId: selected.credentialId } : {}) };
  }
}
