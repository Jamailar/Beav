use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::agent::{
    apply_section_budget, budget_for_section, scan_context_text, ContextBundle, ContextSection,
};
use crate::persistence::with_store;
use crate::redclaw_profile::load_redclaw_profile_prompt_bundle;
use crate::skills::build_skill_runtime_state;
use crate::tools::packs::{pack_for_runtime_mode, ToolPack};
use crate::tools::registry::{
    base_tool_names_for_session_metadata, prompt_tool_lines_for_tool_names,
};
use crate::{
    build_prompt_memory_snapshot, editor_session_prompt_context, lexbox_project_root,
    load_redbox_prompt, now_iso, workspace_root, AppState, SkillRecord,
};

#[derive(Clone)]
struct ContextAssemblyInputs {
    settings: Value,
    metadata: Option<Value>,
    skills: Vec<SkillRecord>,
    structured_memory_snapshot: String,
}

pub fn runtime_context_bundle_enabled(settings: &Value) -> bool {
    settings
        .get("feature_flags")
        .and_then(|value| value.get("runtimeContextBundleV2"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn tool_pack_label(pack: ToolPack) -> &'static str {
    match pack {
        ToolPack::Wander => "wander",
        ToolPack::Chatroom => "chatroom",
        ToolPack::Knowledge => "knowledge",
        ToolPack::Redclaw => "redclaw",
        ToolPack::BackgroundMaintenance => "background-maintenance",
        ToolPack::Editor => "editor",
        ToolPack::Diagnostics => "diagnostics",
    }
}

fn read_optional_text(path: &PathBuf) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn assemble_section(
    id: &str,
    title: &str,
    source: String,
    priority: i64,
    raw_content: String,
) -> Option<ContextSection> {
    let normalized = raw_content.trim().to_string();
    if normalized.is_empty() {
        return None;
    }
    let budget = budget_for_section(id);
    let scan_result = scan_context_text(&normalized);
    let (content, truncated, raw_chars, final_chars) = apply_section_budget(
        &scan_result.sanitized_text,
        budget.max_chars,
        budget.strategy,
    );
    Some(ContextSection {
        id: id.to_string(),
        title: title.to_string(),
        source,
        priority,
        max_chars: budget.max_chars,
        truncation_strategy: budget.strategy,
        raw_chars,
        final_chars,
        truncated,
        scan_warnings: scan_result.warnings,
        content,
    })
}

fn collect_context_inputs(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) -> Result<ContextAssemblyInputs, String> {
    with_store(state, |store| {
        let metadata = session_id.and_then(|id| {
            store
                .chat_sessions
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.metadata.clone())
        });
        Ok(ContextAssemblyInputs {
            settings: store.settings.clone(),
            metadata,
            skills: store.skills.clone(),
            structured_memory_snapshot: build_prompt_memory_snapshot(&store, 2_000),
        })
    })
}

fn build_identity_section(runtime_mode: &str) -> String {
    if runtime_mode == "wander" {
        return [
            "You are RedClaw's wander ideation runtime inside RedBox.",
            "- Inspect real files before concluding.",
            "- Use only the listed redbox_* tools.",
            "- Return concise, evidence-backed ideation results.",
            "- Never invent workspace state or unsupported tools.",
        ]
        .join("\n");
    }
    [
        "You are the RedClaw desktop runtime inside RedBox.",
        "- Default to Chinese unless the user clearly asks otherwise.",
        "- Prefer direct, executable answers.",
        "- Verify file, count, path, and state claims with tools before stating them.",
        "- Use only the listed redbox_* tools in this runtime.",
        "- Keep writes inside currentSpaceRoot and do not claim success without tool confirmation.",
    ]
    .join("\n")
}

fn build_workspace_rules_section(
    workspace_root_value: &str,
    workspace_agents: Option<String>,
    repo_agents: Option<String>,
) -> String {
    let mut lines = vec![
        format!("currentSpaceRoot: {workspace_root_value}"),
        format!("skillsPath: {workspace_root_value}/skills"),
        format!("knowledgePath: {workspace_root_value}/knowledge"),
        format!("manuscriptsPath: {workspace_root_value}/manuscripts"),
        format!("mediaPath: {workspace_root_value}/media"),
        format!("redclawProfilePath: {workspace_root_value}/redclaw/profile"),
        format!("memoryPath: {workspace_root_value}/memory"),
    ];
    if let Some(content) = workspace_agents {
        lines.push(String::new());
        lines.push("[Workspace AGENTS.md]".to_string());
        lines.push(content);
    }
    if let Some(content) = repo_agents {
        lines.push(String::new());
        lines.push("[Repo AGENTS.md]".to_string());
        lines.push(content);
    }
    lines.join("\n")
}

fn build_runtime_mode_section(
    runtime_mode: &str,
    pack: ToolPack,
    metadata: Option<&Value>,
    active_skill_names: &[String],
    skill_context_note: &str,
) -> String {
    let mut lines = vec![
        format!("runtimeMode: {runtime_mode}"),
        format!("toolPack: {}", tool_pack_label(pack)),
    ];
    if !active_skill_names.is_empty() {
        lines.push(format!("activeSkills: {}", active_skill_names.join(", ")));
    }
    if !skill_context_note.trim().is_empty() {
        lines.push(format!("skillContext: {}", skill_context_note.trim()));
    }
    if let Some(metadata) = metadata {
        let metadata_lines = [
            (
                "contextType",
                metadata.get("contextType").and_then(Value::as_str),
            ),
            (
                "contextId",
                metadata.get("contextId").and_then(Value::as_str),
            ),
            (
                "associatedFilePath",
                metadata.get("associatedFilePath").and_then(Value::as_str),
            ),
            (
                "projectId",
                metadata.get("projectId").and_then(Value::as_str),
            ),
        ];
        for (label, value) in metadata_lines {
            if let Some(value) = value.filter(|item| !item.trim().is_empty()) {
                lines.push(format!("{label}: {value}"));
            }
        }
    }
    if runtime_mode == "wander" {
        lines.push(
            "modeDirective: keep the process lean, inspect folders/files, then synthesize."
                .to_string(),
        );
    }
    if let Some(overlay) = runtime_mode_overlay_prompt(runtime_mode) {
        lines.push(format!("[modeOverlay]\n{}", overlay));
    }
    lines.join("\n")
}

fn runtime_mode_overlay_prompt(runtime_mode: &str) -> Option<String> {
    match runtime_mode {
        "video-editor" => load_redbox_prompt("runtime/agents/video_editor/base.txt"),
        "audio-editor" => load_redbox_prompt("runtime/agents/audio_editor/base.txt"),
        _ => None,
    }
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn build_skill_overlay_section(
    active_skill_names: &[String],
    skills_section: &str,
    prompt_prefix: &str,
    prompt_suffix: &str,
) -> String {
    let mut parts = Vec::new();
    if !active_skill_names.is_empty() {
        parts.push(format!("activeSkills: {}", active_skill_names.join(", ")));
    }
    if !skills_section.trim().is_empty() {
        parts.push(format!("[skillsSection]\n{}", skills_section.trim()));
    }
    if !prompt_prefix.trim().is_empty() {
        parts.push(format!("[promptPrefix]\n{}", prompt_prefix.trim()));
    }
    if !prompt_suffix.trim().is_empty() {
        parts.push(format!("[promptSuffix]\n{}", prompt_suffix.trim()));
    }
    parts.join("\n\n")
}

fn runtime_memory_recall_v2_enabled(settings: &Value) -> bool {
    settings
        .get("feature_flags")
        .and_then(|value| value.get("runtimeMemoryRecallV2"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn build_memory_summary_section(structured_memory_snapshot: &str, recall_enabled: bool) -> String {
    if !recall_enabled {
        return String::new();
    }
    [
        "[structuredMemory]".to_string(),
        structured_memory_snapshot.trim().to_string(),
        "[recallContract]".to_string(),
        [
            "- Treat memory as conclusions, not as raw transcript evidence.",
            "- Use redbox_runtime_control(action=runtime_recall) when you need transcript/checkpoint/tool-result evidence.",
            "- Do not ask for large history dumps unless the current task actually depends on them.",
        ]
        .join("\n"),
    ]
    .join("\n")
}

fn build_profile_docs_section(
    state: &State<'_, AppState>,
    runtime_mode: &str,
) -> Result<String, String> {
    if !matches!(runtime_mode, "redclaw" | "wander") {
        return Ok(String::new());
    }
    let bundle = load_redclaw_profile_prompt_bundle(state)?;
    let mut parts = vec![format!("profileRoot: {}", bundle.profile_root.display())];
    for (label, content) in [
        ("Agent.md", bundle.agent),
        ("Soul.md", bundle.soul),
        ("identity.md", bundle.identity),
        ("user.md", bundle.user),
        ("CreatorProfile.md", bundle.creator_profile),
    ] {
        if content.trim().is_empty() {
            continue;
        }
        parts.push(format!("[{label}]\n{}", content.trim()));
    }
    if bundle
        .onboarding_state
        .get("completedAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .is_empty()
        && !bundle.bootstrap.trim().is_empty()
    {
        parts.push(format!("[BOOTSTRAP.md]\n{}", bundle.bootstrap.trim()));
    }
    Ok(parts.join("\n\n"))
}

fn build_tool_contract_section(
    runtime_mode: &str,
    tool_lines: String,
    allowed_tools: &[String],
) -> String {
    [
        format!("runtimeMode: {runtime_mode}"),
        format!("allowedTools: {}", allowed_tools.join(", ")),
        "[toolDescriptors]".to_string(),
        tool_lines,
        "[runtimeContract]".to_string(),
        [
            "- In this Tauri runtime, only the listed redbox_* tools are callable.",
            "- Prefer redbox_app_query for app-managed state and redbox_fs for workspace reads.",
            "- Use redbox_profile_doc only for long-term profile documents.",
            "- Do not assume bash, workspace, app_cli, or pseudo tools exist unless explicitly listed.",
        ]
        .join("\n"),
    ]
    .join("\n")
}

fn build_ephemeral_turn_section(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
) -> String {
    let mut parts = Vec::new();
    let editor_context = editor_session_prompt_context(state, session_id, runtime_mode);
    if !editor_context.trim().is_empty() {
        parts.push(editor_context.trim().to_string());
    }
    parts.join("\n\n")
}

pub fn build_runtime_context_bundle(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Result<ContextBundle, String> {
    let inputs = collect_context_inputs(state, session_id)?;
    let workspace_root_path = workspace_root(state).unwrap_or_else(|_| PathBuf::from("."));
    let workspace_root_value = workspace_root_path.display().to_string();
    let metadata_ref = inputs.metadata.as_ref();
    let base_tools = base_tool_names_for_session_metadata(runtime_mode, metadata_ref);
    let skill_state =
        build_skill_runtime_state(&inputs.skills, runtime_mode, metadata_ref, &base_tools);
    let tool_lines = prompt_tool_lines_for_tool_names(&skill_state.allowed_tools);
    let pack = pack_for_runtime_mode(runtime_mode);
    let active_skill_names = skill_state
        .active_skills
        .iter()
        .map(|item| item.name.clone())
        .collect::<Vec<_>>();

    let workspace_agents_path = workspace_root_path.join("AGENTS.md");
    let workspace_agents = read_optional_text(&workspace_agents_path);
    let repo_agents_path = lexbox_project_root().join("AGENTS.md");
    let repo_agents = if repo_agents_path != workspace_agents_path {
        read_optional_text(&repo_agents_path)
    } else {
        None
    };
    let sections = vec![
        assemble_section(
            "identity_section",
            "Identity",
            "built-in://runtime/identity".to_string(),
            100,
            build_identity_section(runtime_mode),
        ),
        assemble_section(
            "workspace_rules_section",
            "Workspace Rules",
            "workspace://AGENTS.md".to_string(),
            90,
            build_workspace_rules_section(&workspace_root_value, workspace_agents, repo_agents),
        ),
        assemble_section(
            "runtime_mode_section",
            "Runtime Mode",
            format!("runtime://{}", runtime_mode),
            80,
            build_runtime_mode_section(
                runtime_mode,
                pack,
                metadata_ref,
                &active_skill_names,
                &skill_state.context_note,
            ),
        ),
        assemble_section(
            "skill_overlay_section",
            "Skill Overlay",
            "skills://active".to_string(),
            70,
            build_skill_overlay_section(
                &active_skill_names,
                &skill_state.skills_section,
                &skill_state.prompt_prefix,
                &skill_state.prompt_suffix,
            ),
        ),
        assemble_section(
            "memory_summary_section",
            "Memory Summary",
            "workspace://memory/structured".to_string(),
            60,
            build_memory_summary_section(
                &inputs.structured_memory_snapshot,
                runtime_memory_recall_v2_enabled(&inputs.settings),
            ),
        ),
        assemble_section(
            "profile_docs_section",
            "Profile Docs",
            "workspace://redclaw/profile".to_string(),
            50,
            build_profile_docs_section(state, runtime_mode)?,
        ),
        assemble_section(
            "tool_contract_section",
            "Tool Contract",
            "runtime://tool-contract".to_string(),
            40,
            build_tool_contract_section(runtime_mode, tool_lines, &skill_state.allowed_tools),
        ),
        assemble_section(
            "ephemeral_turn_section",
            "Ephemeral Turn",
            "session://ephemeral".to_string(),
            30,
            build_ephemeral_turn_section(state, session_id, runtime_mode),
        ),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    Ok(ContextBundle {
        session_id: session_id.map(ToString::to_string),
        runtime_mode: runtime_mode.to_string(),
        generated_at: now_iso(),
        sections,
    })
}

pub fn render_runtime_context_bundle_prompt(bundle: &ContextBundle) -> String {
    bundle.render_prompt()
}

pub fn context_bundle_checkpoint_payload(bundle: &ContextBundle) -> Value {
    bundle.summary_payload()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_context_bundle_enabled_defaults_true() {
        assert!(runtime_context_bundle_enabled(&json!({})));
        assert!(!runtime_context_bundle_enabled(&json!({
            "feature_flags": { "runtimeContextBundleV2": false }
        })));
    }
}
