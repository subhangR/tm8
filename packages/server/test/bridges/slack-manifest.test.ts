/**
 * The Slack app manifest an admin pastes (integrations/slack-bridge/slack-app-manifest.yaml):
 * Socket Mode with no request URLs, exactly the design §4 bot scopes, §4's events plus their private-channel twins, the /tm8
 * command, Grid org install on, token rotation off. An offline shape check against Slack's
 * published manifest fields; Slack's own validator runs only when the manifest is pasted.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = resolve(__dirname, '../../../..');
const manifest = parse(readFileSync(join(REPO, 'integrations/slack-bridge/slack-app-manifest.yaml'), 'utf8')) as {
  display_information: { name: string; description: string; long_description: string; background_color: string };
  features: {
    bot_user: { display_name: string; always_online: boolean };
    slash_commands: { command: string; description: string; usage_hint: string; url?: string }[];
    app_home: Record<string, boolean>;
  };
  oauth_config: { scopes: { bot: string[]; user?: string[] }; redirect_urls?: string[] };
  settings: {
    event_subscriptions: { bot_events: string[]; request_url?: string };
    interactivity: { is_enabled: boolean; request_url?: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
};

describe('slack app manifest', () => {
  it('asks for exactly the design §4 bot scopes, no user scopes and no optional im:*', () => {
    expect([...manifest.oauth_config.scopes.bot].sort()).toEqual([
      'app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'chat:write.customize',
      'commands', 'files:read', 'files:write', 'groups:history', 'groups:read', 'reactions:read',
      'reactions:write', 'users:read', 'users:read.email',
    ]);
    expect(manifest.oauth_config.scopes.user).toBeUndefined();
    expect(manifest.oauth_config.redirect_urls).toBeUndefined();
  });

  it('subscribes to the design §4 bot events and their private-channel twins', () => {
    // Slack sends channel_left/archive/rename for public channels only; a private channel sends group_*.
    expect([...manifest.settings.event_subscriptions.bot_events].sort()).toEqual([
      'app_mention', 'channel_archive', 'channel_left', 'channel_rename', 'channel_unarchive',
      'group_archive', 'group_left', 'group_rename', 'group_unarchive',
      'member_joined_channel', 'member_left_channel', 'message.channels', 'message.groups',
      'reaction_added', 'reaction_removed',
    ]);
  });

  it('is Socket Mode, Grid-installable and without token rotation', () => {
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.org_deploy_enabled).toBe(true);
    expect(manifest.settings.token_rotation_enabled).toBe(false);
    expect(manifest.settings.event_subscriptions.request_url).toBeUndefined();
    expect(manifest.settings.interactivity.request_url).toBeUndefined();
  });

  it('is the tm8 bot with a /tm8 command, inside Slack\'s field limits', () => {
    const d = manifest.display_information;
    expect(d.name).toBe('tm8');
    expect(d.description.length).toBeLessThanOrEqual(140);
    expect(d.long_description.length).toBeGreaterThanOrEqual(175);
    expect(d.long_description.length).toBeLessThanOrEqual(4000);
    expect(d.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.features.bot_user).toEqual({ display_name: 'tm8', always_online: true });
    expect(manifest.features.slash_commands).toHaveLength(1);
    const [cmd] = manifest.features.slash_commands;
    expect(cmd!.command).toBe('/tm8');
    expect(cmd!.url).toBeUndefined();
    expect(cmd!.usage_hint.length).toBeGreaterThan(0);
    expect(cmd!.description.length).toBeGreaterThan(0);
    // No DMs without the optional im:* scopes, so no Messages tab.
    expect(manifest.features.app_home.messages_tab_enabled).toBe(false);
  });
});
