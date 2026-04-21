use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::persistence::ensure_store_hydrated_for_subjects;
use crate::persistence::with_store;
use crate::runtime::{load_session_bundle_messages, runtime_context_messages_for_session};
use crate::skills::{build_skill_prompt_bundle, normalize_skill_logical_path, resolve_skill_set};
use crate::tools::registry::{
    base_tool_names_for_session_metadata, openai_schemas_for_runtime_mode,
    openai_schemas_for_session, prompt_tool_lines_for_runtime_mode, prompt_tool_lines_for_session,
};
use crate::{
    compact_host_runtime_context, current_host_runtime_context, load_redbox_prompt,
    load_redclaw_profile_prompt_bundle, now_iso, payload_string, redbox_project_root,
    render_host_runtime_context_section, render_redbox_prompt, slug_from_relative_path,
    truncate_chars, workspace_root, AppState,
};

pub(crate) fn interactive_runtime_system_prompt(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> String {
    if session_id.is_none() {
        if let Ok(runtime_warm) = state.runtime_warm.lock() {
            if let Some(entry) = runtime_warm.entries.get(runtime_mode) {
                if !entry.system_prompt.trim().is_empty() {
                    return entry.system_prompt.clone();
                }
            }
        }
    }
    let (
        available_tools,
        project_context,
        skills_section,
        prompt_prefix,
        prompt_suffix,
        advisor_context_section,
        host_runtime_context_section,
    ) = with_store(state, |store| {
        let metadata = session_id.and_then(|id| {
            store
                .chat_sessions
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.metadata.as_ref())
        });
        let base_tools = base_tool_names_for_session_metadata(runtime_mode, metadata);
        let resolved_skills = resolve_skill_set(&store.skills, runtime_mode, metadata, &base_tools);
        let skill_prompt = build_skill_prompt_bundle(&resolved_skills);
        let mut project_context = format!("runtime_mode={runtime_mode}");
        let host_context = current_host_runtime_context();
        project_context.push_str("; ");
        project_context.push_str(&compact_host_runtime_context(&host_context));
        if !resolved_skills.active_skills.is_empty() {
            project_context.push_str("; active_skills=");
            project_context.push_str(
                &resolved_skills
                    .active_skills
                    .iter()
                    .map(|item| item.name.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        if !skill_prompt.context_note.trim().is_empty() {
            project_context.push_str("; skill_context=");
            project_context.push_str(skill_prompt.context_note.trim());
        }
        Ok((
            prompt_tool_lines_for_session(&store, runtime_mode, session_id),
            project_context,
            skill_prompt.skills_section,
            skill_prompt.prompt_prefix,
            skill_prompt.prompt_suffix,
            advisor_runtime_context_section(metadata, &store.advisors),
            render_host_runtime_context_section(&host_context),
        ))
    })
    .unwrap_or_else(|_| {
        let host_context = current_host_runtime_context();
        (
            prompt_tool_lines_for_runtime_mode(runtime_mode),
            format!(
                "runtime_mode={runtime_mode}; {}",
                compact_host_runtime_context(&host_context)
            ),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            render_host_runtime_context_section(&host_context),
        )
    });
    let workspace_root_value = workspace_root(state)
        .map(|value| value.display().to_string())
        .unwrap_or_default();
    let subjects_section = build_subjects_section(state, &workspace_root_value);
    let runtime_agent_overlay = runtime_agent_overlay_prompt(runtime_mode);
    if runtime_mode == "wander" {
        let mut sections = Vec::<String>::new();
        if !prompt_prefix.trim().is_empty() {
            sections.push(prompt_prefix.trim().to_string());
        }
        sections.push(
            [
                "You are RedClaw's wander ideation agent inside RedBox.",
                "Your only job is to inspect the provided material folders/files, discover hidden connections, extract reusable viral-content patterns, and return strict JSON for a truly usable topic.",
                "Use only the available inspection tools in this runtime.",
                "You must inspect files before concluding.",
                "Keep the process lean: prefer redbox_fs(action=list|read, scope=workspace) for bounded folder/file inspection, and use bash only when redbox_fs cannot express the needed read-only action.",
                "The output must be publication-grade, not placeholders.",
                "Treat materials as inspiration and evidence candidates, not mandatory ingredients.",
                "Do not force every material into the final topic; weak materials may be dropped, and strong materials may be used only for hook, angle, tension, structure, or tone learning.",
                "Quality, novelty, and publishability are more important than material coverage.",
                "Never output generic titles such as '从某素材延展出的内容选题' or '未命名选题'.",
                "Never output generic directions such as '围绕这组素材提炼一个方向'.",
                "A valid content_direction must state the target audience, the core conflict/tension, the angle, and how the inspected materials informed that angle or sharpened its hook.",
                "Do not suggest pseudo tools or imaginary commands; call only the tools actually exposed in available_tools.",
                "Do not invent fs aliases such as fs read, knowledge_read, or app_cli fs ... when redbox_fs is available.",
            ]
            .join(" "),
        );
        sections.push(format!("Runtime context: {project_context}"));
        sections.push(format!(
            "Host runtime context:\n{}",
            host_runtime_context_section.trim()
        ));
        if !available_tools.trim().is_empty() {
            sections.push(format!("Available tools:\n{available_tools}"));
        }
        if !skills_section.trim().is_empty() {
            sections.push(format!("Skill guidance:\n{}", skills_section.trim()));
        }
        if !advisor_context_section.trim().is_empty() {
            sections.push(advisor_context_section.trim().to_string());
        }
        if !prompt_suffix.trim().is_empty() {
            sections.push(prompt_suffix.trim().to_string());
        }
        return sections.join("\n\n");
    }
    if let Some(template) = load_redbox_prompt("runtime/pi/system_base.txt") {
        let mut rendered = render_redbox_prompt(
            &template,
            &[
                ("available_tools", available_tools),
                ("workspace_root", workspace_root_value.clone()),
                ("current_space_root", workspace_root_value.clone()),
                ("skills_path", workspace_root_value.clone() + "/skills"),
                (
                    "knowledge_path",
                    workspace_root_value.clone() + "/knowledge",
                ),
                (
                    "knowledge_redbook_path",
                    workspace_root_value.clone() + "/knowledge/redbook",
                ),
                (
                    "knowledge_youtube_path",
                    workspace_root_value.clone() + "/knowledge/youtube",
                ),
                ("advisors_path", workspace_root_value.clone() + "/advisors"),
                (
                    "manuscripts_path",
                    workspace_root_value.clone() + "/manuscripts",
                ),
                ("media_path", workspace_root_value.clone() + "/media"),
                ("subjects_path", workspace_root_value.clone() + "/subjects"),
                ("redclaw_path", workspace_root_value.clone() + "/redclaw"),
                (
                    "redclaw_profile_path",
                    workspace_root_value.clone() + "/redclaw/profile",
                ),
                ("memory_path", workspace_root_value.clone() + "/memory"),
                ("project_context", project_context),
                ("host_runtime_context", host_runtime_context_section.clone()),
                ("skills_section", skills_section.clone()),
                ("subjects_section", subjects_section),
                ("current_date", now_iso()),
                ("current_working_directory", workspace_root_value),
                ("pi_documentation", "Tauri Rust host runtime".to_string()),
            ],
        );
        if !prompt_prefix.trim().is_empty() {
            rendered = format!("{}\n\n{}", prompt_prefix.trim(), rendered);
        }
        if !runtime_agent_overlay.trim().is_empty() {
            rendered.push_str("\n\n");
            rendered.push_str(runtime_agent_overlay.trim());
        }
        if !advisor_context_section.trim().is_empty() {
            rendered.push_str("\n\n");
            rendered.push_str(advisor_context_section.trim());
        }
        if runtime_mode == "redclaw" {
            if let Ok(bundle) = load_redclaw_profile_prompt_bundle(state) {
                rendered.push_str("\n\n## RedClaw 个性化档案（空间隔离）\n");
                rendered.push_str(&format!(
                    "- ProfileRoot: {}\n",
                    bundle.profile_root.display()
                ));
                rendered.push_str(
                    "- 档案文件: Agent.md / Soul.md / identity.md / user.md / CreatorProfile.md\n",
                );
                rendered.push_str("<redclaw_agent_md>\n");
                rendered.push_str(&truncate_chars(&bundle.agent, 6000));
                rendered.push_str("\n</redclaw_agent_md>\n");
                rendered.push_str("<redclaw_soul_md>\n");
                rendered.push_str(&truncate_chars(&bundle.soul, 6000));
                rendered.push_str("\n</redclaw_soul_md>\n");
                rendered.push_str("<redclaw_identity_md>\n");
                rendered.push_str(&truncate_chars(&bundle.identity, 4000));
                rendered.push_str("\n</redclaw_identity_md>\n");
                rendered.push_str("<redclaw_user_md>\n");
                rendered.push_str(&truncate_chars(&bundle.user, 8000));
                rendered.push_str("\n</redclaw_user_md>\n");
                rendered.push_str("<redclaw_creator_profile_md>\n");
                rendered.push_str(&truncate_chars(&bundle.creator_profile, 10000));
                rendered.push_str("\n</redclaw_creator_profile_md>\n");
                rendered.push_str("文档职责与更新规则：\n");
                rendered.push_str("- 工作区相对路径：redclaw/profile/Agent.md | redclaw/profile/Soul.md | redclaw/profile/identity.md | redclaw/profile/user.md | redclaw/profile/CreatorProfile.md | memory/MEMORY.md\n");
                rendered.push_str("- 查询长期档案优先使用 `app_cli(action=\"redclaw.profile.read\"|\"redclaw.profile.bundle\")`，不要先用 bash/find/PowerShell 按文件名盲扫。\n");
                rendered.push_str("- 查询长期记忆优先使用 `app_cli(action=\"memory.list\"|\"memory.search\")`；`memory/MEMORY.md` 只是自动生成摘要，不是主存储。\n");
                rendered.push_str("- Agent.md：RedClaw 的工作契约、执行规则、标准流程。只有当用户明确要求修改工作方式、流程、约束、职责边界时才更新。\n");
                rendered.push_str("- Soul.md：RedClaw 的协作语气、反馈风格、人格倾向。用户明确调整沟通风格、表达方式时更新。\n");
                rendered.push_str("- user.md：用户稳定画像与长期事实（目标、受众、赛道、节奏、指标）。用户明确给出新的长期事实时更新。\n");
                rendered.push_str("- CreatorProfile.md：长期自媒体定位与策略主档案（定位、目标群体、内容风格、商业目标、运营边界）。用户明确给出这类长期变化时更新。\n");
                rendered.push_str("- 一次性任务、临时实验、单篇稿件偏好，不应改写这些长期文档。\n");

                let onboarding_completed = bundle
                    .onboarding_state
                    .get("completedAt")
                    .and_then(|value| value.as_str())
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false);
                if !onboarding_completed && !bundle.bootstrap.trim().is_empty() {
                    rendered.push_str("## RedClaw 首次设定引导状态\n");
                    rendered.push_str("- completed: false\n");
                    rendered.push_str(&format!(
                        "- stepIndex: {}\n",
                        bundle
                            .onboarding_state
                            .get("stepIndex")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(0)
                    ));
                    rendered.push_str("<redclaw_bootstrap>\n");
                    rendered.push_str(&truncate_chars(&bundle.bootstrap, 3000));
                    rendered.push_str("\n</redclaw_bootstrap>\n");
                }
            }
        }
        rendered.push_str(
            "\n\nRuntime compatibility note:\n- Only call the tools explicitly listed in available_tools.\n- `app_cli` now uses structured `action` + optional `payload`; do not invent legacy command strings in normal runtime turns.\n- The available_tools section already lists the action families exposed for this runtime; prefer those families directly instead of exploratory help calls.\n- When `redbox_fs` is available, use it as the default structured file tool. For advisor/member knowledge, prefer `redbox_fs(scope=\"knowledge\", action=\"list|search|read\")` instead of broad `bash` scanning.\n- For workspace file discovery, prefer `redbox_fs(scope=\"workspace\", action=\"search\")` or exact relative paths instead of `bash find` when the path is known or can be narrowed.\n- When `bash` is available, use it only for read-only inspection inside currentSpaceRoot.\n- `redbox_editor` is the editor-only tool for bound video/audio manuscript packages and exposes only the script-first editing actions in normal runtime turns.\n",
        );
        if !prompt_suffix.trim().is_empty() {
            rendered.push_str("\n\n");
            rendered.push_str(prompt_suffix.trim());
        }
        return rendered;
    }
    format!(
        "You are the RedClaw desktop AI runtime inside RedBox for mode `{}`. \
Use tools when the user asks about app state, knowledge, advisors, work items, memories, sessions, or settings. \
Do not invent workspace/app facts that you can fetch with tools. \
If no tool is needed, answer directly and concisely. \
When using tools, synthesize the final answer in Chinese unless the user clearly asks otherwise. \
Host runtime context: {}",
        runtime_mode,
        render_host_runtime_context_section(&current_host_runtime_context())
    )
}

fn advisor_runtime_context_section(
    metadata: Option<&Value>,
    advisors: &[crate::AdvisorRecord],
) -> String {
    let Some(metadata) = metadata else {
        return String::new();
    };
    let advisor_id = crate::payload_string(metadata, "advisorId").or_else(|| {
        let context_type = crate::payload_string(metadata, "contextType");
        if context_type.as_deref() == Some("advisor-discussion") {
            return crate::payload_string(metadata, "contextId");
        }
        None
    });
    let Some(advisor_id) = advisor_id.filter(|value| !value.trim().is_empty()) else {
        return String::new();
    };
    let advisor_name = advisors
        .iter()
        .find(|item| item.id == advisor_id)
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "成员".to_string());
    let advisor_knowledge_path = format!(
        "advisors/{}/knowledge",
        slug_from_relative_path(&advisor_id)
    );
    format!(
        "Advisor knowledge retrieval:\n- Active advisor: {} ({})\n- Advisor knowledge root: {}\n- This turn is bound to a single advisor knowledge scope.\n- Before making advisor-specific claims, prefer `redbox_fs(scope=\"knowledge\", action=\"list|search|read\")` to inspect this advisor's files.\n- Suggested order: `redbox_fs(scope=\"knowledge\", action=\"list\")` -> `redbox_fs(scope=\"knowledge\", action=\"search\")` -> `redbox_fs(scope=\"knowledge\", action=\"read\")`.\n- If a tool call supports `advisorId`, use `{}` explicitly when the session context alone may be ambiguous.\n- Do not answer as if you know the advisor's rules or materials unless you actually inspected them with tools or the user already provided them in chat.",
        advisor_name, advisor_id, advisor_knowledge_path, advisor_id
    )
}

fn build_subjects_section(state: &State<'_, AppState>, workspace_root_value: &str) -> String {
    let subjects_root = if workspace_root_value.trim().is_empty() {
        "subjects".to_string()
    } else {
        format!("{workspace_root_value}/subjects")
    };

    let _ = ensure_store_hydrated_for_subjects(state);
    let (subjects, categories) = match with_store(state, |store| {
        Ok((store.subjects.clone(), store.categories.clone()))
    }) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return [
                format!("Subjects root: {subjects_root}"),
                format!("读取主体索引失败: {error}"),
            ]
            .join("\n");
        }
    };

    if subjects.is_empty() {
        let lines = vec![
            "当前空间还没有注册主体。".to_string(),
            format!("Subjects root: {subjects_root}"),
            "如果用户提到具体人物、商品、场景，仍应优先查询主体库；若结果为空，再明确说明未找到。"
                .to_string(),
        ];
        return lines.join("\n");
    }

    let category_map = categories
        .iter()
        .map(|item| (item.id.clone(), item.name.clone()))
        .collect::<HashMap<_, _>>();

    let subject_nodes = subjects
        .iter()
        .take(200)
        .map(|subject| {
            let category_name = subject
                .category_id
                .as_ref()
                .and_then(|id| category_map.get(id))
                .cloned()
                .unwrap_or_else(|| {
                    subject
                        .category_id
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| "未分类".to_string())
                });
            let attribute_keys = subject
                .attributes
                .iter()
                .map(|item| item.key.trim())
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>();
            let location = format!("{subjects_root}/{}/subject.json", subject.id);
            [
                "  <subject>".to_string(),
                format!("    <id>{}</id>", subject.id),
                format!("    <name>{}</name>", subject.name),
                format!("    <category>{category_name}</category>"),
                format!("    <tags>{}</tags>", subject.tags.join(", ")),
                format!(
                    "    <attribute_keys>{}</attribute_keys>",
                    attribute_keys.join(", ")
                ),
                format!(
                    "    <has_images>{}</has_images>",
                    if subject.image_paths.is_empty() {
                        "false"
                    } else {
                        "true"
                    }
                ),
                format!(
                    "    <has_voice_reference>{}</has_voice_reference>",
                    if subject.voice_path.is_some() {
                        "true"
                    } else {
                        "false"
                    }
                ),
                format!("    <location>{location}</location>"),
                "  </subject>".to_string(),
            ]
            .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n");

    [
        "These subject names have reference materials in the current space.",
        "When the user mentions one of these names or a close combination of them, inspect the subject library before answering.",
        "<available_subjects>",
        &subject_nodes,
        "</available_subjects>",
    ]
    .join("\n")
}

fn runtime_agent_overlay_prompt(runtime_mode: &str) -> String {
    match runtime_mode {
        "video-editor" => {
            load_redbox_prompt("runtime/agents/video_editor/base.txt").unwrap_or_default()
        }
        "audio-editor" => {
            load_redbox_prompt("runtime/agents/audio_editor/base.txt").unwrap_or_default()
        }
        _ => String::new(),
    }
}

pub(crate) fn parse_usize_arg(arguments: &Value, key: &str, default: usize, max: usize) -> usize {
    arguments
        .get(key)
        .and_then(|value| value.as_u64())
        .map(|value| value as usize)
        .unwrap_or(default)
        .clamp(1, max)
}

pub(crate) fn text_snippet(value: &str, limit: usize) -> String {
    let text = value.replace('\n', " ").trim().to_string();
    if text.chars().count() <= limit {
        return text;
    }
    text.chars().take(limit).collect::<String>()
}

pub(crate) fn collect_recent_chat_messages(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    limit: usize,
) -> Vec<Value> {
    let Some(session_id) = session_id else {
        return Vec::new();
    };
    if let Ok(bundle_messages) = load_session_bundle_messages(state, session_id) {
        if !bundle_messages.is_empty() {
            let summary_prompt = with_store(state, |store| {
                Ok(
                    store
                        .session_context_records
                        .iter()
                        .find(|item| {
                            item.session_id == session_id && item.compacted_message_count > 0
                        })
                        .map(|item| {
                            format!(
                                "[Session resume summary]\n{}\n\nUse this archived context together with the recent messages below.",
                                item.summary
                            )
                        }),
                )
            })
            .ok()
            .flatten();
            return crate::runtime::bundle_messages_for_runtime(
                &bundle_messages,
                summary_prompt,
                limit,
            );
        }
    }
    with_store(state, |store| {
        Ok(runtime_context_messages_for_session(
            None, &store, session_id, limit,
        ))
    })
    .unwrap_or_default()
}

pub(crate) fn resolve_workspace_tool_path(
    state: &State<'_, AppState>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }
    let logical_trimmed = normalize_skill_logical_path(trimmed);
    if let Some(relative) = logical_trimmed.strip_prefix("builtin-skills/") {
        let builtin_root = redbox_project_root().join("builtin-skills");
        let candidate = builtin_root.join(relative);
        let normalized = candidate.canonicalize().unwrap_or(candidate.clone());
        let builtin_normalized = builtin_root.canonicalize().unwrap_or(builtin_root);
        if !normalized.starts_with(&builtin_normalized) {
            return Err("path is outside builtin-skills".to_string());
        }
        return Ok(normalized);
    }
    let workspace = workspace_root(state)?;
    let candidate = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        workspace.join(trimmed)
    };
    let normalized = candidate.canonicalize().unwrap_or(candidate.clone());
    let workspace_normalized = workspace.canonicalize().unwrap_or(workspace);
    if !normalized.starts_with(&workspace_normalized) {
        return Err("path is outside currentSpaceRoot".to_string());
    }
    Ok(normalized)
}

pub(crate) fn session_workspace_root_override(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) -> Option<PathBuf> {
    let session_id = session_id?;
    with_store(state, |store| {
        Ok(store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|item| item.metadata.as_ref())
            .and_then(|metadata| {
                let context_type = payload_string(metadata, "contextType").unwrap_or_default();
                let workspace_mode =
                    payload_string(metadata, "associatedPackageWorkspaceMode").unwrap_or_default();
                let is_theme_editing = context_type == "richpost-theme-editing"
                    || workspace_mode == "richpost-theme-editing";
                if !is_theme_editing {
                    return None;
                }
                payload_string(metadata, "associatedPackageThemeEditingRoot")
                    .map(PathBuf::from)
                    .or_else(|| {
                        payload_string(metadata, "associatedPackageThemeEditingFile").and_then(
                            |value| {
                                let path = PathBuf::from(&value);
                                path.parent().map(|parent| parent.to_path_buf())
                            },
                        )
                    })
                    .or_else(|| payload_string(metadata, "associatedFilePath").map(PathBuf::from))
            }))
    })
    .ok()
    .flatten()
}

pub(crate) fn resolve_workspace_tool_path_for_session(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }
    let Some(root) = session_workspace_root_override(state, session_id) else {
        return resolve_workspace_tool_path(state, raw_path);
    };
    let normalized_trimmed = if Path::new(trimmed).is_absolute() {
        trimmed.to_string()
    } else {
        let slash_trimmed = trimmed.replace('\\', "/");
        let root_name = root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let duplicated_theme_prefix = if root_name.is_empty() {
            None
        } else {
            Some(format!("themes/{root_name}/"))
        };
        if let Some(prefix) = duplicated_theme_prefix.as_deref() {
            if slash_trimmed.starts_with(prefix) {
                slash_trimmed[prefix.len()..].to_string()
            } else if !root_name.is_empty() && slash_trimmed.starts_with(&format!("{root_name}/")) {
                slash_trimmed[root_name.len() + 1..].to_string()
            } else {
                slash_trimmed
            }
        } else {
            slash_trimmed
        }
    };
    let candidate = if Path::new(&normalized_trimmed).is_absolute() {
        PathBuf::from(&normalized_trimmed)
    } else {
        root.join(&normalized_trimmed)
    };
    let normalized = candidate.canonicalize().unwrap_or(candidate.clone());
    let root_normalized = root.canonicalize().unwrap_or(root);
    if !normalized.starts_with(&root_normalized) {
        return Err("path is outside currentPackageRoot".to_string());
    }
    Ok(normalized)
}

pub(crate) fn list_directory_entries(path: &Path, limit: usize) -> Result<Vec<Value>, String> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| {
            let entry_path = entry.path();
            json!({
                "name": entry.file_name().to_string_lossy().to_string(),
                "path": entry_path.display().to_string(),
                "kind": if entry_path.is_dir() { "dir" } else { "file" }
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    if entries.len() > limit {
        entries.truncate(limit);
    }
    Ok(entries)
}

pub(crate) fn interactive_runtime_tools_for_mode(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Value {
    with_store(state, |store| {
        Ok(openai_schemas_for_session(&store, runtime_mode, session_id))
    })
    .unwrap_or_else(|_| openai_schemas_for_runtime_mode(runtime_mode))
}
