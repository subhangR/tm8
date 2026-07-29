/**
 * THE AUTHORED REFUSAL COPY for `settings-governance/` (T2-2, T2-4, T2-5).
 *
 * WHY A SECOND REASONS FILE EXISTS, stated because a second vocabulary is
 * normally the defect. `domain/actions.ts` owns the copy for VERBS that are
 * `ActionRef`s — one place, so the honesty vocabulary cannot drift across
 * surfaces (D15). Every reason below is for a control that is NOT an
 * `ActionRef`: "Link project", "New project", "Create kind", "Duplicate as
 * draft", "Retire", the trust segmented control, "+ associate". Those verbs
 * exist in the T2 oracle and in NO registry, and this lane may not edit
 * `domain/actions.ts` (file-ownership boundary, this wave). So they are
 * authored here, in the same shape, and the handover names each one as an
 * `actions.ts` candidate for whoever holds that seat next.
 *
 * The two reasons that DO have registry homes are re-exported rather than
 * restated: `untrust` and `unlink` (`actions.ts:281-282`). Restating them is
 * how a vocabulary drifts, and this file must not be the place it happens.
 *
 * EVERY STRING NAMES THE MECHANISM, not just the refusal (T1-4). "Not
 * available" teaches nothing; "the stamped facade seam carries no projects.*
 * family" tells the reader what would have to change.
 */
import type { UnavailableReason } from '../panels';

/**
 * The one sentence this lane repeats, factored so it cannot drift: what the
 * seam is, and that its absence is a fact about THIS BUILD rather than about
 * the user's permissions. Read `src/data/seam.ts` in full on 2026-07-29 —
 * these absences are measured, not assumed.
 */
const SEAM = 'the stamped facade seam';

export const GOVERNANCE_REASONS = {
  // -- T2-2 · projects & trust ----------------------------------------------

  /** Oracle L156 "⊕ Link project". */
  linkProject: {
    cause: 'Linking a project to this space isn’t wired yet',
    remedy: `projects.link is not in ${SEAM} — the contract declares ProjectLinkInput, and no seam command carries it`,
  },

  /** Oracle L194 "＋ New project" (node-admin registry card). */
  newProject: {
    cause: 'Creating a project isn’t wired yet',
    remedy: `project creation is node-level (POST /v2/projects) and ${SEAM} has no projects.* family at all`,
  },

  /** Oracle L201/L211 "edit" on a registry row. */
  editProject: {
    cause: 'Editing the node registry isn’t wired yet',
    remedy: `ProjectUpdateInput exists in the contract; ${SEAM} carries no read and no write for it`,
  },

  /**
   * Oracle L220-224: the trust segmented control. GRANTING trust has no
   * ActionRef at all (`untrust` exists; there is no `trust`), which is why
   * this is authored here and flagged rather than routed through the registry.
   */
  grantTrust: {
    cause: 'Granting trust isn’t wired yet',
    remedy: 'trust is a node-level grant and there is no `trust` verb in the action registry — only `untrust`, itself deferred',
  },

  /**
   * The NODE REGISTRY READ. Distinct from every refusal above: those are
   * writes, this is why the card has no rows to show. A card that rendered
   * empty here would read as "this node has no projects", which is a claim
   * nobody measured.
   */
  registryRead: {
    cause: 'The node project registry can’t be read from here',
    remedy: `ProjectResource lives on the node (contract.ts:948) and ${SEAM} exposes no read for it — this is not an empty registry, it is an unasked question`,
  },

  /** Oracle L250 "＋ associate" on the session PROJECTS block. */
  associateProject: {
    cause: 'Associating a project with a session isn’t wired yet',
    remedy: 'associations are `in_project` edges (contract.ts:156) and no seam command creates one',
  },

  /**
   * The per-project session attribution the unlink refusal needs. A summary
   * carries no project (measured: `CoreEntityState` work_session member,
   * contract.ts:103-105, has status/agentTool/model/shareMode and no project),
   * so a host that does not supply the mapping leaves this UNKNOWN — never 0.
   */
  usageUnknown: {
    cause: 'How many sessions use this root is unverified',
    remedy: 'a session summary carries no project — the launch root is on EntityDetail.content, one read per session, which this screen does not perform',
  },

  // -- T2-4 · interaction profiles ------------------------------------------

  /** Oracle L403 "＋ New" in the profile list header. */
  newProfile: {
    cause: 'Proposing a profile isn’t wired yet',
    remedy: `ProposeInteractionProfileInput is declared in the contract; ${SEAM} has no interaction-profile command`,
  },

  /** Oracle L441 "Duplicate as draft". */
  duplicateProfile: {
    cause: 'Duplicating a profile isn’t wired yet',
    remedy: `the lifecycle ops (propose / activate / retire) are contract events with no command in ${SEAM}`,
  },

  /** Oracle L442 "Retire". */
  retireProfile: {
    cause: 'Retiring a profile isn’t wired yet',
    remedy: 'retirement is one-way and irreversible; no seam command performs it, so nothing here can',
  },

  /**
   * Oracle L444 title="profiles are restricted — no free linking" — the
   * oracle's OWN words, kept verbatim as the cause because a restriction that
   * teaches is the point of the treatment (oracle note L487).
   */
  profileLink: {
    cause: 'Profiles are restricted — no free linking',
    remedy: 'a profile is reached through the teammate or space that defaults to it, never through an ad-hoc edge',
  },

  /** Oracle L445 title="profiles don't take children". */
  profileAddChild: {
    cause: 'Profiles don’t take children',
    remedy: 'the version chain is the only hierarchy a profile has',
  },

  /** Oracle L467 "＋ teammate" in DEFAULT FOR. */
  setProfileDefault: {
    cause: 'Setting a default isn’t wired yet',
    remedy: 'TeammateProfileDefaultView and SpaceProfileDefaultView are read models with no seam read and no seam write',
  },

  /** Oracle L459-460, the system-prompt preview. */
  profilePreview: {
    cause: 'The prompt for this profile can’t be read from here',
    remedy: 'the contract’s InteractionProfilePreview is documented "sanitized … no prompt/tool/capture policy" (contract.ts:1452), and the seam exposes neither it nor the raw template',
  },

  /** Oracle L409/L413 "41 runs", L471 "41 sessions pinned". */
  profileRunCount: {
    cause: 'Run and pin counts aren’t measured here',
    remedy: 'pins are per work session (InteractionProfilePinView) and nothing totals them — a 0 here would be a count nobody took',
  },

  // -- T2-5 · custom kinds ---------------------------------------------------

  /** Oracle L508 "Create kind". */
  createKind: {
    cause: 'Creating a kind isn’t wired yet',
    remedy: `EntityKindCreateInput is declared (contract.ts:1533); ${SEAM} reads entityKinds() and carries no write`,
  },

  /** Oracle L530 "…" — the glyph picker's overflow. */
  moreGlyphs: {
    cause: 'The full glyph set isn’t available yet',
    remedy: 'the six offered here are the oracle’s own row; a picker with a searchable set is a later surface',
  },
} as const satisfies Record<string, UnavailableReason>;

export type GovernanceReasonId = keyof typeof GOVERNANCE_REASONS;

/**
 * THE GAP REGISTER — the machine-readable twin of the handover's GAPS table.
 *
 * It exists so the register cannot rot away from the screens: `gaps.test.ts`
 * asserts every id here is rendered by a screen, and the handover is written
 * FROM this list rather than beside it. Each entry flips to `wired` by
 * deleting its row and passing the real handler — no consumer edit.
 */
export interface GovernanceGap {
  id: string;
  /** What the user is trying to do. */
  need: string;
  /** What exists today, measured. */
  seamToday: string;
  /** The reason key the screen renders instead. */
  reason: GovernanceReasonId | 'actions.untrust' | 'actions.unlink';
}

export const GOVERNANCE_GAPS: readonly GovernanceGap[] = [
  { id: 'GG1', need: 'link a project to a space', seamToday: 'no projects.* family in the seam', reason: 'linkProject' },
  { id: 'GG2', need: 'unlink a project from a space', seamToday: '`unlink` ActionRef exists, deferred (actions.ts:282)', reason: 'actions.unlink' },
  { id: 'GG3', need: 'read the node project registry', seamToday: 'ProjectResource is contract-only; no seam read', reason: 'registryRead' },
  { id: 'GG4', need: 'create a node project', seamToday: 'ProjectCreateInput declared; no seam command', reason: 'newProject' },
  { id: 'GG5', need: 'edit a node project', seamToday: 'ProjectUpdateInput declared; no seam command', reason: 'editProject' },
  { id: 'GG6', need: 'grant trust', seamToday: 'no `trust` ActionRef exists at all', reason: 'grantTrust' },
  { id: 'GG7', need: 'revoke trust', seamToday: '`untrust` ActionRef exists, deferred (actions.ts:281)', reason: 'actions.untrust' },
  { id: 'GG8', need: 'associate a project with a session', seamToday: 'associations are edges; no seam command', reason: 'associateProject' },
  { id: 'GG9', need: 'count sessions per project', seamToday: 'summaries carry no project; detail-per-session only', reason: 'usageUnknown' },
  { id: 'GG10', need: 'propose a profile', seamToday: 'contract input declared; no seam command', reason: 'newProfile' },
  { id: 'GG11', need: 'duplicate a profile as draft', seamToday: 'no seam command', reason: 'duplicateProfile' },
  { id: 'GG12', need: 'retire a profile', seamToday: 'no seam command', reason: 'retireProfile' },
  { id: 'GG13', need: 'set a profile default', seamToday: 'default views are contract-only', reason: 'setProfileDefault' },
  { id: 'GG14', need: 'read a profile’s prompt', seamToday: 'contract preview is sanitized of prompt policy; no seam read', reason: 'profilePreview' },
  { id: 'GG15', need: 'count runs / pins for a profile', seamToday: 'pins are per session; nothing totals them', reason: 'profileRunCount' },
  { id: 'GG16', need: 'create a custom kind', seamToday: 'entityKinds() reads; no seam write', reason: 'createKind' },
];
