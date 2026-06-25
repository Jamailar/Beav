#![allow(dead_code)]

pub mod cli_runtime;
pub mod editor;
pub mod image;
pub mod manuscripts;
pub mod memory;
pub mod redclaw;
pub mod runtime;
pub mod subjects;
pub mod team;
pub mod voice;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionExposurePolicy {
    pub runtime_mode: &'static str,
    pub direct_namespaces: Vec<&'static str>,
    pub deferred_namespaces: Vec<&'static str>,
    pub max_direct_actions: usize,
}

pub fn default_exposure_policy(runtime_mode: &str) -> ActionExposurePolicy {
    let normalized = normalize_runtime_mode(runtime_mode);
    ActionExposurePolicy {
        runtime_mode: normalized,
        direct_namespaces: default_direct_namespaces(normalized, None),
        deferred_namespaces: default_deferred_namespaces(normalized),
        max_direct_actions: 24,
    }
}

pub fn default_direct_namespaces(
    runtime_mode: &str,
    task_intent: Option<&str>,
) -> Vec<&'static str> {
    let mut namespaces = match normalize_runtime_mode(runtime_mode) {
        "image-generation" => vec![
            image::NAMESPACE,
            runtime::NAMESPACE,
            "generation.job",
            "video_analysis",
            subjects::NAMESPACE,
            voice::NAMESPACE,
        ],
        "knowledge" => vec![subjects::NAMESPACE, runtime::NAMESPACE],
        "redclaw" => vec![
            image::NAMESPACE,
            runtime::NAMESPACE,
            "video_analysis",
            voice::NAMESPACE,
            "video",
            manuscripts::NAMESPACE,
            subjects::NAMESPACE,
        ],
        "background-maintenance" | "diagnostics" => vec![
            runtime::NAMESPACE,
            runtime::TASKS_NAMESPACE,
            redclaw::TASK_NAMESPACE,
            "settings",
        ],
        "team" => vec![
            team::SESSION_NAMESPACE,
            team::MEMBER_NAMESPACE,
            team::TASK_NAMESPACE,
            team::MESSAGE_NAMESPACE,
            team::REPORT_NAMESPACE,
            team::ARTIFACT_NAMESPACE,
            team::BLOCKER_NAMESPACE,
            subjects::NAMESPACE,
            runtime::NAMESPACE,
            image::NAMESPACE,
            manuscripts::NAMESPACE,
            "video_analysis",
            voice::NAMESPACE,
        ],
        _ => vec![
            subjects::NAMESPACE,
            runtime::NAMESPACE,
            image::NAMESPACE,
            manuscripts::NAMESPACE,
            "video_analysis",
            voice::NAMESPACE,
        ],
    };
    match task_intent
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image" | "image-generation" | "cover" => {
            prepend_namespace(&mut namespaces, image::NAMESPACE)
        }
        "video-analysis" | "video_analyze" | "video-analyze" => {
            prepend_namespace(&mut namespaces, "video_analysis")
        }
        "video" | "video-generation" => prepend_namespace(&mut namespaces, "video"),
        "voice" | "tts" | "speech" => prepend_namespace(&mut namespaces, voice::NAMESPACE),
        "redclaw-task" | "scheduled-task" => {}
        "knowledge" | "search" => prepend_namespace(&mut namespaces, subjects::NAMESPACE),
        _ => {}
    }
    namespaces
}

pub fn default_deferred_namespaces(runtime_mode: &str) -> Vec<&'static str> {
    match normalize_runtime_mode(runtime_mode) {
        "wander" => vec![
            image::NAMESPACE,
            "video",
            manuscripts::NAMESPACE,
            redclaw::TASK_NAMESPACE,
            team::SESSION_NAMESPACE,
            runtime::NAMESPACE,
        ],
        "image-generation" => vec![
            manuscripts::NAMESPACE,
            team::SESSION_NAMESPACE,
            memory::NAMESPACE,
            runtime::NAMESPACE,
        ],
        "diagnostics" | "background-maintenance" => {
            vec![
                image::NAMESPACE,
                "video",
                manuscripts::NAMESPACE,
                team::SESSION_NAMESPACE,
            ]
        }
        _ => vec![
            team::SESSION_NAMESPACE,
            runtime::NAMESPACE,
            cli_runtime::NAMESPACE,
        ],
    }
}

pub fn action_family_for_action(action: &str) -> Option<&'static str> {
    let namespace = action.split('.').next().unwrap_or(action);
    match namespace {
        "image" => Some(image::FAMILY),
        "video_analysis" => Some("video_analysis"),
        "video" => Some("video"),
        "media" => Some("media"),
        "voice" => Some(voice::FAMILY),
        "manuscripts" => Some(manuscripts::FAMILY),
        "memory" => Some(memory::FAMILY),
        "assets" | "subjects" => Some(subjects::FAMILY),
        "profile" => Some("profile"),
        "task" => Some("task"),
        "runner" => Some(redclaw::FAMILY),
        "redclaw" => Some(redclaw::FAMILY),
        "team" => Some(team::FAMILY),
        "runtime" => Some(runtime::FAMILY),
        "cli_runtime" => Some(cli_runtime::FAMILY),
        "skills" => Some("skills"),
        "mcp" => Some("mcp"),
        "browser" => Some("browser"),
        _ => None,
    }
}

fn prepend_namespace(namespaces: &mut Vec<&'static str>, namespace: &'static str) {
    if let Some(index) = namespaces.iter().position(|item| *item == namespace) {
        namespaces.remove(index);
    }
    namespaces.insert(0, namespace);
}

fn normalize_runtime_mode(runtime_mode: &str) -> &'static str {
    match runtime_mode.trim() {
        "wander" => "wander",
        "image-generation" | "image_generation" => "image-generation",
        "knowledge" => "knowledge",
        "redclaw" => "redclaw",
        "background-maintenance" => "background-maintenance",
        "diagnostics" => "diagnostics",
        "" | "default" | "chat" | "chatroom" | "team" => "team",
        _ => "team",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_generation_policy_prioritizes_image_family() {
        let namespaces = default_direct_namespaces("image-generation", None);

        assert_eq!(namespaces.first(), Some(&image::NAMESPACE));
        assert!(namespaces.contains(&image::NAMESPACE));
        assert!(!namespaces.contains(&"tools"));
        assert!(!namespaces.contains(&team::SESSION_NAMESPACE));
    }

    #[test]
    fn task_intent_does_not_promote_full_redclaw_task_namespace() {
        let namespaces = default_direct_namespaces("redclaw", Some("scheduled-task"));

        assert!(!namespaces.contains(&redclaw::TASK_NAMESPACE));
    }
}
