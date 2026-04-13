import {
  getGhostHighlightClasses,
  getGhostPreviewItemClasses,
  type TimelineGhostPreviewType,
} from '../utils/drag-drop-preview';

interface TimelineDropGhostPreview {
  left: number;
  width: number;
  label: string;
  type: TimelineGhostPreviewType;
}

interface TimelineDropGhostPreviewsProps<
  TGhostPreview extends TimelineDropGhostPreview = TimelineDropGhostPreview,
> {
  ghostPreviews: TGhostPreview[];
  showEmptyOverlay: boolean;
  variant: 'track' | 'zone';
}

export function TimelineDropGhostPreviews<
  TGhostPreview extends TimelineDropGhostPreview,
>({
  ghostPreviews,
  showEmptyOverlay,
  variant,
}: TimelineDropGhostPreviewsProps<TGhostPreview>) {
  const hasGhostPreviews = ghostPreviews.length > 0;
  const labelClassName = variant === 'track'
    ? 'text-xs text-foreground/70 truncate'
    : 'truncate text-[10px] font-medium text-foreground/80';

  return (
    <>
      {showEmptyOverlay && (
        <div className="absolute inset-0 pointer-events-none z-10 rounded border border-dashed border-primary/50 bg-primary/10" />
      )}

      {hasGhostPreviews && (
        <div
          className={`absolute inset-0 pointer-events-none z-10 rounded border border-dashed ${getGhostHighlightClasses(ghostPreviews)}`}
        />
      )}

      {ghostPreviews.map((ghost, index) => (
        <div
          key={`${ghost.label}-${index}`}
          className={`absolute rounded border-2 border-dashed pointer-events-none z-20 flex items-center px-2 ${getGhostPreviewItemClasses(ghost.type)} ${variant === 'track' ? 'inset-y-0' : ''}`}
          style={{
            left: `${ghost.left}px`,
            width: `${ghost.width}px`,
            ...(variant === 'zone'
              ? {
                top: 0,
                height: '100%',
              }
              : {}),
          }}
        >
          <span className={labelClassName}>{ghost.label}</span>
        </div>
      ))}
    </>
  );
}
