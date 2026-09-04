/**
 * Shared entity-navigation projection.
 *
 * `homeRailGroups()` owns membership and order. This module enriches that
 * registry-derived spine with server counts and liveness without teaching a
 * view how to aggregate them. Most importantly, an absent counter remains
 * absent: a partially counted group is not presented as a smaller, exact
 * total.
 */
import type { KindConfig } from './types';
import type { HomeRailGroup } from './home-rail';

export interface EntityNavigationCounts {
  total: number;
  unseen: number;
}

export type EntityNavigationCountsFor = (
  kind: string,
) => EntityNavigationCounts | undefined;

export interface EntityNavigationItem {
  config: KindConfig;
  counts?: EntityNavigationCounts;
  live?: number;
}

export interface EntityNavigationGroup {
  id: string;
  label: string;
  description: string;
  items: readonly EntityNavigationItem[];
  /** Exact only when every item in the group was counted. */
  total?: number;
  /** Exact only when every item in the group was counted. */
  unseen?: number;
  /** Present when at least one kind in the group declares a live counter. */
  live?: number;
}

export interface EntityNavigationSummary {
  kinds: number;
  total?: number;
  unseen?: number;
  live?: number;
}

export function composeEntityNavigation(
  groups: readonly HomeRailGroup[],
  countsFor: EntityNavigationCountsFor,
  liveFor: (config: KindConfig) => number | undefined = () => undefined,
): EntityNavigationGroup[] {
  return groups.map((group) => {
    const items = group.kinds.map((config): EntityNavigationItem => {
      const counts = countsFor(config.kind);
      const live = liveFor(config);
      return {
        config,
        ...(counts === undefined ? {} : { counts }),
        ...(live === undefined ? {} : { live }),
      };
    });
    const counted = items.every((item) => item.counts !== undefined);
    const liveItems = items.filter(
      (item): item is EntityNavigationItem & { live: number } => item.live !== undefined,
    );
    return {
      id: group.id,
      label: group.label,
      description: group.description,
      items,
      ...(counted
        ? {
            total: items.reduce((sum, item) => sum + item.counts!.total, 0),
            unseen: items.reduce((sum, item) => sum + item.counts!.unseen, 0),
          }
        : {}),
      ...(liveItems.length > 0
        ? { live: liveItems.reduce((sum, item) => sum + item.live, 0) }
        : {}),
    };
  });
}

export function summarizeEntityNavigation(
  groups: readonly EntityNavigationGroup[],
): EntityNavigationSummary {
  const countedGroups = groups.filter(
    (group): group is EntityNavigationGroup & { total: number; unseen: number } =>
      group.total !== undefined && group.unseen !== undefined,
  );
  const counted = countedGroups.length === groups.length;
  const liveGroups = groups.filter(
    (group): group is EntityNavigationGroup & { live: number } => group.live !== undefined,
  );
  return {
    kinds: groups.reduce((sum, group) => sum + group.items.length, 0),
    ...(counted
      ? {
          total: countedGroups.reduce((sum, group) => sum + group.total, 0),
          unseen: countedGroups.reduce((sum, group) => sum + group.unseen, 0),
        }
      : {}),
    ...(liveGroups.length > 0
      ? { live: liveGroups.reduce((sum, group) => sum + group.live, 0) }
      : {}),
  };
}

/** One complete name for a navigation row; colour and placement carry none. */
export function entityNavigationLabel(item: EntityNavigationItem): string {
  const facts = [item.config.labelPlural];
  if (item.counts) facts.push(`${item.counts.total} total`);
  if (item.counts && item.counts.unseen > 0) facts.push(`${item.counts.unseen} new`);
  if (item.live !== undefined && item.live > 0) facts.push(`${item.live} live`);
  return facts.join(', ');
}
