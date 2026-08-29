import './entity-navigation-metrics.css';

export interface EntityNavigationMetricsProps {
  total?: number;
  unseen?: number;
  live?: number;
  /** Full writes the total's unit; compact keeps the entity label in charge. */
  density?: 'compact' | 'full';
  className?: string;
}

/**
 * Counts shared by Home's rail and overview. Activity counts always keep
 * their visible word, so brand/run colour never has to carry meaning alone.
 */
export function EntityNavigationMetrics({
  total,
  unseen = 0,
  live = 0,
  density = 'compact',
  className,
}: EntityNavigationMetricsProps) {
  const facts = [
    ...(total === undefined ? [] : [`${total} total`]),
    ...(unseen > 0 ? [`${unseen} new`] : []),
    ...(live > 0 ? [`${live} live`] : []),
  ];
  if (facts.length === 0) return null;

  return (
    <span
      className={`enav-metrics enav-metrics--${density}${className ? ` ${className}` : ''}`}
      aria-label={facts.join(', ')}
    >
      {total !== undefined ? (
        <span className="enav-metric enav-metric--total">
          <span className="enav-metric__value">{total}</span>
          {density === 'full' ? <span className="enav-metric__unit">total</span> : null}
        </span>
      ) : null}
      {unseen > 0 ? (
        <span className="enav-metric enav-metric--new">
          <span className="enav-metric__value">{unseen}</span>
          <span className="enav-metric__unit">new</span>
        </span>
      ) : null}
      {live > 0 ? (
        <span className="enav-metric enav-metric--live">
          <span className="enav-metric__value">{live}</span>
          <span className="enav-metric__unit">live</span>
        </span>
      ) : null}
    </span>
  );
}
