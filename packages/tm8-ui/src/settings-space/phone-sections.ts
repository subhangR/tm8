/**
 * SETTINGS ON A PHONE — how `SETTINGS_SECTIONS` is grouped and which of its
 * sections a phone can do (audit E1; mockup "Settings and Craft mode on
 * phone", 01a14cc4).
 *
 * NO NEW SECTIONS. Every row is a section the desktop already draws, under one
 * of six headed groups, so a section added to `SETTINGS_SECTIONS` without a
 * group here is a test failure (`settings-stacked.test.tsx`), not a row that
 * silently goes missing on the phone.
 *
 * `desktop` rows still list, and open an honest refusal with a way out (copy
 * the link), because a row that vanishes on a phone reads as "this space has
 * no such thing". They are the editors that need a pointer, a folder picker or
 * a wide table: the menu's drag editor, schema authoring, workflows, and the
 * node-level and destructive sections.
 */
import type { SettingsSectionId } from './types';

export interface PhoneSettingsGroup {
  title: string;
  ids: readonly SettingsSectionId[];
}

export const PHONE_SETTINGS_GROUPS: readonly PhoneSettingsGroup[] = [
  { title: 'You', ids: ['account', 'my-sessions'] },
  { title: 'Space & people', ids: ['profile', 'members', 'invites', 'sessions', 'sharing'] },
  { title: 'Chat & models', ids: ['models', 'chat-defaults'] },
  {
    title: 'Credentials & access',
    ids: ['connectors', 'credentials', 'space-credentials', 'node-credentials', 'filesystem-access', 'space-links', 'projects'],
  },
  { title: 'Structure', ids: ['axes', 'workflows', 'menu', 'kinds'] },
  { title: 'Reference', ids: ['configs', 'danger'] },
];

/** Sections that list on a phone but refuse to open there. */
export const DESKTOP_ONLY_SECTIONS: ReadonlySet<SettingsSectionId> = new Set<SettingsSectionId>([
  'node-credentials',
  'filesystem-access',
  'projects',
  'workflows',
  'menu',
  'kinds',
  'danger',
]);

/** The second line of each row: what is behind it, in the mockup's words. */
export const PHONE_SECTION_HINTS: Partial<Record<SettingsSectionId, string>> = {
  account: 'Your name and how you appear',
  'my-sessions': 'Where you are signed in',
  profile: 'Name and description',
  members: 'Who is in this space',
  invites: 'Links that let people join',
  sessions: 'Anyone’s sign-ins to this space',
  sharing: 'Who can see terminals',
  models: 'Stored in this browser',
  'chat-defaults': 'Teammate and model per kind',
  connectors: 'MCP servers',
  credentials: 'Your agent logins',
  'space-credentials': 'Logins the space owns',
  'node-credentials': 'Admins only',
  'filesystem-access': 'Admins only',
  'space-links': 'Your other spaces',
  projects: 'Needs a folder picker',
  axes: 'Type, priority, area',
  workflows: 'Authored next to axes',
  menu: 'Drag-to-arrange editor',
  kinds: 'Schema authoring',
  configs: 'Every knob, read-only',
  danger: 'Transfer ownership, leave, delete',
};
