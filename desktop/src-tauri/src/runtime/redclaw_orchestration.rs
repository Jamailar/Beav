use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::runtime::RedclawProjectRecord;
use crate::{make_id, now_iso, payload_string, AppStore};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RedclawAgentId {
    ResearchAgent,
    InsightAgent,
    TopicAgent,
    NoteArchitectAgent,
    ScriptAgent,
    CopyAgent,
    StoryboardAgent,
    VisualDirectorAgent,
    MediaAgent,
    ImageAgent,
    LayoutAgent,
    EditorAgent,
    PublishAgent,
    ComplianceAgent,
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
    pub instruction: String,
    pub input_contract: Value,
    pub output_contract: Value,
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
    if includes_any(text, &["配图", "生成图", "生成图片", "封面图", "图片资产"]) {
        return Some("xhs_image_assets".to_string());
    }
    if includes_any(text, &["图文", "多图", "轮播", "卡片", "carousel"]) {
        return Some("xhs_image_text".to_string());
    }
    if includes_any(
        text,
        &["小红书", "xiaohongshu", "rednote", "笔记", "帖子", "post"],
    ) {
        return Some("xhs_article".to_string());
    }
    if includes_any(text, &["长视频", "长稿", "长文"]) {
        return Some("long_form".to_string());
    }
    None
}

fn is_xhs_format(content_format: Option<&str>, platform: Option<&str>) -> bool {
    platform == Some("xiaohongshu")
        || matches!(
            content_format,
            Some("xhs_article") | Some("xhs_image_text") | Some("xhs_image_assets")
        )
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
            allowed_tools: vec!["workflow".to_string(), "resource".to_string()],
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
            allowed_tools: vec!["workflow".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "knowledge".to_string(),
            ],
            output_schema: "CreativeBrief".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::TopicAgent,
            mission: "为小红书创作选择选题、爆点、人群痛点和搜索关键词。".to_string(),
            responsibilities: vec![
                "判断笔记类型".to_string(),
                "提炼人群痛点".to_string(),
                "输出小红书搜索词和标题 hook".to_string(),
            ],
            allowed_skills: vec![
                "xhs.topic_brief".to_string(),
                "xhs.search_keyword_plan".to_string(),
                "insight.idea_score".to_string(),
            ],
            allowed_tools: vec!["workflow".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "knowledge".to_string(),
            ],
            output_schema: "XhsTopicBrief".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::NoteArchitectAgent,
            mission: "把小红书选题拆成文章或图文笔记结构，而不是直接写全文。".to_string(),
            responsibilities: vec![
                "设计笔记开头策略".to_string(),
                "拆正文段落".to_string(),
                "规划多图页目的和顺序".to_string(),
            ],
            allowed_skills: vec![
                "xhs.note_architecture".to_string(),
                "xhs.carousel_page_plan".to_string(),
            ],
            allowed_tools: vec!["workflow".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "project".to_string(),
            ],
            output_schema: "XhsNoteArchitecture".to_string(),
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
            allowed_tools: vec!["workflow".to_string(), "resource".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "skill".to_string(),
            ],
            output_schema: "ScriptDocument".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::CopyAgent,
            mission: "把小红书笔记结构写成标题、封面标题、正文、CTA 和标签。".to_string(),
            responsibilities: vec![
                "写小红书正文".to_string(),
                "生成标题和 hook".to_string(),
                "按用户人设改写语气".to_string(),
            ],
            allowed_skills: vec![
                "xhs.copy_package".to_string(),
                "script.xiaohongshu_note".to_string(),
                "script.hook_variants".to_string(),
            ],
            allowed_tools: vec!["workflow".to_string(), "resource".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "skill".to_string(),
            ],
            output_schema: "XhsCopyPackage".to_string(),
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
            allowed_tools: vec!["workflow".to_string()],
            readable_memory_scopes: vec!["project".to_string(), "asset".to_string()],
            output_schema: "Storyboard".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::VisualDirectorAgent,
            mission: "定义小红书封面和配图策略，把文案变成可执行视觉 brief。".to_string(),
            responsibilities: vec![
                "定义封面视觉方向".to_string(),
                "规划每张配图目的".to_string(),
                "生成图片 prompt 和文字安全区".to_string(),
            ],
            allowed_skills: vec![
                "xhs.visual_brief".to_string(),
                "xhs.cover_direction".to_string(),
                "image.prompt_pack".to_string(),
            ],
            allowed_tools: vec!["workflow".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "asset".to_string(),
            ],
            output_schema: "XhsVisualBrief".to_string(),
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
            allowed_tools: vec!["workflow".to_string(), "resource".to_string()],
            readable_memory_scopes: vec![
                "asset".to_string(),
                "project".to_string(),
                "skill".to_string(),
            ],
            output_schema: "MediaPlan".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::ImageAgent,
            mission: "根据视觉 brief 查找、生成或整理小红书封面和图文配图资产。".to_string(),
            responsibilities: vec![
                "生成配图资产".to_string(),
                "绑定图片到笔记页".to_string(),
                "列出缺失素材和修图要求".to_string(),
            ],
            allowed_skills: vec![
                "image.generate_assets".to_string(),
                "image.asset_match".to_string(),
                "xhs.image_manifest".to_string(),
            ],
            allowed_tools: vec!["workflow".to_string(), "resource".to_string()],
            readable_memory_scopes: vec![
                "asset".to_string(),
                "project".to_string(),
                "skill".to_string(),
            ],
            output_schema: "XhsImageAssets".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::LayoutAgent,
            mission: "决定小红书多图顺序、卡片文案和版式 manifest。".to_string(),
            responsibilities: vec![
                "排列图文页顺序".to_string(),
                "生成卡片文字和版式".to_string(),
                "检查移动端可读性".to_string(),
            ],
            allowed_skills: vec![
                "xhs.carousel_layout".to_string(),
                "xhs.cover_text_safety".to_string(),
            ],
            allowed_tools: vec!["workflow".to_string(), "resource".to_string()],
            readable_memory_scopes: vec![
                "project".to_string(),
                "platform".to_string(),
                "asset".to_string(),
            ],
            output_schema: "XhsCarouselLayout".to_string(),
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
            allowed_tools: vec!["workflow".to_string()],
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
            allowed_tools: vec!["workflow".to_string()],
            readable_memory_scopes: vec![
                "creator".to_string(),
                "platform".to_string(),
                "skill".to_string(),
            ],
            output_schema: "PublishPackage".to_string(),
        },
        RedclawAgentSpec {
            id: RedclawAgentId::ComplianceAgent,
            mission: "检查小红书平台风险、敏感表达、夸张承诺和商业合规缺口。".to_string(),
            responsibilities: vec![
                "检查平台风险".to_string(),
                "标记敏感词和夸张承诺".to_string(),
                "提出可执行修正建议".to_string(),
            ],
            allowed_skills: vec![
                "xhs.compliance_check".to_string(),
                "editor.fact_check".to_string(),
            ],
            allowed_tools: vec!["workflow".to_string()],
            readable_memory_scopes: vec![
                "platform".to_string(),
                "project".to_string(),
                "knowledge".to_string(),
            ],
            output_schema: "ComplianceReport".to_string(),
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
            allowed_tools: vec!["workflow".to_string()],
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

fn skill_instruction(skill_id: &str) -> &'static str {
    match skill_id {
        "xhs.topic_brief" => "Turn research evidence into a RedNote/Xiaohongshu topic brief with audience, pain points, search keywords, hooks, recommended note format, and reasoning.",
        "xhs.search_keyword_plan" => "Expand topic intent into search/discovery keywords, long-tail phrases, and content tags that fit Xiaohongshu search behavior.",
        "xhs.note_architecture" => "Convert the topic brief into a note structure with opening strategy, section roles, key messages, and image/page intent.",
        "xhs.carousel_page_plan" => "Plan each carousel page with purpose, text overlay, visual direction, and sequence logic.",
        "xhs.copy_package" => "Write a publishable Xiaohongshu copy package: title options, cover title, opening hook, body, CTA, hashtags, comment prompt, and tone notes.",
        "xhs.visual_brief" => "Define cover and image visual direction, page image types, prompts, overlay text, aspect ratio, and negative constraints.",
        "xhs.cover_direction" => "Specify cover objective, composition, text hierarchy, safe area, and style constraints for mobile readability.",
        "xhs.image_manifest" => "Bind generated or matched image assets to note pages, with path, source, prompt, overlay text, and missing asset list.",
        "xhs.carousel_layout" => "Create a carousel layout manifest with page order, role, image binding, headline/body text, and layout type.",
        "xhs.cover_text_safety" => "Check cover and carousel text for mobile readability, excessive wording, unsafe claims, and layout risk.",
        "xhs.compliance_check" => "Check Xiaohongshu platform risk, sensitive expressions, exaggerated promises, medical/financial/legal claims, and commercial disclosure gaps.",
        "image.prompt_pack" => "Create image prompts and negative prompts from a visual brief without claiming assets already exist.",
        "image.generate_assets" => "Generate or request image assets according to the visual brief and return concrete asset paths when available.",
        "image.asset_match" => "Match existing local assets to image requirements and return path-bound candidates with confidence and gaps.",
        _ => "Execute the named RedClaw skill using the node input and return the declared structured output.",
    }
}

fn string_array_schema() -> Value {
    json!({ "type": "array", "items": { "type": "string" } })
}

fn schema_contract(schema_name: &str) -> Value {
    match schema_name {
        "XhsTopicBrief" => json!({
            "type": "object",
            "required": ["topic", "targetAudience", "userPainPoints", "contentAngle", "searchKeywords", "titleHooks", "recommendedFormat", "reason"],
            "properties": {
                "topic": { "type": "string" },
                "targetAudience": string_array_schema(),
                "userPainPoints": string_array_schema(),
                "contentAngle": { "type": "string" },
                "searchKeywords": string_array_schema(),
                "titleHooks": string_array_schema(),
                "recommendedFormat": { "type": "string", "enum": ["article_note", "image_text_note", "carousel_guide", "product_seeding", "experience_story", "checklist"] },
                "reason": { "type": "string" },
                "evidenceRefs": string_array_schema()
            }
        }),
        "XhsNoteArchitecture" => json!({
            "type": "object",
            "required": ["format", "openingStrategy", "sections", "imagePlan"],
            "properties": {
                "format": { "type": "string", "enum": ["article_note", "image_text_note", "carousel_guide"] },
                "openingStrategy": { "type": "string" },
                "sections": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["id", "role", "headline", "keyMessage"],
                        "properties": {
                            "id": { "type": "string" },
                            "role": { "type": "string" },
                            "headline": { "type": "string" },
                            "keyMessage": { "type": "string" },
                            "suggestedVisual": { "type": "string" }
                        }
                    }
                },
                "imagePlan": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["pageIndex", "purpose", "textOverlay", "visualDirection"],
                        "properties": {
                            "pageIndex": { "type": "integer" },
                            "purpose": { "type": "string" },
                            "textOverlay": { "type": "string" },
                            "visualDirection": { "type": "string" }
                        }
                    }
                }
            }
        }),
        "XhsCopyPackage" => json!({
            "type": "object",
            "required": ["titles", "coverTitle", "openingHook", "body", "cta", "hashtags", "toneNotes"],
            "properties": {
                "titles": string_array_schema(),
                "coverTitle": { "type": "string" },
                "openingHook": { "type": "string" },
                "body": { "type": "string" },
                "cta": { "type": "string" },
                "hashtags": string_array_schema(),
                "commentPrompt": { "type": "string" },
                "toneNotes": string_array_schema()
            }
        }),
        "XhsVisualBrief" => json!({
            "type": "object",
            "required": ["cover", "images"],
            "properties": {
                "cover": {
                    "type": "object",
                    "required": ["objective", "mainText", "visualStyle", "composition", "negativePrompt"],
                    "properties": {
                        "objective": { "type": "string" },
                        "mainText": { "type": "string" },
                        "subText": { "type": "string" },
                        "visualStyle": { "type": "string" },
                        "composition": { "type": "string" },
                        "negativePrompt": string_array_schema()
                    }
                },
                "images": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["index", "type", "aspectRatio"],
                        "properties": {
                            "index": { "type": "integer" },
                            "type": { "type": "string", "enum": ["ai_image", "photo", "screenshot", "text_card", "comparison", "diagram"] },
                            "prompt": { "type": "string" },
                            "overlayText": { "type": "string" },
                            "sourceRequirement": { "type": "string" },
                            "aspectRatio": { "type": "string", "enum": ["3:4", "1:1", "4:5"] }
                        }
                    }
                }
            }
        }),
        "XhsImageAssets" => json!({
            "type": "object",
            "required": ["pages", "missingAssets"],
            "properties": {
                "coverImage": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "prompt": { "type": "string" },
                        "usage": { "type": "string", "enum": ["cover"] }
                    }
                },
                "pages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["index", "path", "source"],
                        "properties": {
                            "index": { "type": "integer" },
                            "path": { "type": "string" },
                            "source": { "type": "string", "enum": ["generated", "local_asset", "template"] },
                            "prompt": { "type": "string" },
                            "overlayText": { "type": "string" }
                        }
                    }
                },
                "missingAssets": string_array_schema()
            }
        }),
        "XhsCarouselLayout" => json!({
            "type": "object",
            "required": ["aspectRatio", "pages"],
            "properties": {
                "aspectRatio": { "type": "string", "enum": ["3:4", "1:1", "4:5"] },
                "pages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["index", "role", "headline", "layout"],
                        "properties": {
                            "index": { "type": "integer" },
                            "role": { "type": "string" },
                            "imagePath": { "type": "string" },
                            "headline": { "type": "string" },
                            "bodyText": { "type": "string" },
                            "layout": { "type": "string", "enum": ["title_card", "image_with_caption", "split_compare", "checklist", "quote"] }
                        }
                    }
                }
            }
        }),
        "ComplianceReport" => json!({
            "type": "object",
            "required": ["riskLevel", "blockingIssues", "sensitiveTerms", "suggestedRewrites", "approved"],
            "properties": {
                "riskLevel": { "type": "string", "enum": ["low", "medium", "high"] },
                "blockingIssues": string_array_schema(),
                "sensitiveTerms": string_array_schema(),
                "suggestedRewrites": string_array_schema(),
                "approved": { "type": "boolean" }
            }
        }),
        "PublishPackage" => json!({
            "type": "object",
            "required": ["titleOptions", "coverOptions", "body", "hashtags", "checklist"],
            "properties": {
                "titleOptions": string_array_schema(),
                "coverOptions": string_array_schema(),
                "body": { "type": "string" },
                "hashtags": string_array_schema(),
                "checklist": string_array_schema()
            }
        }),
        "ReviewAgentOutput" => json!({
            "type": "object",
            "required": ["qualityScore", "blockingIssues", "suggestedPatches", "learningCandidates"],
            "properties": {
                "qualityScore": { "type": "object" },
                "blockingIssues": string_array_schema(),
                "suggestedPatches": { "type": "array" },
                "learningCandidates": { "type": "array" }
            }
        }),
        _ => json!({
            "type": "object",
            "description": schema_name
        }),
    }
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
            "insight.idea_score",
            "insight",
            "TopicCandidates",
            "IdeaScore",
        ),
        ("xhs.topic_brief", "xhs", "ResearchBrief", "XhsTopicBrief"),
        (
            "xhs.search_keyword_plan",
            "xhs",
            "XhsTopicBrief",
            "XhsSearchKeywordPlan",
        ),
        (
            "xhs.note_architecture",
            "xhs",
            "XhsTopicBrief",
            "XhsNoteArchitecture",
        ),
        (
            "xhs.carousel_page_plan",
            "xhs",
            "XhsNoteArchitecture",
            "XhsCarouselPagePlan",
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
            "xhs.copy_package",
            "xhs",
            "XhsNoteArchitecture",
            "XhsCopyPackage",
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
            "xhs.visual_brief",
            "xhs",
            "XhsCopyPackage",
            "XhsVisualBrief",
        ),
        (
            "xhs.cover_direction",
            "xhs",
            "XhsCopyPackage",
            "XhsCoverDirection",
        ),
        (
            "image.prompt_pack",
            "image",
            "XhsVisualBrief",
            "ImagePromptPack",
        ),
        (
            "image.generate_assets",
            "image",
            "XhsVisualBrief",
            "XhsImageAssets",
        ),
        (
            "image.asset_match",
            "image",
            "XhsVisualBrief",
            "XhsImageAssets",
        ),
        (
            "xhs.image_manifest",
            "xhs",
            "XhsImageAssets",
            "XhsImageManifest",
        ),
        (
            "xhs.carousel_layout",
            "xhs",
            "XhsImageAssets",
            "XhsCarouselLayout",
        ),
        (
            "xhs.cover_text_safety",
            "xhs",
            "XhsCarouselLayout",
            "CoverTextSafetyReport",
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
            "xhs.compliance_check",
            "xhs",
            "PublishPackage",
            "ComplianceReport",
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
            instruction: skill_instruction(id).to_string(),
            input_contract: schema_contract(input_schema),
            output_contract: schema_contract(output_schema),
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
    let xhs_mode = is_xhs_format(content_format.as_deref(), platform.as_deref()) && !wants_video;

    let mut nodes = vec![node(
        "research",
        "整理资料与证据",
        RedclawAgentId::ResearchAgent,
        vec![
            "research.collect_recent_references",
            "research.extract_claims",
        ],
        vec!["ResearchBrief"],
        "ResearchBrief",
    )];

    if xhs_mode {
        nodes.push(node(
            "topic",
            "生成小红书选题 brief",
            RedclawAgentId::TopicAgent,
            vec![
                "xhs.topic_brief",
                "xhs.search_keyword_plan",
                "insight.idea_score",
            ],
            vec!["XhsTopicBrief"],
            "XhsTopicBrief",
        ));
        nodes.push(node(
            "note_architecture",
            "设计小红书笔记结构",
            RedclawAgentId::NoteArchitectAgent,
            vec!["xhs.note_architecture", "xhs.carousel_page_plan"],
            vec!["XhsNoteArchitecture"],
            "XhsNoteArchitecture",
        ));
        nodes.push(node(
            "copy",
            "生成小红书文案包",
            RedclawAgentId::CopyAgent,
            vec![
                "xhs.copy_package",
                "script.xiaohongshu_note",
                "script.hook_variants",
            ],
            vec!["XhsCopyPackage"],
            "XhsCopyPackage",
        ));
    } else {
        nodes.push(node(
            "insight",
            "生成创作 brief",
            RedclawAgentId::InsightAgent,
            vec!["insight.topic_cluster", "insight.brief_from_references"],
            vec!["CreativeBrief"],
            "CreativeBrief",
        ));
        nodes.push(node(
            "script",
            "生成脚本或文案",
            RedclawAgentId::ScriptAgent,
            vec!["script.short_video_script", "script.hook_variants"],
            vec!["ScriptDocument"],
            "ScriptDocument",
        ));
    }

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

    let xhs_needs_images = matches!(
        content_format.as_deref(),
        Some("xhs_image_text") | Some("xhs_image_assets")
    ) || (xhs_mode
        && includes_any(&lower, &["配图", "图片", "封面", "图文", "多图", "卡片"]));
    if xhs_needs_images {
        nodes.push(node(
            "visual_direction",
            "制定小红书视觉 brief",
            RedclawAgentId::VisualDirectorAgent,
            vec![
                "xhs.visual_brief",
                "xhs.cover_direction",
                "image.prompt_pack",
            ],
            vec!["XhsVisualBrief"],
            "XhsVisualBrief",
        ));
        nodes.push(node(
            "image_assets",
            "生成或匹配小红书配图",
            RedclawAgentId::ImageAgent,
            vec![
                "image.generate_assets",
                "image.asset_match",
                "xhs.image_manifest",
            ],
            vec!["XhsImageAssets"],
            "XhsImageAssets",
        ));
        nodes.push(node(
            "layout",
            "生成小红书图文排版",
            RedclawAgentId::LayoutAgent,
            vec!["xhs.carousel_layout", "xhs.cover_text_safety"],
            vec!["XhsCarouselLayout"],
            "XhsCarouselLayout",
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

    if xhs_mode {
        nodes.push(node(
            "compliance",
            "检查小红书平台风险",
            RedclawAgentId::ComplianceAgent,
            vec!["xhs.compliance_check", "editor.fact_check"],
            vec!["ComplianceReport"],
            "ComplianceReport",
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
    let has_topic = nodes.iter().any(|item| item.id == "topic");
    let has_visual_direction = nodes.iter().any(|item| item.id == "visual_direction");
    let has_layout = nodes.iter().any(|item| item.id == "layout");
    let has_publish = nodes.iter().any(|item| item.id == "publish");
    let has_compliance = nodes.iter().any(|item| item.id == "compliance");
    let mut edges = Vec::new();
    if has_topic {
        edges.push(edge(
            "research",
            "topic",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "topic",
            "note_architecture",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "note_architecture",
            "copy",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "copy",
            "editor",
            RedclawTaskDependencyType::RequiresOutput,
        ));
    } else {
        edges.push(edge(
            "research",
            "insight",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "insight",
            "script",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "script",
            "editor",
            RedclawTaskDependencyType::RequiresOutput,
        ));
    }
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
    if has_visual_direction {
        edges.push(edge(
            "copy",
            "visual_direction",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "note_architecture",
            "visual_direction",
            RedclawTaskDependencyType::OptionalContext,
        ));
        edges.push(edge(
            "visual_direction",
            "image_assets",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "image_assets",
            "layout",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        edges.push(edge(
            "copy",
            "layout",
            RedclawTaskDependencyType::OptionalContext,
        ));
        edges.push(edge(
            "layout",
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
    if has_layout && has_publish {
        edges.push(edge(
            "layout",
            "publish",
            RedclawTaskDependencyType::OptionalContext,
        ));
    }
    if has_publish {
        edges.push(edge(
            "editor",
            "publish",
            RedclawTaskDependencyType::RequiresOutput,
        ));
        if has_compliance {
            edges.push(edge(
                "publish",
                "compliance",
                RedclawTaskDependencyType::RequiresReview,
            ));
            edges.push(edge(
                "compliance",
                "review",
                RedclawTaskDependencyType::RequiresReview,
            ));
        } else {
            edges.push(edge(
                "publish",
                "review",
                RedclawTaskDependencyType::RequiresReview,
            ));
        }
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
    if let Some(session_id) = record.collab_session_id.as_deref() {
        if let Some(session) = store
            .collab_sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        {
            if task.status == "completed" || task.status == "failed" || task.status == "cancelled" {
                session.status = task.status.clone();
                session.completed_at = task.completed_at;
                session.updated_at = task.updated_at;
            }
        }
        for member in store
            .collab_members
            .iter_mut()
            .filter(|member| member.session_id == session_id)
        {
            let temporary = member
                .metadata
                .as_ref()
                .and_then(|value| value.get("temporary"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if temporary
                && (task.status == "completed"
                    || task.status == "failed"
                    || task.status == "cancelled")
            {
                member.status = if task.status == "completed" {
                    "completed".to_string()
                } else {
                    "failed".to_string()
                };
                member.last_activity_at = task.completed_at;
                member.updated_at = task.updated_at;
            }
        }
    }
    Ok(Some(record))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plan_redclaw_orchestration_requires_goal() {
        let result = plan_redclaw_orchestration(&json!({}));
        assert!(result.is_err());
    }

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
    fn xhs_article_goal_builds_note_team_without_image_agents() {
        let graph = build_redclaw_task_graph("把这个灵感扩展成小红书文章笔记");
        let node_ids = graph
            .nodes
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(graph.content_format.as_deref(), Some("xhs_article"));
        assert!(node_ids.contains(&"topic"));
        assert!(node_ids.contains(&"note_architecture"));
        assert!(node_ids.contains(&"copy"));
        assert!(node_ids.contains(&"publish"));
        assert!(node_ids.contains(&"compliance"));
        assert!(!node_ids.contains(&"storyboard"));
        assert!(!node_ids.contains(&"media"));
        assert!(!node_ids.contains(&"image_assets"));
    }

    #[test]
    fn xhs_image_text_goal_builds_visual_and_layout_team() {
        let graph = build_redclaw_task_graph("把这个灵感扩展成小红书图文笔记");
        let node_ids = graph
            .nodes
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(graph.content_format.as_deref(), Some("xhs_image_text"));
        assert!(node_ids.contains(&"topic"));
        assert!(node_ids.contains(&"note_architecture"));
        assert!(node_ids.contains(&"copy"));
        assert!(node_ids.contains(&"visual_direction"));
        assert!(node_ids.contains(&"image_assets"));
        assert!(node_ids.contains(&"layout"));
        assert!(!node_ids.contains(&"storyboard"));
        assert!(!node_ids.contains(&"media"));
        assert!(node_ids.contains(&"publish"));
        assert!(node_ids.contains(&"compliance"));
    }

    #[test]
    fn image_asset_goal_does_not_create_dangling_publish_edge() {
        let graph = build_redclaw_task_graph("帮我生成一组配图");
        let node_ids = graph
            .nodes
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(graph.content_format.as_deref(), Some("xhs_image_assets"));
        assert!(node_ids.contains(&"visual_direction"));
        assert!(node_ids.contains(&"image_assets"));
        assert!(node_ids.contains(&"layout"));
        assert!(!node_ids.contains(&"publish"));
        assert!(graph.edges.iter().all(|edge| {
            node_ids.contains(&edge.from.as_str()) && node_ids.contains(&edge.to.as_str())
        }));
    }

    #[test]
    fn xhs_skill_profiles_include_executable_contracts() {
        let profiles = redclaw_skill_profiles();
        let copy = profiles
            .iter()
            .find(|profile| profile.id == "xhs.copy_package")
            .expect("missing copy package skill");

        assert!(copy.instruction.contains("Xiaohongshu"));
        assert_eq!(
            copy.output_contract
                .get("properties")
                .and_then(|properties| properties.get("body"))
                .and_then(|body| body.get("type"))
                .and_then(Value::as_str),
            Some("string")
        );
        assert!(profiles
            .iter()
            .filter(|profile| profile.domain == "xhs")
            .all(|profile| profile.output_contract.get("type").is_some()));
    }
}
