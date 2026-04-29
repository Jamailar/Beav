#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPack {
    Wander,
    Chatroom,
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
        "chatroom" | "default" => Some(ToolPack::Chatroom),
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
        _ => ToolPack::Chatroom,
    }
}

pub fn tool_names_for_pack(pack: ToolPack) -> &'static [&'static str] {
    match pack {
        ToolPack::Wander => &["redbox_fs"],
        ToolPack::ManuscriptEditor => &["app_cli"],
        ToolPack::Chatroom => &["bash", "redbox_fs", "app_cli"],
        ToolPack::ImageGeneration => &["bash", "redbox_fs", "app_cli"],
        ToolPack::Knowledge => &["bash", "redbox_fs", "app_cli"],
        ToolPack::Redclaw => {
            if cfg!(target_os = "windows") {
                &["redbox_fs", "app_cli"]
            } else {
                &["bash", "redbox_fs", "app_cli"]
            }
        }
        ToolPack::BackgroundMaintenance => &["bash", "app_cli"],
        ToolPack::Editor => &["bash", "redbox_fs", "app_cli", "redbox_editor"],
        ToolPack::Diagnostics => &["bash", "redbox_fs", "app_cli", "redbox_editor"],
    }
}

pub fn visible_tool_names_for_pack(pack: ToolPack) -> &'static [&'static str] {
    match pack {
        ToolPack::Wander => &["Read", "List", "Search"],
        ToolPack::ManuscriptEditor => &["Write"],
        ToolPack::Chatroom => &["Read", "List", "Search", "Write", "Redbox", "bash"],
        ToolPack::ImageGeneration => &["Read", "List", "Search", "Redbox", "bash"],
        ToolPack::Knowledge => &["Read", "List", "Search", "Redbox", "bash"],
        ToolPack::Redclaw => {
            if cfg!(target_os = "windows") {
                &["Read", "List", "Search", "Write", "Redbox"]
            } else {
                &["Read", "List", "Search", "Write", "Redbox", "bash"]
            }
        }
        ToolPack::BackgroundMaintenance => &["Read", "List", "Search", "Redbox", "bash"],
        ToolPack::Editor => &["Read", "List", "Search", "Write", "Redbox", "bash"],
        ToolPack::Diagnostics => &["Read", "List", "Search", "Write", "Redbox", "bash"],
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
        assert!(tools.contains(&"redbox_editor"));
    }

    #[test]
    fn audio_editor_runtime_includes_editor_tool_pack() {
        let tools = tool_names_for_runtime_mode("audio-editor");
        assert!(tools.contains(&"redbox_editor"));
    }

    #[test]
    fn manuscript_editor_runtime_only_exposes_bound_write() {
        let tools = tool_names_for_runtime_mode("manuscript-editor");
        assert_eq!(tools, &["app_cli"]);
        let visible = visible_tool_names_for_runtime_mode("manuscript-editor");
        assert_eq!(visible, &["Write"]);
    }

    #[test]
    fn image_generation_runtime_includes_generation_tools() {
        let tools = tool_names_for_runtime_mode("image-generation");
        assert!(tools.contains(&"app_cli"));
        assert!(tools.contains(&"redbox_fs"));
        assert!(tools.contains(&"bash"));
    }

    #[test]
    fn wander_runtime_includes_structured_file_tool() {
        let tools = tool_names_for_runtime_mode("wander");
        assert!(tools.contains(&"redbox_fs"));
        assert!(!tools.contains(&"bash"));
    }

    #[test]
    fn redclaw_runtime_includes_structured_file_tool() {
        let tools = tool_names_for_runtime_mode("redclaw");
        assert!(tools.contains(&"redbox_fs"));
        assert!(tools.contains(&"app_cli"));
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
        assert!(tools.contains(&"Redbox"));
        assert!(!tools.contains(&"app_cli"));
        assert!(!tools.contains(&"redbox_fs"));
    }
}
