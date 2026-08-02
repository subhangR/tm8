/**
 * The props contract for T2 half A. Everything here is data-in / callbacks-out
 * — no component in this module constructs a seam (see `port.ts` for why).
 */
import type { ReactNode } from 'react';
import type { EntitySummary, SpaceSummary } from '@tm8/contract';
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
}

/**
 * The invite shapes the oracle draws. They are NOT contract types — the
 * contract defines no invite DTO at all — so they live here, named for what
 * they are, and only the dev review board ever supplies one. Product code
 * receives `null` and renders the honest absence.
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
