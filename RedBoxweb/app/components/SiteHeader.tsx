'use client';

import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const LiquidGlass = dynamic(() => import('liquid-glass-react'), {
    ssr: false,
});

interface SiteHeaderProps {
    compact?: boolean;
}

export function SiteHeader({ compact = false }: SiteHeaderProps) {
    const [mounted, setMounted] = useState(false);
    const headerFrameRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        setMounted(true);
    }, []);

    const frameClass = compact
        ? 'mx-auto h-[104px] w-full max-w-[1040px] md:h-[60px]'
        : 'mx-auto h-[108px] w-full max-w-[1080px] md:h-[64px]';
    const shellClass = compact
        ? 'grid w-full grid-cols-[1fr_auto] items-center gap-2 rounded-[30px] px-2.5 py-2 sm:px-3 md:grid-cols-[1fr_auto_1fr]'
        : 'grid w-full grid-cols-[1fr_auto] items-center gap-2 rounded-[34px] px-2.5 py-2 sm:px-3 md:grid-cols-[1fr_auto_1fr]';
    const brandMarkClass = compact
        ? 'relative flex h-10 w-10 shrink-0 items-center justify-center'
        : 'relative flex h-11 w-11 shrink-0 items-center justify-center';
    const navLinkClass =
        'rounded-full border border-transparent px-3 py-2 text-[13px] font-bold !text-[#22170f] transition duration-200 hover:border-white/65 hover:bg-white/38 hover:!text-[#22170f] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_8px_22px_rgba(87,56,45,0.1)] hover:backdrop-blur-xl';
    const buttonBaseClass =
        'inline-flex items-center justify-center rounded-full border px-3 py-2 text-[13px] font-bold transition duration-200 sm:px-4';

    const headerContent = (
        <header className={shellClass}>
            <Link href="/" className="pointer-events-auto flex min-w-0 items-center gap-2.5 justify-self-start rounded-full px-2 py-1 sm:gap-3">
                <span className={brandMarkClass}>
                    <Image
                        src="/redbox.png"
                        alt="RedBox"
                        width={88}
                        height={88}
                        className="h-full w-full object-contain"
                        priority
                    />
                </span>
                <span className="grid min-w-0 gap-0.5">
                    <strong className="truncate text-[15px] font-extrabold text-[#22170f]">RedBox</strong>
                    <small className="hidden truncate text-[11px] text-[#6d5a4f] sm:block">自媒体 AI 全能工作台</small>
                </span>
            </Link>

            <nav
                className="pointer-events-auto col-span-2 row-start-2 flex w-full flex-nowrap justify-center gap-3 overflow-x-auto px-1 pt-1 md:col-span-1 md:row-start-auto md:w-auto md:justify-self-center md:pt-0 [&::-webkit-scrollbar]:hidden"
                aria-label="站点导航"
            >
                <Link href="/#capabilities" className={navLinkClass}>
                    功能
                </Link>
                <Link href="/changelog" className={navLinkClass}>
                    更新日志
                </Link>
                <Link href="/download" className={navLinkClass}>
                    下载
                </Link>
            </nav>

            <div className="pointer-events-auto flex shrink-0 items-center justify-end gap-1.5 justify-self-end sm:gap-2">
                <a
                    href="https://github.com/Jamailar/RedBox"
                    target="_blank"
                    rel="noreferrer"
                    className={`${buttonBaseClass} border-transparent bg-[linear-gradient(135deg,#d7441f,#a9270f_68%,#771705)] !text-white shadow-[0_5px_12px_rgba(177,48,18,0.14)] hover:translate-y-[-1px] hover:!text-white`}
                >
                    GitHub
                </a>
            </div>
        </header>
    );

    return (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-50 px-2 sm:top-4 sm:px-4">
            <div ref={headerFrameRef} className={`relative ${frameClass}`}>
                {mounted ? (
                    <LiquidGlass
                        className="redbox-liquid-header pointer-events-auto w-full"
                        style={{ position: 'absolute', top: '50%', left: '50%', width: '100%' }}
                        padding="0"
                        cornerRadius={compact ? 30 : 34}
                        displacementScale={48}
                        blurAmount={0.1}
                        saturation={145}
                        aberrationIntensity={1.05}
                        elasticity={0.045}
                        mouseContainer={headerFrameRef}
                        mode="shader"
                        overLight
                    >
                        {headerContent}
                    </LiquidGlass>
                ) : (
                    <div className="pointer-events-auto absolute left-1/2 top-1/2 w-full -translate-x-1/2 -translate-y-1/2">
                        {headerContent}
                    </div>
                )}
            </div>
        </div>
    );
}
