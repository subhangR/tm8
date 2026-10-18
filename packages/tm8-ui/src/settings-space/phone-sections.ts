/**
 * SETTINGS ON A PHONE — how `SETTINGS_SECTIONS` is grouped and which of its
 * sections a phone can do (audit E1; mockup "Settings and Craft mode on
 * phone", 01a14cc4).
 *
 * NO NEW SECTIONS. Every row is a section the desktop already draws, under one
 * of six headed groups, so a section added to `SETTINGS_SECTIONS` without a
 * group here is a test failure (`settings.test.tsx`), not a row that
 * silently goes missing on the phone.
 *
 * `desktop` rows still list, and open an honest refusal with a way out (copy
 * the link), because a row that vanishes on a phone reads as "this space has
 * no such thing". They are the editors that need a pointer, a folder picker or
 * a wide table: the menu's drag editor, schema authoring, workflows, and the
 * node-level and destructive sections.
 */
import type { SpaceInviteView } from '@tm8/contract';
import { stateOf } from './InviteFrames';
import type { SettingsData, SettingsSectionId } from './types';

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

/**
 * Sections that open on the phone with their write controls removed, and the
 * tag their row carries to say so before it is tapped. Configs is read-only
 * everywhere; axes and space credentials are only read-only here, because
 * editing them changes what every workflow and every launch keys on.
 */
export const PHONE_READ_ONLY_TAGS: Partial<Record<SettingsSectionId, string>> = {
  'space-credentials': 'status',
  axes: 'read-only',
  configs: 'read-only',
};

/**
 * The tile each row leads with, as drawn. `tone` names a token family
 * (`--pn-<tone>` on `--pn-<tone>-soft`), never a colour, so a custom style
 * repaints the tiles with everything else. Desktop-only rows are all `idle`:
 * grey says "not here" before the tag does.
 */
export type PhoneTone = 'info' | 'run' | 'brand' | 'merged' | 'wait' | 'block' | 'idle';
export const PHONE_SECTION_ICONS: Record<SettingsSectionId, { glyph: string; tone: PhoneTone }> = {
  account: { glyph: '👤', tone: 'info' },
  'my-sessions': { glyph: '🔑', tone: 'info' },
  profile: { glyph: '⌂', tone: 'run' },
  members: { glyph: '👥', tone: 'run' },
  invites: { glyph: '✉', tone: 'run' },
  sessions: { glyph: '▶', tone: 'run' },
  sharing: { glyph: '⇄', tone: 'run' },
  models: { glyph: '◎', tone: 'info' },
  'chat-defaults': { glyph: '💬', tone: 'info' },
  connectors: { glyph: '⌁', tone: 'brand' },
  credentials: { glyph: '🔐', tone: 'brand' },
  'space-credentials': { glyph: '🏛', tone: 'brand' },
  'node-credentials': { glyph: '🖥', tone: 'idle' },
  'filesystem-access': { glyph: '📁', tone: 'idle' },
  'space-links': { glyph: '🔗', tone: 'brand' },
  projects: { glyph: '⎇', tone: 'idle' },
  axes: { glyph: '⇅', tone: 'merged' },
  workflows: { glyph: '⟲', tone: 'idle' },
  menu: { glyph: '☰', tone: 'idle' },
  kinds: { glyph: '◇', tone: 'idle' },
  configs: { glyph: '⚙', tone: 'idle' },
  danger: { glyph: '⚠', tone: 'block' },
};

/**
 * The LIVE second line, for the rows whose answer the shell has already read
 * on its boot round trip (`SettingsData`). `null` keeps the fixed hint: every
 * other row would need a read of its own just to draw its subtitle, and a
 * list that fans out eight requests to say "2 connected" costs more than it
 * tells. A read that failed (`null` in the data) also keeps the fixed hint,
 * never a made-up zero.
 */
export function phoneLiveHint(id: SettingsSectionId, data: SettingsData): string | null {
  switch (id) {
    case 'account': {
      const who = data.identity;
      if (!who) return null;
      return who.displayName ? `${who.displayName} · @${who.username}` : `@${who.username}`;
    }
    case 'profile':
      return data.space?.name ?? null;
    case 'members': {
      if (data.members.length === 0) return null;
      const people = `${data.members.length} member${data.members.length === 1 ? '' : 's'}`;
      const open = liveInvites(data.invites);
      return open === null || open === 0 ? people : `${people} · ${open} pending`;
    }
    case 'invites': {
      const open = liveInvites(data.invites);
      return open === null ? null : open === 0 ? 'None live' : `${open} live`;
    }
    case 'axes':
      if (!data.axes) return null;
      return data.axes.length === 0
        ? 'None defined'
        : [...data.axes].sort((a, b) => a.position - b.position).map((a) => a.name).join(' · ');
    default:
      return null;
  }
}

function liveInvites(invites: readonly SpaceInviteView[] | null): number | null {
  return invites === null ? null : invites.filter((i) => stateOf(i) === 'live').length;
}

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
  'chat-defaults': 'Teammate + model per kind',
  connectors: 'MCP servers',
  credentials: 'Your agent logins',
  'space-credentials': 'Status only on phone',
  'node-credentials': 'Admins only',
  'filesystem-access': 'Admins only',
  'space-links': 'Your other spaces',
  projects: 'Needs a folder picker',
  axes: 'Axes and their values',
  workflows: 'Authored next to axes',
  menu: 'Drag-to-arrange editor',
  kinds: 'Schema authoring',
  configs: 'Every knob, read-only',
  danger: 'Transfer ownership · leave · delete',
};
