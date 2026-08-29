// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EntityNavigationMetrics } from './EntityNavigationMetrics';

describe('EntityNavigationMetrics', () => {
  it('preserves honest paginated totals and an explicit zero-live state', () => {
    const { getByLabelText, getByText } = render(
      <div className="cv2-root">
        <EntityNavigationMetrics
          total="601+"
          live={0}
          showZeroLive
          liveAnnouncement="No live entities"
        />
      </div>,
    );

    expect(getByLabelText('601+ total, No live entities')).toBeTruthy();
    expect(getByText('601+')).toBeTruthy();
    expect(getByText('0')).toBeTruthy();
    expect(getByText('live')).toBeTruthy();
  });

  it('keeps a quiet zero absent when a navigation surface does not request it', () => {
    const { container } = render(<EntityNavigationMetrics live={0} />);
    expect(container.firstChild).toBeNull();
  });
});
