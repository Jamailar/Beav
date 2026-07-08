import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Link2 } from 'lucide-react';
import { clsx } from 'clsx';
import {
  clipboardCapturePlatformLabel,
  detectClipboardCaptureCandidate,
} from '../../features/capture/clipboardDetector';
import type { ClipboardCaptureCandidate, ClipboardCapturePlatform } from '../../features/capture/captureTypes';

const PROFILE_CAPTURE_KINDS = new Set([
  'xhs-profile',
  'douyin-profile',
  'bilibili-profile',
  'tiktok-profile',
  'youtube-channel',
]);

interface SupportedHomepagePlatform {
  id: ClipboardCapturePlatform;
  name: string;
  icon: ReactNode;
}

const SUPPORTED_HOMEPAGE_PLATFORMS: SupportedHomepagePlatform[] = [
  {
    id: 'xiaohongshu',
    name: '小红书',
    icon: <img src="/ecommerce-platform-icons/xiaohongshu-shop.svg" alt="" className="h-5 w-5 object-contain" />,
  },
  {
    id: 'douyin',
    name: '抖音',
    icon: <img src="/ecommerce-platform-icons/douyin-shop.png" alt="" className="h-5 w-5 object-contain" />,
  },
  {
    id: 'bilibili',
    name: 'Bilibili',
    icon: <img src="/platform-icons/bilibili.svg" alt="" className="h-5 w-5 object-contain" />,
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    icon: <img src="/platform-icons/tiktok.svg" alt="" className="h-5 w-5 object-contain" />,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    icon: <img src="/platform-icons/youtube.svg" alt="" className="h-5 w-5 object-contain" />,
  },
];

interface ChatInlineHomepageInputProps {
  placeholder?: string;
  submitLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  onSubmit: (payload: { url: string; candidate: ClipboardCaptureCandidate }) => void;
}

function normalizeCandidate(value: string): ClipboardCaptureCandidate | null {
  const candidate = detectClipboardCaptureCandidate(value, 'paste');
  if (!candidate || !PROFILE_CAPTURE_KINDS.has(candidate.kind)) return null;
  return candidate;
}

export function ChatInlineHomepageInput({
  placeholder = 'https://www.xiaohongshu.com/user/profile/...',
  submitLabel = '开始采集',
  disabled = false,
  autoFocus = false,
  className,
  onSubmit,
}: ChatInlineHomepageInputProps) {
  const [value, setValue] = useState('');
  const trimmedValue = value.trim();
  const candidate = useMemo(() => normalizeCandidate(trimmedValue), [trimmedValue]);
  const canSubmit = Boolean(candidate) && !disabled;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!candidate || disabled) return;
    onSubmit({ url: candidate.canonicalUrl || trimmedValue, candidate });
  };

  return (
    <div className={clsx('w-full max-w-[680px] space-y-4', className)}>
      <div className="flex flex-wrap items-center gap-4 px-1">
        {SUPPORTED_HOMEPAGE_PLATFORMS.map((platform) => {
          const active = candidate?.platform === platform.id;
          return (
            <span
              key={platform.id}
              title={platform.name}
              aria-label={platform.name}
              className={clsx(
                'inline-flex h-8 w-8 items-center justify-center rounded-xl transition-all duration-200',
                active
                  ? 'scale-105 bg-accent-primary/10 text-text-primary shadow-[0_10px_26px_rgb(var(--color-accent-primary)/0.18)] ring-1 ring-accent-primary/35'
                  : 'text-text-secondary opacity-80 hover:-translate-y-0.5 hover:bg-surface-primary/80 hover:text-text-primary hover:opacity-100 hover:shadow-[0_10px_24px_rgb(var(--color-accent-primary)/0.12)]',
              )}
            >
              {platform.icon}
            </span>
          );
        })}
      </div>

      <form
        onSubmit={handleSubmit}
        className={clsx(
          'group relative overflow-hidden rounded-[22px] border border-accent-primary/20 bg-surface-primary/85 p-2 shadow-[0_14px_40px_rgb(68_51_36/0.10)] transition-all duration-300 hover:-translate-y-0.5 hover:border-accent-primary/45 hover:shadow-[0_22px_58px_rgb(var(--color-accent-primary)/0.18)] focus-within:-translate-y-0.5 focus-within:border-accent-primary/60 focus-within:bg-surface-primary focus-within:shadow-[0_22px_58px_rgb(var(--color-accent-primary)/0.20)]',
          disabled && 'opacity-50',
        )}
      >
        <div className="pointer-events-none absolute -inset-8 rounded-[30px] bg-[radial-gradient(circle_at_82%_50%,rgb(var(--color-accent-primary)/0.26),transparent_42%),radial-gradient(circle_at_18%_50%,rgb(var(--color-status-success)/0.16),transparent_38%)] opacity-0 blur-2xl transition-opacity duration-500 group-hover:animate-pulse group-hover:opacity-100 group-focus-within:animate-pulse group-focus-within:opacity-100" />
        <div className="relative flex items-center gap-2">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={disabled}
            autoFocus={autoFocus}
            inputMode="url"
            className="h-12 min-w-0 flex-1 rounded-2xl border border-transparent bg-white/35 px-4 text-sm font-semibold text-text-primary outline-none transition-colors placeholder:text-text-tertiary disabled:cursor-not-allowed"
            placeholder={placeholder}
          />
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-12 shrink-0 items-center gap-2 rounded-2xl bg-accent-primary px-5 text-sm font-bold text-white shadow-[0_12px_28px_rgb(var(--color-accent-primary)/0.28)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent-primary/95 hover:shadow-[0_16px_36px_rgb(var(--color-accent-primary)/0.36)] disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-surface-secondary disabled:text-text-tertiary disabled:shadow-none"
            aria-label={submitLabel}
          >
            <span>{submitLabel}</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>

        {trimmedValue ? (
          <div className="relative mt-2 flex items-center justify-between gap-3 rounded-2xl border border-border/50 bg-surface-secondary/35 px-3 py-2">
            {candidate ? (
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-primary/90 shadow-sm">
                    {SUPPORTED_HOMEPAGE_PLATFORMS.find((platform) => platform.id === candidate.platform)?.icon || <Link2 className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-text-primary">{clipboardCapturePlatformLabel(candidate)}</div>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-xs text-text-tertiary">
                <Link2 className="h-3.5 w-3.5" />
                暂未识别支持的平台主页
              </div>
            )}
          </div>
        ) : null}
      </form>
    </div>
  );
}
