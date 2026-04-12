#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPack {
    Wander,
    Chatroom,
    Knowledge,
    Redclaw,
    BackgroundMaintenance,
    Editor,
    Diagnostics,
}

pub fn pack_by_name(name: &str) -> Option<ToolPack> {
    match name.trim().to_lowercase().as_str() {
        "wander" => Some(ToolPack::Wander),
        "chatroom" | "default" => Some(ToolPack::Chatroom),
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
        ToolPack::Chatroom => &[
            "redbox_app_query",
            "redbox_fs",
            "redbox_profile_doc",
            "redbox_mcp",
            "redbox_skill",
            "redbox_runtime_control",
        ],
        ToolPack::Knowledge => &[
            "redbox_app_query",
            "redbox_fs",
            "redbox_mcp",
            "redbox_skill",
            "redbox_runtime_control",
        ],
        ToolPack::Redclaw => &[
            "redbox_app_query",
            "redbox_fs",
            "redbox_profile_doc",
            "redbox_mcp",
            "redbox_skill",
            "redbox_runtime_control",
        ],
        ToolPack::BackgroundMaintenance => &[
            "redbox_app_query",
            "redbox_fs",
            "redbox_mcp",
            "redbox_runtime_control",
        ],
        ToolPack::Editor => &[
            "redbox_app_query",
            "redbox_fs",
            "redbox_editor",
            "redbox_runtime_control",
        ],
        ToolPack::Diagnostics => &[
            "redbox_app_query",
            "redbox_fs",
            "redbox_profile_doc",
            "redbox_mcp",
            "redbox_skill",
            "redbox_runtime_control",
            "redbox_editor",
        ],
    }
}

pub fn tool_names_for_runtime_mode(runtime_mode: &str) -> &'static [&'static str] {
    tool_names_for_pack(pack_for_runtime_mode(runtime_mode))
}
