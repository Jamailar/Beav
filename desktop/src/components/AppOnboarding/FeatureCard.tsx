import { LucideIcon } from 'lucide-react';

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  desc: string;
  colorClass: string;
}

export function FeatureCard({ icon: Icon, title, desc, colorClass }: FeatureCardProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface-secondary/60 p-6 text-center">
      <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${colorClass}`}>
        <Icon className="h-6 w-6" strokeWidth={1.6} />
      </div>
      <div className="text-sm font-semibold text-text-primary">{title}</div>
      <div className="text-xs leading-5 text-text-tertiary">{desc}</div>
    </div>
  );
}
