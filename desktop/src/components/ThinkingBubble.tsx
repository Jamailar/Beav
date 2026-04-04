import { Lightbulb, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

interface ThinkingBubbleProps {
    content: string;
    isActive?: boolean;
}

export function ThinkingBubble({ content, isActive = true }: ThinkingBubbleProps) {
    return (
        <div className={clsx(
            "rounded-lg border px-4 py-3 transition-all",
            isActive
                ? "bg-amber-500/5 border-amber-500/30"
                : "bg-surface-secondary border-border"
        )}>
            <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
                {content}
            </p>
        </div>
    );
}

interface SkillActivatedBadgeProps {
    name: string;
    description: string;
}

export function SkillActivatedBadge({ name, description: _description }: SkillActivatedBadgeProps) {
    return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30">
            <Lightbulb className="w-4 h-4 text-green-500" />
            <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-green-600 dark:text-green-400">
                    Skill Activated:
                </span>
                <span className="ml-2 text-xs font-mono text-text-primary">
                    {name}
                </span>
            </div>
            <ChevronRight className="w-3 h-3 text-text-tertiary" />
        </div>
    );
}

interface ToolResultCardProps {
    name: string;
    success: boolean;
    content: string;
    duration?: number;
}

export function ToolResultCard({ name, success, content, duration }: ToolResultCardProps) {
    return (
        <div className={clsx(
            "rounded-lg border overflow-hidden",
            success
                ? "border-green-500/30 bg-green-500/5"
                : "border-red-500/30 bg-red-500/5"
        )}>
            <div className="px-3 py-2 border-b border-border/50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className={clsx(
                        "w-2 h-2 rounded-full",
                        success ? "bg-green-500" : "bg-red-500"
                    )} />
                    <span className="text-xs font-mono text-text-primary">{name}</span>
                </div>
                {duration && (
                    <span className="text-[10px] text-text-tertiary">
                        {duration}ms
                    </span>
                )}
            </div>
            <div className="px-3 py-2 text-xs font-mono text-text-secondary max-h-32 overflow-auto whitespace-pre-wrap">
                {content.length > 500 ? content.substring(0, 500) + '...' : content}
            </div>
        </div>
    );
}
