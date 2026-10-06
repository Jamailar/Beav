import React from 'react';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { clsx } from 'clsx';

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  tool?: string;
}

interface TodoListProps {
  steps: PlanStep[];
}

export function TodoList({ steps }: TodoListProps) {
  if (!steps || steps.length === 0) return null;

  const completedCount = steps.filter(s => s.status === 'done').length;
  const progress = Math.round((completedCount / steps.length) * 100);

  return (
    <div className="w-full max-w-3xl bg-surface-primary border border-border rounded-xl overflow-hidden mb-6 shadow-sm ring-1 ring-border/50">
      <div className="px-5 py-3 border-b border-border bg-surface-secondary/30 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            {progress < 100 && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-75"></span>}
            <span className={clsx("relative inline-flex rounded-full h-2.5 w-2.5", progress === 100 ? "bg-green-500" : "bg-accent-primary")}></span>
          </span>
          执行计划
        </h3>
        <div className="flex items-center gap-3">
            <div className="w-24 h-1.5 bg-border/50 rounded-full overflow-hidden">
                <div className="h-full bg-accent-primary transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-text-tertiary font-mono">
            {completedCount}/{steps.length}
            </span>
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {steps.map((step, index) => (
          <div
            key={step.id || index}
            className={clsx(
              "px-5 py-3.5 flex items-start gap-4 transition-colors",
              step.status === 'in_progress' ? "bg-accent-primary/5 border-l-2 border-l-accent-primary" : "hover:bg-surface-secondary/50 border-l-2 border-l-transparent"
            )}
          >
            <div className="mt-0.5 shrink-0">
              {step.status === 'done' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
              {step.status === 'in_progress' && <Loader2 className="w-5 h-5 text-accent-primary animate-spin" />}
              {step.status === 'pending' && <Circle className="w-5 h-5 text-text-tertiary/50" />}
              {step.status === 'failed' && <XCircle className="w-5 h-5 text-red-500" />}
            </div>

            <div className="flex-1 min-w-0">
              <p className={clsx(
                "text-sm leading-relaxed",
                step.status === 'done' ? "text-text-secondary/70 line-through decoration-text-tertiary/50" :
                step.status === 'in_progress' ? "text-text-primary font-medium" :
                "text-text-secondary"
              )}>
                {step.description}
              </p>
              {/* 只在非完成状态或展开时显示工具详情，保持简洁 */}
              {step.tool && step.status === 'in_progress' && (
                <div className="mt-2 flex items-center gap-2 animate-in fade-in slide-in-from-left-1">
                   <span className="text-[10px] uppercase tracking-wider font-bold text-accent-primary bg-accent-primary/10 px-2 py-0.5 rounded-full border border-accent-primary/20">
                     {step.tool}
                   </span>
                   <span className="text-xs text-text-tertiary animate-pulse">正在执行...</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
