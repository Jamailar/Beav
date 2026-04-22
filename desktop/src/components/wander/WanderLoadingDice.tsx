import type { CSSProperties } from 'react';
import { clsx } from 'clsx';

interface WanderLoadingDiceProps {
  className?: string;
  size?: number;
}

const FACE_PIPS: Record<number, Array<[number, number]>> = {
  1: [[50, 50]],
  2: [[30, 30], [70, 70]],
  3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]],
};

const FACE_LAYOUTS = [
  { value: 1, transform: (depth: number) => `translateZ(${depth}px)` },
  { value: 2, transform: (depth: number) => `rotateY(180deg) translateZ(${depth}px)` },
  { value: 3, transform: (depth: number) => `rotateY(90deg) translateZ(${depth}px)` },
  { value: 4, transform: (depth: number) => `rotateY(-90deg) translateZ(${depth}px)` },
  { value: 5, transform: (depth: number) => `rotateX(90deg) translateZ(${depth}px)` },
  { value: 6, transform: (depth: number) => `rotateX(-90deg) translateZ(${depth}px)` },
];

export function WanderLoadingDice({ className, size = 92 }: WanderLoadingDiceProps) {
  const depth = Math.round(size / 2);
  const pipSize = Math.max(8, Math.round(size * 0.14));
  const haloSize = Math.round(size * 1.42);
  const shadowWidth = Math.round(size * 1.02);
  const shadowHeight = Math.max(12, Math.round(size * 0.22));
  const sparkBase = Math.max(6, Math.round(size * 0.1));
  const frameStyle: CSSProperties = {
    width: Math.round(size * 1.9),
    height: Math.round(size * 1.7),
  };

  return (
    <div
      aria-hidden="true"
      className={clsx('relative flex items-center justify-center', className)}
      style={frameStyle}
    >
      <div
        className="wander-loading-dice__halo absolute rounded-full bg-accent-primary/14 blur-[30px]"
        style={{ width: haloSize, height: haloSize }}
      />
      <div
        className="wander-loading-dice__shadow absolute bottom-2 rounded-full bg-black/[0.12] blur-md"
        style={{ width: shadowWidth, height: shadowHeight }}
      />

      <div className="wander-loading-dice__float relative flex items-center justify-center [transform-style:preserve-3d]">
        <div
          className="wander-loading-dice__cube relative [transform-style:preserve-3d]"
          style={{ width: size, height: size }}
        >
          {FACE_LAYOUTS.map(({ value, transform }) => (
            <div
              key={value}
              className="wander-loading-dice__face absolute inset-0 overflow-hidden rounded-[26px] border border-white/85 bg-white/90 shadow-[0_18px_44px_-22px_rgba(15,23,42,0.3),inset_0_1px_0_rgba(255,255,255,0.8)]"
              style={{ transform: transform(depth) }}
            >
              <div className="absolute inset-[1px] rounded-[24px] bg-[linear-gradient(145deg,rgba(255,255,255,0.98)_0%,rgba(249,250,252,0.98)_45%,rgba(234,238,243,0.95)_100%)]" />
              <div className="absolute inset-x-3 top-2 h-4 rounded-full bg-white/70 blur-sm" />
              {FACE_PIPS[value].map(([left, top], index) => (
                <span
                  key={`${value}-${index}`}
                  className="absolute rounded-full bg-text-primary/80 shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_1px_2px_rgba(15,23,42,0.12)]"
                  style={{
                    width: pipSize,
                    height: pipSize,
                    left: `${left}%`,
                    top: `${top}%`,
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div
        className="wander-loading-dice__spark wander-loading-dice__spark--a absolute rounded-full bg-accent-primary/65 blur-[1px]"
        style={{ left: Math.round(size * 0.24), top: Math.round(size * 0.18), width: sparkBase, height: sparkBase }}
      />
      <div
        className="wander-loading-dice__spark wander-loading-dice__spark--b absolute rounded-full bg-sky-400/60 blur-[1px]"
        style={{ right: Math.round(size * 0.2), top: Math.round(size * 0.3), width: sparkBase + 2, height: sparkBase + 2 }}
      />
      <div
        className="wander-loading-dice__spark wander-loading-dice__spark--c absolute rounded-full bg-amber-400/70 blur-[1px]"
        style={{ right: Math.round(size * 0.33), bottom: Math.round(size * 0.22), width: Math.max(5, sparkBase - 1), height: Math.max(5, sparkBase - 1) }}
      />
    </div>
  );
}
