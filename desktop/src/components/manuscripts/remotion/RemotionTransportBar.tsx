import clsx from 'clsx';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';

function formatTime(timeInSeconds: number) {
    const safe = Number.isFinite(timeInSeconds) ? Math.max(0, timeInSeconds) : 0;
    const minutes = Math.floor(safe / 60);
    const seconds = Math.floor(safe - minutes * 60);
    return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

interface RemotionTransportBarProps {
    fps: number;
    durationInFrames: number;
    currentFrame: number;
    playing: boolean;
    onTogglePlayback: () => void;
    onSeekFrame: (frame: number) => void;
    onStepFrame: (delta: number) => void;
    disabled?: boolean;
}

export function RemotionTransportBar({
    fps,
    durationInFrames,
    currentFrame,
    playing,
    onTogglePlayback,
    onSeekFrame,
    onStepFrame,
    disabled = false,
}: RemotionTransportBarProps) {
    const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
    const maxFrame = Math.max(0, durationInFrames - 1);
    const boundedFrame = Math.min(Math.max(0, currentFrame), maxFrame);
    const currentSeconds = boundedFrame / safeFps;
    const totalSeconds = durationInFrames / safeFps;

    return (
        <div className="rounded-[18px] border border-white/10 bg-black/35 px-4 py-3 text-white shadow-[0_12px_30px_rgba(0,0,0,0.2)] backdrop-blur-sm">
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => onStepFrame(-safeFps)}
                    disabled={disabled}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-white/80 transition hover:border-cyan-300/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                    title="后退 1 秒"
                >
                    <SkipBack className="h-4 w-4" />
                </button>
                <button
                    type="button"
                    onClick={onTogglePlayback}
                    disabled={disabled}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-cyan-300/35 bg-cyan-400/15 text-cyan-100 transition hover:border-cyan-200/55 hover:bg-cyan-400/25 disabled:cursor-not-allowed disabled:opacity-35"
                    title={playing ? '暂停' : '播放'}
                >
                    {playing ? <Pause className="h-4.5 w-4.5" /> : <Play className="ml-0.5 h-4.5 w-4.5" />}
                </button>
                <button
                    type="button"
                    onClick={() => onStepFrame(safeFps)}
                    disabled={disabled}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-white/80 transition hover:border-cyan-300/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                    title="前进 1 秒"
                >
                    <SkipForward className="h-4 w-4" />
                </button>

                <div className="min-w-[92px] text-sm font-medium tabular-nums text-white/90">
                    {formatTime(currentSeconds)} / {formatTime(totalSeconds)}
                </div>

                <div className="flex-1">
                    <input
                        type="range"
                        min={0}
                        max={Math.max(1, maxFrame)}
                        value={boundedFrame}
                        disabled={disabled || maxFrame <= 0}
                        onChange={(event) => onSeekFrame(Number(event.target.value || 0))}
                        className={clsx(
                            'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-cyan-300',
                            (disabled || maxFrame <= 0) && 'cursor-not-allowed opacity-40'
                        )}
                    />
                </div>

                <div className="min-w-[96px] text-right text-[11px] uppercase tracking-[0.18em] text-white/45">
                    {durationInFrames}f @ {safeFps}fps
                </div>
            </div>
        </div>
    );
}
