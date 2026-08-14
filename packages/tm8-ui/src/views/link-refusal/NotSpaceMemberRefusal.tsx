import { LinkRefusalCard } from './LinkRefusalCard';

export interface NotSpaceMemberRefusalProps {
  onOpenAvailableSpace?: () => void;
}

export function NotSpaceMemberRefusal({ onOpenAvailableSpace }: NotSpaceMemberRefusalProps) {
  return (
    <LinkRefusalCard
      testId="not-space-member-refusal"
      title="You are not a member of this Space."
      onAction={onOpenAvailableSpace}
    >
      <div>Ask whoever sent you this link for an invite.</div>
      <div>The linked Space was not opened, and no other Space was substituted for it.</div>
    </LinkRefusalCard>
  );
}
