import { getMarqueeRect, type MarqueeState } from '@/hooks/use-marquee-selection';

interface MarqueeOverlayProps {
  /** Current marquee state */
  marqueeState: MarqueeState;

  /** Custom className for styling */
  className?: string;
}

/**
 * Visual overlay for marquee selection rectangle
 *
 * Renders a draggable selection box that appears when the user
 * click-drags to select multiple items.
 *
 * @example
 * ```tsx
 * const { marqueeState } = useMarqueeSelection({ ... });
 *
 * return (
 *   <div className="relative">
 *     <MarqueeOverlay marqueeState={marqueeState} />
 *     {items.map(item => <Item key={item.id} />)}
 *   </div>
 * );
 * ```
 */
export function MarqueeOverlay({ marqueeState, className }: MarqueeOverlayProps) {
  if (!marqueeState.active) return null;

  const rect = getMarqueeRect(
    marqueeState.startX,
    marqueeState.startY,
    marqueeState.currentX,
    marqueeState.currentY
  );

  return (
    <div
      className={`
        absolute pointer-events-none z-50
        border-2 border-dashed border-primary bg-primary/10
        ${className || ''}
      `}
      style={{
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    />
  );
}
