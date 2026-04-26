import Image from 'next/image';
import {
    Bot,
    BookOpen,
    Code2,
    GitFork,
    Github,
    PencilLine,
    Star,
    UsersRound,
} from 'lucide-react';
import { SiteHeader } from './components/SiteHeader';

export const dynamic = 'force-dynamic';

const featureCards = [
    {
        title: '知识库管理',
        summary: '轻松导入和管理各类知识资源，构建专属知识库，为 AI 创作提供坚实基础。',
        icon: BookOpen,
    },
    {
        title: 'AI 创作',
        summary: '基于大模型能力，支持多种内容生成场景，快速生成高质量文章、报告、文案等内容。',
        icon: PencilLine,
    },
    {
        title: '多 Agents 协作',
        summary: '支持多个智能体协同工作，分工合作，各展所长，复杂任务也能轻松应对。',
        icon: UsersRound,
    },
    {
        title: '角色蒸馏',
        summary: '将优秀角色的能力蒸馏到你的自有角色中，打造更符合你需求的专属 AI 助手。',
        icon: Bot,
    },
];

const stats = [
    {
        value: '10k+',
        label: 'GitHub Stars',
        icon: Star,
        filled: true,
    },
    {
        value: '2k+',
        label: 'GitHub Forks',
        icon: GitFork,
        filled: false,
    },
    {
        value: '5k+',
        label: '活跃用户',
        icon: UsersRound,
        filled: false,
    },
    {
        value: '持续更新',
        label: '快速迭代，持续优化',
        icon: Code2,
        filled: false,
    },
];

export default function HomePage() {
    return (
        <main id="top" className="min-h-screen bg-white text-[#171b22]">
            <SiteHeader />

            <section className="relative overflow-hidden px-5 pb-8 pt-40 sm:px-8 sm:pt-36 lg:px-12 lg:pb-0 lg:pt-28">
                <div className="absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(circle_at_83%_41%,rgba(221,39,51,0.17),transparent_36%),radial-gradient(circle_at_9%_8%,rgba(221,39,51,0.08),transparent_26%)]" />
                <div className="relative mx-auto grid w-full max-w-[1180px] items-center gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:gap-8">
                    <div className="max-w-[650px] py-1 lg:py-10">
                        <h1 className="text-5xl font-black leading-none text-[#d51f2d] sm:text-7xl lg:text-8xl">
                            RedBox
                        </h1>
                        <p className="mt-5 text-2xl font-black leading-tight text-[#222830] sm:mt-6 sm:text-4xl xl:text-5xl">
                            用 <span className="text-[#d51f2d]">AI</span> 创作高质量内容
                        </p>
                        <p className="mt-5 max-w-[600px] text-[15px] leading-7 text-[#5f6874] sm:mt-6 sm:text-lg sm:leading-8">
                            RedBox 是一款新一代 AI 内容创作平台，集知识管理、智能创作、多智能体协作与角色蒸馏于一体，助你高效创作，激发无限灵感。
                        </p>

                        <div className="mt-7 flex flex-wrap items-center gap-3 sm:mt-8 sm:gap-4">
                            <a
                                href="/download"
                                className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#d51f2d] px-7 text-base font-bold text-white shadow-[0_14px_30px_rgba(213,31,45,0.22)] transition hover:bg-[#bd1725] sm:h-12 sm:w-auto sm:px-8"
                            >
                                立即体验
                            </a>
                            <a
                                href="https://github.com/Jamailar/RedBox"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#e5e7eb] bg-white px-7 text-base font-semibold text-[#222830] shadow-[0_10px_24px_rgba(17,24,39,0.08)] transition hover:border-[#d51f2d]/40 hover:text-[#d51f2d] sm:h-12 sm:w-auto"
                            >
                                <Github className="h-5 w-5" />
                                在 GitHub 上查看
                            </a>
                        </div>

                        <p className="mt-7 flex items-center gap-2 text-sm text-[#6b7280]">
                            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[#d5dbe3] text-[11px] font-bold text-[#7a8491]">
                                M
                            </span>
                            开源项目 · MIT License
                        </p>
                    </div>

                    <div className="relative min-h-[245px] sm:min-h-[320px] lg:min-h-[470px]">
                        <FloatingCube className="left-[8%] top-[43%] h-10 w-10 opacity-70 blur-[0.2px] sm:h-16 sm:w-16" />
                        <FloatingCube className="left-[23%] top-[5%] h-8 w-8 opacity-50 blur-[1px] sm:h-11 sm:w-11" />
                        <FloatingCube className="right-[1%] top-[15%] h-9 w-9 opacity-48 blur-[1px] sm:h-12 sm:w-12" />
                        <FloatingCube className="right-[9%] bottom-[22%] h-10 w-10 opacity-58 blur-[0.2px] sm:h-16 sm:w-16" />
                        <div className="absolute inset-x-0 bottom-0 mx-auto h-[46%] max-w-[680px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(213,31,45,0.28),transparent_68%)] blur-2xl" />
                        <div className="relative mx-auto flex h-full max-w-[720px] items-center justify-center">
                            <Image
                                src="/Box.png"
                                alt="RedBox 产品视觉"
                                width={660}
                                height={660}
                                priority
                                className="h-auto w-full max-w-[330px] drop-shadow-[0_34px_42px_rgba(145,18,28,0.22)] sm:max-w-[480px] lg:max-w-[560px] xl:max-w-[620px]"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <section id="capabilities" className="px-5 pb-14 pt-6 sm:px-8 sm:pb-16 lg:px-12">
                <div className="mx-auto w-full max-w-[1180px]">
                    <div className="mx-auto max-w-[760px] text-center">
                        <h2 className="text-3xl font-black leading-tight text-[#202733] sm:text-4xl">
                            强大功能，释放 AI 创作潜能
                        </h2>
                        <p className="mt-3 text-base leading-7 text-[#6b7280]">
                            RedBox 提供一站式 AI 创作解决方案，让创作更高效、更智能。
                        </p>
                    </div>

                    <div className="mt-7 grid gap-4 md:grid-cols-2 lg:grid-cols-4 lg:gap-5">
                        {featureCards.map((item) => {
                            const Icon = item.icon;

                            return (
                                <article
                                    key={item.title}
                                    className="rounded-lg border border-[#ebeef2] bg-white p-5 text-center shadow-[0_12px_32px_rgba(17,24,39,0.04)] transition hover:-translate-y-1 hover:border-[#f2c7cc] hover:shadow-[0_18px_40px_rgba(213,31,45,0.08)] sm:p-7"
                                >
                                    <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#fde7ea] text-[#d51f2d]">
                                        <Icon className="h-8 w-8" strokeWidth={2.6} />
                                    </span>
                                    <h3 className="mt-5 text-lg font-black text-[#1f2733]">{item.title}</h3>
                                    <p className="mt-4 text-[15px] leading-7 text-[#697282]">{item.summary}</p>
                                </article>
                            );
                        })}
                    </div>

                    <div id="pricing" className="mt-5 grid gap-4 rounded-lg border border-[#f0dce0] bg-[linear-gradient(180deg,#fff,#fff8f9)] px-5 py-5 shadow-[0_16px_36px_rgba(213,31,45,0.06)] sm:grid-cols-2 sm:px-6 sm:py-6 lg:grid-cols-4">
                        {stats.map((item) => {
                            const Icon = item.icon;

                            return (
                                <div key={item.label} className="flex items-center justify-start gap-4 sm:justify-center">
                                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#fde7ea] text-[#d51f2d]">
                                        <Icon className="h-7 w-7" fill={item.filled ? 'currentColor' : 'none'} strokeWidth={2.4} />
                                    </span>
                                    <div>
                                        <strong className="block text-2xl font-black leading-tight text-[#d51f2d]">{item.value}</strong>
                                        <span className="mt-1 block text-sm text-[#697282]">{item.label}</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </section>
        </main>
    );
}

function FloatingCube({ className }: { className: string }) {
    return (
        <span
            aria-hidden="true"
            className={`absolute block rotate-45 rounded-md bg-[linear-gradient(145deg,#ff6b78,#d51f2d_58%,#a91520)] shadow-[0_18px_34px_rgba(213,31,45,0.2)] ${className}`}
        >
            <span className="absolute inset-[18%] rounded-[4px] bg-white/12" />
        </span>
    );
}
