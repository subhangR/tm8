import { LinkRefusalCard } from './LinkRefusalCard';

export interface SpaceAccessRefusalProps {
  onOpenAvailableSpace?: () => void;
}

/**
 * The privacy-preserving shared state for wrong-node and non-member failures.
 * Use this on link arrival whenever the API deliberately does not distinguish
 * those cases. The viewer arrived by address and may be probing: saying “not a
 * member” would confirm that the Space exists. An ordinary boot restore is a
 * different audience — that viewer already knew the Space — so GateApp's boot
 * card may honestly retain the node's specific refusal.
 */
export function SpaceAccessRefusal({ onOpenAvailableSpace }: SpaceAccessRefusalProps) {
  return (
    <LinkRefusalCard
      testId="space-access-refusal"
      title="You do not have access to this link’s Space."
      onAction={onOpenAvailableSpace}
    >
      <div>The Space may be on a different tm8 node, or you may need an invite from the sender.</div>
      <div>Nothing else was opened in its place.</div>
    </LinkRefusalCard>
  );
}
