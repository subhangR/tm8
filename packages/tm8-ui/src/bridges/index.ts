/** `bridges/` — Settings → Bridges and the bridge panel (BRIDGE-ENTITY-DESIGN §4.2, §4.4). */
export { BridgesSection, connectionRowsOf, type BridgesSectionProps } from './BridgesSection';
export { BridgePageBlock, BRIDGE_TABS, type BridgeTab } from './BridgePage';
export {
  bridgesPortFromSeam, catalogServes, createBridgesClient, type BridgePatch, type BridgesClient, type BridgesPort,
} from './api';
