import Image from 'next/image';
import {
    Bot,
    BookOpen,
    Code2,
    Download,
    GitFork,
    Github,
    PencilLine,
    Star,
    UsersRound,
} from 'lucide-react';
import { SiteHeader } from './components/SiteHeader';
import { fetchGithubRepoStats } from './lib/github';
import type { GithubRepoStats } from './lib/types';

export const revalidate = 3600;

const githubOwner = 'Jamailar';
const githubRepo = 'RedBox';
const fallbackGithubStats: GithubRepoStats = {
    htmlUrl: 'https://github.com/Jamailar/RedBox',
    stars: 824,
    forks: 116,
};

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

const productScreenshots = [
    {
        title: 'GPT-image-2 媒体套图',
        summary: '围绕自媒体封面、插图与套图生成，把图片编排接进创作流程。',
        src: '/screenshots/gpt-image-2-media-suite.jpg',
        width: 1440,
        height: 810,
        featured: true,
    },
    {
        title: '知识库',
        summary: '统一管理采集内容、文档、素材与标签，作为 AI 创作的长期上下文。',
        src: '/screenshots/knowledge.png',
        width: 1920,
        height: 1055,
    },
    {
        title: '随机漫步',
        summary: '从知识库素材里做灵感碰撞，生成选题方向并继续投喂给稿件或 RedClaw。',
        src: '/screenshots/wander.png',
        width: 1920,
        height: 1046,
    },
    {
        title: '稿件工作台',
        summary: '管理图文稿、视频稿、文件夹与素材绑定，集中完成内容生产。',
        src: '/screenshots/manuscripts.png',
        width: 1920,
        height: 1070,
    },
    {
        title: '创作页',
        summary: '在同一入口完成生图、生视频与素材生成，并绑定到后续发布链路。',
        src: '/screenshots/creation-page.jpg',
        width: 1600,
        height: 943,
    },
    {
        title: 'RedClaw',
        summary: '把任务、技能调用、定时执行和后台 Runner 收束到持续运行的工作台。',
        src: '/screenshots/Redclaw.png',
        width: 1920,
        height: 1053,
    },
    {
        title: '主体库',
        summary: '沉淀人物、商品、场景等创作主体，让写稿、生图和封面生成可复用参考。',
        src: '/screenshots/subjects.png',
        width: 1920,
        height: 1059,
    },
    {
        title: '团队协作',
        summary: '管理成员画像、成员知识、单成员对话和多人群聊协作。',
        src: '/screenshots/team.png',
        width: 1920,
        height: 1034,
    },
    {
        title: '媒体库',
        summary: '统一管理 AI 生成图、导入图和计划图，支持按项目、稿件、来源过滤。',
        src: '/screenshots/media-library.png',
        width: 1920,
        height: 1036,
    },
    {
        title: '封面图生成',
        summary: '支持模板图、底图和标题组组合，也能让 AI 直接生成封面方向。',
        src: '/screenshots/gen_cover.jpg',
        width: 1366,
        height: 768,
    },
];

function formatStatNumber(value: number) {
    return new Intl.NumberFormat('en-US').format(value);
}

async function getGithubStats() {
    try {
        return await fetchGithubRepoStats(githubOwner, githubRepo, process.env.GITHUB_TOKEN);
    } catch (error) {
        console.warn(error);
        return fallbackGithubStats;
    }
}

function buildStats(githubStats: GithubRepoStats) {
    return [
        {
            value: formatStatNumber(githubStats.stars),
            label: 'GitHub Stars',
            icon: Star,
            filled: true,
        },
        {
            value: formatStatNumber(githubStats.forks),
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
}

export default async function HomePage() {
    const githubStats = await getGithubStats();
    const stats = buildStats(githubStats);

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
                                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[linear-gradient(135deg,#d82030,#b41422)] px-7 text-base font-black !text-white shadow-[0_14px_30px_rgba(213,31,45,0.24)] transition hover:bg-[#bd1725] sm:h-12 sm:w-auto sm:px-8"
                            >
                                <Download className="h-4 w-4" strokeWidth={2.7} />
                                立即体验
                            </a>
                            <a
                                href={githubStats.htmlUrl}
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
                            开源项目 · MIT 非商用协议
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
                                src="/redbox.png"
                                alt="RedBox app 图标"
                                width={520}
                                height={520}
                                priority
                                className="h-auto w-full max-w-[220px] rounded-[28px] drop-shadow-[0_28px_38px_rgba(145,18,28,0.2)] sm:max-w-[300px] sm:rounded-[36px] lg:max-w-[360px] xl:max-w-[400px]"
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

            <section id="screenshots" className="bg-[#fbfbfc] px-5 py-14 sm:px-8 sm:py-16 lg:px-12">
                <div className="mx-auto w-full max-w-[1180px]">
                    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                        <div className="max-w-[720px]">
                            <h2 className="text-3xl font-black leading-tight text-[#202733] sm:text-4xl">
                                从采集到创作的完整工作台
                            </h2>
                            <p className="mt-3 text-base leading-7 text-[#6b7280]">
                                README 里的核心功能截图已经同步到首页，直接展示桌面端真实工作流。
                            </p>
                        </div>
                        <a
                            href="https://github.com/Jamailar/RedBox#功能截图"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-10 items-center justify-center rounded-lg border border-[#e5e7eb] bg-white px-4 text-sm font-semibold text-[#222830] transition hover:border-[#d51f2d]/40 hover:text-[#d51f2d]"
                        >
                            查看 README
                        </a>
                    </div>

                    <div className="mt-7 grid gap-5 lg:grid-cols-2">
                        {productScreenshots.map((item) => (
                            <article
                                key={item.title}
                                className={item.featured ? 'lg:col-span-2' : undefined}
                            >
                                <div className="overflow-hidden rounded-lg border border-[#e6e9ee] bg-white shadow-[0_18px_44px_rgba(17,24,39,0.08)]">
                                    <Image
                                        src={item.src}
                                        alt={`${item.title} 功能截图`}
                                        width={item.width}
                                        height={item.height}
                                        sizes={item.featured ? '(min-width: 1024px) 1180px, 100vw' : '(min-width: 1024px) 590px, 100vw'}
                                        className="h-auto w-full"
                                    />
                                </div>
                                <div className="mt-3">
                                    <h3 className="text-lg font-black text-[#202733]">{item.title}</h3>
                                    <p className="mt-1 text-sm leading-6 text-[#687281]">{item.summary}</p>
                                </div>
                            </article>
                        ))}
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
