import { useCallback, useEffect, useState } from 'react';
import { OPEN_FEEDBACK_REPORT_EVENT, type FeedbackReportContext } from '../../components/FeedbackReportDialog';
import type { ViewType } from './types';

const FEEDBACK_REPORT_SUBMITTED_EVENT = 'redbox:feedback-report-submitted';

export function useFeedbackReportDialog(currentView: ViewType) {
  const [feedbackReportOpen, setFeedbackReportOpen] = useState(false);
  const [feedbackReportContext, setFeedbackReportContext] = useState<FeedbackReportContext | null>(null);

  const openFeedbackReport = useCallback((context?: FeedbackReportContext | null) => {
    setFeedbackReportContext({
      sourcePage: currentView,
      ...(context || {}),
    });
    setFeedbackReportOpen(true);
  }, [currentView]);

  const closeFeedbackReport = useCallback(() => {
    setFeedbackReportOpen(false);
  }, []);

  const notifyFeedbackReportSubmitted = useCallback(() => {
    window.dispatchEvent(new CustomEvent(FEEDBACK_REPORT_SUBMITTED_EVENT));
  }, []);

  useEffect(() => {
    const handleOpenFeedbackReport = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      openFeedbackReport(detail && typeof detail === 'object' ? detail as FeedbackReportContext : null);
    };
    window.addEventListener(OPEN_FEEDBACK_REPORT_EVENT, handleOpenFeedbackReport);
    return () => window.removeEventListener(OPEN_FEEDBACK_REPORT_EVENT, handleOpenFeedbackReport);
  }, [openFeedbackReport]);

  return {
    feedbackReportOpen,
    feedbackReportContext,
    openFeedbackReport,
    closeFeedbackReport,
    notifyFeedbackReportSubmitted,
  };
}
