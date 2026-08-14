import { LinkRefusalCard } from './LinkRefusalCard';

export interface WrongNodeRefusalProps {
  onOpenAvailableSpace?: () => void;
}

/**
 * A held option for a future API that safely establishes node identity.
 * Today's link-arrival path combines this with non-membership because a viewer
 * arriving by address may be probing. The existing boot-restore card serves a
 * viewer who already knew the Space and may retain the node's specific words.
 */
export function WrongNodeRefusal({ onOpenAvailableSpace }: WrongNodeRefusalProps) {
  return (
    <LinkRefusalCard
      testId="wrong-node-refusal"
      title="This link’s Space is not on this tm8 node."
      onAction={onOpenAvailableSpace}
    >
      <div>The link may belong to a different tm8 node. Ask the sender to check where they copied it.</div>
      <div>Nothing else was opened in its place.</div>
    </LinkRefusalCard>
  );
}
