use dirs::config_dir;
use serde_json::json;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::MutexGuard;
use tauri::State;

use crate::runtime::SkillRecord;
use crate::scheduler::sync_redclaw_job_definitions;
use crate::workspace_loaders::{
    load_chat_rooms_from_fs, load_chatroom_messages_from_fs, load_memories_from_fs,
    load_memory_history_from_fs,
};
use crate::{
    active_space_workspace_root_from_store, load_advisors_from_fs, load_cover_assets_from_fs,
    load_document_sources_from_fs, load_knowledge_notes_from_fs, load_media_assets_from_fs,
    load_redclaw_state_from_fs, load_subject_categories_from_fs, load_subjects_from_fs,
    load_work_items_from_fs, load_youtube_videos_from_fs, now_iso, AppState, AppStore,
    AssistantStateRecord, RedclawStateRecord, SpaceRecord,
};

pub(crate) struct WorkspaceHydrationSnapshot {
    categories: Vec<crate::SubjectCategory>,
    subjects: Vec<crate::SubjectRecord>,
    advisors: Vec<crate::AdvisorRecord>,
    chat_rooms: Vec<crate::ChatRoomRecord>,
    chatroom_messages: Vec<crate::ChatRoomMessageRecord>,
    memories: Vec<crate::UserMemoryRecord>,
    memory_history: Vec<crate::MemoryHistoryRecord>,
    media_assets: Vec<crate::MediaAssetRecord>,
    cover_assets: Vec<crate::CoverAssetRecord>,
    knowledge_notes: Vec<crate::KnowledgeNoteRecord>,
    youtube_videos: Vec<crate::YoutubeVideoRecord>,
    document_sources: Vec<crate::DocumentKnowledgeSourceRecord>,
    redclaw_state: RedclawStateRecord,
    work_items: Vec<crate::WorkItemRecord>,
}

pub(crate) struct KnowledgeHydrationSnapshot {
    knowledge_notes: Vec<crate::KnowledgeNoteRecord>,
    youtube_videos: Vec<crate::YoutubeVideoRecord>,
    document_sources: Vec<crate::DocumentKnowledgeSourceRecord>,
}

pub(crate) struct SubjectsHydrationSnapshot {
    categories: Vec<crate::SubjectCategory>,
    subjects: Vec<crate::SubjectRecord>,
}

pub(crate) struct ChatroomsHydrationSnapshot {
    chat_rooms: Vec<crate::ChatRoomRecord>,
    chatroom_messages: Vec<crate::ChatRoomMessageRecord>,
}

pub(crate) struct MediaHydrationSnapshot {
    media_assets: Vec<crate::MediaAssetRecord>,
}

pub(crate) struct CoverHydrationSnapshot {
    cover_assets: Vec<crate::CoverAssetRecord>,
}

pub(crate) struct AdvisorsHydrationSnapshot {
    advisors: Vec<crate::AdvisorRecord>,
}

pub(crate) struct RedclawHydrationSnapshot {
    redclaw_state: RedclawStateRecord,
    work_items: Vec<crate::WorkItemRecord>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PersistedSessionArtifacts {
    session_id: String,
    updated_at: String,
    chat_messages: Vec<crate::ChatMessageRecord>,
    session_transcript_records: Vec<crate::SessionTranscriptRecord>,
    session_checkpoints: Vec<crate::SessionCheckpointRecord>,
    session_tool_results: Vec<crate::SessionToolResultRecord>,
}

pub(crate) fn load_workspace_hydration_snapshot(root: &Path) -> WorkspaceHydrationSnapshot {
    WorkspaceHydrationSnapshot {
        categories: load_subject_categories_from_fs(&root.join("subjects")),
        subjects: load_subjects_from_fs(&root.join("subjects")),
        advisors: load_advisors_from_fs(&root.join("advisors")),
        chat_rooms: load_chat_rooms_from_fs(&root.join("chatrooms")),
        chatroom_messages: load_chatroom_messages_from_fs(&root.join("chatrooms")),
        memories: load_memories_from_fs(&root.join("memory")),
        memory_history: load_memory_history_from_fs(&root.join("memory")),
        media_assets: load_media_assets_from_fs(&root.join("media")),
        cover_assets: load_cover_assets_from_fs(&root.join("cover")),
        knowledge_notes: load_knowledge_notes_from_fs(&root.join("knowledge")),
        youtube_videos: load_youtube_videos_from_fs(&root.join("knowledge")),
        document_sources: load_document_sources_from_fs(&root.join("knowledge")),
        redclaw_state: load_redclaw_state_from_fs(&root.join("redclaw")),
        work_items: load_work_items_from_fs(&root.join("redclaw")),
    }
}

pub(crate) fn load_knowledge_hydration_snapshot(root: &Path) -> KnowledgeHydrationSnapshot {
    let knowledge_root = root.join("knowledge");
    KnowledgeHydrationSnapshot {
        knowledge_notes: load_knowledge_notes_from_fs(&knowledge_root),
        youtube_videos: load_youtube_videos_from_fs(&knowledge_root),
        document_sources: load_document_sources_from_fs(&knowledge_root),
    }
}

pub(crate) fn apply_knowledge_hydration_snapshot(
    store: &mut AppStore,
    snapshot: KnowledgeHydrationSnapshot,
) {
    store.knowledge_notes = snapshot.knowledge_notes;
    store.youtube_videos = snapshot.youtube_videos;
    store.document_sources = snapshot.document_sources;
}

pub(crate) fn load_subjects_hydration_snapshot(root: &Path) -> SubjectsHydrationSnapshot {
    let subjects_root = root.join("subjects");
    SubjectsHydrationSnapshot {
        categories: load_subject_categories_from_fs(&subjects_root),
        subjects: load_subjects_from_fs(&subjects_root),
    }
}

pub(crate) fn apply_subjects_hydration_snapshot(
    store: &mut AppStore,
    snapshot: SubjectsHydrationSnapshot,
) {
    store.categories = snapshot.categories;
    store.subjects = snapshot.subjects;
}

pub(crate) fn load_chatrooms_hydration_snapshot(root: &Path) -> ChatroomsHydrationSnapshot {
    let chatrooms_root = root.join("chatrooms");
    ChatroomsHydrationSnapshot {
        chat_rooms: load_chat_rooms_from_fs(&chatrooms_root),
        chatroom_messages: load_chatroom_messages_from_fs(&chatrooms_root),
    }
}

pub(crate) fn apply_chatrooms_hydration_snapshot(
    store: &mut AppStore,
    snapshot: ChatroomsHydrationSnapshot,
) {
    store.chat_rooms = snapshot.chat_rooms;
    store.chatroom_messages = snapshot.chatroom_messages;
}

pub(crate) fn load_media_hydration_snapshot(root: &Path) -> MediaHydrationSnapshot {
    MediaHydrationSnapshot {
        media_assets: load_media_assets_from_fs(&root.join("media")),
    }
}

pub(crate) fn apply_media_hydration_snapshot(
    store: &mut AppStore,
    snapshot: MediaHydrationSnapshot,
) {
    store.media_assets = snapshot.media_assets;
}

pub(crate) fn load_cover_hydration_snapshot(root: &Path) -> CoverHydrationSnapshot {
    CoverHydrationSnapshot {
        cover_assets: load_cover_assets_from_fs(&root.join("cover")),
    }
}

pub(crate) fn apply_cover_hydration_snapshot(
    store: &mut AppStore,
    snapshot: CoverHydrationSnapshot,
) {
    store.cover_assets = snapshot.cover_assets;
}

pub(crate) fn load_advisors_hydration_snapshot(root: &Path) -> AdvisorsHydrationSnapshot {
    AdvisorsHydrationSnapshot {
        advisors: load_advisors_from_fs(&root.join("advisors")),
    }
}

pub(crate) fn apply_advisors_hydration_snapshot(
    store: &mut AppStore,
    snapshot: AdvisorsHydrationSnapshot,
) {
    store.advisors = snapshot.advisors;
}

pub(crate) fn load_redclaw_hydration_snapshot(root: &Path) -> RedclawHydrationSnapshot {
    let redclaw_root = root.join("redclaw");
    RedclawHydrationSnapshot {
        redclaw_state: load_redclaw_state_from_fs(&redclaw_root),
        work_items: load_work_items_from_fs(&redclaw_root),
    }
}

pub(crate) fn apply_redclaw_hydration_snapshot(
    store: &mut AppStore,
    snapshot: RedclawHydrationSnapshot,
) {
    store.redclaw_state = snapshot.redclaw_state;
    sync_redclaw_job_definitions(store);
    store.work_items = snapshot.work_items;
}

pub(crate) fn apply_workspace_hydration_snapshot(
    store: &mut AppStore,
    snapshot: WorkspaceHydrationSnapshot,
) {
    store.categories = snapshot.categories;
    store.subjects = snapshot.subjects;
    store.advisors = snapshot.advisors;
    store.chat_rooms = snapshot.chat_rooms;
    store.chatroom_messages = snapshot.chatroom_messages;
    store.memories = snapshot.memories;
    store.memory_history = snapshot.memory_history;
    store.media_assets = snapshot.media_assets;
    store.cover_assets = snapshot.cover_assets;
    store.knowledge_notes = snapshot.knowledge_notes;
    store.youtube_videos = snapshot.youtube_videos;
    store.document_sources = snapshot.document_sources;
    store.redclaw_state = snapshot.redclaw_state;
    sync_redclaw_job_definitions(store);
    store.work_items = snapshot.work_items;
}

pub fn build_store_path() -> PathBuf {
    let base = config_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let redbox_dir = base.join("RedBox");
    let redbox_path = redbox_dir.join("redbox-state.json");

    if redbox_path.exists() {
        let _ = fs::create_dir_all(&redbox_dir);
        return redbox_path;
    }

    let _ = fs::create_dir_all(&redbox_dir);
    redbox_path
}

fn store_root_from_store_path(store_path: &Path) -> Result<PathBuf, String> {
    let root = store_path
        .parent()
        .ok_or_else(|| "RedBox store root is unavailable".to_string())?
        .to_path_buf();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn session_artifact_dir(store_path: &Path) -> Result<PathBuf, String> {
    let dir = store_root_from_store_path(store_path)?.join("session-artifacts");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn session_artifact_path(store_path: &Path, session_id: &str) -> Result<PathBuf, String> {
    Ok(session_artifact_dir(store_path)?.join(format!(
        "{}.json",
        crate::slug_from_relative_path(session_id)
    )))
}

fn append_session_artifacts_bucket<'a>(
    buckets: &'a mut BTreeMap<String, PersistedSessionArtifacts>,
    session_id: &str,
) -> &'a mut PersistedSessionArtifacts {
    buckets
        .entry(session_id.to_string())
        .or_insert_with(|| PersistedSessionArtifacts {
            session_id: session_id.to_string(),
            updated_at: now_iso(),
            ..PersistedSessionArtifacts::default()
        })
}

fn take_session_artifacts_from_store(store: &mut AppStore) -> Vec<PersistedSessionArtifacts> {
    let mut buckets = BTreeMap::<String, PersistedSessionArtifacts>::new();

    for message in std::mem::take(&mut store.chat_messages) {
        append_session_artifacts_bucket(&mut buckets, &message.session_id)
            .chat_messages
            .push(message);
    }
    for record in std::mem::take(&mut store.session_transcript_records) {
        append_session_artifacts_bucket(&mut buckets, &record.session_id)
            .session_transcript_records
            .push(record);
    }
    for record in std::mem::take(&mut store.session_checkpoints) {
        append_session_artifacts_bucket(&mut buckets, &record.session_id)
            .session_checkpoints
            .push(record);
    }
    for record in std::mem::take(&mut store.session_tool_results) {
        append_session_artifacts_bucket(&mut buckets, &record.session_id)
            .session_tool_results
            .push(record);
    }

    buckets
        .into_values()
        .filter(|item| {
            !item.chat_messages.is_empty()
                || !item.session_transcript_records.is_empty()
                || !item.session_checkpoints.is_empty()
                || !item.session_tool_results.is_empty()
        })
        .collect()
}

fn apply_session_artifacts_to_store(store: &mut AppStore, artifacts: PersistedSessionArtifacts) {
    store.chat_messages.extend(artifacts.chat_messages);
    store
        .session_transcript_records
        .extend(artifacts.session_transcript_records);
    store
        .session_checkpoints
        .extend(artifacts.session_checkpoints);
    store
        .session_tool_results
        .extend(artifacts.session_tool_results);
}

fn load_session_artifacts_from_disk(
    store_path: &Path,
) -> Result<Vec<PersistedSessionArtifacts>, String> {
    let dir = session_artifact_dir(store_path)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let artifacts = serde_json::from_str::<PersistedSessionArtifacts>(&content)
            .map_err(|error| error.to_string())?;
        if artifacts.session_id.trim().is_empty() {
            continue;
        }
        items.push(artifacts);
    }
    items.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    Ok(items)
}

fn restore_session_artifacts_from_disk(
    store_path: &Path,
    store: &mut AppStore,
) -> Result<HashSet<String>, String> {
    let mut loaded_ids = HashSet::new();
    for artifacts in load_session_artifacts_from_disk(store_path)? {
        loaded_ids.insert(artifacts.session_id.clone());
        apply_session_artifacts_to_store(store, artifacts);
    }
    Ok(loaded_ids)
}

fn write_session_artifacts_to_disk(
    store_path: &Path,
    artifacts: &[PersistedSessionArtifacts],
) -> Result<(), String> {
    let dir = session_artifact_dir(store_path)?;
    let mut retained_paths = HashSet::<PathBuf>::new();
    for item in artifacts {
        let path = session_artifact_path(store_path, &item.session_id)?;
        let serialized = serde_json::to_string_pretty(item).map_err(|error| error.to_string())?;
        fs::write(&path, serialized).map_err(|error| error.to_string())?;
        retained_paths.insert(path);
    }
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if retained_paths.contains(&path) {
            continue;
        }
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn builtin_skill_records() -> Vec<SkillRecord> {
    vec![
        SkillRecord {
            name: "cover-builder".to_string(),
            description: "封面生成辅助技能".to_string(),
            location: "redbox://skills/cover-builder".to_string(),
            body: "---\nallowedRuntimeModes: [redclaw]\nallowedToolPack: redclaw\nallowedTools: [bash, app_cli]\nhookMode: inline\nautoActivate: false\ncontextNote: 需要明确输出封面标题、构图与提示词。\n---\n# Cover Builder\n\n用于把标题、平台调性和参考素材转成封面方案的内置技能。\n\n## 输出要求\n\n- 提供 3-5 个封面标题方案。\n- 标注主视觉、构图、色彩、字体建议。\n- 如果配置了图片生成 endpoint，优先生成真实封面资产；否则输出可执行的封面提示词。".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "remotion-best-practices".to_string(),
            description: "视频编辑内置 Remotion 官方最佳实践技能".to_string(),
            location: "redbox://skills/remotion-best-practices".to_string(),
            body: "---\nallowedRuntimeModes: [video-editor]\nallowedTools: [bash, app_cli, redbox_editor]\nhookMode: inline\nautoActivate: true\ncontextNote: 当前视频运行时默认启用 Remotion 官方最佳实践知识包。优先按 Composition / Sequence / timing / assets 的思路设计动画，但最终仍以 remotion.scene.json 为宿主真相层，并以 baseMedia.outputPath 作为基础视频。\npromptPrefix: 你当前必须遵守 remotion-best-practices：先读取当前 Remotion 工程状态，再决定 composition/scene 边界、主体 element、timing 与 assets；不要直接虚构任意 React 代码或 CSS 动画。\npromptSuffix: 只使用宿主支持的 Remotion scene/entity/animation 能力落地结果。若官方 Remotion 能力超出宿主范围，必须显式降级为可预览的 scene patch，而不是假装已实现。\n---\n# Remotion Best Practices\n\n用于 `video-editor` 运行时的内置 Remotion 官方最佳实践技能。\n\n- 先 `redbox_editor(action=project_read)` 了解当前视频工程，再 `redbox_editor(action=remotion_read)` 读取当前 Remotion 工程状态。\n- 运行时会自动加载 compositions / animations / sequencing / timing / assets / text-animations / subtitles / transitions / calculate-metadata。\n- 先明确 Composition / scene 边界，再确定主体 element、timing、assets、字幕与导出默认项。\n- 结果必须回写 `remotion.scene.json`，不要退化成脱离宿主的自由 TSX 代码。\n- 若脚本没有明确要求屏幕文字，默认不要生成 `overlayTitle`、`overlayBody`、`overlays` 或解释性 `text` entity；优先只保留动画主体。\n- 不要调用旧时间轴动作编辑视频；基础视频剪辑走 `ffmpeg_edit`，图层动画走 `remotion_*`。\n- 禁止使用 CSS transition、CSS animation 或 Tailwind animate 类名来实现 Remotion 动画。".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "redbox-video-director".to_string(),
            description: "短视频生成导演技能，用于 RedBox 官方视频 API 的分镜脚本确认、参考图引导、首尾帧过渡和多镜头生成。".to_string(),
            location: "redbox://skills/redbox-video-director".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/redbox-video-director/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "skill-creator".to_string(),
            description: "技能创建指导技能，用于创建或更新 SKILL.md、脚本、参考文档、资源和 agents/openai.yaml。".to_string(),
            location: "redbox://skills/skill-creator".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/skill-creator/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "richpost-layout-designer".to_string(),
            description: "图文排版专用技能，用于 richpost 的主题、字体、分页和页面样式调整，并强制保持正文内容不变。".to_string(),
            location: "redbox://skills/richpost-layout-designer".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/richpost-layout-designer/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "richpost-theme-editor".to_string(),
            description: "图文主题编辑专用技能，用于 richpost 的首页、内容页、尾页母版与 layout tokens 调整，并强制只改模板层不改正文。".to_string(),
            location: "redbox://skills/richpost-theme-editor".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/richpost-theme-editor/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "longform-layout-designer".to_string(),
            description: "长文排版专用技能，用于 longform 的母版、分栏、字体和 layout/wechat HTML 样式调整，并强制保持正文内容不变。".to_string(),
            location: "redbox://skills/longform-layout-designer".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/longform-layout-designer/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "image-prompt-optimizer".to_string(),
            description: "当任务准备调用 app_cli(image generate) 做文生图、参考图引导或图生图时，先用它整理最终提示词，避免主体跑偏、风格失控和把说明文字画进图里。".to_string(),
            location: "redbox://skills/image-prompt-optimizer".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/image-prompt-optimizer/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "writing-style".to_string(),
            description: "当任务进入选题 framing、标题拟定、完整写稿、改写、扩写或润色时，用它统一语气、结构和禁区。".to_string(),
            location: "redbox://skills/writing-style".to_string(),
            body: "---\nallowedRuntimeModes: [wander, redclaw, chatroom]\nhookMode: inline\nautoActivate: false\nactivationScope: session\ncontextNote: 这是当前空间统一的写作风格底盘。若任务已经进入选题 framing、标题拟定、完整写稿、改写、扩写、润色，或用户明确提到 writing-style，应优先加载它；非写作任务不要让它干扰其他决策。\npromptPrefix: 你当前已加载 writing-style。凡是涉及选题 framing、完整写稿、改写、扩写、润色或内容表达方式调整，都先按这份技能执行，避免模板化 AI 文案。\npromptSuffix: 如果当前任务不是写作，就不要让 writing-style 主导其他决策；如果当前任务是写作，标题、内容方向、正文和文案细节都必须体现这份技能的约束。\nmaxPromptChars: 2400\n---\n# Writing Style\n\n用于当前空间所有写作相关任务的统一风格底盘技能。\n\n推荐在这些场景加载它，选题 framing、标题拟定、内容方向判断、正文创作、改写、扩写、润色、复盘，以及用户明确要求按既定写作风格继续写的时候。\n\n## 强制规则\n\n- 涉及写作、改写、扩写、润色、复盘，或选题 framing 的任务，都先遵守这份技能。\n- 漫步阶段的标题和内容方向，与 RedClaw 阶段的完整稿件、标签、封面文案，使用同一套风格底盘。\n- 标题和方向先追求具体、有人味、真实张力，再追求工整。\n- 没有真实细节时，不要硬装第一手经历或情绪。\n- 素材是启发、证据和细节候选，不是必须逐条塞进正文的原料。\n- 后续创作优先内容质量、传播性和完成度；若某条素材只适合提供 hook、结构、语气、冲突或视角启发，可以只学其方法，不必强行显式使用。\n- 如果某个素材会拖累成稿质量、破坏叙事完整性或让表达变得生硬，可以舍弃，不要为了“用了素材”而牺牲成稿。\n- 如果当前任务不是写作，不要让本技能主导非写作决策。\n\n## 基础目标\n\n- 像活人说话，不像报告、客服话术或课程总结。\n- 先讲具体场景、动作、问题和处境，再讲抽象判断。\n- 可以有观点，但不要写成无懈可击的上帝视角。\n- 能承认不确定，就不要假装确定。\n\n## 选题判断\n\n先用 HKR 做快速质检。\n\n- H，是否足够有趣，让人想继续看。\n- K，是否真的有信息量，不是在重复常识。\n- R，是否有情绪、处境、冲突或共鸣点。\n\n如果素材只有主题，没有细节、冲突、观点或切口，不要硬写成空方向。标题要落到具体对象、具体处境、反差、问题，或一个可被读者立刻感知的 tension。\n\n## 语言与节奏\n\n- 长短句混用，短段优先。\n- 允许适度口语和停顿感，但不要为了口语而装腔。\n- 转场尽量自然，不要写成报告式大纲。\n\n## 绝对禁区\n\n- 禁用“首先、其次、最后”“综上所述”“值得注意的是”“不难发现”“让我们来看看”。\n- 禁用“说白了”“这意味着”“意味着什么”“本质上”“换句话说”“不可否认”。\n- 禁用“从某素材延展出的内容选题”“围绕这组素材提炼一个方向”这类 AI 占位句。\n- 不编造经历、情绪、案例，不用宏大空话开头。\n- 不要把“把素材都用上”当成目标本身。\n\n## 自检\n\n- 有没有具体场景、对象、动作、问题。\n- 有没有表面像人话，底层判断却很空。\n- 有没有写得太匀速、太整齐、太像模板。\n- 有没有为了照顾素材覆盖率，牺牲标题力度、开头张力或正文自然度。".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
    ]
}

fn ensure_builtin_skills_present(store: &mut AppStore) -> bool {
    let builtins = builtin_skill_records();
    let builtin_names = builtins
        .iter()
        .map(|skill| skill.name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut changed = false;
    let before = store.skills.len();
    store.skills.retain(|skill| {
        let is_builtin =
            skill.is_builtin.unwrap_or(false) || skill.source_scope.as_deref() == Some("builtin");
        !is_builtin || builtin_names.contains(&skill.name.to_ascii_lowercase())
    });
    if store.skills.len() != before {
        changed = true;
    }

    for builtin in builtins {
        let existing = store
            .skills
            .iter()
            .position(|skill| skill.name.eq_ignore_ascii_case(&builtin.name));
        if let Some(index) = existing {
            let preserved_disabled = store.skills[index].disabled;
            let refreshed = SkillRecord {
                disabled: preserved_disabled.or(builtin.disabled),
                ..builtin
            };
            if skill_record_differs(&store.skills[index], &refreshed) {
                store.skills[index] = refreshed;
                changed = true;
            }
        } else {
            store.skills.push(builtin);
            changed = true;
        }
    }
    changed
}

fn skill_record_differs(left: &SkillRecord, right: &SkillRecord) -> bool {
    left.name != right.name
        || left.description != right.description
        || left.location != right.location
        || left.body != right.body
        || left.source_scope != right.source_scope
        || left.is_builtin != right.is_builtin
        || left.disabled != right.disabled
}

pub fn default_store() -> AppStore {
    let timestamp = now_iso();
    AppStore {
        settings: json!({}),
        spaces: vec![SpaceRecord {
            id: "default".to_string(),
            name: "默认空间".to_string(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        }],
        active_space_id: "default".to_string(),
        subjects: Vec::new(),
        categories: Vec::new(),
        advisors: Vec::new(),
        advisor_videos: Vec::new(),
        chat_rooms: Vec::new(),
        chatroom_messages: Vec::new(),
        wechat_official_bindings: Vec::new(),
        embedding_cache: Vec::new(),
        similarity_cache: Vec::new(),
        wander_history: Vec::new(),
        chat_sessions: Vec::new(),
        chat_messages: Vec::new(),
        session_context_records: Vec::new(),
        manuscript_write_proposals: Vec::new(),
        youtube_videos: Vec::new(),
        knowledge_notes: Vec::new(),
        document_sources: Vec::new(),
        session_transcript_records: Vec::new(),
        session_checkpoints: Vec::new(),
        session_tool_results: Vec::new(),
        runtime_tasks: Vec::new(),
        runtime_task_traces: Vec::new(),
        debug_logs: Vec::new(),
        archive_profiles: Vec::new(),
        archive_samples: Vec::new(),
        memories: Vec::new(),
        memory_history: Vec::new(),
        mcp_servers: Vec::new(),
        runtime_hooks: Vec::new(),
        skills: builtin_skill_records(),
        assistant_state: AssistantStateRecord {
            enabled: true,
            auto_start: true,
            keep_alive_when_no_window: true,
            host: "127.0.0.1".to_string(),
            port: 31937,
            listening: false,
            lock_state: "passive".to_string(),
            blocked_by: None,
            last_error: Some("RedClaw assistant daemon is idle.".to_string()),
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
        },
        redclaw_state: RedclawStateRecord {
            enabled: false,
            lock_state: "owner".to_string(),
            blocked_by: None,
            interval_minutes: 20,
            keep_alive_when_no_window: true,
            max_projects_per_tick: 1,
            max_automation_per_tick: 2,
            is_ticking: false,
            current_project_id: None,
            current_automation_task_id: None,
            next_automation_fire_at: None,
            in_flight_task_ids: Vec::new(),
            in_flight_long_cycle_task_ids: Vec::new(),
            heartbeat_in_flight: false,
            last_tick_at: None,
            next_tick_at: None,
            next_maintenance_at: None,
            last_error: Some("RedClaw runner is idle.".to_string()),
            heartbeat: json!({
                "enabled": true,
                "intervalMinutes": 30,
                "suppressEmptyReport": true,
                "reportToMainSession": true
            }),
            scheduled_tasks: Vec::new(),
            long_cycle_tasks: Vec::new(),
            projects: Vec::new(),
        },
        redclaw_job_definitions: Vec::new(),
        redclaw_job_executions: Vec::new(),
        media_assets: Vec::new(),
        cover_assets: Vec::new(),
        work_items: Vec::new(),
        legacy_imported_at: None,
        legacy_import_source: None,
    }
}

fn should_enable_assistant_daemon_by_default(state: &AssistantStateRecord) -> bool {
    if state.enabled || !state.auto_start || state.listening {
        return false;
    }

    if state.last_error.as_deref() == Some("RedClaw assistant daemon stopped.") {
        return false;
    }

    state.active_task_count == 0
        && state.queued_peer_count == 0
        && state.in_flight_keys.is_empty()
        && matches!(
            state.last_error.as_deref(),
            None | Some("RedClaw assistant daemon is idle.")
        )
}

pub fn load_store(path: &PathBuf) -> AppStore {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return default_store(),
    };
    let mut store = serde_json::from_str(&content).unwrap_or_else(|_| default_store());
    store.debug_logs.clear();
    let embedded_session_artifacts = take_session_artifacts_from_store(&mut store);
    let disk_session_ids =
        restore_session_artifacts_from_disk(path, &mut store).unwrap_or_default();
    let mut migrated_session_artifacts = false;
    if !embedded_session_artifacts.is_empty() {
        for artifacts in embedded_session_artifacts {
            if disk_session_ids.contains(&artifacts.session_id) {
                continue;
            }
            apply_session_artifacts_to_store(&mut store, artifacts);
            migrated_session_artifacts = true;
        }
    }
    let skills_migrated = ensure_builtin_skills_present(&mut store);
    let assistant_daemon_migrated =
        if should_enable_assistant_daemon_by_default(&store.assistant_state) {
            store.assistant_state.enabled = true;
            true
        } else {
            false
        };
    crate::session_manager::enforce_default_retention(&mut store);
    if skills_migrated || assistant_daemon_migrated || migrated_session_artifacts {
        let _ = persist_store(path, &store);
    }
    store
}

pub fn persist_store(path: &PathBuf, store: &AppStore) -> Result<(), String> {
    let mut snapshot = store.clone();
    crate::session_manager::enforce_default_retention(&mut snapshot);
    crate::auth::sanitize_store_for_persist(&mut snapshot);
    let session_artifacts = take_session_artifacts_from_store(&mut snapshot);
    snapshot.debug_logs.clear();
    write_session_artifacts_to_disk(path, &session_artifacts)?;
    let serialized = serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, serialized).map_err(|error| error.to_string())
}

pub fn with_store_mut<T>(
    state: &State<'_, AppState>,
    mutator: impl FnOnce(&mut AppStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    let result = mutator(&mut store)?;
    let retention = crate::session_manager::enforce_default_retention(&mut store);
    let snapshot = store.clone();
    drop(store);
    for session_id in retention.removed_session_ids {
        let _ = crate::runtime::remove_session_bundle(state, &session_id);
        if let Ok(mut guard) = state.chat_runtime_states.lock() {
            guard.remove(&session_id);
        }
    }
    schedule_store_persist(state, snapshot);
    Ok(result)
}

pub fn with_store<T>(
    state: &State<'_, AppState>,
    reader: impl FnOnce(MutexGuard<'_, AppStore>) -> Result<T, String>,
) -> Result<T, String> {
    let store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    reader(store)
}

pub fn hydrate_store_from_workspace_files(
    store: &mut AppStore,
    store_path: &Path,
) -> Result<(), String> {
    let root = active_space_workspace_root_from_store(store, &store.active_space_id, store_path)?;
    let snapshot = load_workspace_hydration_snapshot(&root);
    apply_workspace_hydration_snapshot(store, snapshot);
    Ok(())
}

pub fn ensure_store_hydrated_for_knowledge(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        let needs_hydration = store.knowledge_notes.is_empty()
            || store.youtube_videos.is_empty()
            || store.document_sources.is_empty();
        if !needs_hydration {
            return Ok(None);
        }
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &store.active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_knowledge_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_knowledge_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_subjects(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        let needs_hydration = store.subjects.is_empty() || store.categories.is_empty();
        if !needs_hydration {
            return Ok(None);
        }
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &store.active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_subjects_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_subjects_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_media(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        if !store.media_assets.is_empty() {
            return Ok(None);
        }
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &store.active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_media_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_media_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_cover(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        if !store.cover_assets.is_empty() {
            return Ok(None);
        }
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &store.active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_cover_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_cover_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_work(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        if !store.work_items.is_empty() {
            return Ok(None);
        }
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &store.active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_redclaw_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_redclaw_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_advisors(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        if !store.advisors.is_empty() {
            return Ok(None);
        }
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &store.active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_advisors_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_advisors_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_redclaw(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        let needs_hydration = store.redclaw_state.scheduled_tasks.is_empty()
            && store.redclaw_state.long_cycle_tasks.is_empty()
            && store.work_items.is_empty();
        if !needs_hydration {
            return Ok(None);
        }
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &store.active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_workspace_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_workspace_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

fn schedule_store_persist(state: &State<'_, AppState>, store: AppStore) {
    let path = state.store_path.clone();
    let version = state
        .store_persist_version
        .fetch_add(1, Ordering::SeqCst)
        .saturating_add(1);
    let latest = state.store_persist_version.clone();
    std::thread::spawn(move || {
        let mut snapshot = store.clone();
        crate::session_manager::enforce_default_retention(&mut snapshot);
        crate::auth::sanitize_store_for_persist(&mut snapshot);
        let session_artifacts = take_session_artifacts_from_store(&mut snapshot);
        snapshot.debug_logs.clear();
        let serialized = match serde_json::to_string_pretty(&snapshot) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[RedBox async persist] serialize failed: {error}");
                return;
            }
        };
        if version != latest.load(Ordering::SeqCst) {
            return;
        }
        if let Err(error) = write_session_artifacts_to_disk(&path, &session_artifacts) {
            eprintln!("[RedBox async persist] session artifact write failed: {error}");
            return;
        }
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!("[RedBox async persist] create dir failed: {error}");
                return;
            }
        }
        let tmp_path = path.with_extension(format!("json.tmp.{version}"));
        if let Err(error) = fs::write(&tmp_path, serialized) {
            eprintln!("[RedBox async persist] temp write failed: {error}");
            return;
        }
        if version != latest.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&tmp_path);
            return;
        }
        if let Err(error) = fs::rename(&tmp_path, &path) {
            let _ = fs::remove_file(&tmp_path);
            eprintln!("[RedBox async persist] rename failed: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_store_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("redbox-persistence-{label}-{unique}"));
        fs::create_dir_all(&root).expect("temp dir should be creatable");
        root.join("redbox-state.json")
    }

    fn seeded_store() -> AppStore {
        let mut store = default_store();
        let session_id = "session-test-1".to_string();
        store.chat_sessions.push(crate::ChatSessionRecord {
            id: session_id.clone(),
            title: "Session".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            metadata: None,
        });
        store.chat_messages.push(crate::ChatMessageRecord {
            id: "message-1".to_string(),
            session_id: session_id.clone(),
            role: "user".to_string(),
            content: "hello".to_string(),
            display_content: None,
            attachment: None,
            created_at: "1".to_string(),
        });
        store
            .session_transcript_records
            .push(crate::SessionTranscriptRecord {
                id: "trace-1".to_string(),
                session_id: session_id.clone(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                payload: None,
                created_at: 1,
            });
        store
            .session_checkpoints
            .push(crate::SessionCheckpointRecord {
                id: "checkpoint-1".to_string(),
                session_id: session_id.clone(),
                runtime_id: None,
                parent_runtime_id: None,
                source_task_id: None,
                checkpoint_type: "summary".to_string(),
                summary: "checkpoint".to_string(),
                payload: None,
                created_at: 2,
            });
        store
            .session_tool_results
            .push(crate::SessionToolResultRecord {
                id: "tool-1".to_string(),
                session_id,
                runtime_id: None,
                parent_runtime_id: None,
                source_task_id: None,
                call_id: "call-1".to_string(),
                tool_name: "bash".to_string(),
                command: Some("echo hi".to_string()),
                success: true,
                result_text: Some("hi".to_string()),
                summary_text: Some("ok".to_string()),
                prompt_text: None,
                original_chars: Some(2),
                prompt_chars: Some(2),
                truncated: false,
                payload: Some(json!({ "ok": true })),
                created_at: 3,
                updated_at: 4,
            });
        store
    }

    #[test]
    fn ensure_builtin_skills_present_refreshes_existing_builtin_body_and_preserves_disabled() {
        let mut store = default_store();
        let skill = store
            .skills
            .iter_mut()
            .find(|item| item.name == "image-prompt-optimizer")
            .expect("image-prompt-optimizer builtin should exist");
        skill.body =
            "---\nallowedRuntimeModes: [chatroom, image-generation]\n---\n# stale".to_string();
        skill.disabled = Some(true);

        ensure_builtin_skills_present(&mut store);

        let refreshed = store
            .skills
            .iter()
            .find(|item| item.name == "image-prompt-optimizer")
            .expect("refreshed image-prompt-optimizer should exist");
        assert!(refreshed
            .body
            .contains("allowedRuntimeModes: [chatroom, redclaw, image-generation]"));
        assert_eq!(refreshed.disabled, Some(true));
        assert_eq!(refreshed.source_scope.as_deref(), Some("builtin"));
        assert_eq!(refreshed.is_builtin, Some(true));
    }

    #[test]
    fn persist_store_moves_session_artifacts_out_of_main_snapshot() {
        let path = test_store_path("persist-split");
        let store = seeded_store();

        persist_store(&path, &store).expect("persist should succeed");

        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(&path).expect("main store should be readable"),
        )
        .expect("main store should be valid json");
        assert_eq!(
            persisted["chatMessages"].as_array().map(Vec::len),
            Some(0),
            "main snapshot should no longer embed chat messages"
        );
        assert_eq!(
            persisted["sessionTranscriptRecords"]
                .as_array()
                .map(Vec::len),
            Some(0),
            "main snapshot should no longer embed transcript records"
        );
        assert_eq!(
            persisted["sessionToolResults"].as_array().map(Vec::len),
            Some(0),
            "main snapshot should no longer embed tool results"
        );

        let reloaded = load_store(&path);
        assert_eq!(reloaded.chat_messages.len(), 1);
        assert_eq!(reloaded.session_transcript_records.len(), 1);
        assert_eq!(reloaded.session_checkpoints.len(), 1);
        assert_eq!(reloaded.session_tool_results.len(), 1);

        let _ = fs::remove_dir_all(path.parent().expect("path should have parent"));
    }

    #[test]
    fn load_store_migrates_embedded_session_artifacts_from_legacy_snapshot() {
        let path = test_store_path("legacy-migrate");
        let legacy_store = seeded_store();

        let parent = path.parent().expect("path should have parent");
        fs::create_dir_all(parent).expect("parent dir should exist");
        fs::write(
            &path,
            serde_json::to_string_pretty(&legacy_store).expect("legacy store should serialize"),
        )
        .expect("legacy store should write");

        let migrated = load_store(&path);
        assert_eq!(migrated.chat_messages.len(), 1);
        assert_eq!(migrated.session_transcript_records.len(), 1);
        assert_eq!(migrated.session_checkpoints.len(), 1);
        assert_eq!(migrated.session_tool_results.len(), 1);

        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(&path).expect("migrated main store should be readable"),
        )
        .expect("migrated main store should be valid json");
        assert_eq!(persisted["chatMessages"].as_array().map(Vec::len), Some(0));
        assert_eq!(
            persisted["sessionTranscriptRecords"]
                .as_array()
                .map(Vec::len),
            Some(0)
        );
        assert_eq!(
            persisted["sessionCheckpoints"].as_array().map(Vec::len),
            Some(0)
        );
        assert_eq!(
            persisted["sessionToolResults"].as_array().map(Vec::len),
            Some(0)
        );

        let artifact_dir = parent.join("session-artifacts");
        let artifact_files = fs::read_dir(&artifact_dir)
            .expect("artifact dir should exist")
            .filter_map(Result::ok)
            .count();
        assert_eq!(artifact_files, 1);

        let _ = fs::remove_dir_all(parent);
    }
}
