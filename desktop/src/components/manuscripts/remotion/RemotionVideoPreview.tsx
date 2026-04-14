import { Player, type PlayerRef } from '@remotion/player';
import React, { useMemo } from 'react';
import { VideoMotionComposition } from './VideoMotionComposition';
import type { RemotionCompositionConfig } from './types';

function RemotionVideoPreviewInner({
    composition,
    playerRef,
}: {
    composition: RemotionCompositionConfig;
    playerRef?: React.RefObject<PlayerRef | null>;
}) {
    const inputProps = useMemo(() => ({
        composition,
        runtime: 'preview' as const,
    }), [composition]);

    return (
        <div className="h-full w-full bg-[#0f1013]">
            <Player
                ref={playerRef}
                component={VideoMotionComposition as unknown as React.ComponentType<Record<string, unknown>>}
                durationInFrames={composition.durationInFrames}
                compositionWidth={composition.width}
                compositionHeight={composition.height}
                fps={composition.fps}
                controls={false}
                loop={false}
                autoPlay={false}
                style={{
                    width: '100%',
                    height: '100%',
                }}
                inputProps={inputProps}
            />
        </div>
    );
}

export const RemotionVideoPreview = React.memo(RemotionVideoPreviewInner, (prevProps, nextProps) => (
    prevProps.composition === nextProps.composition
    && prevProps.playerRef === nextProps.playerRef
));
