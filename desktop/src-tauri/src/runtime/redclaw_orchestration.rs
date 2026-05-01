use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::runtime::RedclawProjectRecord;
use crate::{make_id, now_iso, payload_string, AppStore};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RedclawAgentId {
    ResearchAgent,
    InsightAgent,
    ScriptAgent,
    StoryboardAgent,
    MediaAgent,
    EditorAgent,
    PublishAgent,
    ReviewAgent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawAgentSpec {
    pub id: RedclawAgentId,
    pub mission: String,
    pub responsibilities: Vec<String>,
    pub allowed_skills: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub readable_memory_scopes: Vec<String>,
    pub output_schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawSkillProfile {
    pub id: String,
    pub domain: String,
    pub version: String,
    pub input_schema: String,
    pub output_schema: String,
    pub evaluation_dimensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedclawTaskNodeStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawTaskNode {
    pub id: String,
    pub title: String,
    pub agent_id: RedclawAgentId,
    pub skill_ids: Vec<String>,
    pub required_artifacts: Vec<String>,
    pub output_schema: String,
    pub status: RedclawTaskNodeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedclawTaskDependencyType {
    RequiresOutput,
    RequiresReview,
    OptionalContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawTaskEdge {
    pub from: String,
    pub to: String,
    pub dependency_type: RedclawTaskDependencyType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawTaskGraph {
    pub id: String,
    pub goal: String,
    pub platform: Option<String>,
    pub content_format: Option<String>,
    pub nodes: Vec<RedclawTaskNode>,
    pub edges: Vec<RedclawTaskEdge>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawOrchestrationPlan {
    pub success: bool,
    pub run_id: String,
    pub mode: String,
    pub graph: RedclawTaskGraph,
    pub agent_specs: Vec<RedclawAgentSpec>,
    pub skill_profiles: Vec<RedclawSkillProfile>,
    pub memory_scopes: Vec<String>,
    pub release_policy: String,
}

fn includes_any(text: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|pattern| text.contains(pattern))
}

fn detect_platform(text: &str) -> Option<String> {
    if includes_any(text, &["小红书", "xiaohongshu", "rednote"]) {
        return Some("xiaohongshu".to_string());
    }
    if includes_any(text, &["抖音", "douyin", "tiktok"]) {
        return Some("douyin".to_string());
    }
    if includes_any(text, &["b站", "bilibili", "哔哩哔哩"]) {
        return Some("bilibili".to_string());
    }
    if includes_any(text, &["youtube", "油管"]) {
        return Some("youtube".to_string());
    }
    None
}

fn detect_format(text: &str) -> Option<String> {
    if includes_any(text, &["口播", "短视频", "视频", "分镜", "粗剪"]) {
        return Some("short_video".to_string());
    }
    if includes_any(text, &["图文", "笔记", "帖子", "post"]) {
        return Some("note".to_string());
    }
    if includes_any(text, &["长视频", "长稿", "长文"]) {
        return Some("long_form".to_string());
    }
    None
}

fn node(
    suffix: &str,
    title: &str,
    agent_id: RedclawAgentId,
    skill_ids: Vec<&str>,
    required_artifacts: Vec<&str>,
    output_schema: &str,
) -> RedclawTaskNode {
    RedclawTaskNode {
        id: suffix.to_string(),
        title: title.to_string(),
        agent_id,
        skill_ids: skill_ids.into_iter().map(ToString::to_string).collect(),
        required_artifacts: required_artifacts
            .into_iter()
            .map(ToString::to_string)
            .collect(),
        output_schema: output_schema.to_string(),
        status: RedclawTaskNodeStatus::Pending,
    }
}

fn edge(from: &str, to: &str, dependency_type: RedclawTaskDependencyType) -> RedclawTaskEdge {
    RedclawTaskEdge {
        from: from.to_string(),
        to: to.to_string(),
        dependency_type,
    }
}

pub fn redclaw_agent_specs() -> Vec<RedclawAgentSpec> {
    vec![
        RedclawAgentSpec {
            id: RedclawAgentId::ResearchAgent,
            mission: "检索和提炼创作证据、参考案例、素材线索。".to_string(),
            responsibilities: vec![
                "查找资料".to_string(),
                "提取证据".to_string(),
                "标出不确定项".to_string(),
            ],
            allowed_skills: vec![
                "research.collect_recent_references".to_string(),
                "research.extract_claims".to_string(),
            ],
            allowed_tools: vec!["app_cli".to_string(), "redbox_fs".to_string()],
            readable_memory_scopes: vec!["knowledge".to_string(), "creator".to_string()],
            output_schema: "ResearchBrief".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::InsightAgent,
            mission: "把资料转成选题角度、平台适配判断和创作 brief。".to_string(),
            responsibilities: vec![
                "聚类主题".to_string(),
                "生成角度".to_string(),
                "评估机会".to_string(),
            ],
            allowed_skills: vec![
                "insight.topic_cluster".to_string(),
                "insight.brief_from_references".to_string(),
            ],
            allowed_tools: vec!["app_cli".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "knowledge".to_string(),
            ],
            output_schema: "CreativeBrief".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::ScriptAgent,
            mission: "把 brief 转成符合用户风格和平台格式的脚本/文案。".to_string(),
            responsibilities: vec![
                "生成脚本".to_string(),
                "生成 hook".to_string(),
                "保留证据引用".to_string(),
            ],
            allowed_skills: vec![
                "script.short_video_script".to_string(),
                "script.xiaohongshu_note".to_string(),
                "script.hook_variants".to_string(),
            ],
            allowed_tools: vec!["app_cli".to_string(), "redbox_fs".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "skill".to_string(),
            ],
            output_schema: "ScriptDocument".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::StoryboardAgent,
            mission: "把脚本拆成分镜、镜头需求和字幕节奏。".to_string(),
            responsibilities: vec![
                "拆分镜".to_string(),
                "列素材需求".to_string(),
                "估算节奏".to_string(),
            ],
            allowed_skills: vec![
                "storyboard.scene_breakdown".to_string(),
                "storyboard.shot_list".to_string(),
            ],
            allowed_tools: vec!["app_cli".to_string()],
            readable_memory_scopes: vec!["project".to_string(), "asset".to_string()],
            output_schema: "Storyboard".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::MediaAgent,
            mission: "匹配素材并生成媒体生产计划或粗剪时间线。".to_string(),
            responsibilities: vec![
                "匹配素材".to_string(),
                "生成粗剪计划".to_string(),
                "列出缺失素材".to_string(),
            ],
            allowed_skills: vec![
                "media.asset_match".to_string(),
                "media.rough_cut_plan".to_string(),
            ],
            allowed_tools: vec!["app_cli".to_string(), "redbox_fs".to_string()],
            readable_memory_scopes: vec![
                "asset".to_string(),
                "project".to_string(),
                "skill".to_string(),
            ],
            output_schema: "MediaPlan".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::EditorAgent,
            mission: "改稿、事实风险、一致性和生产可行性修正。".to_string(),
            responsibilities: vec![
                "一致性检查".to_string(),
                "事实风险检查".to_string(),
                "提出 patch".to_string(),
            ],
            allowed_skills: vec![
                "editor.fact_check".to_string(),
                "editor.voice_consistency".to_string(),
            ],
            allowed_tools: vec!["app_cli".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "project".to_string(),
                "knowledge".to_string(),
            ],
            output_schema: "ProjectPatch".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::PublishAgent,
            mission: "生成标题、封面文案、正文、标签和平台发布包。".to_string(),
            responsibilities: vec![
                "标题变体".to_string(),
                "封面文案".to_string(),
                "发布正文".to_string(),
            ],
            allowed_skills: vec![
                "publish.title_variants".to_string(),
                "publish.cover_copy".to_string(),
                "publish.platform_package".to_string(),
            ],
            allowed_tools: vec!["app_cli".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "skill".to_string(),
            ],
            output_schema: "PublishPackage".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::ReviewAgent,
            mission: "质检产物并把反馈转成学习候选。".to_string(),
            responsibilities: vec![
                "质量评分".to_string(),
                "阻塞问题".to_string(),
                "学习候选".to_string(),
            ],
            allowed_skills: vec![
                "review.run_quality_review".to_string(),
                "review.learning_candidate_extract".to_string(),
            ],
            allowed_tools: vec!["app_cli".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "project".to_string(),
                "skill".to_string(),
            ],
            output_schema: "ReviewAgentOutput".to_string(),
        },
    ]
}

pub fn redclaw_skill_profiles() -> Vec<RedclawSkillProfile> {
    [
        (
            "research.collect_recent_references",
            "research",
            "ResearchQuery",
            "ResearchBrief",
        ),
        (
            "research.extract_claims",
            "research",
            "ContentItems",
            "ClaimSet",
        ),
        (
            "insight.topic_cluster",
            "insight",
            "ResearchBrief",
            "TopicClusters",
        ),
        (
            "insight.brief_from_references",
            "insight",
            "ResearchBrief",
            "CreativeBrief",
        ),
        (
            "script.short_video_script",
            "script",
            "CreativeBrief",
            "ScriptDocument",
        ),
        (
            "script.xiaohongshu_note",
            "script",
            "CreativeBrief",
            "NoteDraft",
        ),
        (
            "script.hook_variants",
            "script",
            "CreativeBrief",
            "HookOptions",
        ),
        (
            "storyboard.scene_breakdown",
            "storyboard",
            "ScriptDocument",
            "Storyboard",
        ),
        (
            "storyboard.shot_list",
            "storyboard",
            "Storyboard",
            "RequiredShots",
        ),
        (
            "media.asset_match",
            "media",
            "RequiredShots",
            "MatchedAssets",
        ),
        (
            "media.rough_cut_plan",
            "media",
            "Storyboard",
            "TimelinePlan",
        ),
        (
            "editor.fact_check",
            "editor",
            "ProjectArtifacts",
            "ProjectPatch",
        ),
        (
            "editor.voice_consistency",
            "editor",
            "ProjectArtifacts",
            "ProjectPatch",
        ),
        (
            "publish.title_variants",
            "publish",
            "ProjectArtifacts",
            "TitleOptions",
        ),
        (
            "publish.cover_copy",
            "publish",
            "ProjectArtifacts",
            "CoverCopy",
        ),
        (
            "publish.platform_package",
            "publish",
            "ProjectArtifacts",
            "PublishPackage",
        ),
        (
            "review.run_quality_review",
            "review",
            "ProjectArtifacts",
            "ReviewAgentOutput",
        ),
        (
            "review.learning_candidate_extract",
            "review",
            "RedclawEvents",
            "LearningCandidates",
        ),
    ]
    .into_iter()
    .map(
        |(id, domain, input_schema, output_schema)| RedclawSkillProfile {
            id: id.to_string(),
            domain: domain.to_string(),
            version: "0.1.0".to_string(),
            input_schema: input_schema.to_string(),
            output_schema: output_schema.to_string(),
            evaluation_dimensions: vec![
                "relevance".to_string(),
                "voiceMatch".to_string(),
                "productionReadiness".to_string(),
            ],
        },
    )
    .collect()
}

pub fn build_redclaw_task_graph(goal: &str) -> RedclawTaskGraph {
    let normalized_goal = goal.trim();
    let lower = normalized_goal.to_lowercase();
    let platform = detect_platform(&lower);
    let content_format = detect_format(&lower);
    let wants_video = content_format.as_deref() == Some("short_video")
        || includes_any(&lower, &["分镜", "素材", "粗剪", "视频"]);
    let wants_publish = includes_any(&lower, &["发布", "标题", "封面", "标签", "正文", "publish"]);

    let mut nodes = vec![
        node(
            "research",
            "整理资料与证据",
            RedclawAgentId::ResearchAgent,
            vec![
                "research.collect_recent_references",
                "research.extract_claims",
            ],
            vec!["ResearchBrief"],
            "ResearchBrief",
        ),
        node(
            "insight",
            "生成创作 brief",
            RedclawAgentId::InsightAgent,
            vec!["insight.topic_cluster", "insight.brief_from_references"],
            vec!["CreativeBrief"],
            "CreativeBrief",
        ),
        node(
            "script",
            "生成脚本或文案",
            RedclawAgentId::ScriptAgent,
            if content_format.as_deref() == Some("note") {
                vec!["script.xiaohongshu_note", "script.hook_variants"]
            } else {
                vec!["script.short_video_script", "script.hook_variants"]
            },
            vec!["ScriptDocument"],
            "ScriptDocument",
        ),
    ];

    if wants_video {
        nodes.push(node(
            "storyboard",
            "拆解分镜和镜头需求",
            RedclawAgentId::StoryboardAgent,
            vec!["storyboard.scene_breakdown", "storyboard.shot_list"],
            vec!["Storyboard"],
            "Storyboard",
        ));
        nodes.push(node(
            "media",
            "匹配素材并生成粗剪计划",
            RedclawAgentId::MediaAgent,
            vec!["media.asset_match", "media.rough_cut_plan"],
            vec!["MediaPlan"],
            "MediaPlan",
        ));
    }

    nodes.push(node(
        "editor",
        "检查并修正稿件",
        RedclawAgentId::EditorAgent,
        vec!["editor.fact_check", "editor.voice_consistency"],
        vec!["ProjectPatch"],
        "ProjectPatch",
    ));

    if wants_publish || platform.is_some() {
        nodes.push(node(
            "publish",
            "生成平台发布包",
            RedclawAgentId::PublishAgent,
            vec![
                "publish.title_variants",
                "publish.cover_copy",
                "publish.platform_package",
            ],
            vec!["PublishPackage"],
            "PublishPackage",
        ));
    }

    nodes.push(node(
        "review",
        "质检并生成学习候选",
        RedclawAgentId::ReviewAgent,
        vec![
            "review.run_quality_review",
            "review.learning_candidate_extract",
        ],
        vec!["ReviewAgentOutput", "LearningCandidates"],
        "ReviewAgentOutput",
    ));

    let has_storyboard = nodes.iter().any(|item| item.id == "storyboard");
    let has_media = nodes.iter().any(|item| item.id == "media");
    let has_publish = nodes.iter().any(|item| item.id == "publish");
    let mut edges = vec![
        edge(
            "research",
            "insight",
            RedclawTaskDependencyType::RequiresOutput,
        ),
        edge(
            "insight",
            "script",
            RedclawTaskDependencyType::RequiresOutput,
        ),
        edge(
            "script",
            "editor",
            RedclawTaskDependencyType::RequiresOutput,
        ),
    ];
    if has_storyboard {
        edges.push(edge(
            "script",
            "storyboard",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "storyboard",
            "media",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "media",
            "editor",
            RedclawTaskDependencyType::OptionalContext,
        ));
    }
    if has_media {
        edges.push(edge(
            "media",
            "review",
            RedclawTaskDependencyType::RequiresReview,
        ));
    }
    if has_publish {
        edges.push(edge(
            "editor",
            "publish",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "publish",
            "review",
            RedclawTaskDependencyType::RequiresReview,
        ));
    } else {
        edges.push(edge(
            "editor",
            "review",
            RedclawTaskDependencyType::RequiresReview,
        ));
    }

    RedclawTaskGraph {
        id: make_id("redclaw-graph"),
        goal: normalized_goal.to_string(),
        platform,
        content_format,
        nodes,
        edges,
        created_at: now_iso(),
    }
}

pub fn plan_redclaw_orchestration(payload: &Value) -> Result<RedclawOrchestrationPlan, String> {
    let goal = payload_string(payload, "goal")
        .or_else(|| payload_string(payload, "task"))
        .or_else(|| payload_string(payload, "message"))
        .ok_or_else(|| "goal is required".to_string())?;
    let graph = build_redclaw_task_graph(&goal);
    Ok(RedclawOrchestrationPlan {
        success: true,
        run_id: make_id("redclaw-run"),
        mode: "team_orchestration_plan".to_string(),
        graph,
        agent_specs: redclaw_agent_specs(),
        skill_profiles: redclaw_skill_profiles(),
        memory_scopes: vec![
            "creator".to_string(),
            "platform".to_string(),
            "project".to_string(),
            "skill".to_string(),
            "knowledge".to_string(),
            "asset".to_string(),
            "execution".to_string(),
        ],
        release_policy: "Agent run instances are ephemeral. Persist project artifacts, events, skill performance, and learning candidates; release subagent contexts after the run completes.".to_string(),
    })
}

pub fn redclaw_orchestration_registry_value() -> Value {
    json!({
        "success": true,
        "agents": redclaw_agent_specs(),
        "skills": redclaw_skill_profiles(),
        "memoryScopes": ["creator", "platform", "project", "skill", "knowledge", "asset", "execution"]
    })
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn redclaw_project_id_from_metadata(metadata: Option<&Value>) -> Option<String> {
    metadata
        .and_then(|value| value_string(value, "projectId"))
        .or_else(|| {
            metadata
                .and_then(|value| value_string(value, "runId"))
                .map(|run_id| format!("redclaw-project:{run_id}"))
        })
}

fn orchestration_outputs_from_task(
    task_artifacts: &[crate::runtime::RuntimeArtifact],
) -> Vec<Value> {
    task_artifacts
        .iter()
        .filter(|artifact| artifact.artifact_type == "subagent-orchestration")
        .filter_map(|artifact| artifact.payload.as_ref())
        .filter_map(|payload| payload.get("outputs").and_then(Value::as_array))
        .flat_map(|items| items.iter().cloned())
        .collect()
}

fn learning_candidates_from_outputs(outputs: &[Value], task_id: &str) -> Vec<Value> {
    let mut candidates = Vec::new();
    for output in outputs {
        let role_id = value_string(output, "roleId").unwrap_or_default();
        if role_id != "review_agent" && role_id != "reviewer" {
            continue;
        }
        if let Some(items) = output.get("learningCandidates").and_then(Value::as_array) {
            for item in items {
                candidates.push(json!({
                    "id": make_id("redclaw-learning"),
                    "scope": item.get("scope").cloned().unwrap_or_else(|| json!("project")),
                    "statement": item.get("statement").cloned().unwrap_or_else(|| item.clone()),
                    "evidence": item.get("evidence").cloned().unwrap_or_else(|| json!([{ "taskId": task_id }])),
                    "confidence": item.get("confidence").cloned().unwrap_or_else(|| json!(0.5)),
                    "status": "pending",
                    "proposedBy": role_id,
                    "createdAt": now_iso()
                }));
            }
        }
        let issues = output
            .get("issues")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !issues.is_empty() {
            candidates.push(json!({
                "id": make_id("redclaw-learning"),
                "scope": "project",
                "statement": "Review Agent found reusable quality issues for this RedClaw run.",
                "evidence": [{ "taskId": task_id, "issues": issues }],
                "confidence": 0.6,
                "status": "pending",
                "proposedBy": role_id,
                "createdAt": now_iso()
            }));
        }
    }
    candidates
}

fn skill_runs_from_graph(graph: &Value, task_id: &str, status: &str) -> Vec<Value> {
    graph
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|node| {
            let node_id = value_string(node, "id").unwrap_or_default();
            let agent_id = value_string(node, "agentId").unwrap_or_default();
            node.get("skillIds")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(move |skill| {
                    let skill_id = skill.as_str()?.trim().to_string();
                    if skill_id.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "skillId": skill_id,
                        "agentId": agent_id,
                        "nodeId": node_id,
                        "taskId": task_id,
                        "status": status,
                        "recordedAt": now_iso()
                    }))
                })
        })
        .collect()
}

pub fn sync_redclaw_project_from_runtime_task(
    store: &mut AppStore,
    task_id: &str,
) -> Result<Option<RedclawProjectRecord>, String> {
    let Some(task) = store
        .runtime_tasks
        .iter()
        .find(|item| item.id == task_id)
        .cloned()
    else {
        return Ok(None);
    };
    let metadata = task.metadata.as_ref();
    let source = metadata.and_then(|value| value_string(value, "source"));
    if source.as_deref() != Some("redclaw-orchestrator") {
        return Ok(None);
    }
    let Some(project_id) = redclaw_project_id_from_metadata(metadata) else {
        return Ok(None);
    };
    let graph = metadata
        .and_then(|value| value.get("redclawTaskGraph"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let run_id = metadata.and_then(|value| value_string(value, "runId"));
    let graph_id = metadata.and_then(|value| value_string(value, "graphId"));
    let collab_session_id = store
        .collab_sessions
        .iter()
        .find(|session| {
            session
                .metadata
                .as_ref()
                .and_then(|value| value_string(value, "sourceTaskId"))
                .as_deref()
                == Some(task_id)
        })
        .map(|session| session.id.clone());
    let artifact_path = task
        .artifacts
        .iter()
        .find_map(|artifact| artifact.path.clone());
    let outputs = orchestration_outputs_from_task(&task.artifacts);
    let learning_candidates = learning_candidates_from_outputs(&outputs, &task.id);
    let skill_runs = skill_runs_from_graph(&graph, &task.id, &task.status);
    let artifacts = task
        .artifacts
        .iter()
        .map(|artifact| serde_json::to_value(artifact).unwrap_or_else(|_| Value::Null))
        .collect::<Vec<_>>();
    let checkpoints = task
        .checkpoints
        .iter()
        .map(|checkpoint| serde_json::to_value(checkpoint).unwrap_or_else(|_| Value::Null))
        .collect::<Vec<_>>();
    let now = now_iso();
    let record = RedclawProjectRecord {
        id: project_id.clone(),
        goal: task.goal.clone().unwrap_or_else(|| task_id.to_string()),
        platform: value_string(&graph, "platform"),
        task_type: Some(task.task_type.clone()),
        status: task.status.clone(),
        run_id,
        graph_id,
        runtime_task_id: Some(task.id.clone()),
        collab_session_id,
        content_format: value_string(&graph, "contentFormat"),
        artifact_path,
        artifacts,
        checkpoints,
        learning_candidates,
        skill_runs,
        metadata: Some(json!({
            "source": "redclaw-orchestrator",
            "redclawTaskGraph": graph,
            "orchestrationOutputs": outputs,
            "runtimeTaskStatus": task.status,
            "runtimeTaskError": task.last_error,
        })),
        created_at: store
            .redclaw_state
            .projects
            .iter()
            .find(|item| item.id == project_id)
            .and_then(|item| item.created_at.clone())
            .or_else(|| Some(now.clone())),
        updated_at: now,
    };
    if let Some(existing) = store
        .redclaw_state
        .projects
        .iter_mut()
        .find(|item| item.id == project_id)
    {
        *existing = record.clone();
    } else {
        store.redclaw_state.projects.push(record.clone());
    }
    store.redclaw_state.current_project_id = Some(project_id);
    Ok(Some(record))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_publish_goal_builds_full_creative_team_graph() {
        let graph = build_redclaw_task_graph(
            "基于最近收藏做一条小红书 60 秒口播视频，并给我标题、封面文案和发布正文",
        );
        let node_ids = graph
            .nodes
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(graph.platform.as_deref(), Some("xiaohongshu"));
        assert_eq!(graph.content_format.as_deref(), Some("short_video"));
        assert!(node_ids.contains(&"research"));
        assert!(node_ids.contains(&"storyboard"));
        assert!(node_ids.contains(&"media"));
        assert!(node_ids.contains(&"publish"));
        assert_eq!(node_ids.last(), Some(&"review"));
    }

    #[test]
    fn note_goal_skips_media_when_video_work_is_not_requested() {
        let graph = build_redclaw_task_graph("把这个灵感扩展成小红书图文笔记");
        let node_ids = graph
            .nodes
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(graph.content_format.as_deref(), Some("note"));
        assert!(!node_ids.contains(&"storyboard"));
        assert!(!node_ids.contains(&"media"));
        assert!(node_ids.contains(&"publish"));
    }
}
