import type { BridgeCore } from '../types';

export function createAdvisorsBridge(core: BridgeCore) {
  return {
    advisors: {
      list: <T = Record<string, unknown>>() => core.invokeCommandGuarded<Array<T>>(
        'advisors_list',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'advisors:list',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      listTemplates: <T = Record<string, unknown>>() => core.invokeCommandGuarded<Array<T>>(
        'advisors_list_templates',
        undefined,
        {
          timeoutMs: 3200,
          fallbackChannel: 'advisors:list-templates',
          normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
        },
      ),
      create: (payload: Record<string, unknown>) => core.invokeChannel('advisors:create', payload),
      update: (payload: Record<string, unknown>) => core.invokeChannel('advisors:update', payload),
      delete: (advisorId: string) => core.invokeChannel('advisors:delete', advisorId),
      pickKnowledgeFiles: <T = Record<string, unknown>>() => core.invokeChannel('advisors:pick-knowledge-files') as Promise<T>,
      pickKnowledgeFolder: <T = Record<string, unknown>>() => core.invokeChannel('advisors:pick-knowledge-folder') as Promise<T>,
      uploadKnowledge: (payload: string | { advisorId: string; filePaths?: string[] }) => core.invokeChannel('advisors:upload-knowledge', payload),
      deleteKnowledge: (payload: { advisorId: string; fileName: string }) => core.invokeChannel('advisors:delete-knowledge', payload),
      inspectMemberSkill: (payload: { advisorId: string }) => core.invokeChannel('advisors:inspect-member-skill', payload),
      distillMemberSkill: (payload: { advisorId: string }) => core.invokeChannel('members:enqueue-distillation', payload),
      promoteMemberSkillCandidate: (payload: { advisorId: string; candidateVersion?: string }) =>
        core.invokeChannel('advisors:promote-member-skill-candidate', payload),
      discardMemberSkillCandidate: (payload: { advisorId: string }) => core.invokeChannel('advisors:discard-member-skill-candidate', payload),
      rollbackMemberSkillVersion: (payload: { advisorId: string; version: string }) => core.invokeChannel('advisors:rollback-member-skill-version', payload),
      optimizePrompt: (payload: Record<string, unknown>) => core.invokeChannel('advisors:optimize-prompt', payload),
      optimizePromptDeep: (payload: Record<string, unknown>) => core.invokeChannel('advisors:optimize-prompt-deep', payload),
      generatePersona: (payload: Record<string, unknown>) => core.invokeChannel('advisors:generate-persona', payload),
      selectAvatar: () => core.invokeChannel('advisors:select-avatar'),
    },
    fetchYoutubeInfo: (channelUrl: string) => core.invokeChannel('advisors:fetch-youtube-info', { channelUrl }),
    downloadYoutubeSubtitles: (params: Record<string, unknown>) => core.invokeChannel('advisors:download-youtube-subtitles', params),
    refreshVideos: (advisorId: string, limit?: number) => core.invokeChannel('advisors:refresh-videos', { advisorId, limit }),
    getVideos: (advisorId: string) => core.invokeChannel('advisors:get-videos', { advisorId }),
    downloadVideo: (advisorId: string, videoId: string) => core.invokeChannel('advisors:download-video', { advisorId, videoId }),
    retryFailedVideos: (advisorId: string) => core.invokeChannel('advisors:retry-failed', { advisorId }),
    updateAdvisorYoutubeSettings: (advisorId: string, settings: unknown) => core.invokeChannel('advisors:update-youtube-settings', { advisorId, settings }),
    getAdvisorYoutubeRunnerStatus: () => core.invokeChannel('advisors:youtube-runner-status'),
    runAdvisorYoutubeNow: (advisorId?: string) => core.invokeChannel('advisors:youtube-runner-run-now', { advisorId }),
  };
}
