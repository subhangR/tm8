import { LinkRefusalCard } from './LinkRefusalCard';

export interface SpaceAccessRefusalProps {
  onOpenAvailableSpace?: () => void;
}

/**
 * The privacy-preserving shared state for wrong-node and non-member failures.
 * Use this whenever the API deliberately does not distinguish those cases.
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
