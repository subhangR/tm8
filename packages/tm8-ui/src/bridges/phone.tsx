import type { ReactNode } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { getKind } from '../domain';
import type { BridgesPort } from './api';
import { BridgePageBlock } from './BridgePage';

/**
 * THE PHONE BODY FOR A KIND WITH A PAGE BLOCK (BRIDGE-ENTITY-DESIGN §4.1
 * Mobile: "the same list, panel and link flow" on the phone).
 *
 * The phone shell draws every kind without its own phone screen through the
 * generic `PhoneEntityPage` (title, text, links, messages). A bridge's text is
 * nothing; its page is the `bridge-page` block. So a row whose panel carries
 * that block gets it as the phone page's body — read from registry DATA, the
 * same way GenericBody reads it, so no host names a kind. The block itself
 * is already single-column under 640px (bridge-panel.css).
 */
export function phoneBodyFor(
  detail: EntityDetail | null | undefined,
  port: BridgesPort | null | undefined,
  onOpenEntity: (id: string) => void,
): ReactNode | undefined {
  if (!detail) return undefined;
  const blocks = getKind(detail.kind).panel.blocks ?? [];
  if (!blocks.some((b) => b.block === 'bridge-page')) return undefined;
  return <BridgePageBlock detail={detail} port={port} onOpenEntity={onOpenEntity} />;
}
