import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { ChatInlineChoiceGroup, type ChatInlineChoice } from '../../components/chat/ChatInlineChoiceGroup';
import { ChatInlineHomepageInput } from '../../components/chat/ChatInlineHomepageInput';
import { APP_BRAND } from '../../config/brand';
import type { SpaceInitState } from '../../bridge/domains/spacesBridge';
import type { PendingChatMessage } from '../app-shell/types';
import type { ClipboardCaptureCandidate } from '../capture/captureTypes';
import {
  buildChoiceMessage,
  SPACE_INIT_CONTEXT_TYPE,
} from './spaceInitAccountCapture';

interface SpaceInitializationPageProps {
  state: SpaceInitState | null;
  canClose: boolean;
  onCompleted: () => void | Promise<void>;
  onBranchStart: (message: PendingChatMessage, nextState?: SpaceInitState | null) => void;
  onHomepageCaptureStart: (payload: { url: string; candidate: ClipboardCaptureCandidate; progressBase: Record<string, unknown> }) => void;
}

const SPACE_INIT_CHOICES: ChatInlineChoice[] = [
  {
    id: 'no-account',
    label: '还没有账号，帮我做新账号定位',
  },
];

export function SpaceInitializationPage({
  state,
  canClose,
  onCompleted,
  onBranchStart,
  onHomepageCaptureStart,
}: SpaceInitializationPageProps) {
  const [activeSpaceId, setActiveSpaceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [setupError, setSetupError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.ipcRenderer.spaces.list().then((result) => {
      if (cancelled) return;
      setActiveSpaceId(String(result?.activeSpaceId || 'default').trim());
    }).catch((error) => {
      console.warn('Failed to load active space for initialization page:', error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const progressBase = useMemo(() => ({
    ...(state?.progress || {}),
    flow: 'chat-agent-v1',
    source: SPACE_INIT_CONTEXT_TYPE,
    activeSpaceId: activeSpaceId || undefined,
  }), [activeSpaceId, state]);

  const closeToDefaultSpace = useCallback(async () => {
    await window.ipcRenderer.spaces.switch('default');
    await onCompleted();
  }, [onCompleted]);

  const enterPositioningConversation = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setSetupError('');
    try {
      const nextState = await window.ipcRenderer.spaces.init.progress<SpaceInitState>({
        phase: 'positioning',
        homepageUrl: String(state?.homepageUrl || ''),
        platform: state?.platform || undefined,
        progress: {
          ...progressBase,
          branch: 'positioning',
          uiStage: 'agent_conversation',
          updatedAt: new Date().toISOString(),
        },
      });
      await window.ipcRenderer.redclawProfile.startStyleDefinition({
        source: SPACE_INIT_CONTEXT_TYPE,
      }).catch((error) => {
        console.warn('Failed to start RedClaw style definition flow:', error);
      });
      onBranchStart(buildChoiceMessage(), nextState);
    } catch (error) {
      console.error('Failed to enter space initialization agent conversation:', error);
      setSetupError(error instanceof Error ? error.message : '进入初始化对话失败');
      setSubmitting(false);
    }
  }, [onBranchStart, progressBase, state, submitting]);

  const submitHomepageUrl = useCallback((payload: { url: string; candidate: ClipboardCaptureCandidate }) => {
    if (submitting) return;
    setSubmitting(true);
    setSetupError('');
    onHomepageCaptureStart({
      url: payload.url.trim(),
      candidate: payload.candidate,
      progressBase,
    });
  }, [onHomepageCaptureStart, progressBase, submitting]);

  return (
    <div
      className="fixed inset-0 z-[200] flex min-w-0 flex-col text-text-primary"
      style={{ background: 'var(--app-shell-background)' }}
    >
      {canClose ? (
        <button
          type="button"
          onClick={() => void closeToDefaultSpace()}
          className="absolute right-5 top-5 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-primary/80 text-text-tertiary shadow-sm backdrop-blur transition-colors hover:text-text-primary"
          aria-label="关闭初始化流程"
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}

      <main className="mx-auto flex min-h-0 w-full max-w-[860px] flex-1 flex-col justify-center px-6 py-10">
        <div className="space-y-9">
          <div className="flex justify-center">
            <img
              src={APP_BRAND.logoSrc}
              alt={APP_BRAND.displayName}
              className="h-24 w-24 object-contain drop-shadow-[0_18px_32px_rgba(110,84,44,0.14)]"
            />
          </div>

          <section className="space-y-4 text-[20px] leading-9 text-text-primary">
            <p>欢迎来到账号空间初始化。</p>
            <p>如果你已经有账号，请粘贴任意平台的主页链接，我会先进入对话页下载账号数据，完成后自动开始 AI 分析。</p>
          </section>

          <ChatInlineHomepageInput
            placeholder="粘贴账号主页链接..."
            submitLabel="开始分析"
            disabled={submitting}
            onSubmit={submitHomepageUrl}
          />

          <div className="space-y-3 pt-4">
            <div className="text-sm leading-6 text-text-secondary">
              如果你还没有账号，可以点击下面的按钮，我们先从新账号定位开始。
            </div>
            <ChatInlineChoiceGroup choices={SPACE_INIT_CHOICES} onSelect={enterPositioningConversation} columns={1} disabled={submitting} />
          </div>

          {setupError ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600">
              {setupError}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
