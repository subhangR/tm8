import { LinkRefusalCard } from './LinkRefusalCard';

export interface EntityUnavailableRefusalProps {
  onOpenSpace?: () => void;
}

export function EntityUnavailableRefusal({ onOpenSpace }: EntityUnavailableRefusalProps) {
  return (
    <LinkRefusalCard
      testId="entity-unavailable-refusal"
      title="This linked entity is unavailable."
      actionLabel="Open the Space"
      onAction={onOpenSpace}
    >
      <div>It may have been deleted or purged, or its visibility may prevent it from being read.</div>
      <div>The unavailable entity is shown on its own; no companion view has been substituted.</div>
    </LinkRefusalCard>
  );
}
