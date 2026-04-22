import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export type ChatComposerTheme = 'default' | 'dark';
export type ChatComposerVariant = 'main' | 'empty';

interface ChatComposerFrameProps {
    theme?: ChatComposerTheme;
    variant?: ChatComposerVariant;
    className?: string;
    children: ReactNode;
}

export interface ChatComposerPalette {
    shellMain: string;
    shellEmpty: string;
    text: string;
    subtleButton: string;
    sendButtonActive: string;
    sendButtonIdle: string;
}

export function getChatComposerPalette(theme: ChatComposerTheme = 'default'): ChatComposerPalette {
    if (theme === 'dark') {
        return {
            shellMain: 'bg-[#121417] border border-white/10 rounded-[24px] p-1.5',
            shellEmpty: 'bg-[#121417] border border-white/10 rounded-[28px] p-2',
            text: 'text-white placeholder:text-white/28',
            subtleButton: 'text-white/48 hover:text-white/82',
            sendButtonActive: 'bg-[#4c82ff] text-white hover:bg-[#5b8eff]',
            sendButtonIdle: 'bg-white/10 text-white/45 opacity-80',
        };
    }

    return {
        shellMain: 'bg-[#fdfcf9] border border-[#edebe4] rounded-[24px] p-1.5',
        shellEmpty: 'bg-[#fdfcf9] border border-[#edebe4] rounded-[28px] p-2',
        text: 'text-text-primary placeholder:text-[#b4b2a8]',
        subtleButton: 'text-text-tertiary hover:text-text-secondary',
        sendButtonActive: 'bg-[#4c82ff] text-white hover:bg-[#5b8eff]',
        sendButtonIdle: 'bg-[#edebe4] text-white opacity-60',
    };
}

export function ChatComposerFrame({
    theme = 'default',
    variant = 'main',
    className,
    children,
}: ChatComposerFrameProps) {
    const palette = getChatComposerPalette(theme);

    return (
        <div
            className={clsx(
                'group relative flex flex-col w-full transition-all duration-200 focus-within:shadow-lg focus-within:border-accent-primary/20',
                variant === 'empty' ? palette.shellEmpty : palette.shellMain,
                className,
            )}
        >
            {children}
        </div>
    );
}
