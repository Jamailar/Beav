use crate::{cli_runtime, runtime::*};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpaceRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SubjectAttribute {
    pub(crate) key: String,
    pub(crate) value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubjectSku {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) attributes: Vec<SubjectAttribute>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubjectCategory {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubjectRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) category_id: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) tags: Vec<String>,
    pub(crate) attributes: Vec<SubjectAttribute>,
    pub(crate) image_paths: Vec<String>,
    pub(crate) voice_path: Option<String>,
    pub(crate) video_path: Option<String>,
    pub(crate) voice_script: Option<String>,
    pub(crate) voice: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) brand_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) skus: Vec<SubjectSku>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) absolute_image_paths: Vec<String>,
    pub(crate) preview_urls: Vec<String>,
    pub(crate) primary_preview_url: Option<String>,
    pub(crate) absolute_voice_path: Option<String>,
    pub(crate) voice_preview_url: Option<String>,
    pub(crate) absolute_video_path: Option<String>,
    pub(crate) video_preview_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSessionRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) deleted_at: Option<i64>,
    #[serde(default)]
    pub(crate) starred: bool,
    #[serde(default)]
    pub(crate) archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatMessageRecord {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) role: String,
    pub(crate) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) attachment: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<Value>,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSessionContextRecord {
    pub(crate) session_id: String,
    pub(crate) summary: String,
    pub(crate) summary_source: String,
    pub(crate) total_message_count: i64,
    pub(crate) compacted_message_count: i64,
    pub(crate) tail_message_count: i64,
    pub(crate) compact_rounds: i64,
    pub(crate) summary_chars: i64,
    pub(crate) estimated_total_tokens: i64,
    pub(crate) first_user_message: Option<String>,
    pub(crate) last_user_message: Option<String>,
    pub(crate) last_assistant_message: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManuscriptWriteProposalRecord {
    pub(crate) id: String,
    pub(crate) file_path: String,
    pub(crate) session_id: Option<String>,
    pub(crate) tool_call_id: Option<String>,
    pub(crate) draft_type: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) metadata: Option<Value>,
    pub(crate) base_content: String,
    pub(crate) proposed_content: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdvisorRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) avatar: String,
    pub(crate) personality: String,
    pub(crate) system_prompt: String,
    pub(crate) knowledge_language: Option<String>,
    pub(crate) knowledge_files: Vec<String>,
    pub(crate) youtube_channel: Option<Value>,
    pub(crate) member_skill_ref: Option<String>,
    pub(crate) member_skill_status: Option<String>,
    pub(crate) member_skill_version: Option<String>,
    pub(crate) member_skill_last_distilled_at: Option<String>,
    pub(crate) member_skill_last_error: Option<String>,
    pub(crate) member_skill_candidate_version: Option<String>,
    pub(crate) member_skill_candidate_path: Option<String>,
    pub(crate) member_skill_candidate_created_at: Option<String>,
    pub(crate) member_skill_candidate_source_event: Option<String>,
    pub(crate) detected_knowledge_language: Option<String>,
    pub(crate) language_detection_status: Option<String>,
    pub(crate) language_confidence: Option<f64>,
    pub(crate) redclaw_visible: Option<bool>,
    pub(crate) redclaw_order: Option<i64>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdvisorVideoRecord {
    pub(crate) id: String,
    pub(crate) advisor_id: String,
    pub(crate) title: String,
    pub(crate) published_at: String,
    pub(crate) status: String,
    pub(crate) retry_count: i64,
    pub(crate) error_message: Option<String>,
    pub(crate) subtitle_file: Option<String>,
    pub(crate) video_url: Option<String>,
    pub(crate) channel_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRoomRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) advisor_ids: Vec<String>,
    pub(crate) created_at: String,
    pub(crate) is_system: Option<bool>,
    pub(crate) system_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRoomMessageRecord {
    pub(crate) id: String,
    pub(crate) room_id: String,
    pub(crate) role: String,
    pub(crate) advisor_id: Option<String>,
    pub(crate) advisor_name: Option<String>,
    pub(crate) advisor_avatar: Option<String>,
    pub(crate) content: String,
    pub(crate) timestamp: String,
    pub(crate) is_streaming: Option<bool>,
    pub(crate) phase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WechatOfficialBindingRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) app_id: String,
    pub(crate) secret: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) verified_at: Option<String>,
    pub(crate) is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddingCacheRecord {
    pub(crate) file_path: String,
    pub(crate) content_hash: String,
    pub(crate) embedding: Vec<f64>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SimilarityCacheRecord {
    pub(crate) manuscript_id: String,
    pub(crate) content_hash: String,
    pub(crate) knowledge_version: String,
    pub(crate) sorted_ids: Vec<String>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WanderHistoryRecord {
    pub(crate) id: String,
    pub(crate) items: String,
    pub(crate) result: String,
    pub(crate) created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct YoutubeVideoRecord {
    pub(crate) id: String,
    pub(crate) video_id: String,
    pub(crate) video_url: String,
    pub(crate) title: String,
    pub(crate) original_title: Option<String>,
    pub(crate) description: String,
    pub(crate) summary: Option<String>,
    pub(crate) thumbnail_url: String,
    pub(crate) has_subtitle: bool,
    pub(crate) subtitle_content: Option<String>,
    pub(crate) subtitle_error: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) created_at: String,
    pub(crate) folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AppStore {
    pub(crate) settings: Value,
    pub(crate) spaces: Vec<SpaceRecord>,
    pub(crate) active_space_id: String,
    pub(crate) subjects: Vec<SubjectRecord>,
    pub(crate) categories: Vec<SubjectCategory>,
    pub(crate) advisors: Vec<AdvisorRecord>,
    pub(crate) advisor_videos: Vec<AdvisorVideoRecord>,
    pub(crate) chat_rooms: Vec<ChatRoomRecord>,
    pub(crate) chatroom_messages: Vec<ChatRoomMessageRecord>,
    pub(crate) wechat_official_bindings: Vec<WechatOfficialBindingRecord>,
    pub(crate) embedding_cache: Vec<EmbeddingCacheRecord>,
    pub(crate) similarity_cache: Vec<SimilarityCacheRecord>,
    pub(crate) wander_history: Vec<WanderHistoryRecord>,
    pub(crate) chat_sessions: Vec<ChatSessionRecord>,
    pub(crate) chat_messages: Vec<ChatMessageRecord>,
    pub(crate) session_context_records: Vec<ChatSessionContextRecord>,
    pub(crate) manuscript_write_proposals: Vec<ManuscriptWriteProposalRecord>,
    pub(crate) youtube_videos: Vec<YoutubeVideoRecord>,
    pub(crate) knowledge_notes: Vec<KnowledgeNoteRecord>,
    pub(crate) knowledge_authors: Vec<KnowledgeAuthorRecord>,
    pub(crate) document_sources: Vec<DocumentKnowledgeSourceRecord>,
    pub(crate) session_transcript_records: Vec<SessionTranscriptRecord>,
    pub(crate) session_checkpoints: Vec<SessionCheckpointRecord>,
    pub(crate) session_tool_results: Vec<SessionToolResultRecord>,
    pub(crate) runtime_tasks: Vec<RuntimeTaskRecord>,
    pub(crate) runtime_task_traces: Vec<RuntimeTaskTraceRecord>,
    pub(crate) collab_sessions: Vec<CollabSessionRecord>,
    pub(crate) collab_members: Vec<CollabMemberRecord>,
    pub(crate) collab_tasks: Vec<CollabTaskRecord>,
    pub(crate) collab_mailbox_messages: Vec<CollabMailboxMessageRecord>,
    pub(crate) collab_progress_reports: Vec<CollabProgressReportRecord>,
    pub(crate) review_dockets: Vec<ReviewDocketRecord>,
    pub(crate) review_decisions: Vec<ReviewDecisionRecord>,
    pub(crate) cli_tools: Vec<cli_runtime::CliToolRecord>,
    pub(crate) cli_environments: Vec<cli_runtime::CliEnvironmentRecord>,
    pub(crate) cli_manifests: Vec<cli_runtime::CliToolManifestRecord>,
    pub(crate) cli_executions: Vec<cli_runtime::CliExecutionRecord>,
    pub(crate) cli_escalations: Vec<cli_runtime::CliEscalationRequestRecord>,
    pub(crate) cli_verifications: Vec<cli_runtime::CliVerificationRecord>,
    pub(crate) debug_logs: Vec<String>,
    pub(crate) archive_profiles: Vec<ArchiveProfileRecord>,
    pub(crate) archive_samples: Vec<ArchiveSampleRecord>,
    pub(crate) memories: Vec<UserMemoryRecord>,
    pub(crate) memory_history: Vec<MemoryHistoryRecord>,
    pub(crate) mcp_servers: Vec<McpServerRecord>,
    pub(crate) runtime_hooks: Vec<RuntimeHookRecord>,
    pub(crate) skills: Vec<SkillRecord>,
    pub(crate) assistant_state: AssistantStateRecord,
    pub(crate) redclaw_state: RedclawStateRecord,
    pub(crate) redclaw_job_definitions: Vec<RedclawJobDefinitionRecord>,
    pub(crate) redclaw_job_executions: Vec<RedclawJobExecutionRecord>,
    pub(crate) media_assets: Vec<MediaAssetRecord>,
    pub(crate) cover_assets: Vec<CoverAssetRecord>,
    pub(crate) work_items: Vec<WorkItemRecord>,
    pub(crate) legacy_imported_at: Option<String>,
    pub(crate) legacy_import_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AssistantStateRecord {
    pub(crate) enabled: bool,
    pub(crate) auto_start: bool,
    pub(crate) keep_alive_when_no_window: bool,
    pub(crate) host: String,
    pub(crate) port: i64,
    pub(crate) listening: bool,
    pub(crate) lock_state: String,
    pub(crate) blocked_by: Option<String>,
    pub(crate) last_error: Option<String>,
    pub(crate) active_task_count: i64,
    pub(crate) queued_peer_count: i64,
    pub(crate) in_flight_keys: Vec<String>,
    pub(crate) feishu: Value,
    pub(crate) relay: Value,
    pub(crate) weixin: Value,
    pub(crate) knowledge_api: Value,
}

impl Default for AssistantStateRecord {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_start: true,
            keep_alive_when_no_window: true,
            host: "127.0.0.1".to_string(),
            port: 31937,
            listening: false,
            lock_state: "passive".to_string(),
            blocked_by: None,
            last_error: Some("Assistant daemon is idle.".to_string()),
            active_task_count: 0,
            queued_peer_count: 0,
            in_flight_keys: Vec::new(),
            feishu: json!({
                "enabled": false,
                "receiveMode": "webhook",
                "endpointPath": "/hooks/feishu/events",
                "replyUsingChatId": true,
                "webhookUrl": "",
                "websocketRunning": false
            }),
            relay: json!({
                "enabled": true,
                "endpointPath": "/hooks/channel/relay",
                "authToken": "",
                "webhookUrl": ""
            }),
            weixin: json!({
                "enabled": false,
                "endpointPath": "/hooks/weixin/relay",
                "authToken": "",
                "accountId": "",
                "autoStartSidecar": false,
                "cursorFile": "",
                "sidecarCommand": "",
                "sidecarArgs": [],
                "sidecarCwd": "",
                "sidecarEnv": {},
                "webhookUrl": "",
                "sidecarRunning": false,
                "connected": false,
                "stateDir": "",
                "availableAccountIds": []
            }),
            knowledge_api: json!({
                "endpointPath": "/api/knowledge",
                "webhookUrl": ""
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveProfileRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) platform: Option<String>,
    pub(crate) goal: Option<String>,
    pub(crate) domain: Option<String>,
    pub(crate) audience: Option<String>,
    pub(crate) tone_tags: Vec<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveSampleRecord {
    pub(crate) id: String,
    pub(crate) profile_id: String,
    pub(crate) title: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) excerpt: Option<String>,
    pub(crate) tags: Vec<String>,
    pub(crate) images: Vec<String>,
    pub(crate) platform: Option<String>,
    pub(crate) source_url: Option<String>,
    pub(crate) sample_date: Option<String>,
    pub(crate) is_featured: i64,
    pub(crate) created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserMemoryRecord {
    pub(crate) id: String,
    pub(crate) content: String,
    pub(crate) r#type: String,
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) entities: Vec<String>,
    #[serde(default)]
    pub(crate) scope: Option<String>,
    #[serde(default)]
    pub(crate) space_id: Option<String>,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<Value>,
    #[serde(default)]
    pub(crate) confidence: Option<f64>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: Option<i64>,
    pub(crate) last_accessed: Option<i64>,
    pub(crate) status: Option<String>,
    pub(crate) archived_at: Option<i64>,
    pub(crate) archive_reason: Option<String>,
    pub(crate) origin_id: Option<String>,
    pub(crate) canonical_key: Option<String>,
    pub(crate) revision: Option<i64>,
    pub(crate) last_conflict_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryHistoryRecord {
    pub(crate) id: String,
    pub(crate) memory_id: String,
    pub(crate) origin_id: String,
    pub(crate) action: String,
    pub(crate) reason: Option<String>,
    pub(crate) timestamp: i64,
    pub(crate) before: Option<Value>,
    pub(crate) after: Option<Value>,
    pub(crate) archived_memory_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeNoteStatsRecord {
    pub(crate) likes: i64,
    pub(crate) collects: Option<i64>,
    pub(crate) comments: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeNoteRecord {
    pub(crate) id: String,
    pub(crate) r#type: Option<String>,
    pub(crate) source_domain: Option<String>,
    pub(crate) source_link: Option<String>,
    pub(crate) source_url: Option<String>,
    pub(crate) title: String,
    pub(crate) author: String,
    pub(crate) author_id: Option<String>,
    pub(crate) author_url: Option<String>,
    pub(crate) author_avatar_url: Option<String>,
    pub(crate) author_description: Option<String>,
    pub(crate) content: String,
    pub(crate) excerpt: Option<String>,
    pub(crate) site_name: Option<String>,
    pub(crate) capture_kind: Option<String>,
    pub(crate) metadata: Option<Value>,
    pub(crate) html_file: Option<String>,
    pub(crate) html_file_url: Option<String>,
    pub(crate) images: Vec<String>,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) cover: Option<String>,
    pub(crate) video: Option<String>,
    pub(crate) video_url: Option<String>,
    pub(crate) transcript: Option<String>,
    pub(crate) transcription_status: Option<String>,
    pub(crate) stats: KnowledgeNoteStatsRecord,
    pub(crate) created_at: String,
    pub(crate) folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeAuthorRecord {
    pub(crate) id: String,
    pub(crate) r#type: String,
    pub(crate) name: String,
    pub(crate) platform: String,
    pub(crate) platform_user_id: Option<String>,
    pub(crate) handle: Option<String>,
    pub(crate) profile_url: Option<String>,
    pub(crate) avatar_url: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) source_domain: Option<String>,
    pub(crate) linked_note_ids: Vec<String>,
    pub(crate) note_count: i64,
    pub(crate) first_seen_at: String,
    pub(crate) latest_note_at: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentKnowledgeSourceRecord {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) root_path: String,
    pub(crate) locked: bool,
    pub(crate) indexing: bool,
    pub(crate) index_error: Option<String>,
    pub(crate) file_count: i64,
    pub(crate) sample_files: Vec<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAssetRecord {
    pub(crate) id: String,
    pub(crate) source: String,
    pub(crate) source_domain: Option<String>,
    pub(crate) source_link: Option<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) provider_template: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) aspect_ratio: Option<String>,
    pub(crate) size: Option<String>,
    pub(crate) quality: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) content_hash: Option<String>,
    pub(crate) relative_path: Option<String>,
    pub(crate) bound_manuscript_path: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) absolute_path: Option<String>,
    pub(crate) preview_url: Option<String>,
    pub(crate) thumbnail_url: Option<String>,
    pub(crate) exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoverAssetRecord {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) template_name: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) provider_template: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) aspect_ratio: Option<String>,
    pub(crate) size: Option<String>,
    pub(crate) quality: Option<String>,
    pub(crate) relative_path: Option<String>,
    pub(crate) preview_url: Option<String>,
    pub(crate) exists: bool,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkRefsRecord {
    pub(crate) project_ids: Vec<String>,
    pub(crate) session_ids: Vec<String>,
    pub(crate) task_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkScheduleRecord {
    pub(crate) mode: String,
    pub(crate) interval_minutes: Option<i64>,
    pub(crate) time: Option<String>,
    pub(crate) weekdays: Option<Vec<i64>>,
    pub(crate) run_at: Option<String>,
    pub(crate) next_run_at: Option<String>,
    pub(crate) completed_rounds: Option<i64>,
    pub(crate) total_rounds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkItemRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: Option<String>,
    pub(crate) summary: Option<String>,
    pub(crate) status: String,
    pub(crate) effective_status: String,
    pub(crate) priority: i64,
    pub(crate) r#type: String,
    pub(crate) blocked_by: Vec<String>,
    pub(crate) refs: WorkRefsRecord,
    pub(crate) metadata: Option<Value>,
    pub(crate) schedule: WorkScheduleRecord,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRuntimeStateRecord {
    pub(crate) session_id: String,
    pub(crate) is_processing: bool,
    pub(crate) partial_response: String,
    pub(crate) updated_at: u128,
    pub(crate) error: Option<String>,
    pub(crate) cancel_requested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorRuntimeStateRecord {
    pub(crate) file_path: String,
    pub(crate) session_id: Option<String>,
    pub(crate) playhead_seconds: f64,
    pub(crate) selected_clip_id: Option<String>,
    pub(crate) selected_clip_ids: Option<Value>,
    pub(crate) active_track_id: Option<String>,
    pub(crate) selected_track_ids: Option<Value>,
    pub(crate) selected_scene_id: Option<String>,
    pub(crate) preview_tab: Option<String>,
    pub(crate) canvas_ratio_preset: Option<String>,
    pub(crate) active_panel: Option<String>,
    pub(crate) drawer_panel: Option<String>,
    pub(crate) scene_item_transforms: Option<Value>,
    pub(crate) scene_item_visibility: Option<Value>,
    pub(crate) scene_item_order: Option<Value>,
    pub(crate) scene_item_locks: Option<Value>,
    pub(crate) scene_item_groups: Option<Value>,
    pub(crate) focused_group_id: Option<String>,
    pub(crate) track_ui: Option<Value>,
    pub(crate) viewport_scroll_left: f64,
    pub(crate) viewport_max_scroll_left: f64,
    pub(crate) viewport_scroll_top: f64,
    pub(crate) viewport_max_scroll_top: f64,
    pub(crate) timeline_zoom_percent: f64,
    pub(crate) undo_stack: Vec<Value>,
    pub(crate) redo_stack: Vec<Value>,
    pub(crate) updated_at: u128,
}
