import { LinkRefusalCard } from './LinkRefusalCard';

export interface NotSpaceMemberRefusalProps {
  onOpenAvailableSpace?: () => void;
}

/**
 * A held option for a future API that deliberately permits disclosure.
 * Do not use this for today's link-arrival path: unlike an ordinary boot
 * restore by a former member, a viewer arriving by address may be probing, and
 * this wording would confirm that the Space exists.
 */
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
