#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPack {
    Wander,
    Team,
    ManuscriptEditor,
    ImageGeneration,
    Knowledge,
    Redclaw,
    BackgroundMaintenance,
    Editor,
    Diagnostics,
}

pub fn pack_by_name(name: &str) -> Option<ToolPack> {
    match name.trim().to_lowercase().as_str() {
        "wander" => Some(ToolPack::Wander),
        "manuscript-editor" | "manuscript_editor" => Some(ToolPack::ManuscriptEditor),
        "team" | "chatroom" | "default" | "chat" => Some(ToolPack::Team),
        "image-generation" | "image_generation" => Some(ToolPack::ImageGeneration),
        "knowledge" => Some(ToolPack::Knowledge),
        "redclaw" => Some(ToolPack::Redclaw),
        "background-maintenance" => Some(ToolPack::BackgroundMaintenance),
        "editor" | "video-editor" | "audio-editor" => Some(ToolPack::Editor),
        "diagnostics" => Some(ToolPack::Diagnostics),
        _ => None,
    }
}

pub fn pack_for_runtime_mode(runtime_mode: &str) -> ToolPack {
    match runtime_mode.trim().to_lowercase().as_str() {
        "wander" => ToolPack::Wander,
        "manuscript-editor" | "manuscript_editor" => ToolPack::ManuscriptEditor,
        "image-generation" | "image_generation" => ToolPack::ImageGeneration,
        "knowledge" => ToolPack::Knowledge,
        "redclaw" => ToolPack::Redclaw,
        "video-editor" | "audio-editor" => ToolPack::Editor,
        "background-maintenance" => ToolPack::BackgroundMaintenance,
        "diagnostics" => ToolPack::Diagnostics,
        "team" | "chatroom" | "default" | "chat" => ToolPack::Team,
        _ => ToolPack::Team,
    }
}

pub fn tool_names_for_pack(pack: ToolPack) -> &'static [&'static str] {
    match pack {
        ToolPack::Wander => &["resource"],
        ToolPack::ManuscriptEditor => &["workflow"],
        ToolPack::Team => &["bash", "resource", "workflow"],
        ToolPack::ImageGeneration => &["bash", "resource", "workflow"],
        ToolPack::Knowledge => &["bash", "resource", "workflow"],
        ToolPack::Redclaw => {
            if cfg!(target_os = "windows") {
                &["resource", "workflow"]
            } else {
                &["bash", "resource", "workflow"]
            }
        }
        ToolPack::BackgroundMaintenance => &["bash", "workflow"],
        ToolPack::Editor => &["bash", "resource", "workflow", "editor"],
        ToolPack::Diagnostics => &["bash", "resource", "workflow", "editor"],
    }
}

pub fn visible_tool_names_for_pack(pack: ToolPack) -> &'static [&'static str] {
    match pack {
        ToolPack::Wander => &["Read", "List", "Search"],
        ToolPack::ManuscriptEditor => &["Write"],
        ToolPack::Team => &["Read", "List", "Search", "Write", "Operate", "bash"],
        ToolPack::ImageGeneration => &["Read", "List", "Search", "Operate", "bash"],
        ToolPack::Knowledge => &["Read", "List", "Search", "Operate", "bash"],
        ToolPack::Redclaw => {
            if cfg!(target_os = "windows") {
                &["Read", "List", "Search", "Write", "Operate"]
            } else {
                &["Read", "List", "Search", "Write", "Operate", "bash"]
            }
        }
        ToolPack::BackgroundMaintenance => &["Read", "List", "Search", "Operate", "bash"],
        ToolPack::Editor => &["Read", "List", "Search", "Write", "Operate", "bash"],
        ToolPack::Diagnostics => &["Read", "List", "Search", "Write", "Operate", "bash"],
    }
}

pub fn tool_names_for_runtime_mode(runtime_mode: &str) -> &'static [&'static str] {
    tool_names_for_pack(pack_for_runtime_mode(runtime_mode))
}

pub fn visible_tool_names_for_runtime_mode(runtime_mode: &str) -> &'static [&'static str] {
    visible_tool_names_for_pack(pack_for_runtime_mode(runtime_mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_editor_runtime_includes_editor_tool_pack() {
        let tools = tool_names_for_runtime_mode("video-editor");
        assert!(tools.contains(&"editor"));
    }

    #[test]
    fn audio_editor_runtime_includes_editor_tool_pack() {
        let tools = tool_names_for_runtime_mode("audio-editor");
        assert!(tools.contains(&"editor"));
    }

    #[test]
    fn manuscript_editor_runtime_only_exposes_bound_write() {
        let tools = tool_names_for_runtime_mode("manuscript-editor");
        assert_eq!(tools, &["workflow"]);
        let visible = visible_tool_names_for_runtime_mode("manuscript-editor");
        assert_eq!(visible, &["Write"]);
    }

    #[test]
    fn image_generation_runtime_includes_generation_tools() {
        let tools = tool_names_for_runtime_mode("image-generation");
        assert!(tools.contains(&"workflow"));
        assert!(tools.contains(&"resource"));
        assert!(tools.contains(&"bash"));
    }

    #[test]
    fn wander_runtime_includes_structured_file_tool() {
        let tools = tool_names_for_runtime_mode("wander");
        assert!(tools.contains(&"resource"));
        assert!(!tools.contains(&"bash"));
    }

    #[test]
    fn redclaw_runtime_includes_structured_file_tool() {
        let tools = tool_names_for_runtime_mode("redclaw");
        assert!(tools.contains(&"resource"));
        assert!(tools.contains(&"workflow"));
        if cfg!(target_os = "windows") {
            assert!(!tools.contains(&"bash"));
        } else {
            assert!(tools.contains(&"bash"));
        }
    }

    #[test]
    fn visible_tools_use_coding_agent_style_names() {
        let tools = visible_tool_names_for_runtime_mode("redclaw");
        assert!(tools.contains(&"Read"));
        assert!(tools.contains(&"List"));
        assert!(tools.contains(&"Search"));
        assert!(tools.contains(&"Operate"));
        assert!(!tools.contains(&"workflow"));
        assert!(!tools.contains(&"resource"));
    }
}
