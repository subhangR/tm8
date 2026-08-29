/**
 * THE PURE MODEL for the T2 governance surfaces — everything decidable without
 * React, so it can be tested without a DOM and cannot drift between the three
 * screens that share it.
 *
 * The rule this file follows throughout: an absent fact and a measured zero are
 * DIFFERENT VALUES, and the type carries the difference. Every "we did not
 * read this" is a `{ known: false, reason }`, never a default. The defect that
 * discipline prevents is specific and this program has shipped it: a screen
 * that says `0 live sessions` when nobody counted, above an Unlink button the
 * user then presses.
 */
import type {
  CustomEntityKind,
  CustomFieldType,
  EntityKindDef,
  EntitySummary,
  ProjectTrustLevel,
} from '@tm8/contract';
import { resolveAction } from '../domain/actions';
import { allKinds, isReservedSlug } from '../domain/registry';
import { toReason, type UnavailableReason } from '../panels';
import { GOVERNANCE_REASONS } from './reasons';

// ---------------------------------------------------------------------------
// Known / unknown — the shape every unread fact takes
// ---------------------------------------------------------------------------

export type Known<T> = { known: true; value: T } | { known: false; reason: UnavailableReason };

export const known = <T,>(value: T): Known<T> => ({ known: true, value });
export const unknown = <T,>(reason: UnavailableReason): Known<T> => ({ known: false, reason });

// ---------------------------------------------------------------------------
// T2-2 · projects & trust
// ---------------------------------------------------------------------------

/**
 * What a host can tell us about a project beyond its space-side projection.
 * Both members are optional and BOTH ABSENCES ARE VISIBLE: the trust chip and
 * the usage line render their reason rather than a value.
 */
export interface ProjectFacts {
  /** From `ProjectResource` — no seam read exists for it today (GG3). */
  trust?: ProjectTrustLevel;
  workingDir?: string;
  repoUrl?: string | null;
  linkFrozen?: boolean;
  /** Spaces holding a link, for the over-cap refusal (oracle L213). */
  frozenBySpaces?: readonly string[];
  /** Sessions using this root. Supply BOTH numbers or neither. */
  usage?: { recorded: number; live: number };
}

export interface ProjectRow {
  id: string;
  title: string;
  /** The node-side project id from the space-side projection (state member). */
  projectId: string | null;
  trust: Known<ProjectTrustLevel>;
  workingDir: Known<string>;
  usage: Known<{ recorded: number; live: number }>;
  linkFrozen: boolean;
  frozenBySpaces: readonly string[];
}

/**
 * Narrow a summary's discriminated state STRUCTURALLY, not by its `kind` tag.
 *
 * §15.2 forbids a kind string literal in component code, and this lane carries
 * its own copy of that guard (`no-kind-literals.test.ts`, following
 * `settings-space/`). `projectId` is unique to the project member of
 * `CoreEntityState` (contract.ts:107) — checked against the whole union — so
 * the structural test is exact, and it is the one narrowing the guard permits.
 */
function projectStateOf(summary: EntitySummary): { projectId: string } | null {
  const state = summary.state as { projectId?: string };
  return typeof state.projectId === 'string' ? { projectId: state.projectId } : null;
}

export function projectRowOf(summary: EntitySummary, facts?: ProjectFacts): ProjectRow {
  return {
    id: summary.id,
    title: summary.title,
    projectId: projectStateOf(summary)?.projectId ?? null,
    trust:
      facts?.trust === undefined
        ? unknown(GOVERNANCE_REASONS.registryRead)
        : known(facts.trust),
    workingDir:
      facts?.workingDir === undefined
        ? unknown(GOVERNANCE_REASONS.registryRead)
        : known(facts.workingDir),
    usage: facts?.usage === undefined ? unknown(GOVERNANCE_REASONS.usageUnknown) : known(facts.usage),
    linkFrozen: facts?.linkFrozen === true,
    frozenBySpaces: facts?.frozenBySpaces ?? [],
  };
}

/**
 * THE UNLINK REFUSAL, RANKED. Three things can be true at once and they send
 * the user to three different remedies, so the order is decided here once
 * rather than by whichever branch a component happens to write first.
 *
 *   1. usage UNVERIFIED — refuse and say so. Never fall through to a verb-level
 *      reason, which would imply the world is fine and only the build is
 *      missing. We do not know that.
 *   2. LIVE SESSIONS — the oracle's own case (L174: "blocked: 2 live sessions
 *      still use this root — exit them first"). A fact about the WORLD outranks
 *      a fact about this BUILD: the user can act on it today.
 *   3. otherwise the action registry's own answer for `unlink`, verbatim.
 *
 * The same ranking is used by `panels/bodies/GovernedBody` (its handover §3.8).
 * Two surfaces, one order — deliberately, so the two never disagree on screen.
 */
export function unlinkRefusal(row: Pick<ProjectRow, 'usage'>): UnavailableReason {
  if (!row.usage.known) return row.usage.reason;
  const { live } = row.usage.value;
  if (live > 0) {
    return {
      cause: `Unlink blocked: ${live} live session${live === 1 ? '' : 's'} still use this root`,
      remedy: 'exit them first — unlinking a root out from under a running agent is not a recoverable state',
    };
  }
  return verbRefusal('unlink');
}

/** The `untrust` verb's own copy, read from the registry rather than restated. */
export function untrustRefusal(): UnavailableReason {
  return verbRefusal('untrust');
}

/**
 * A verb's authored refusal, READ FROM `domain/actions.ts` rather than copied.
 *
 * The day `untrust` stops being `deferred()`, this returns the availability
 * verdict instead and the caller's control comes alive with no edit here. That
 * is the whole reason this goes through the registry: a copy of the sentence
 * would still say "isn’t wired yet" on the day it is.
 */
function verbRefusal(ref: 'unlink' | 'untrust'): UnavailableReason {
  const availability = resolveAction(ref).availability({ spaceId: 'governance' });
  return availability.kind === 'disabled'
    ? toReason(availability.reason)
    : { cause: `“${ref}” is available`, remedy: 'this screen has no dispatcher wired for it' };
}

/**
 * The over-cap freeze line (oracle L213). Returns null when the project is not
 * frozen — the caller renders nothing, because a row that says "not frozen" is
 * noise. When frozen with NO named spaces we still render the line: the freeze
 * is the fact, and the missing space list is stated as missing.
 */
export function frozenNote(row: Pick<ProjectRow, 'linkFrozen' | 'frozenBySpaces'>): {
  text: string;
  spaces: readonly string[];
} | null {
  if (!row.linkFrozen) return null;
  return {
    text:
      row.frozenBySpaces.length > 0
        ? 'over cap — unlink one to unfreeze:'
        : 'over cap — which spaces hold the links is not readable from here',
    spaces: row.frozenBySpaces,
  };
}

// ---------------------------------------------------------------------------
// T2-2d · session provenance vs association (two truths, two treatments)
// ---------------------------------------------------------------------------

/**
 * The oracle's third note (L268): "Association ≠ provenance. Chips (editable,
 * removable) vs the ⚿ mono line (immutable, set at launch). They never share
 * styling, so history can't be rewritten by editing chips."
 *
 * That is a TYPE-LEVEL distinction here, not a styling convention: provenance
 * has no remove handler in its shape, so a component cannot render one by
 * accident.
 */
export interface SessionProjects {
  /** `EntityDetail.content.launchProjectId` — immutable. `null` ⇒ scratch. */
  launchedFrom: Known<{ projectId: string; label: string; workingDir: Known<string> } | null>;
  /** `in_project` edges. Empty array is a MEASURED empty; `known:false` is unread. */
  associations: Known<readonly { id: string; label: string }[]>;
}

/** The scratch label the oracle insists on (L257): labelled, never blank. */
export const SCRATCH_LABEL = 'sandboxed · no project';

// ---------------------------------------------------------------------------
// T2-4 · interaction profiles
// ---------------------------------------------------------------------------

export type ProfileLifecycle = 'draft' | 'active' | 'retired';

/** The oracle's one-way RAIL (L456): draft → active → retired. */
export const PROFILE_LIFECYCLE: readonly ProfileLifecycle[] = ['draft', 'active', 'retired'];

/**
 * The oracle's LIST order (L406, L415, L419): ACTIVE · 2, DRAFT · 1,
 * RETIRED · 1 — NOT the rail order.
 *
 * Found by a failing test, which is the only reason it is right: the first
 * implementation grouped by `PROFILE_LIFECYCLE` because one order for one
 * concept is the tidier idea, and the screen then led with drafts. Two orders
 * for two jobs is the oracle's actual design — the rail teaches the one-way
 * transition, the list leads with what is in force.
 */
export const PROFILE_LIST_ORDER: readonly ProfileLifecycle[] = ['active', 'draft', 'retired'];

export interface ProfileRow {
  id: string;
  title: string;
  status: ProfileLifecycle;
  /** `activeVersion ?? currentDraftVersion` — the version this row IS. */
  version: number | null;
  /** Oracle draws "41 runs"; nothing measures it (GG15). */
  runs: Known<number>;
  /** Which scope defaults to this profile. Unread ⇒ unknown, never "none". */
  defaultFor: Known<readonly ProfileDefaultScope[]>;
}

export interface ProfileDefaultScope {
  /**
   * The scope a default is set AT — the space, or one teammate (oracle note
   * L488: "teammate default beats space default").
   *
   * The word is `teammate`, NOT the contract's `team_member` discriminator,
   * and this lane's §15.2 guard is why: `team_member` is also an entity kind,
   * so the literal made `no-kind-literals.test.ts` red on its very first run.
   * Renaming beat exempting on the merits as well — `Teammate` is the
   * registry's own label for that kind (registry.ts:474) and the word the
   * oracle uses on screen, so this is the UI vocabulary rather than the wire's.
   * The mapping to `TeammateProfileDefaultView` happens at whatever adapter
   * eventually reads it, which is where wire words belong.
   */
  scope: 'space' | 'teammate';
  label: string;
}

/**
 * D53 applied to this surface: when both a space default and a teammate default
 * name a profile, the TEAMMATE one wins and is the brass badge; the outranked
 * space badge stays visible and grey. Visible-and-outranked, never hidden —
 * hiding it would make the resolution unexplainable at the moment it matters.
 */
export function rankDefaults(scopes: readonly ProfileDefaultScope[]): {
  winner: ProfileDefaultScope | null;
  outranked: readonly ProfileDefaultScope[];
} {
  const teammate = scopes.find((s) => s.scope === 'teammate');
  if (teammate) return { winner: teammate, outranked: scopes.filter((s) => s !== teammate) };
  const space = scopes.find((s) => s.scope === 'space') ?? null;
  return { winner: space, outranked: space ? scopes.filter((s) => s !== space) : scopes };
}

function profileStateOf(summary: EntitySummary): {
  status: ProfileLifecycle;
  activeVersion: number | null;
  currentDraftVersion: number;
} | null {
  // Structural again (see `projectStateOf`): `currentDraftVersion` is unique to
  // the interaction_profile member of `CoreEntityState` (contract.ts:108-110).
  const state = summary.state as {
    status?: ProfileLifecycle;
    activeVersion?: number | null;
    currentDraftVersion?: number;
  };
  if (typeof state.currentDraftVersion !== 'number' || !state.status) return null;
  return {
    status: state.status,
    activeVersion: state.activeVersion ?? null,
    currentDraftVersion: state.currentDraftVersion ?? 0,
  };
}

export function profileRowOf(
  summary: EntitySummary,
  defaults?: readonly ProfileDefaultScope[],
): ProfileRow {
  const state = profileStateOf(summary);
  return {
    id: summary.id,
    title: summary.title,
    // A summary whose state does not narrow is NOT silently 'draft': it is the
    // one case where we have no lifecycle at all, and the screen must show the
    // row rather than drop it. 'draft' is the least-claiming member — it
    // asserts no activation ever happened, which is exactly what we know.
    status: state?.status ?? 'draft',
    version: state ? (state.activeVersion ?? state.currentDraftVersion) : null,
    runs: unknown(GOVERNANCE_REASONS.profileRunCount),
    defaultFor:
      defaults === undefined ? unknown(GOVERNANCE_REASONS.setProfileDefault) : known(defaults),
  };
}

export interface ProfileGroup {
  id: ProfileLifecycle;
  label: string;
  rows: readonly ProfileRow[];
}

/**
 * Groups in LIFECYCLE order, and — the part that matters — a group with no
 * rows still appears with a count of 0. The oracle draws "ACTIVE · 2",
 * "DRAFT · 1", "RETIRED · 1"; a space with no drafts must still teach that
 * drafts exist. This is a MEASURED zero (we listed the profiles and found
 * none), which is why 0 is honest here and hollow elsewhere in this file.
 */
export function profileGroups(rows: readonly ProfileRow[]): readonly ProfileGroup[] {
  return PROFILE_LIST_ORDER.map((id) => ({
    id,
    label: id.toUpperCase(),
    rows: rows.filter((r) => r.status === id),
  }));
}

// ---------------------------------------------------------------------------
// T2-5 · custom-kind authoring
// ---------------------------------------------------------------------------

export interface DraftField {
  /** Stable across reorders so React keys and focus survive a move. */
  id: string;
  name: string;
  type: CustomFieldType;
  required: boolean;
  /** `enum` only. */
  values: readonly string[];
}

export interface KindDraft {
  name: string;
  /** Oracle L517: "PLURAL · MENU LABEL" — one field, two jobs. */
  plural: string;
  glyph: string;
  fields: readonly DraftField[];
}

export const emptyKindDraft = (): KindDraft => ({ name: '', plural: '', glyph: '', fields: [] });

/** Oracle L522-530 — the row of glyphs the canvas offers, in its order. */
export const GLYPH_CHOICES: readonly string[] = ['◮', '◭', '⊗', '⊘', '◆', '▲'];

/** Oracle L558: "status · title · reactions · points · edges come built-in". */
export const UNIVERSAL_SPINE: readonly string[] = ['status', 'title', 'reactions', 'points', 'edges'];

export const FIELD_TYPES: readonly CustomFieldType[] = ['text', 'number', 'bool', 'date', 'enum'];

/**
 * How a field VALUE renders, per the oracle's own sentence (L587): "enum →
 * word-chip, text → value, datetime → mono".
 *
 * A RULING I MADE ALONE, flagged in the handover: the oracle names three of
 * the five contract types. `number` follows `text` (a value), and `bool`
 * follows `enum` (a word-chip — a bool IS a two-member enum, and rendering it
 * as bare "true" would be the only place in this UI where a state reads as a
 * programming literal). `date` is the oracle's "datetime".
 */
export function fieldTreatment(type: CustomFieldType): 'word-chip' | 'value' | 'mono' {
  switch (type) {
    case 'enum':
    case 'bool':
      return 'word-chip';
    case 'date':
      return 'mono';
    default:
      return 'value';
  }
}

/** `incident` → `incident`; `Release Checklist` → `release-checklist`. */
export function slugifyKindName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The `c:*` kind id a draft would create, or null when the name is unusable. */
export function draftKindId(draft: KindDraft): CustomEntityKind | null {
  const slug = slugifyKindName(draft.name);
  return slug ? (`c:${slug}` as CustomEntityKind) : null;
}

/** The route slug that kind would own — `c:incident` → `c-incident` (WLT §2.1). */
export function draftRouteSlug(draft: KindDraft): string | null {
  const slug = slugifyKindName(draft.name);
  return slug ? `c-${slug}` : null;
}

export interface DraftIssue {
  /** Which control to attach the message to. */
  at: 'name' | 'plural' | 'glyph' | `field:${string}`;
  message: string;
}

/**
 * Validates a draft against the REAL registry and the REAL existing kinds.
 *
 * This is the one part of T2-5 that is fully wired: the collision checks run
 * against `domain/registry` (reserved slugs, core kind slugs) and against the
 * `entityKinds()` read the seam genuinely performs. The COMMIT is refused
 * (GG16) — the validation is not. A form that cannot submit can still be
 * honest about whether what you typed would work.
 */
export function validateKindDraft(
  draft: KindDraft,
  existingKinds: readonly EntityKindDef[] = [],
): readonly DraftIssue[] {
  const issues: DraftIssue[] = [];
  const slug = slugifyKindName(draft.name);

  if (!draft.name.trim()) {
    issues.push({ at: 'name', message: 'A kind needs a name.' });
  } else if (!slug) {
    issues.push({ at: 'name', message: 'That name has no letters or digits in it.' });
  } else {
    const routeSlug = `c-${slug}`;
    if (isReservedSlug(slug) || isReservedSlug(routeSlug)) {
      issues.push({ at: 'name', message: `“${slug}” is a reserved route word — pick another name.` });
    }
    if (allKinds().some((k) => k.slug === slug || k.slug === routeSlug)) {
      issues.push({ at: 'name', message: `A built-in kind already owns the “${slug}” route.` });
    }
    if (existingKinds.some((k) => k.kind === `c:${slug}`)) {
      issues.push({ at: 'name', message: `This space already defines c:${slug}.` });
    }
  }

  if (!draft.plural.trim()) {
    issues.push({ at: 'plural', message: 'The plural is the menu label — the rail has nothing to show without it.' });
  }
  if (!draft.glyph.trim()) {
    issues.push({ at: 'glyph', message: 'Pick a glyph — it identifies the kind in every chip, card and row.' });
  }

  const seen = new Set<string>();
  for (const field of draft.fields) {
    const name = field.name.trim().toLowerCase();
    if (!name) {
      issues.push({ at: `field:${field.id}`, message: 'This field needs a name.' });
      continue;
    }
    if (UNIVERSAL_SPINE.includes(name)) {
      issues.push({
        at: `field:${field.id}`,
        message: `“${name}” comes built-in on every kind — defining it again would shadow the spine.`,
      });
    }
    if (seen.has(name)) {
      issues.push({ at: `field:${field.id}`, message: `Two fields are both called “${name}”.` });
    }
    seen.add(name);
    if (field.type === 'enum' && field.values.filter((v) => v.trim()).length === 0) {
      issues.push({ at: `field:${field.id}`, message: 'An enum field needs at least one value.' });
    }
  }

  return issues;
}

/**
 * The exact `EntityKindCreateInput` this draft WOULD send. Returned even
 * though no command accepts it: the screen shows the composed payload, so the
 * refusal is "nothing carries this", not "we never built the thing to carry".
 * Null when the draft does not validate.
 */
export function draftToCreateInput(
  draft: KindDraft,
  clientMutationId: string,
  existingKinds: readonly EntityKindDef[] = [],
): { kind: CustomEntityKind; icon: string; fieldSchema: DraftField[]; clientMutationId: string } | null {
  if (validateKindDraft(draft, existingKinds).length > 0) return null;
  const kind = draftKindId(draft);
  if (!kind) return null;
  return {
    kind,
    icon: draft.glyph,
    fieldSchema: draft.fields.map((f) => ({ ...f, values: [...f.values] })),
    clientMutationId,
  };
}

/** Move a field within the draft, clamped. Used by the ⠿ handle's keyboard path. */
export function moveField(fields: readonly DraftField[], from: number, to: number): DraftField[] {
  const next = [...fields];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [moved] = next.splice(from, 1);
  if (!moved) return next;
  next.splice(target, 0, moved);
  return next;
}
