import { useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';

type AudioWaveformPreviewProps = {
    src?: string | null;
};

export function AudioWaveformPreview({ src }: AudioWaveformPreviewProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!containerRef.current || !src) return;
        const waveSurfer = WaveSurfer.create({
            container: containerRef.current,
            url: src,
            height: 132,
            normalize: true,
            autoScroll: true,
            minPxPerSec: 48,
            waveColor: 'rgba(255,255,255,0.16)',
            progressColor: 'rgba(16,185,129,0.88)',
            cursorColor: 'rgba(255,255,255,0.68)',
            barWidth: 3,
            barGap: 2,
            barRadius: 3,
            dragToSeek: true,
        });
        return () => {
            waveSurfer.destroy();
        };
    }, [src]);

    return (
        <div className="rounded-[24px] border border-white/10 bg-[#1b1b1b] px-4 py-4">
            {src ? (
                <div ref={containerRef} className="w-full overflow-hidden" />
            ) : (
                <div className="flex h-[132px] items-center justify-center text-sm text-white/45">
                    还没有可预览的音频波形
                </div>
            )}
        </div>
    );
}
