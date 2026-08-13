/**
 * `tracking.pr.merge` — the ONE forge write door, guarded on this side of the
 * network.
 *
 * THE GUARDS RUN AGAINST OBSERVED FACTS, BEFORE ANY GITHUB CALL. The observer
 * (`tracking/observer.ts`) is the node's source of PR truth; this handler
 * refuses from the stored row — not from a fresh read — because the stored row
 * is what the human REVIEWED in the UI. If the stored facts are stale, the
 * merge call itself still carries `expectedHeadSha`, and GitHub answers
 * `head_moved` rather than merging commits nobody looked at.
 *
 * THE CREDENTIAL IS THE ACTING MEMBER'S OWN. `read_account_git_credential`
 * resolves under the caller's claims, so a node token can never merge and an
 * unauthorized member gets `forbidden` with the reason named. Every merge on
 * the forge is attributable to the account whose credential performed it.
 *
 * AFTER A MERGE, THE OBSERVER CLOSES THE LOOP: `queue_tracking_refresh` (with
 * the acting actor recorded) re-reads the PR, `apply_pull_request_facts`
 * projects `merged` and fires `git.pr_state_changed` into the ledger — the
 * same path a merge made on github.com takes, so the graph cannot end up with
 * two kinds of merged.
 */
import { CollabError, type TrackingPrMergeInput, type TrackingPrMergeResult } from '@tm8/contract';

import { DbGitHubCredentialStore } from '../../../credentials/github-credential-store.js';
import { GithubWriteClient } from '../../../tracking/github-write.js';
import { resolveServerDataDir } from '../../../http/config.js';
import type { RequestContext } from '../../../http/types.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';

interface PullRequestRow {
  entity_id: string;
  repo: string;
  number: number;
  state: 'open' | 'merged' | 'closed' | 'draft';
  head_sha: string | null;
  ci_status: string | null;
  mergeable_state: string | null;
}

export interface TrackingWriteServiceOptions {
  /** Injected in tests; defaults to the real client. */
  writeClient?: Pick<GithubWriteClient, 'mergePullRequest'>;
  /** Injected in tests; defaults to the DB-backed store. */
  credentials?: Pick<DbGitHubCredentialStore, 'resolve'>;
}

export class W2TrackingWriteService {
  private readonly writeClient: Pick<GithubWriteClient, 'mergePullRequest'>;
  private readonly credentials: Pick<DbGitHubCredentialStore, 'resolve'>;

  constructor(
    private readonly deps: FacadeDeps,
    options: TrackingWriteServiceOptions = {},
  ) {
    this.writeClient = options.writeClient ?? new GithubWriteClient();
    this.credentials =
      options.credentials ??
      new DbGitHubCredentialStore({
        db: this.deps.db,
        dataDir: this.deps.config.dataDir ?? resolveServerDataDir(),
      });
  }

  readonly mergePr = async (ctx: RequestContext): Promise<TrackingPrMergeResult> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as TrackingPrMergeInput;
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);

    // ── observed-facts guards, before any network ─────────────────────────
    const rows = await this.deps.db.query<PullRequestRow>(
      claims,
      `select entity_id, repo, number, state, head_sha, ci_status, mergeable_state
         from public.pull_requests where entity_id = $1`,
      [id],
    );
    const pr = rows[0];
    if (!pr) throw new CollabError('not_found', `no pull_request entity ${id}`);
    if (pr.state !== 'open') {
      throw new CollabError('invariant_violation', `PR ${pr.repo}#${String(pr.number)} is ${pr.state}, not open`, {
        details: { reason: 'not_open', state: pr.state },
      });
    }
    if (pr.mergeable_state === 'dirty') {
      throw new CollabError('invariant_violation', `PR ${pr.repo}#${String(pr.number)} has conflicts (observed mergeable_state=dirty)`, {
        details: { reason: 'conflicted' },
      });
    }
    if (pr.ci_status === 'failing') {
      throw new CollabError('invariant_violation', `PR ${pr.repo}#${String(pr.number)} has failing checks (observed ci_status=failing)`, {
        details: { reason: 'ci_red' },
      });
    }

    // ── the acting member's own credential, or a named refusal ────────────
    const credential = await this.credentials.resolve(claims as never);
    if (credential === null) {
      throw new CollabError('forbidden', 'no GitHub credential stored for this account — connect one under Settings → Agent credentials', {
        details: { reason: 'no_github_credential' },
      });
    }

    // ── the one write ─────────────────────────────────────────────────────
    const outcome = await this.writeClient.mergePullRequest({
      repo: pr.repo,
      number: pr.number,
      token: credential.token,
      // "Merge exactly what was reviewed": the caller may pin a sha, else the
      // OBSERVED head is the pin — never an unpinned merge.
      expectedHeadSha: input.headSha ?? pr.head_sha ?? undefined,
      commitTitle: input.commitTitle,
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'method_blocked':
          throw new CollabError('invariant_violation', `the forge refused the merge: ${outcome.detail}`, {
            details: { reason: 'forge_blocked' },
          });
        case 'head_moved':
          throw new CollabError('conflict', `the branch moved after review: ${outcome.detail}`, {
            details: { reason: 'head_moved' },
          });
        case 'not_found':
          throw new CollabError('not_found', outcome.detail);
        case 'unauthorized':
          throw new CollabError('forbidden', `GitHub refused this credential: ${outcome.detail}`);
        case 'rate_limited':
          throw new CollabError('rate_limited', outcome.detail);
        default:
          throw new CollabError('upstream_unavailable', outcome.detail);
      }
    }

    // ── close the loop through the observer, actor recorded ───────────────
    await this.deps.db.tx(claims, (q) =>
      q.rpc('queue_tracking_refresh', [[id], envelope.actorId ?? null, envelope.clientMutationId ?? null]),
    );

    return {
      entityId: id as TrackingPrMergeResult['entityId'],
      repo: pr.repo,
      number: pr.number,
      merged: true,
      mergeSha: outcome.value.sha,
    };
  };
}
