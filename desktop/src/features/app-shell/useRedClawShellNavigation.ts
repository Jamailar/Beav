import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { AuthoringTaskHints } from '../../utils/redclawAuthoring';
import { uiTraceInteraction } from '../../utils/uiDebug';
import type { ImmersiveMode, PendingChatMessage, RedClawNavigationAction, ViewType } from './types';

interface UseRedClawShellNavigationParams {
  currentView: ViewType;
  setCurrentView: Dispatch<SetStateAction<ViewType>>;
  setActiveManuscriptEditorFile: Dispatch<SetStateAction<string | null>>;
  setImmersiveMode: Dispatch<SetStateAction<ImmersiveMode>>;
}

export function useRedClawShellNavigation({
  currentView,
  setCurrentView,
  setActiveManuscriptEditorFile,
  setImmersiveMode,
}: UseRedClawShellNavigationParams) {
  const [redclawOnboardingVersion, setRedclawOnboardingVersion] = useState(0);
  const [pendingRedClawMessage, setPendingRedClawMessage] = useState<PendingChatMessage | null>(null);
  const [redClawNavigationAction, setRedClawNavigationAction] = useState<RedClawNavigationAction | null>(null);

  const navigateToRedClaw = useCallback((message: PendingChatMessage) => {
    uiTraceInteraction('app', 'nav_to_redclaw', { to: 'redclaw' });
    setPendingRedClawMessage(message);
    setCurrentView('redclaw');
  }, [setCurrentView]);

  const openRedClawOnboarding = useCallback(() => {
    void (async () => {
      try {
        await window.ipcRenderer.redclawProfile.startStyleDefinition({
          forceRestart: true,
          source: 'manual-redefine',
        });
        setRedclawOnboardingVersion((value) => value + 1);
      } catch (error) {
        console.error('Failed to start RedClaw style definition:', error);
      }
      navigateToRedClaw({
        content: '我想重新定义这个空间的自媒体定位和写作风格。请先让我上传账号主页截图来确认账号定位，可以让我发 1 到 3 张主页相关截图一起分析；确认后，再让我上传一篇自己的文章截图或对标账号文章截图来学习创作风格。不要直接写稿。',
        displayContent: '重新定义这个空间的风格',
        sessionRouting: 'new',
        deliveryMode: 'send',
        taskHints: {
          activeSkills: ['redclaw-style-definition'],
          requiredSkill: 'redclaw-style-definition',
          allowedOperateActions: [
            'redclaw.profile.bundle',
            'redclaw.profile.read',
            'redclaw.profile.update',
            'redclaw.profile.completeStyleDefinition',
          ],
          initialContext: '用户从界面入口手动请求重新定义当前 RedClaw 空间风格。',
        } as AuthoringTaskHints,
      });
    })();
  }, [navigateToRedClaw]);

  const clearPendingRedClawMessage = useCallback(() => {
    setPendingRedClawMessage(null);
  }, []);

  const clearRedClawNavigationAction = useCallback(() => {
    setRedClawNavigationAction(null);
  }, []);

  const navigateToManuscript = useCallback((filePath: string) => {
    uiTraceInteraction('app', 'open_manuscript_editor', { sourceView: currentView });
    setActiveManuscriptEditorFile(filePath);
    setCurrentView('redclaw');
  }, [currentView, setActiveManuscriptEditorFile, setCurrentView]);

  const closeManuscriptEditor = useCallback(() => {
    setActiveManuscriptEditorFile(null);
    setImmersiveMode(false);
  }, [setActiveManuscriptEditorFile, setImmersiveMode]);

  const openRedClawChatSurface = useCallback(() => {
    setActiveManuscriptEditorFile(null);
    setImmersiveMode(false);
    setCurrentView('redclaw');
  }, [setActiveManuscriptEditorFile, setCurrentView, setImmersiveMode]);

  const openRedClawSession = useCallback((sessionId: string) => {
    const nextSessionId = String(sessionId || '').trim();
    if (!nextSessionId) return;
    setActiveManuscriptEditorFile(null);
    setImmersiveMode(false);
    setRedClawNavigationAction({
      action: 'open-session',
      sessionId: nextSessionId,
      nonce: Date.now(),
    });
    setCurrentView('redclaw');
  }, [setActiveManuscriptEditorFile, setCurrentView, setImmersiveMode]);

  return {
    redclawOnboardingVersion,
    pendingRedClawMessage,
    redClawNavigationAction,
    setRedClawNavigationAction,
    navigateToRedClaw,
    openRedClawOnboarding,
    clearPendingRedClawMessage,
    clearRedClawNavigationAction,
    navigateToManuscript,
    closeManuscriptEditor,
    openRedClawChatSurface,
    openRedClawSession,
  };
}
