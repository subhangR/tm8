/**
 * The space defaults a space admin sets from Settings: the default channel,
 * the default interaction profile, the space-password requirement and the
 * default style. One port over the seam, so the settings sections stay free of
 * kind names (their §15.2 guards scan `settings-space/` and
 * `settings-governance/`; the two kind-scoped queries live here instead).
 *
 * A setter is absent when the seam has no command for it; the section then
 * renders the control refused rather than inert.
 */
import type { EntityId, EntitySummary, SpaceId, SpacePasswordSetRequiredResult, StyleListRow } from '@tm8/contract';
import type { Seam } from './seam';

export interface SpaceDefaultsSnapshot {
  /** `SpaceSettingsView.settingsRevision`, the guard the two default setters take. */
  revision: number;
  defaultChannelId: EntityId | null;
  defaultInteractionProfileId: EntityId | null;
}

export interface SpaceStyleChoice {
  defaultStyle: string;
  /** `spaces.styleDefault.get` revision (0 = no row yet). */
  revision: number;
  styles: StyleListRow[];
}

export interface SpaceDefaultsPort {
  loadDefaults(): Promise<SpaceDefaultsSnapshot>;
  loadChannels(): Promise<EntitySummary[]>;
  loadProfiles(): Promise<EntitySummary[]>;
  setDefaultChannel?(channelId: EntityId | null, revision: number): Promise<void>;
  setDefaultProfile?(profileId: EntityId | null, revision: number): Promise<void>;
  setPasswordRequired?(required: boolean, password?: string): Promise<SpacePasswordSetRequiredResult>;
  loadStyle?(): Promise<SpaceStyleChoice>;
  setStyleDefault?(defaultStyle: string, revision: number): Promise<void>;
}

export function spaceDefaultsPortFromSeam(seam: Seam, spaceId: SpaceId): SpaceDefaultsPort {
  const byKind = async (kind: 'channel' | 'interaction_profile') => {
    const result = await seam.query({ spaceId, kinds: [kind] });
    return result.page.items;
  };
  return {
    async loadDefaults() {
      const settings = await seam.spaceSettings(spaceId);
      return {
        revision: settings.settingsRevision,
        defaultChannelId: settings.defaultChannelId,
        defaultInteractionProfileId: settings.defaultInteractionProfileId,
      };
    },
    loadChannels: () => byKind('channel'),
    loadProfiles: () => byKind('interaction_profile'),
    ...(seam.setDefaultChannel
      ? { setDefaultChannel: async (id: EntityId | null, revision: number) => {
          await seam.setDefaultChannel!(spaceId, id, revision);
        } }
      : {}),
    ...(seam.setDefaultInteractionProfile
      ? { setDefaultProfile: async (id: EntityId | null, revision: number) => {
          await seam.setDefaultInteractionProfile!(spaceId, id, revision);
        } }
      : {}),
    ...(seam.setSpacePasswordRequired
      ? { setPasswordRequired: (required: boolean, password?: string) =>
          seam.setSpacePasswordRequired!(spaceId, required, password) }
      : {}),
    ...(seam.styles && seam.styleDefault
      ? { loadStyle: async () => {
          const [list, current] = await Promise.all([seam.styles!(spaceId), seam.styleDefault!(spaceId)]);
          return { defaultStyle: current.defaultStyle, revision: current.revision, styles: list.items };
        } }
      : {}),
    ...(seam.setStyleDefault
      ? { setStyleDefault: async (defaultStyle: string, revision: number) => {
          await seam.setStyleDefault!(spaceId, defaultStyle, revision);
        } }
      : {}),
  };
}
