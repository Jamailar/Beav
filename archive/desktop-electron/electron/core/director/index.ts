/**
 * Director Module - 总监与讨论流程管理
 */

export {
    DirectorAgent,
    createDirectorAgent,
    DIRECTOR_ID,
    DIRECTOR_NAME,
    DIRECTOR_AVATAR,
    type DirectorConfig,
    type DirectorEvent,
    type ConversationMessage,
} from './DirectorAgent';

export {
    DiscussionFlowService,
    createDiscussionFlowService,
    type DiscussionConfig,
    type AdvisorInfo,
    type DiscussionMessage,
} from './DiscussionFlowService';

export {
    multiStageRAG,
    buildEnhancedSystemPrompt,
    getCriticalThinkingPrompt,
    getSelfValidationPrompt,
    type WorkflowContext,
    type RAGResult,
    type EnhancedRAGResult,
} from './EnhancedAdvisorWorkflow';

// 智能检索模块
export {
    QueryPlanner,
    createQueryPlanner,
    type QueryPlannerConfig,
    type AdvisorContext,
    type ConversationContext,
    type QueryPlan,
    type SearchQuery,
} from './QueryPlanner';

export {
    SmartRetrieval,
    createSmartRetrieval,
    type SmartRetrievalConfig,
    type RetrievalSource,
    type SmartRetrievalResult,
    type RetrievalEvent,
} from './SmartRetrieval';
