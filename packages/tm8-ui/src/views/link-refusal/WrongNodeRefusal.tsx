import { LinkRefusalCard } from './LinkRefusalCard';

export interface WrongNodeRefusalProps {
  onOpenAvailableSpace?: () => void;
}

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
