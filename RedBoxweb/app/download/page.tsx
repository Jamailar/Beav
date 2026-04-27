import { Chrome, Cloud, Download, FolderOpen, PackageCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { SiteHeader } from '../components/SiteHeader';
import { formatBytes, getLatestManifest, pickPrimaryDownloadAssets } from '../lib/downloads';
import type { ReleaseAsset, ReleaseManifest } from '../lib/types';

export const dynamic = 'force-dynamic';

function formatShortDate(iso?: string) {
    if (!iso) return '准备中';
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return iso;
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(value).replace(/\//g, '-');
}

function buildMeta(manifest: ReleaseManifest | null, asset: ReleaseAsset | null) {
    return [
        `安装包版本：${manifest?.tag || '准备中'}`,
        formatShortDate(manifest?.publishedAt),
        asset ? formatBytes(asset.size) : '镜像准备中',
    ];
}

function buildPluginMeta(plugin: ReleaseManifest['plugin']) {
    return [
        `插件版本：${plugin?.sourceRef || '准备中'}`,
        plugin ? formatBytes(plugin.size) : '镜像准备中',
    ];
}

export default async function DownloadPage() {
    const manifest = await getLatestManifest();
    const downloads = pickPrimaryDownloadAssets(manifest);
    const macPrimary = downloads.macArm64 || downloads.macX64;
    const macSecondary = downloads.macArm64 && downloads.macX64 ? downloads.macX64 : null;
    const plugin = manifest?.plugin || null;
    const pluginMeta = buildPluginMeta(plugin);

    const items = [
        {
            title: 'macOS 12+',
            subtitle: 'Intel / Apple Silicon',
            buttonLabel: '下载 macOS 版',
            asset: macPrimary,
            secondaryAsset: macSecondary,
            secondaryLabel: 'Intel 版备用下载',
            logoSrc: '/platforms/apple.svg',
            logoAlt: 'Apple',
            featured: true,
            meta: buildMeta(manifest, macPrimary),
        },
        {
            title: 'Windows 10+',
            subtitle: '64-bit',
            buttonLabel: '下载 Windows 版',
            asset: downloads.windowsX64,
            secondaryAsset: null,
            secondaryLabel: null,
            logoSrc: '/platforms/windows.svg',
            logoAlt: 'Windows',
            featured: false,
            meta: buildMeta(manifest, downloads.windowsX64),
        },
    ];

    return (
        <main className="min-h-screen bg-[radial-gradient(circle_at_20%_8%,rgba(132,93,255,0.12),transparent_32%),radial-gradient(circle_at_78%_16%,rgba(53,150,255,0.12),transparent_34%),#f8faff] pt-36 text-[#141820] md:pt-32">
            <SiteHeader compact />

            <section className="px-5 pb-20 pt-8 sm:px-8">
                <div className="mx-auto w-full max-w-[960px]">
                    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                        <div className="flex items-start gap-4">
                            <span className="flex h-14 w-14 shrink-0 items-center justify-center">
                                <img src="/redbox.png" alt="RedBox" className="h-14 w-14 object-contain" />
                            </span>
                            <div>
                                <h1 className="text-3xl font-black tracking-normal text-[#151922] sm:text-4xl">
                                    下载 RedBox
                                </h1>
                                <p className="mt-2 max-w-[560px] text-sm font-semibold leading-6 text-[#647089] sm:text-base">
                                    选择对应系统版本。安装包由 GitHub Release 同步到镜像源，优先提供最新稳定版。
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs font-black text-[#526178]">
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#dfe6f2] bg-white/72 px-3 py-2">
                                <RefreshCw className="h-3.5 w-3.5 text-[#d51f2d]" />
                                自动同步
                            </span>
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#dfe6f2] bg-white/72 px-3 py-2">
                                <Cloud className="h-3.5 w-3.5 text-[#2563eb]" />
                                OSS 镜像
                            </span>
                        </div>
                    </div>

                    <div className="grid gap-6 md:grid-cols-2">
                        {items.map((item) => {
                            return (
                                <article
                                    key={item.title}
                                    className={`rounded-[18px] border bg-white/74 p-6 shadow-[0_18px_44px_rgba(53,65,88,0.08)] backdrop-blur transition hover:-translate-y-0.5 hover:bg-white/88 ${
                                        item.featured
                                            ? 'border-[#8568ff] ring-1 ring-[#39a8ff]/60'
                                            : 'border-[#dfe6f2]'
                                    }`}
                                >
                                    <div className="flex items-center gap-5">
                                        <span className="flex h-14 w-14 shrink-0 items-center justify-center">
                                            <img
                                                src={item.logoSrc}
                                                alt={item.logoAlt}
                                                className="h-12 w-12 object-contain"
                                            />
                                        </span>
                                        <div className="min-w-0">
                                            <h2 className="text-xl font-black tracking-normal text-[#151922]">{item.title}</h2>
                                            <p className="mt-1 text-[15px] font-semibold text-[#8a93a3]">{item.subtitle}</p>
                                        </div>
                                    </div>

                                    <div className="mt-6">
                                        <div className="mb-3 flex items-center gap-2 rounded-[14px] border border-[#dfe6f2] bg-white/70 px-4 py-3 text-sm font-bold text-[#526178]">
                                            <ShieldCheck className="h-4 w-4 shrink-0 text-[#0f5d5a]" />
                                            <span>{item.asset ? '稳定版安装包已同步镜像源' : '正在等待最新稳定版镜像同步'}</span>
                                        </div>
                                        {item.asset ? (
                                            <a
                                                href={item.asset.publicUrl}
                                                className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-lg bg-[#05080d] px-5 text-lg font-black !text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_28px_rgba(5,8,13,0.18)] transition hover:bg-[#151a22] hover:!text-white"
                                            >
                                                <Download className="h-5 w-5" strokeWidth={2.5} />
                                                {item.buttonLabel}
                                            </a>
                                        ) : (
                                            <div className="inline-flex h-14 w-full items-center justify-center rounded-lg bg-[#9aa3b2] px-5 text-lg font-black text-white">
                                                镜像准备中
                                            </div>
                                        )}
                                    </div>

                                    <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-[#687282]">
                                        {item.meta.map((value, index) => (
                                            <span key={`${item.title}-${value}`} className="inline-flex items-center gap-2">
                                                {index > 0 ? <span className="text-[#b6becb]">|</span> : null}
                                                {value}
                                            </span>
                                        ))}
                                    </div>

                                    {item.secondaryAsset ? (
                                        <a
                                            href={item.secondaryAsset.publicUrl}
                                            className="mt-3 inline-flex text-sm font-bold text-[#5f6878] transition hover:text-[#151922]"
                                        >
                                            {item.secondaryLabel}
                                        </a>
                                    ) : null}
                                </article>
                            );
                        })}
                    </div>

                    <article className="mt-6 rounded-[18px] border border-[#dfe6f2] bg-white/76 p-6 shadow-[0_18px_44px_rgba(53,65,88,0.08)] backdrop-blur">
                        <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-center">
                            <div className="flex items-start gap-5">
                                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[16px] bg-[#d51f2d]/10 text-[#d51f2d]">
                                    <Chrome className="h-8 w-8" strokeWidth={2.3} />
                                </span>
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h2 className="text-xl font-black tracking-normal text-[#151922]">浏览器插件</h2>
                                        <span className="inline-flex items-center gap-1 rounded-full border border-[#dfe6f2] bg-white/76 px-2.5 py-1 text-xs font-black text-[#526178]">
                                            <PackageCheck className="h-3.5 w-3.5 text-[#0f5d5a]" />
                                            Chrome / Edge
                                        </span>
                                    </div>
                                    <p className="mt-2 max-w-[620px] text-sm font-semibold leading-6 text-[#647089]">
                                        下载 RedBox 浏览器插件，用于采集网页、小红书、YouTube、图片和选中文字，并发送到桌面端知识库。
                                    </p>
                                    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-[#687282]">
                                        {pluginMeta.map((value, index) => (
                                            <span key={value} className="inline-flex items-center gap-2">
                                                {index > 0 ? <span className="text-[#b6becb]">|</span> : null}
                                                {value}
                                            </span>
                                        ))}
                                    </div>
                                    <div className="mt-4 flex flex-wrap gap-2 text-xs font-black text-[#526178]">
                                        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#dfe6f2] bg-white/72 px-3 py-2">
                                            <FolderOpen className="h-3.5 w-3.5 text-[#8568ff]" />
                                            解压后加载 Plugin 文件夹
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#dfe6f2] bg-white/72 px-3 py-2">
                                            <ShieldCheck className="h-3.5 w-3.5 text-[#0f5d5a]" />
                                            本地连接 RedBox 桌面端
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <a
                                href={plugin?.publicUrl || '#'}
                                aria-disabled={!plugin}
                                className={`inline-flex h-14 w-full items-center justify-center gap-2 rounded-lg px-6 text-lg font-black !text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_28px_rgba(5,8,13,0.18)] transition hover:!text-white lg:w-auto ${
                                    plugin
                                        ? 'bg-[#05080d] hover:bg-[#151a22]'
                                        : 'pointer-events-none bg-[#9aa3b2]'
                                }`}
                            >
                                <Download className="h-5 w-5" strokeWidth={2.5} />
                                {plugin ? '下载插件' : '插件镜像准备中'}
                            </a>
                        </div>
                    </article>
                </div>
            </section>
        </main>
    );
}
