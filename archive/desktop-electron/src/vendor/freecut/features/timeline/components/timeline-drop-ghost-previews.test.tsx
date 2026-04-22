import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TimelineDropGhostPreviews } from './timeline-drop-ghost-previews';

describe('TimelineDropGhostPreviews', () => {
  it('renders the empty overlay when requested', () => {
    const { container } = render(
      <TimelineDropGhostPreviews
        ghostPreviews={[]}
        showEmptyOverlay
        variant="track"
      />
    );

    expect(container.querySelector('.border-primary\\/50')).not.toBeNull();
  });

  it('renders track ghost previews with track-specific classes', () => {
    render(
      <TimelineDropGhostPreviews
        ghostPreviews={[
          { left: 12, width: 48, label: 'Drop media', type: 'external-file' },
        ]}
        showEmptyOverlay={false}
        variant="track"
      />
    );

    const ghost = screen.getByText('Drop media').parentElement;
    expect(ghost?.className).toContain('inset-y-0');
    expect(ghost?.className).toContain('border-orange-500');
    expect(ghost).toHaveStyle({ left: '12px', width: '48px' });
  });

  it('renders zone ghost previews with full-height styling', () => {
    render(
      <TimelineDropGhostPreviews
        ghostPreviews={[
          { left: 20, width: 80, label: 'Clip', type: 'video' },
        ]}
        showEmptyOverlay={false}
        variant="zone"
      />
    );

    const ghost = screen.getByText('Clip').parentElement;
    expect(ghost?.className).not.toContain('inset-y-0');
    expect(ghost).toHaveStyle({ left: '20px', width: '80px', top: '0px', height: '100%' });
  });
});
