#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPack {
    Wander,
    Chatroom,
    Knowledge,
    Redclaw,
    BackgroundMaintenance,
    Diagnostics,
}

pub fn pack_for_runtime_mode(runtime_mode: &str) -> ToolPack {
    match runtime_mode.trim().to_lowercase().as_str() {
        "wander" => ToolPack::Wander,
        "knowledge" => ToolPack::Knowledge,
        "redclaw" => ToolPack::Redclaw,
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
        ToolPack::Diagnostics => &[
            "redbox_app_query",
            "redbox_fs",
            "redbox_profile_doc",
            "redbox_mcp",
            "redbox_skill",
            "redbox_runtime_control",
        ],
    }
}

pub fn tool_names_for_runtime_mode(runtime_mode: &str) -> &'static [&'static str] {
    tool_names_for_pack(pack_for_runtime_mode(runtime_mode))
}
