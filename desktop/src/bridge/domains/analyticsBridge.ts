import type { BridgeCore } from '../types';

export type AnalyticsConsent = 'none' | 'prompt' | 'approved';

export type AnalyticsEventName =
  | 'app_launched'
  | 'surface_viewed'
  | 'settings_changed'
  | 'acquisition_survey_shown'
  | 'acquisition_survey_answered'
  | 'acquisition_survey_skipped'
  | 'onboarding_step_viewed'
  | 'onboarding_step_completed'
  | 'onboarding_completed'
  | 'ai_turn_started'
  | 'ai_turn_completed'
  | 'ai_turn_failed'
  | 'user_signed_in'
  | 'user_signed_out'
  | 'membership_status_loaded'
  | 'membership_activated'
  | 'founder_sponsor_modal_opened'
  | 'founder_sponsor_purchase_clicked'
  | 'checkout_started'
  | 'checkout_opened'
  | 'checkout_completed'
  | 'checkout_completed_inferred'
  | 'checkout_failed'
  | 'redclaw_task_submitted'
  | 'media_generation_requested'
  | 'media_job_completed'
  | 'media_job_failed'
  | 'knowledge_item_added'
  | 'topic_center_viewed'
  | 'topic_source_selected'
  | 'topic_generation_started'
  | 'topic_generation_completed'
  | 'topic_generation_failed'
  | 'topic_selected'
  | 'topic_option_selected'
  | 'topic_abandoned_toggled'
  | 'topic_deleted'
  | 'topic_used_for_task';

export type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>;

export interface AnalyticsStatus {
  consent: AnalyticsConsent;
  enabled: boolean;
  endpoint: string;
  pendingCount: number;
}

export function createAnalyticsBridge(core: BridgeCore) {
  return {
    analytics: {
      getStatus: () => core.invokeChannelGuarded<AnalyticsStatus>('analytics:status', undefined, {
        fallback: {
          consent: 'approved',
          enabled: true,
          endpoint: '',
          pendingCount: 0,
        },
      }),
      setConsent: (consent: AnalyticsConsent) => core.invokeChannel('analytics:set-consent', { consent }),
      track: (
        event: AnalyticsEventName,
        payload?: {
          surface?: string;
          origin?: string;
          properties?: AnalyticsProperties;
        },
      ) => core.invokeChannelGuarded('analytics:track', {
        event,
        surface: payload?.surface,
        origin: payload?.origin,
        properties: payload?.properties || {},
      }, {
        fallback: { success: true, queued: false, skipped: 'unavailable' },
      }),
      flush: () => core.invokeChannel('analytics:flush'),
      clearQueue: () => core.invokeChannel('analytics:clear-queue'),
    },
  };
}
