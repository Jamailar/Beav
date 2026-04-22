import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClipIndicators } from './clip-indicators';

describe('ClipIndicators', () => {
  it('shows a speed badge when playback speed differs from 1x', () => {
    render(
      <ClipIndicators
        hasKeyframes={false}
        currentSpeed={1.25}
        isStretching={false}
        stretchFeedback={null}
        isBroken={false}
        hasMediaId
        isMask={false}
        isShape={false}
      />
    );

    expect(screen.getByTitle('Speed: 1.25x')).toBeInTheDocument();
  });
});
