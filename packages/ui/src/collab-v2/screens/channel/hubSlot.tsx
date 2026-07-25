/**
 * `EntityFullView` hub-slot adapter — the Z4 promote path for a channel renders
 * the SAME `ChannelHubBody` the `channel` center view does.
 */
import type { EntityDetail } from '../../types/contract';
import type { EntityFullViewSlots } from '../../entity';
import { ChannelHubBody } from './ChannelHubBody';

export function channelHubSlot(): NonNullable<EntityFullViewSlots['hub']> {
  return (detail: EntityDetail) => <ChannelHubBody detail={detail} />;
}
