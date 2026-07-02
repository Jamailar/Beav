import { Copy, FileText, Image, LayoutGrid, MessageSquareText, Scissors, Sparkles, TrendingUp, Type, Video } from 'lucide-react';
import type { UploadedFileAttachment } from '../../../components/ChatComposer';
import { resolveAssetUrl } from '../../../utils/pathManager';
import type { ChatAttachmentActionKind } from './types';

export function getActionKindLabel(kind: ChatAttachmentActionKind): string {
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  return '文件';
}

export function renderActionKindIcon(kind: ChatAttachmentActionKind, className: string) {
  if (kind === 'image') return <Image className={className} strokeWidth={1.8} />;
  if (kind === 'video') return <Video className={className} strokeWidth={1.8} />;
  return <FileText className={className} strokeWidth={1.8} />;
}

export function getAttachmentPreviewSource(attachment: UploadedFileAttachment): string {
  const source = String(
    attachment.thumbnailDataUrl
    || attachment.thumbnailUrl
    || attachment.inlineDataUrl
    || attachment.localUrl
    || attachment.absolutePath
    || attachment.originalAbsolutePath
    || '',
  ).trim();
  if (!source) return '';
  return source.startsWith('data:') ? source : resolveAssetUrl(source);
}

export function renderActionIcon(label: string, className: string) {
  if (label.includes('自定义')) return <MessageSquareText className={className} strokeWidth={1.8} />;
  if (label.includes('爆款')) return <TrendingUp className={className} strokeWidth={1.8} />;
  if (label.includes('字幕') || label.includes('文案')) return <Type className={className} strokeWidth={1.8} />;
  if (label.includes('剪辑') || label.includes('切片')) return <Scissors className={className} strokeWidth={1.8} />;
  if (label.includes('电商') || label.includes('套图')) return <LayoutGrid className={className} strokeWidth={1.8} />;
  if (label.includes('封面')) return <Image className={className} strokeWidth={1.8} />;
  if (label.includes('同款')) return <Copy className={className} strokeWidth={1.8} />;
  return <Sparkles className={className} strokeWidth={1.8} />;
}

export function getActionDescription(label: string): string {
  if (label.includes('自定义')) return '回到输入框，自己写提示词';
  if (label.includes('爆款')) return '拆解钩子、节奏和传播亮点';
  if (label.includes('字幕')) return '提取字幕文本和可用字幕文件';
  if (label.includes('剪辑') || label.includes('切片')) return '找出精彩片段并剪成短视频';
  if (label.includes('电商') || label.includes('套图')) return '生成主图、卖点图和场景图方案';
  if (label.includes('封面')) return '设计标题、构图和封面提示词';
  if (label.includes('同款')) return '复用风格生成同款视觉方案';
  if (label.includes('文案')) return '提炼卖点并改写成转化文案';
  return '让 AI 直接处理这个附件';
}

export function getActionTone(label: string, darkEmbedded: boolean): { card: string; icon: string; arrow: string; wash: string; dots: string } {
  if (label.includes('自定义')) {
    return darkEmbedded
      ? { card: 'border-white/12 bg-white/[0.045] hover:border-white/24 hover:bg-white/[0.08]', icon: 'bg-white/10 text-white/76', arrow: 'bg-white/10 text-white/70', wash: 'bg-white/10', dots: 'text-white/12' }
      : { card: 'border-[#e8e2d8] bg-white hover:border-[#d9d0c2] hover:shadow-[0_24px_60px_rgba(64,54,42,0.1)]', icon: 'bg-stone-100 text-stone-700', arrow: 'bg-stone-100 text-stone-700 shadow-sm', wash: 'bg-stone-100/80', dots: 'text-stone-200/80' };
  }
  if (label.includes('爆款')) {
    return darkEmbedded
      ? { card: 'border-rose-300/20 bg-[linear-gradient(145deg,rgba(244,63,94,0.14),rgba(255,255,255,0.04))] hover:border-rose-300/34', icon: 'bg-rose-400/18 text-rose-200', arrow: 'bg-[linear-gradient(135deg,#fb7185,#e11d48)] text-white', wash: 'bg-rose-400/16', dots: 'text-rose-300/18' }
      : { card: 'border-rose-100 bg-[linear-gradient(145deg,#fff7f8,#fff)] hover:border-rose-200 hover:shadow-[0_24px_60px_rgba(225,29,72,0.14)]', icon: 'bg-rose-100 text-rose-600', arrow: 'bg-[linear-gradient(135deg,#fb7185,#e11d48)] text-white', wash: 'bg-rose-100/80', dots: 'text-rose-200/70' };
  }
  if (label.includes('字幕') || label.includes('文案')) {
    return darkEmbedded
      ? { card: 'border-sky-300/20 bg-[linear-gradient(145deg,rgba(56,189,248,0.14),rgba(255,255,255,0.04))] hover:border-sky-300/34', icon: 'bg-sky-400/18 text-sky-200', arrow: 'bg-[linear-gradient(135deg,#60a5fa,#2563eb)] text-white', wash: 'bg-sky-400/16', dots: 'text-sky-300/18' }
      : { card: 'border-sky-100 bg-[linear-gradient(145deg,#f4fbff,#fff)] hover:border-sky-200 hover:shadow-[0_24px_60px_rgba(2,132,199,0.13)]', icon: 'bg-sky-100 text-sky-700', arrow: 'bg-[linear-gradient(135deg,#60a5fa,#2563eb)] text-white', wash: 'bg-sky-100/90', dots: 'text-sky-200/80' };
  }
  if (label.includes('剪辑') || label.includes('切片')) {
    return darkEmbedded
      ? { card: 'border-amber-300/20 bg-[linear-gradient(145deg,rgba(251,191,36,0.14),rgba(255,255,255,0.04))] hover:border-amber-300/34', icon: 'bg-amber-400/18 text-amber-200', arrow: 'bg-[linear-gradient(135deg,#fbbf24,#d97706)] text-white', wash: 'bg-amber-400/16', dots: 'text-amber-300/18' }
      : { card: 'border-amber-100 bg-[linear-gradient(145deg,#fffbeb,#fff)] hover:border-amber-200 hover:shadow-[0_24px_60px_rgba(217,119,6,0.14)]', icon: 'bg-amber-100 text-amber-700', arrow: 'bg-[linear-gradient(135deg,#fbbf24,#d97706)] text-white', wash: 'bg-amber-100/90', dots: 'text-amber-200/80' };
  }
  if (label.includes('电商') || label.includes('套图')) {
    return darkEmbedded
      ? { card: 'border-emerald-300/20 bg-[linear-gradient(145deg,rgba(52,211,153,0.14),rgba(255,255,255,0.04))] hover:border-emerald-300/34', icon: 'bg-emerald-400/18 text-emerald-200', arrow: 'bg-[linear-gradient(135deg,#86efac,#10b981)] text-white', wash: 'bg-emerald-400/16', dots: 'text-emerald-300/18' }
      : { card: 'border-emerald-100 bg-[linear-gradient(145deg,#f0fdf4,#fff)] hover:border-emerald-200 hover:shadow-[0_24px_60px_rgba(5,150,105,0.14)]', icon: 'bg-emerald-100 text-emerald-700', arrow: 'bg-[linear-gradient(135deg,#86efac,#10b981)] text-white', wash: 'bg-emerald-100/90', dots: 'text-emerald-200/80' };
  }
  if (label.includes('封面')) {
    return darkEmbedded
      ? { card: 'border-violet-300/20 bg-[linear-gradient(145deg,rgba(139,92,246,0.14),rgba(255,255,255,0.04))] hover:border-violet-300/34', icon: 'bg-violet-400/18 text-violet-200', arrow: 'bg-[linear-gradient(135deg,#a78bfa,#7c3aed)] text-white', wash: 'bg-violet-400/16', dots: 'text-violet-300/18' }
      : { card: 'border-violet-100 bg-[linear-gradient(145deg,#faf5ff,#fff)] hover:border-violet-200 hover:shadow-[0_24px_60px_rgba(124,58,237,0.13)]', icon: 'bg-violet-100 text-violet-700', arrow: 'bg-[linear-gradient(135deg,#a78bfa,#7c3aed)] text-white', wash: 'bg-violet-100/90', dots: 'text-violet-200/80' };
  }
  if (label.includes('同款')) {
    return darkEmbedded
      ? { card: 'border-fuchsia-300/20 bg-[linear-gradient(145deg,rgba(217,70,239,0.14),rgba(255,255,255,0.04))] hover:border-fuchsia-300/34', icon: 'bg-fuchsia-400/18 text-fuchsia-200', arrow: 'bg-[linear-gradient(135deg,#e879f9,#c026d3)] text-white', wash: 'bg-fuchsia-400/16', dots: 'text-fuchsia-300/18' }
      : { card: 'border-fuchsia-100 bg-[linear-gradient(145deg,#fdf4ff,#fff)] hover:border-fuchsia-200 hover:shadow-[0_24px_60px_rgba(192,38,211,0.13)]', icon: 'bg-fuchsia-100 text-fuchsia-700', arrow: 'bg-[linear-gradient(135deg,#e879f9,#c026d3)] text-white', wash: 'bg-fuchsia-100/90', dots: 'text-fuchsia-200/80' };
  }
  return darkEmbedded
    ? { card: 'border-white/10 bg-white/[0.06] hover:border-white/22 hover:bg-white/[0.1]', icon: 'bg-white/10 text-white/78', arrow: 'bg-white/10 text-white/72', wash: 'bg-white/10', dots: 'text-white/12' }
    : { card: 'border-[#ebe7dc] bg-[#fcfbf7] hover:border-accent-primary/28 hover:bg-white hover:shadow-[0_24px_60px_rgba(120,88,38,0.12)]', icon: 'bg-accent-primary/10 text-accent-primary', arrow: 'bg-white text-accent-primary shadow-sm', wash: 'bg-stone-100/80', dots: 'text-stone-200/80' };
}
