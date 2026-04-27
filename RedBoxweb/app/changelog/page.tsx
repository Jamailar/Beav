import { CalendarDays, ExternalLink } from 'lucide-react';
import { SiteHeader } from '../components/SiteHeader';
import { formatReleaseDate, getLatestManifest } from '../lib/downloads';
import type { ReleaseManifest, ReleaseNotesEntry } from '../lib/types';

export const dynamic = 'force-dynamic';

function getReleaseNotes(manifest: ReleaseManifest | null): ReleaseNotesEntry[] {
    if (!manifest) {
        return [];
    }

    if (manifest.releaseNotes?.length) {
        return manifest.releaseNotes;
    }

    if (!manifest.notes) {
        return [];
    }

    return [{
        tag: manifest.tag,
        releaseName: manifest.releaseName,
        releaseUrl: manifest.releaseUrl,
        publishedAt: manifest.publishedAt,
        notes: manifest.notes,
    }];
}

function renderReleaseNotes(notes: string) {
    const lines = notes
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
        return (
            <p className="text-[14px] leading-7 text-[#7a6a5d]">
                这次发布没有填写更新日志。
            </p>
        );
    }

    return (
        <div className="grid gap-2.5">
            {lines.map((line, index) => {
                const trimmed = line.trim();
                const heading = trimmed.replace(/^#{1,6}\s+/, '');
                const bullet = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');

                if (heading !== trimmed) {
                    return (
                        <h3 key={`${index}-${trimmed}`} className="pt-2 text-base font-black text-[#22170f]">
                            {heading}
                        </h3>
                    );
                }

                if (bullet !== trimmed) {
                    return (
                        <p key={`${index}-${trimmed}`} className="flex gap-2 text-[14px] leading-7 text-[#53463c]">
                            <span className="mt-[0.7em] h-1.5 w-1.5 shrink-0 rounded-full bg-[#d75d31]" />
                            <span>{bullet}</span>
                        </p>
                    );
                }

                return (
                    <p key={`${index}-${trimmed}`} className="text-[14px] leading-7 text-[#53463c]">
                        {trimmed}
                    </p>
                );
            })}
        </div>
    );
}

export default async function ChangelogPage() {
    const manifest = await getLatestManifest();
    const releaseNotes = getReleaseNotes(manifest);

    return (
        <main className="min-h-screen bg-[#fffaf6] text-[#22170f]">
            <SiteHeader compact />

            <section className="px-4 pb-10 pt-36 md:pt-32">
                <div className="mx-auto w-full max-w-5xl">
                    <div className="max-w-3xl">
                        <h1 className="text-4xl font-black leading-tight text-[#22170f] sm:text-5xl">
                            更新日志
                        </h1>
                    </div>
                </div>
            </section>

            <section className="px-4 pb-24">
                <div className="mx-auto grid w-full max-w-5xl gap-4">
                    {releaseNotes.length > 0 ? (
                        releaseNotes.map((release, index) => (
                            <article
                                key={release.tag}
                                className="rounded-[18px] border border-[#32231714] bg-white px-5 py-5 shadow-[0_18px_42px_rgba(47,28,16,0.07)] sm:px-6 sm:py-6"
                            >
                                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="rounded-full bg-[#d75d31]/10 px-2.5 py-1 text-[12px] font-black text-[#a43816]">
                                                {release.tag}
                                            </span>
                                            {index === 0 ? (
                                                <span className="rounded-full bg-[#22170f] px-2.5 py-1 text-[12px] font-black text-white">
                                                    最新版本
                                                </span>
                                            ) : null}
                                        </div>
                                        <h2 className="mt-3 break-words text-2xl font-black leading-tight text-[#22170f]">
                                            {release.releaseName || release.tag}
                                        </h2>
                                        <p className="mt-2 inline-flex items-center gap-2 text-[13px] font-semibold text-[#8a715d]">
                                            <CalendarDays className="h-4 w-4" />
                                            {formatReleaseDate(release.publishedAt)}
                                        </p>
                                    </div>

                                    <a
                                        href={release.releaseUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border border-[#d75d31]/18 bg-[#d75d31]/8 px-3 text-[13px] font-black text-[#a43816] transition hover:border-[#d75d31]/35 hover:bg-[#d75d31]/12"
                                    >
                                        GitHub
                                        <ExternalLink className="h-3.5 w-3.5" />
                                    </a>
                                </div>

                                <div className="mt-5 border-t border-[#32231712] pt-5">
                                    {renderReleaseNotes(release.notes)}
                                </div>
                            </article>
                        ))
                    ) : (
                        <div className="rounded-[18px] border border-[#32231714] bg-white px-6 py-8 text-center shadow-[0_18px_42px_rgba(47,28,16,0.07)]">
                            <h2 className="text-xl font-black text-[#22170f]">更新日志准备中</h2>
                            <p className="mx-auto mt-3 max-w-xl text-[14px] leading-7 text-[#7a6a5d]">
                                当前还没有读取到 OSS manifest。部署后先运行一次安装包同步，或确认 `OSS_PUBLIC_BASE_URL` 可以访问 `manifests/latest.json`。
                            </p>
                        </div>
                    )}
                </div>
            </section>
        </main>
    );
}
