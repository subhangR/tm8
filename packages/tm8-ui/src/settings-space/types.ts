/**
 * The props contract for T2 half A. Everything here is data-in / callbacks-out
 * — no component in this module constructs a seam (see `port.ts` for why).
 */
import type { ReactNode } from 'react';
import type { EntitySummary, SpaceInviteView, SpaceSummary, TaskAxis } from '@tm8/contract';
import type { IdentityView } from '../data/seam';
import type { ResolvedMenu } from '../shell/menu-resolve';
import type { SettingsPort } from './port';

/**
 * The eight destinations the oracle's section nav names (T2-1, L33–L43), in
 * its order. `projects` and `kinds` are HALF B's content — this shell owns the
 * nav and the frame, the sibling module owns those two bodies, and they meet
 * at the `sections` prop rather than at an edit to either lane's files.
 */
export type SettingsSectionId =
  | 'profile'
  | 'account'
  | 'members'
  | 'invites'
  | 'axes'
  | 'models'
  | 'credentials'
  | 'projects'
  | 'menu'
  | 'kinds'
  | 'danger';

export interface SettingsSectionDef {
  id: SettingsSectionId;
  /** Nav label — the oracle's words. */
  label: string;
  /** Section heading — the oracle's words where it draws one. */
  heading: string;
  /** Renders in the block-coloured danger slot at the foot of the nav (L43). */
  danger?: boolean;
  /** Built by another module and injected through `sections`. */
  externallyOwned?: boolean;
}

/**
 * Oracle L33–L43, verbatim labels, verbatim order — PLUS `account`, which the
 * oracle predates: `identity.profile.update` (067 / Identity v2) landed after
 * that canvas was drawn, and the viewer's own display identity needs a home.
 * It sits directly under the space Profile so "about the space" and "about
 * you" read as neighbours, not as one thing.
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'profile', label: 'Profile', heading: 'Profile' },
  { id: 'account', label: 'Your profile', heading: 'Your profile' },
  { id: 'members', label: 'Members & roles', heading: 'Members & roles' },
  { id: 'invites', label: 'Invites', heading: 'Invites' },
  { id: 'axes', label: 'Task axes', heading: 'Task axes' },
  /* Models sits with the other space-shaped configuration even though it is
     browser-local: it is where someone looking for "what can I launch with"
     will look, and the section itself states its real scope rather than
     letting its neighbours imply one. */
  { id: 'models', label: 'Models', heading: 'Models' },
  /* Agent credentials — the viewer's OWN logins, built in
     `settings-credentials/` and injected through `sections`. It sits beside
     Models because both answer "what can I launch with", and directly after it
     because a model you cannot authenticate against is not a thing you can
     launch. Like `projects` and `kinds` it is externally owned, so an
     unsupplied section renders the shell's honest not-mounted state rather
     than a blank pane. */
  { id: 'credentials', label: 'Agent credentials', heading: 'Agent credentials', externallyOwned: true },
  { id: 'projects', label: 'Linked projects', heading: 'Linked projects', externallyOwned: true },
  { id: 'menu', label: 'Menu', heading: 'Menu' },
  { id: 'kinds', label: 'Custom kinds', heading: 'Custom kinds', externallyOwned: true },
  { id: 'danger', label: 'Danger zone', heading: 'Danger zone', danger: true },
];

/** Everything the shell has loaded, or `null` while it is still loading. */
export interface SettingsData {
  space: SpaceSummary | null;
  members: EntitySummary[];
  identity: IdentityView | null;
  menu: ResolvedMenu | null;
  /**
   * `null` means NOT READ, and is the normal state for a plain member: the
   * invite list is admin-only, so its rejection is the correct answer rather
   * than a fault. Distinguished from `[]` — "read, and there are none" —
   * because only one of those is worth acting on.
   */
  invites: readonly SpaceInviteView[] | null;
  /**
   * The task-axis registry (W2). `null` means NOT READ — the read rides the
   * same `spaces.settings` round trip as invites, so a failure there leaves
   * this section saying "could not be read" rather than "no axes".
   */
  axes: readonly TaskAxis[] | null;
}

export interface SettingsShellProps {
  /** The one seam adapter. Construct with `settingsPortFromSeam(seam, spaceId)`. */
  port: SettingsPort;
  /**
   * Bodies for sections this module does not build. A section listed as
   * `externallyOwned` with nothing supplied renders disabled-with-reason
   * naming the gap — never a blank pane.
   */
  sections?: Partial<Record<SettingsSectionId, ReactNode>>;
  /** Which section opens first. Defaults to the oracle's own drawn state. */
  initialSection?: SettingsSectionId;
  /** Notified on every section change so a host can mirror it into the route. */
  onSectionChange?: (id: SettingsSectionId) => void;
  /**
   * Which node's browser-local settings this shell edits. Defaults to the local
   * node. Only the Models section reads it today; it is a prop rather than a
   * module read so a host pointed at a named Server edits THAT node's catalog.
   */
  nodeKey?: string;
  /**
   * Fired after any axis write LANDS (W2). The host uses it to refresh the
   * workspace's own `taskAxes` projection so a new axis appears as a picker
   * (W1) and a group-by option (W3) without a reload. Optional: the shell
   * re-reads its own list either way.
   */
  onAxesChanged?: () => void;
}

/**
 * The invite shape the ORACLE draws — the canvas's own annotations, which are
 * not the contract's DTO and never were. `SpaceInviteView` (contract, 109) is
 * what product renders; this stays because the dev review board diffs the
 * built list against the canvas, and the two carry different fields (the
 * oracle draws a revoker and a human-written expiry phrase; the node returns a
 * role, a use budget and an ISO timestamp).
 *
 * Only the dev board ever supplies one. Product passes `invites`.
 */
export interface SpecimenInvite {
  code: string;
  role: string;
  used: number;
  uses: number;
  createdWhen: string;
  createdBy: string;
  expiry: string;
  revoked?: { when: string; by: string; effect: string };
}

/** T2-1d's four states (L124–L139 + the annotation at L141). */
export type RedeemState = 'valid' | 'expired' | 'revoked' | 'used-up';
