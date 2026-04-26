import Link from 'next/link';

interface SiteHeaderProps {
    compact?: boolean;
}

export function SiteHeader({ compact = false }: SiteHeaderProps) {
    const shellClass = compact
        ? 'mx-auto flex w-full max-w-[1040px] flex-wrap items-center gap-2 rounded-[22px] border border-[#22170f0f] bg-white px-2.5 py-2 shadow-[0_18px_42px_rgba(54,33,18,0.08)] sm:px-3 md:flex-nowrap'
        : 'mx-auto flex w-full max-w-[1080px] flex-wrap items-center gap-2 rounded-[24px] border border-[#22170f0f] bg-white px-2.5 py-2 shadow-[0_20px_46px_rgba(54,33,18,0.08)] sm:px-3 md:flex-nowrap';
    const brandMarkClass = compact
        ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[linear-gradient(145deg,#d9602f,#92260f)] text-sm font-black text-white shadow-[0_10px_20px_rgba(146,38,15,0.2)]'
        : 'flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[linear-gradient(145deg,#d9602f,#92260f)] text-sm font-black text-white shadow-[0_12px_22px_rgba(146,38,15,0.2)]';
    const navLinkClass =
        'rounded-full px-3 py-2 text-[13px] font-bold text-[#5f4a3c] transition hover:bg-white/80 hover:text-[#22170f]';
    const buttonBaseClass =
        'inline-flex items-center justify-center rounded-full border px-3 py-2 text-[13px] font-bold transition duration-200 sm:px-4';

    return (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-50 px-2 sm:top-4 sm:px-4">
            <header className={shellClass}>
                <Link href="/" className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2.5 rounded-full px-2 py-1 sm:gap-3 md:flex-none">
                    <span className={brandMarkClass}>R</span>
                    <span className="grid min-w-0 gap-0.5">
                        <strong className="truncate text-[15px] font-extrabold text-[#22170f]">RedBox</strong>
                        <small className="hidden truncate text-[11px] text-[#6d5a4f] sm:block">自媒体 AI 全能工作台</small>
                    </span>
                </Link>

                <nav
                    className="pointer-events-auto order-3 flex w-full flex-nowrap justify-between gap-1 overflow-x-auto px-1 pt-1 md:order-none md:w-auto md:shrink-0 md:justify-center md:pt-0 [&::-webkit-scrollbar]:hidden"
                    aria-label="站点导航"
                >
                    <Link href="/#capabilities" className={navLinkClass}>
                        功能
                    </Link>
                    <Link href="/#pricing" className={navLinkClass}>
                        数据
                    </Link>
                    <Link href="/download" className={navLinkClass}>
                        下载
                    </Link>
                </nav>

                <div className="pointer-events-auto ml-auto flex shrink-0 items-center justify-end gap-1.5 sm:gap-2 md:flex-none md:basis-auto">
                    <a
                        href="https://github.com/Jamailar/RedBox"
                        target="_blank"
                        rel="noreferrer"
                        className={`${buttonBaseClass} hidden border-white/55 bg-white/45 text-[#22170f] shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] hover:bg-white/82 sm:inline-flex`}
                    >
                        GitHub
                    </a>
                    <Link
                        href="/account"
                        className={`${buttonBaseClass} border-transparent bg-[linear-gradient(135deg,#df6031,#b13012_65%,#881d08)] text-white shadow-[0_10px_22px_rgba(177,48,18,0.24)] hover:translate-y-[-1px]`}
                    >
                        登录
                    </Link>
                </div>
            </header>
        </div>
    );
}
