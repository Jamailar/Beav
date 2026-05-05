use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::persistence::ensure_store_hydrated_for_subjects;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_session_checkpoint, build_runtime_context_bundle_summary, load_session_bundle_messages,
    runtime_context_messages_for_session, RuntimeContextBundle,
};
use crate::skills::{build_skill_prompt_bundle, normalize_skill_logical_path, resolve_skill_set};
use crate::tools::registry::{
    base_tool_names_for_session_metadata, openai_schemas_for_runtime_mode,
    openai_schemas_for_session_with_mcp, prompt_tool_lines_for_runtime_mode,
    prompt_tool_lines_for_session, tool_plan_snapshot_for_session,
    tool_plan_snapshot_for_session_with_mcp,
};
use crate::{
    compact_host_runtime_context, current_host_runtime_context, load_redbox_prompt,
    load_redclaw_profile_prompt_bundle, now_iso, payload_string, redbox_builtin_skill_roots,
    render_host_runtime_context_section, render_redbox_prompt, slug_from_relative_path,
    truncate_chars, workspace_root, AppState,
};

pub(crate) fn interactive_runtime_context_bundle(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> RuntimeContextBundle {
    if session_id.is_none() {
        if let Ok(runtime_warm) = state.runtime_warm.lock() {
            if let Some(entry) = runtime_warm.entries.get(runtime_mode) {
                if !entry.system_prompt.trim().is_empty() {
                    return RuntimeContextBundle::new(
                        entry.system_prompt.clone(),
                        entry.context_bundle.clone(),
                    );
                }
            }
        }
    }
    let (
        available_tools,
        active_skill_count,
        project_context,
        skills_section,
        prompt_prefix,
        prompt_suffix,
        active_speaker_section,
        explicit_knowledge_section,
        has_member_speaker,
        host_runtime_context_section,
        subagent_role_overlay_section,
    ) = with_store(state, |store| {
        let raw_metadata = session_id.and_then(|id| {
            store
                .chat_sessions
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.metadata.as_ref())
        });
        let effective_metadata = effective_member_runtime_metadata(&store, raw_metadata);
        let metadata = effective_metadata.as_ref().or(raw_metadata);
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
        if metadata
            .and_then(|item| item.get("isSubagentSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let role_id = metadata
                .and_then(|item| payload_string(item, "roleId"))
                .unwrap_or_default();
            if !role_id.trim().is_empty() {
                project_context.push_str("; subagent_role=");
                project_context.push_str(role_id.trim());
            }
        }
        Ok((
            prompt_tool_lines_for_session(&store, runtime_mode, session_id),
            resolved_skills.active_skills.len(),
            project_context,
            skill_prompt.skills_section,
            skill_prompt.prompt_prefix,
            skill_prompt.prompt_suffix,
            active_speaker_prompt_section(metadata, &store.advisors),
            explicit_knowledge_prompt_section(metadata),
            has_active_member_speaker(metadata),
            render_host_runtime_context_section(&host_context),
            subagent_role_overlay_section(metadata),
        ))
    })
    .unwrap_or_else(|_| {
        let host_context = current_host_runtime_context();
        (
            prompt_tool_lines_for_runtime_mode(runtime_mode),
            0,
            format!(
                "runtime_mode={runtime_mode}; {}",
                compact_host_runtime_context(&host_context)
            ),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            false,
            render_host_runtime_context_section(&host_context),
            String::new(),
        )
    });
    let workspace_root_value = workspace_root(state)
        .map(|value| value.display().to_string())
        .unwrap_or_default();
    let subjects_section = build_subjects_section(state, &workspace_root_value);
    let memory_section =
        crate::memory::build_memory_prompt_section(state, runtime_mode, session_id, 8);
    let account_context_section = crate::accounts::build_account_prompt_section(state);
    let runtime_agent_overlay = runtime_agent_overlay_prompt(runtime_mode);
    let video_analysis_section = video_analysis_prompt_section();
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
                "When the host already preloaded a material bundle, use that bundle first and do not repeat exploratory file reads by default.",
                "Keep the process lean: use List/Search/Read on workspace paths only when the preloaded material bundle is clearly insufficient.",
                "The output must be publication-grade, not placeholders.",
                "Treat materials as inspiration and evidence candidates, not mandatory ingredients.",
                "Do not force every material into the final topic; weak materials may be dropped, and strong materials may be used only for hook, angle, tension, structure, or tone learning.",
                "Quality, novelty, and publishability are more important than material coverage.",
                "Never output generic titles such as '从某素材延展出的内容选题' or '未命名选题'.",
                "The final title must stay within 20 Chinese characters or the equivalent concise length in other languages.",
                "Never output generic directions such as '围绕这组素材提炼一个方向'.",
                "A valid result must include direction_frame.target_reader, direction_frame.core_tension, direction_frame.angle, and direction_frame.material_entry before you finalize title and content_direction.",
                "A valid content_direction must state the target audience, the core conflict/tension, the angle, and how the inspected materials informed that angle or sharpened its hook.",
                "Do not suggest pseudo tools or imaginary commands; call only the tools actually exposed in available_tools.",
                "Do not invent fs aliases such as fs read, knowledge_read, workflow fs ..., or resource(...); use only the visible tools.",
            ]
            .join(" "),
        );
        sections.push(format!("Runtime context: {project_context}"));
        sections.push(format!(
            "Host runtime context:\n{}",
            host_runtime_context_section.trim()
        ));
        if !subagent_role_overlay_section.trim().is_empty() {
            sections.push(subagent_role_overlay_section.trim().to_string());
        }
        sections.push(video_analysis_section.to_string());
        if !available_tools.trim().is_empty() {
            sections.push(format!("Available tools:\n{available_tools}"));
        }
        if !skills_section.trim().is_empty() {
            sections.push(format!("Skill guidance:\n{}", skills_section.trim()));
        }
        if let Some(memory_section) = memory_section.as_ref() {
            sections.push(memory_section.summary.trim().to_string());
        }
        if let Some(account_context_section) = account_context_section.as_ref() {
            sections.push(account_context_section.trim().to_string());
        }
        if !explicit_knowledge_section.trim().is_empty() {
            sections.push(explicit_knowledge_section.trim().to_string());
        }
        if !active_speaker_section.trim().is_empty() {
            sections.push(active_speaker_section.trim().to_string());
        }
        if !prompt_suffix.trim().is_empty() {
            sections.push(prompt_suffix.trim().to_string());
        }
        let final_prompt = sections.join("\n\n");
        return RuntimeContextBundle::new(
            final_prompt.clone(),
            build_runtime_context_bundle_summary(
                runtime_mode,
                &available_tools,
                active_skill_count,
                &project_context,
                &host_runtime_context_section,
                &active_speaker_section,
                memory_section.as_ref().map(|item| item.summary.as_str()),
                &subjects_section,
                &prompt_prefix,
                &prompt_suffix,
                &final_prompt,
            ),
        );
    }
    if runtime_mode == "manuscript-editor" {
        if let Some(template) = load_redbox_prompt("runtime/pi/manuscript_editor.txt") {
            let mut rendered = render_redbox_prompt(
                &template,
                &[
                    ("available_tools", available_tools.clone()),
                    ("project_context", project_context.clone()),
                    ("host_runtime_context", host_runtime_context_section.clone()),
                    ("skills_section", skills_section.clone()),
                    ("current_date", now_iso()),
                ],
            );
            if !prompt_prefix.trim().is_empty() {
                rendered = format!("{}\n\n{}", prompt_prefix.trim(), rendered);
            }
            if !subagent_role_overlay_section.trim().is_empty() {
                rendered.push_str("\n\n");
                rendered.push_str(subagent_role_overlay_section.trim());
            }
            if !prompt_suffix.trim().is_empty() {
                rendered.push_str("\n\n");
                rendered.push_str(prompt_suffix.trim());
            }
            if !explicit_knowledge_section.trim().is_empty() {
                rendered.push_str("\n\n");
                rendered.push_str(explicit_knowledge_section.trim());
            }
            if let Some(account_context_section) = account_context_section.as_ref() {
                rendered.push_str("\n\n");
                rendered.push_str(account_context_section.trim());
            }
            if !active_speaker_section.trim().is_empty() {
                rendered.push_str("\n\n");
                rendered.push_str(active_speaker_section.trim());
            }
            return RuntimeContextBundle::new(
                rendered.clone(),
                build_runtime_context_bundle_summary(
                    runtime_mode,
                    &available_tools,
                    active_skill_count,
                    &project_context,
                    &host_runtime_context_section,
                    &active_speaker_section,
                    memory_section.as_ref().map(|item| item.summary.as_str()),
                    &subjects_section,
                    &prompt_prefix,
                    &prompt_suffix,
                    &rendered,
                ),
            );
        }
    }
    if let Some(template) = load_redbox_prompt("runtime/pi/system_base.txt") {
        let mut rendered = render_redbox_prompt(
            &template,
            &[
                ("available_tools", available_tools.clone()),
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
                ("subjects_path", workspace_root_value.clone() + "/assets"),
                ("redclaw_path", workspace_root_value.clone() + "/redclaw"),
                (
                    "redclaw_profile_path",
                    workspace_root_value.clone() + "/redclaw/profile",
                ),
                ("memory_path", workspace_root_value.clone() + "/memory"),
                ("project_context", project_context.clone()),
                ("host_runtime_context", host_runtime_context_section.clone()),
                ("skills_section", skills_section.clone()),
                (
                    "memory_section",
                    memory_section
                        .as_ref()
                        .map(|item| item.summary.clone())
                        .unwrap_or_default(),
                ),
                ("subjects_section", subjects_section.clone()),
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
        rendered.push_str("\n\n");
        rendered.push_str(video_analysis_section);
        if !subagent_role_overlay_section.trim().is_empty() {
            rendered.push_str("\n\n");
            rendered.push_str(subagent_role_overlay_section.trim());
        }
        if let Some(memory_section) = memory_section.as_ref() {
            rendered.push_str("\n\n");
            rendered.push_str(memory_section.summary.trim());
        }
        if let Some(account_context_section) = account_context_section.as_ref() {
            rendered.push_str("\n\n");
            rendered.push_str(account_context_section.trim());
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
                if has_member_speaker {
                    rendered.push_str("<redclaw_soul_md skipped=\"active-member-speaker\">\n");
                    rendered.push_str("Soul.md belongs to RedClaw's own speaking persona. It is intentionally not injected for this turn because a member is the active speaker.\n");
                    rendered.push_str("</redclaw_soul_md>\n");
                } else {
                    rendered.push_str("<redclaw_soul_md>\n");
                    rendered.push_str(&truncate_chars(&bundle.soul, 6000));
                    rendered.push_str("\n</redclaw_soul_md>\n");
                }
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
                rendered.push_str("- 查询长期档案优先使用 `Operate(resource=\"profile\", operation=\"get|list\")`，不要先用 bash/find/PowerShell 按文件名盲扫。\n");
                rendered.push_str("- 查询长期记忆优先使用 `Operate(resource=\"memory\", operation=\"list|search|get\")`；写入/修订长期记忆使用 `Operate(resource=\"memory\", operation=\"create|update\")`；`memory/MEMORY.md` 只是自动生成摘要，不是主存储。\n");
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
                let onboarding_flow_mode = bundle
                    .onboarding_state
                    .get("flowMode")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if !onboarding_completed
                    && onboarding_flow_mode != "screen-flow"
                    && !bundle.bootstrap.trim().is_empty()
                {
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
            "\n\nRuntime tool note:\n- Only call the tools explicitly listed in available_tools.\n- Use `Read`, `List`, `Search`, `Write`, `Operate`, `bash`, and `tool_search` exactly as exposed; do not call internal tools such as `workflow`, `resource`, or `editor`.\n- The available_tools section already lists the action families exposed for this runtime; prefer those families directly instead of exploratory help calls.\n- For a user-provided public URL, use `Read(path=\"https://...\")`; do not use `bash` with curl/wget for web pages.\n- When diagnosing local CLI availability, prefer `Operate(resource=\"cli_runtime\", operation=\"inspect\", input={\"command\":\"<name>\"})` for a known command and `Operate(resource=\"cli_runtime\", operation=\"discover\")` for PATH search. Preserve the exact executable string the user typed, including hyphens such as `lark-cli`; do not shorten it to a guessed alias like `lark`.\n- Do not infer “not installed” only because `cli_runtime.detect` did not list a command. `cli_runtime.inspect` includes host shell and shell resolve probe evidence; treat missing as final only after that evidence and install/retry options are exhausted. If the inspected CLI is missing and the user asked you to make it usable, continue with `Operate(resource=\"cli_runtime\", operation=\"install\", input={\"installMethod\":\"npm|pnpm|python|uv|cargo|go|binary|manual\",\"spec\":\"<package-or-url>\",\"toolName\":\"<exact-command>\"})` when an install spec is known, then inspect/execute again.\n- To actually run a local CLI command, use `Operate(resource=\"cli_runtime\", operation=\"run\", input={\"argv\":[\"<command>\",\"--flag\"]})`; this response includes stdoutText/stderrText for short output. If more output is needed, call `Operate(resource=\"cli_runtime\", operation=\"get\", input={\"executionId\":\"cli-exec-...\"})`.\n- Do not read CLI runtime log files directly and do not write temporary files just to capture command output.\n- Do not use `bash` for real CLI execution or PATH diagnosis such as `curl`, `which`, `command -v`, `type`, `npm`, `pnpm`, `node`, `lark-cli`, or `echo $PATH`; `bash` is read-only workspace inspection only and its allowlist does not model host CLI availability.\n- For advisor/member knowledge, prefer `List(path=\"knowledge://\")`, `Search(path=\"knowledge://\", query=\"...\")`, or `Read(path=\"knowledge://...\")` instead of broad `bash` scanning.\n- For workspace file discovery, prefer `Search(path=\"workspace://\", query=\"...\")` or exact relative paths instead of `bash find` when the path is known or can be narrowed.\n- When `bash` is available, use it only for read-only inspection inside currentSpaceRoot.\n- For bound video/audio manuscript packages, use `Read(path=\"editor://current/script\")`, `Write(path=\"editor://current/script\", content=\"...\")`, or `Operate(resource=\"editor\", operation=\"...\")`.\n",
        );
        rendered.push_str("- For MCP setup or diagnostics, use `Operate(resource=\"mcp\", operation=\"list|install|verify|get|run\")`; do not stop at written installation instructions when the user asked you to configure or test MCP. If an MCP package must be installed, use `Operate(resource=\"cli_runtime\", ...)` to inspect/install/run the host CLI, then save and test the server through `Operate(resource=\"mcp\", ...)`.\n");
        rendered.push_str("\n");
        rendered.push_str(team_coordinator_prompt());
        if !prompt_suffix.trim().is_empty() {
            rendered.push_str("\n\n");
            rendered.push_str(prompt_suffix.trim());
        }
        if !explicit_knowledge_section.trim().is_empty() {
            rendered.push_str("\n\n");
            rendered.push_str(explicit_knowledge_section.trim());
        }
        if !active_speaker_section.trim().is_empty() {
            rendered.push_str("\n\n");
            rendered.push_str(active_speaker_section.trim());
        }
        return RuntimeContextBundle::new(
            rendered.clone(),
            build_runtime_context_bundle_summary(
                runtime_mode,
                &available_tools,
                active_skill_count,
                &project_context,
                &host_runtime_context_section,
                &active_speaker_section,
                memory_section.as_ref().map(|item| item.summary.as_str()),
                &subjects_section,
                &prompt_prefix,
                &prompt_suffix,
                &rendered,
            ),
        );
    }
    let mut fallback = format!(
        "You are the RedClaw desktop AI runtime inside RedBox for mode `{}`. \
Use tools when the user asks about app state, knowledge, advisors, work items, memories, sessions, or settings. \
Do not invent workspace/app facts that you can fetch with tools. \
If no tool is needed, answer directly and concisely. \
When using tools, synthesize the final answer in Chinese unless the user clearly asks otherwise. \
During multi-step tool work, provide concise user-visible progress summaries before the first tool call, after meaningful tool results, when changing approach, after failures or fallbacks, and before the final answer. \
These summaries must be user-readable and must not expose hidden chain-of-thought, prompt text, tool schemas, internal framework labels, page numbers, draft labels, or placeholders. \
Host runtime context: {}\n{}",
        runtime_mode,
        render_host_runtime_context_section(&current_host_runtime_context()),
        team_coordinator_prompt()
    );
    if !active_speaker_section.trim().is_empty() {
        if !explicit_knowledge_section.trim().is_empty() {
            fallback.push_str("\n\n");
            fallback.push_str(explicit_knowledge_section.trim());
        }
        if let Some(account_context_section) = account_context_section.as_ref() {
            fallback.push_str("\n\n");
            fallback.push_str(account_context_section.trim());
        }
        fallback.push_str("\n\n");
        fallback.push_str(active_speaker_section.trim());
    } else if !explicit_knowledge_section.trim().is_empty() {
        fallback.push_str("\n\n");
        fallback.push_str(explicit_knowledge_section.trim());
        if let Some(account_context_section) = account_context_section.as_ref() {
            fallback.push_str("\n\n");
            fallback.push_str(account_context_section.trim());
        }
    } else if let Some(account_context_section) = account_context_section.as_ref() {
        fallback.push_str("\n\n");
        fallback.push_str(account_context_section.trim());
    }
    RuntimeContextBundle::new(
        fallback.clone(),
        build_runtime_context_bundle_summary(
            runtime_mode,
            &active_speaker_section,
            0,
            "",
            "",
            "",
            None,
            "",
            "",
            "",
            &fallback,
        ),
    )
}

fn video_analysis_prompt_section() -> &'static str {
    "Video Analysis Specialist:\n- When a user attaches a video and the task depends on real video content, use `Operate(resource=\"video\", operation=\"analyze\", input={\"toolPath\":\"<attachment toolPath>\",\"mode\":\"summary|shot_breakdown|speech_extract|highlight_clips|talking_head_cut|smart_edit\",\"instruction\":\"...\"})` before making claims about the video's visual or audio content.\n- `video.analyze` is executed by the locked `Video Analysis Agent` specialist/subagent. The main chat model must not pretend to have watched the video and must not replace this specialist with ordinary `Read`.\n- The Video Analysis Agent only returns structured analysis JSON. Use that result as evidence for writing, editing, short-clip selection, or RedClaw/team follow-up work.\n- If `video.analyze` reports that the dedicated video model is missing or unsupported, tell the user to configure the Video Analysis Agent model instead of inventing video details."
}

fn effective_member_runtime_metadata(
    store: &crate::AppStore,
    metadata: Option<&Value>,
) -> Option<Value> {
    let metadata = metadata?;
    let has_member_skill = metadata
        .get("memberSkillRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if !has_member_skill
        || crate::member_skill::member_feature_flag_enabled_for_store(
            store,
            "memberRuntimeOverlay",
            true,
        )
    {
        return None;
    }
    let mut object = metadata.as_object()?.clone();
    crate::member_skill::detach_member_skill_metadata(&mut object);
    Some(Value::Object(object))
}

pub(crate) fn interactive_runtime_system_prompt(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> String {
    interactive_runtime_context_bundle(state, runtime_mode, session_id).system_prompt
}

fn has_active_member_speaker(metadata: Option<&Value>) -> bool {
    let Some(metadata) = metadata else {
        return false;
    };
    metadata
        .get("activeSpeaker")
        .and_then(Value::as_object)
        .and_then(|object| object.get("type"))
        .and_then(Value::as_str)
        .map(|value| value == "member")
        .unwrap_or(false)
        || metadata
            .get("memberMentionMode")
            .and_then(Value::as_str)
            .map(|value| value == "single-turn")
            .unwrap_or(false)
}

fn explicit_knowledge_prompt_section(metadata: Option<&Value>) -> String {
    let Some(metadata) = metadata else {
        return String::new();
    };
    let Some(items) = metadata
        .get("explicitKnowledgeRefs")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    else {
        return String::new();
    };
    let mut lines = vec![
        "ExplicitKnowledgeReferences:".to_string(),
        "- The user explicitly mentioned the following knowledge library items with `#` in this turn.".to_string(),
        "- Treat these references as high-priority context anchors.".to_string(),
        "- `primaryPath` is the best local path to inspect first. For note/video captures, it is usually a material folder; list it first, then read `meta.json` and any transcript/content/description files you find there.".to_string(),
        "- For document sources, `rootPath` is the document source root; search/read files under that root before making detailed factual claims.".to_string(),
        "- If a referenced item cannot be inspected, say so instead of inventing details.".to_string(),
    ];
    for (index, item) in items.iter().take(12).enumerate() {
        let knowledge_id = item
            .get("knowledgeId")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("未命名内容");
        let source_kind = item
            .get("sourceKind")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let folder_path = item
            .get("folderPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let root_path = item
            .get("rootPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let source_url = item
            .get("sourceUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let summary = item
            .get("summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        lines.push(format!(
            "{}. title: {}; id: {}; kind: {}",
            index + 1,
            title,
            knowledge_id,
            source_kind
        ));
        if !folder_path.is_empty() || !root_path.is_empty() {
            let primary_path = if !root_path.is_empty() {
                root_path
            } else {
                folder_path
            };
            if !primary_path.is_empty() {
                lines.push(format!("   primaryPath: {}", primary_path));
            }
            lines.push(format!(
                "   contentFolderPath: {}; rootPath: {}",
                folder_path, root_path
            ));
        }
        if !source_url.is_empty() {
            lines.push(format!("   sourceUrl: {}", source_url));
        }
        if !summary.is_empty() {
            lines.push(format!("   summary: {}", truncate_chars(summary, 900)));
        }
    }
    lines.join("\n")
}

fn active_speaker_prompt_section(
    metadata: Option<&Value>,
    advisors: &[crate::AdvisorRecord],
) -> String {
    let Some(metadata) = metadata else {
        return String::new();
    };
    let active_speaker = metadata.get("activeSpeaker").and_then(Value::as_object);
    let advisor_id = metadata
        .get("activeSpeaker")
        .and_then(Value::as_object)
        .and_then(|object| {
            object
                .get("speakerId")
                .and_then(Value::as_str)
                .or_else(|| object.get("memberId").and_then(Value::as_str))
        })
        .map(ToString::to_string)
        .or_else(|| crate::payload_string(metadata, "advisorId"))
        .or_else(|| {
            let context_type = crate::payload_string(metadata, "contextType");
            if context_type.as_deref() == Some("advisor-discussion") {
                return crate::payload_string(metadata, "contextId");
            }
            None
        });
    let Some(advisor_id) = advisor_id.filter(|value| !value.trim().is_empty()) else {
        return String::new();
    };
    let advisor = advisors.iter().find(|item| item.id == advisor_id);
    let advisor_name = active_speaker
        .and_then(|object| object.get("displayName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| advisor.map(|item| item.name.clone()))
        .unwrap_or_else(|| "成员".to_string());
    let advisor_personality = active_speaker
        .and_then(|object| object.get("personality"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            advisor
                .map(|item| item.personality.trim())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("保持该成员在团队中的专业视角。");
    let advisor_system_prompt = active_speaker
        .and_then(|object| object.get("systemPrompt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            advisor
                .map(|item| item.system_prompt.trim())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("以该成员身份回答，优先结合绑定知识库，不确定时明确说明。");
    let member_skill_ref = crate::payload_string(metadata, "memberSkillRef")
        .or_else(|| advisor.and_then(|item| item.member_skill_ref.clone()))
        .unwrap_or_else(|| "(none)".to_string());
    let advisor_knowledge_path = format!(
        "advisors/{}/knowledge",
        slug_from_relative_path(&advisor_id)
    );
    format!(
        "ActiveSpeakerProfile:\n- type: member\n- You are currently answering as: {} ({})\n- Member skill ref: {}\n- This single turn must use this member's role, voice, priorities, and decision style. Do not answer as RedClaw, a generic assistant, or another member.\n- This section has higher priority than RedClaw Soul.md when both are present.\n\nMember persona:\n{}\n\nMember system prompt:\n{}\n\nAdvisor knowledge retrieval:\n- Advisor knowledge root: {}\n- This turn is bound to a single advisor knowledge scope.\n- Before making advisor-specific claims, prefer `List(path=\"knowledge://\")`, `Search(path=\"knowledge://\", query=\"...\")`, or `Read(path=\"knowledge://...\")` to inspect this advisor's files.\n- Suggested order: `List(path=\"knowledge://\")` -> `Search(path=\"knowledge://\", query=\"...\")` -> `Read(path=\"knowledge://...\")`.\n- If a tool call supports `advisorId`, use `{}` explicitly when the session context alone may be ambiguous.\n- Do not answer as if you know the advisor's source materials unless you actually inspected them with tools or the user already provided them in chat.",
        advisor_name,
        advisor_id,
        member_skill_ref,
        truncate_chars(advisor_personality, 1800),
        truncate_chars(advisor_system_prompt, 3000),
        advisor_knowledge_path,
        advisor_id
    )
}

fn subagent_role_overlay_section(metadata: Option<&Value>) -> String {
    let Some(metadata) = metadata else {
        return String::new();
    };
    if !metadata
        .get("isSubagentSession")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return String::new();
    }

    let role_id = payload_string(metadata, "roleId").unwrap_or_else(|| "subagent".to_string());
    let purpose = payload_string(metadata, "subagentRolePurpose").unwrap_or_default();
    let handoff_contract =
        payload_string(metadata, "subagentRoleHandoffContract").unwrap_or_default();
    let output_schema = payload_string(metadata, "subagentRoleOutputSchema").unwrap_or_default();
    let directive = payload_string(metadata, "subagentRoleDirective").unwrap_or_default();
    let system_prompt_patch =
        payload_string(metadata, "subagentSystemPromptPatch").unwrap_or_default();
    let allowed_tools = metadata
        .get("allowedTools")
        .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string()))
        .unwrap_or_else(|| "[]".to_string());

    let mut lines = vec![
        "## Subagent Role Overlay".to_string(),
        "You are a child runtime inside RedBox. Stay strictly inside this role and only produce the work this role owns.".to_string(),
        format!("- roleId: {}", role_id.trim()),
        format!("- purpose: {}", purpose.trim()),
        format!("- handoffContract: {}", handoff_contract.trim()),
        format!("- outputSchema: {}", output_schema.trim()),
        format!("- allowedTools: {}", allowed_tools),
    ];
    if !directive.trim().is_empty() {
        lines.push("Role directive:".to_string());
        lines.push(directive.trim().to_string());
    }
    if !system_prompt_patch.trim().is_empty() {
        lines.push("Additional child-runtime constraints:".to_string());
        lines.push(system_prompt_patch.trim().to_string());
    }
    lines.push(
        "Return strict JSON only with fields summary, artifact, handoff, risks, issues, approved."
            .to_string(),
    );
    lines.push("Do not claim files, images, videos, or records were created unless a tool result or prior output confirms it.".to_string());
    lines.join("\n")
}

fn build_subjects_section(state: &State<'_, AppState>, workspace_root_value: &str) -> String {
    let subjects_root = if workspace_root_value.trim().is_empty() {
        "assets".to_string()
    } else {
        format!("{workspace_root_value}/assets")
    };

    let _ = ensure_store_hydrated_for_subjects(state);
    let (subjects, categories) = match with_store(state, |store| {
        Ok((store.subjects.clone(), store.categories.clone()))
    }) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return [
                format!("Assets root: {subjects_root}"),
                format!("读取资产索引失败: {error}"),
            ]
            .join("\n");
        }
    };

    if subjects.is_empty() {
        let lines = vec![
            "当前空间还没有注册资产。".to_string(),
            format!("Assets root: {subjects_root}"),
            "如果用户提到具体人物、商品、场景，仍应优先查询资产库；若结果为空，再明确说明未找到。"
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
        "These asset names have reference materials in the current space.",
        "When the user mentions one of these names or a close combination of them, inspect the asset library before answering.",
        "<available_subjects>",
        &subject_nodes,
        "</available_subjects>",
    ]
    .join("\n")
}

fn runtime_agent_overlay_prompt(runtime_mode: &str) -> String {
    match runtime_mode {
        "redclaw" => load_redbox_prompt("runtime/agents/redclaw/base.txt").unwrap_or_default(),
        "image-generation" => {
            load_redbox_prompt("runtime/agents/image_generation/base.txt").unwrap_or_default()
        }
        "video-editor" => {
            load_redbox_prompt("runtime/agents/video_editor/base.txt").unwrap_or_default()
        }
        "audio-editor" => {
            load_redbox_prompt("runtime/agents/audio_editor/base.txt").unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn team_coordinator_prompt() -> &'static str {
    "\nTeam coordinator rules:\n- When the user asks for team collaboration, multiple roles, project tracking, a Kanban board, or regular progress reports, use `Operate(resource=\"team\", ...)` actions instead of only describing a plan.\n- Create the collaboration project with `Operate(resource=\"team.session\", operation=\"create\", ...)`, then create internal members with `Operate(resource=\"team.member\", operation=\"spawn\", ...)`, then create assignable tasks with `Operate(resource=\"team.task\", operation=\"create\", ...)`.\n- Team members are internal runtime members only. Do not create external ACP/CLI members and do not ask the user to install an external agent for team collaboration.\n- Use `Operate(resource=\"team.message\", operation=\"send\", ...)` for member-to-member/coordinator communication and `Operate(resource=\"team.report\", operation=\"request|submit\", ...)` for progress reporting.\n- After mutating team state, summarize the created session id, member names, task titles, and what the user can see on the Workboard."
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
        let sanitized_messages =
            crate::runtime::sanitize_runtime_history_messages(&bundle_messages);
        if !sanitized_messages.is_empty() {
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
                &sanitized_messages,
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
        let builtin_roots = redbox_builtin_skill_roots();
        for builtin_root in &builtin_roots {
            let candidate = builtin_root.join(relative);
            if !candidate.exists() {
                continue;
            }
            let normalized = candidate.canonicalize().unwrap_or(candidate.clone());
            let builtin_normalized = builtin_root.canonicalize().unwrap_or(builtin_root.clone());
            if !normalized.starts_with(&builtin_normalized) {
                return Err("path is outside builtin-skills".to_string());
            }
            return Ok(normalized);
        }
        if let Some(builtin_root) = builtin_roots.into_iter().next() {
            let candidate = builtin_root.join(relative);
            let normalized = candidate.canonicalize().unwrap_or(candidate.clone());
            let builtin_normalized = builtin_root.canonicalize().unwrap_or(builtin_root);
            if !normalized.starts_with(&builtin_normalized) {
                return Err("path is outside builtin-skills".to_string());
            }
            return Ok(normalized);
        }
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
    let mcp_servers = with_store(state, |store| Ok(store.mcp_servers.clone())).unwrap_or_default();
    let mcp_inventory = state.mcp_manager.list_all_tools(&mcp_servers).ok();
    with_store_mut(state, |store| {
        let snapshot = if mcp_inventory.is_some() {
            tool_plan_snapshot_for_session_with_mcp(
                &store,
                runtime_mode,
                session_id,
                mcp_inventory.as_ref(),
            )
        } else {
            tool_plan_snapshot_for_session(&store, runtime_mode, session_id)
        };
        eprintln!("[tools][plan] {snapshot}");
        if let Some(session_id) = session_id {
            append_session_checkpoint(
                store,
                session_id,
                "tool_plan",
                "tool plan generated".to_string(),
                Some(snapshot),
            );
            if let Some(member_skill_activation) =
                crate::member_skill::member_skill_activation_checkpoint_payload(store, session_id)
            {
                append_session_checkpoint(
                    store,
                    session_id,
                    "memberSkillActivation",
                    "member skill activation resolved".to_string(),
                    Some(member_skill_activation),
                );
            }
        }
        Ok(openai_schemas_for_session_with_mcp(
            &store,
            runtime_mode,
            session_id,
            mcp_inventory.as_ref(),
        ))
    })
    .unwrap_or_else(|_| openai_schemas_for_runtime_mode(runtime_mode))
}
