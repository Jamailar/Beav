import { Player } from '@remotion/player';
import React from 'react';
import { VideoMotionComposition } from './VideoMotionComposition';
import type { RemotionCompositionConfig } from './types';

export function RemotionVideoPreview({
    composition,
}: {
    composition: RemotionCompositionConfig;
}) {
    return (
        <div className="h-full w-full bg-[#0f1013]">
            <Player
                component={VideoMotionComposition as unknown as React.ComponentType<Record<string, unknown>>}
                durationInFrames={composition.durationInFrames}
                compositionWidth={composition.width}
                compositionHeight={composition.height}
                fps={composition.fps}
                controls
                loop
                autoPlay={false}
                style={{
                    width: '100%',
                    height: '100%',
                }}
                inputProps={{
                    composition,
                    runtime: 'preview',
                }}
            />
        </div>
    );
}
