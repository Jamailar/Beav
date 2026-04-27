import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'RedBox | 自媒体 AI 全能工作台',
    description: 'RedBox 官网与下载镜像站，提供最新稳定版高速下载，并介绍灵感采集、AI 创作、AI 剪视频、AI 剪播客、AI 生图、AI 生视频等核心能力。',
    icons: {
        icon: '/redbox.png',
        apple: '/redbox.png',
    },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="zh-CN">
            <body>{children}</body>
        </html>
    );
}
