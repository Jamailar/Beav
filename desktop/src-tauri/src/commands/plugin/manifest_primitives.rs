pub(super) fn validate_plugin_segment(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!(
            "{field} only allows ASCII letters, digits, `-`, and `_`"
        ));
    }
    Ok(())
}

pub(super) fn validate_plugin_version(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("version must not be empty".to_string());
    }
    if matches!(value, "." | "..") {
        return Err("version must not be `.` or `..`".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '+' | '-' | '_'))
    {
        return Err(
            "version only allows ASCII letters, digits, `.`, `+`, `-`, and `_`".to_string(),
        );
    }
    Ok(())
}

pub(super) fn is_known_plugin_capability(value: &str) -> bool {
    matches!(
        value,
        "ai.skill"
            | "mcp.server"
            | "app.connector"
            | "knowledge.read"
            | "knowledge.import"
            | "assets.read"
            | "subjects.read"
            | "manuscripts.read"
            | "manuscripts.write.current"
            | "editor.read.current"
            | "editor.write.current"
            | "media.read"
            | "media.import"
            | "media.process"
            | "video.exportPreset"
            | "video.effectPreset"
            | "subtitle.stylePreset"
            | "audio.processor"
            | "cover.template"
            | "export.create"
            | "network.request.scoped"
            | "pluginData.read"
            | "pluginData.write"
            | "ui.settingsPanel"
            | "ui.home"
            | "ui.manuscriptSidebar"
            | "ui.videoInspectorPanel"
    )
}

pub(super) fn is_known_plugin_ui_slot(value: &str) -> bool {
    matches!(
        value,
        "settings"
            | "settingsPanel"
            | "home"
            | "homeWidget"
            | "manuscriptSidebar"
            | "videoInspectorPanel"
            | "exportPanelAddon"
            | "knowledgeImporterPanel"
            | "commandPaletteCommand"
    )
}

pub(super) fn is_known_plugin_home_widget_kind(value: &str) -> bool {
    matches!(value, "metric" | "list" | "prompt" | "action")
}

pub(super) fn is_known_plugin_home_source(value: &str) -> bool {
    matches!(
        value,
        "knowledge.count"
            | "knowledge.recent"
            | "knowledge.items"
            | "manuscripts.count"
            | "manuscripts.recent"
            | "manuscripts.tree"
            | "media.count"
            | "media.recent"
            | "media.assets"
            | "subjects.count"
            | "subjects.recent"
            | "subjects.list"
    )
}

pub(super) fn is_known_plugin_home_action_target(value: &str) -> bool {
    matches!(
        value,
        "redclaw" | "coverStudio" | "generationStudio" | "manuscripts"
    )
}

pub(super) fn normalize_plugin_home_limit(value: Option<usize>) -> usize {
    value.unwrap_or(4).clamp(1, 20)
}

pub(super) fn validate_network_host(value: &str) -> Result<(), String> {
    let host = value.trim();
    if host.is_empty() {
        return Err("network host must not be empty".to_string());
    }
    if host.contains("://") || host.contains('/') || host.contains('*') {
        return Err(format!("invalid network host `{host}`"));
    }
    if !host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
    {
        return Err(format!("invalid network host `{host}`"));
    }
    Ok(())
}
