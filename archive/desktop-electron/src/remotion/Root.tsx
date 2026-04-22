import React from 'react';
import { Composition } from 'remotion';
import { VideoMotionComposition } from '../components/manuscripts/remotion/VideoMotionComposition';
import type { RemotionCompositionConfig } from '../components/manuscripts/remotion/types';

export const REDBOX_REMOTION_COMPOSITION_ID = 'RedBoxVideoMotion';

const DEFAULT_COMPOSITION: RemotionCompositionConfig = {
    version: 1,
    title: 'RedBox Motion',
    entryCompositionId: REDBOX_REMOTION_COMPOSITION_ID,
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
            id={REDBOX_REMOTION_COMPOSITION_ID}
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
                const renderMode = composition.renderMode === 'motion-layer' ? 'motion-layer' : 'full';
                const requestedRender = composition.render || {};
                const defaultCodec = typeof requestedRender.codec === 'string'
                    ? requestedRender.codec
                    : (renderMode === 'motion-layer' ? 'prores' : 'h264');
                const defaultVideoImageFormat = requestedRender.imageFormat === 'png' || requestedRender.imageFormat === 'jpeg'
                    ? requestedRender.imageFormat
                    : (defaultCodec === 'prores' ? 'png' : 'jpeg');
                const defaultPixelFormat = defaultCodec === 'prores'
                    ? (typeof requestedRender.pixelFormat === 'string' ? requestedRender.pixelFormat : 'yuva444p10le')
                    : undefined;
                const defaultProResProfile = defaultCodec === 'prores'
                    ? (typeof requestedRender.proResProfile === 'string' ? requestedRender.proResProfile : '4444')
                    : undefined;
                const defaultOutName = typeof requestedRender.defaultOutName === 'string' && requestedRender.defaultOutName.trim()
                    ? requestedRender.defaultOutName.trim()
                    : String(
                        (composition.title || 'redbox-motion')
                            .trim()
                            .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
                            .replace(/-+/g, '-')
                            .replace(/^-|-$/g, '')
                            || 'redbox-motion',
                    );
                return {
                    width: composition.width,
                    height: composition.height,
                    fps: composition.fps,
                    durationInFrames: composition.durationInFrames,
                    defaultCodec,
                    defaultVideoImageFormat,
                    defaultPixelFormat,
                    defaultProResProfile,
                    defaultOutName,
                    props: {
                        ...props,
                        composition,
                    },
                };
            }}
        />
    );
};
