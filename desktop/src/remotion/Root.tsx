import React from 'react';
import { Composition } from 'remotion';
import { VideoMotionComposition } from '../components/manuscripts/remotion/VideoMotionComposition';
import type { RemotionCompositionConfig } from '../components/manuscripts/remotion/types';

const DEFAULT_COMPOSITION: RemotionCompositionConfig = {
    version: 1,
    title: 'RedBox Motion',
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 180,
    backgroundColor: '#05070b',
    scenes: [],
};

export const RemotionRoot: React.FC = () => {
    return (
        <Composition
            id="RedBoxVideoMotion"
            component={VideoMotionComposition}
            width={DEFAULT_COMPOSITION.width}
            height={DEFAULT_COMPOSITION.height}
            fps={DEFAULT_COMPOSITION.fps}
            durationInFrames={DEFAULT_COMPOSITION.durationInFrames}
            defaultProps={{
                composition: DEFAULT_COMPOSITION,
                runtime: 'render',
            }}
            calculateMetadata={({ props }) => {
                const composition = (props as { composition?: RemotionCompositionConfig }).composition || DEFAULT_COMPOSITION;
                return {
                    width: composition.width,
                    height: composition.height,
                    fps: composition.fps,
                    durationInFrames: composition.durationInFrames,
                    props: {
                        ...props,
                        composition,
                    },
                };
            }}
        />
    );
};
