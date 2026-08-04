/**
 * Loading skeletons for the three zoom levels — panels never blank-flash
 * (UX brief §11). Pure presentational shimmer blocks.
 */

export function ChipSkeleton() {
  return (
    <span className="cv2-chip cv2-chip--skeleton" aria-hidden="true">
      <span className="cv2-skel cv2-skel--dot" />
      <span className="cv2-skel" style={{ width: 90 }} />
    </span>
  );
}

export function EntityCardSkeleton() {
  return (
    <div className="cv2-card cv2-card--skeleton" aria-hidden="true" data-skeleton="card">
      <div className="cv2-card__head">
        <span className="cv2-skel cv2-skel--dot" />
        <span className="cv2-skel" style={{ width: 48 }} />
        <span className="cv2-skel cv2-skel--avatar" style={{ marginLeft: 'auto' }} />
      </div>
      <span className="cv2-skel" style={{ width: '82%', height: 13, marginTop: 8 }} />
      <span className="cv2-skel" style={{ width: '55%', marginTop: 8 }} />
      <div className="cv2-card__foot">
        <span className="cv2-skel" style={{ width: 24 }} />
        <span className="cv2-skel" style={{ width: 24 }} />
        <span className="cv2-skel" style={{ width: 24 }} />
      </div>
    </div>
  );
}

export function EntityPanelSkeleton() {
  return (
    <div className="cv2-panel cv2-panel--skeleton" aria-hidden="true" data-skeleton="panel">
      <div className="cv2-panel__header">
        <span className="cv2-skel" style={{ width: 140 }} />
        <span className="cv2-skel" style={{ width: '70%', height: 14, marginTop: 8 }} />
      </div>
      <div className="cv2-panel__actions">
        {[0, 1, 2, 3].map((i) => <span key={i} className="cv2-skel cv2-skel--dot" />)}
      </div>
      <div className="cv2-panel__tabs">
        {[0, 1, 2, 3].map((i) => <span key={i} className="cv2-skel" style={{ width: 64, margin: '10px 6px' }} />)}
      </div>
      <div className="cv2-panel__body">
        <span className="cv2-skel" style={{ width: '90%' }} />
        <span className="cv2-skel" style={{ width: '75%', marginTop: 8 }} />
        <span className="cv2-skel" style={{ width: '60%', marginTop: 8 }} />
      </div>
    </div>
  );
}
