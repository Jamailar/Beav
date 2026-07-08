use crate::{accounts, app_brand_display_name, commands, AppState};
use serde_json::Value;
use tauri::{AppHandle, State};

pub(crate) fn handle_channel(
    app: &AppHandle,
    channel: &str,
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    if let Some(result) = commands::system::handle_system_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) =
        commands::analytics::handle_analytics_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::audio::handle_audio_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::voice::handle_voice_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::official::handle_official_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::wechat_official::handle_wechat_official_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::plugin::handle_plugin_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::spaces::handle_spaces_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) =
        commands::space_init::handle_space_init_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::embeddings::handle_embeddings_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::brand_workspace::handle_brand_workspace_channel(state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::subjects::handle_subjects_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::file_ops::handle_file_ops_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::assistant_daemon::handle_assistant_daemon_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = accounts::handle_accounts_channel(state, channel, &payload) {
        return result;
    }
    if let Some(result) =
        commands::advisor_ops::handle_advisor_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::library::handle_library_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) =
        commands::mcp_tools::handle_mcp_tools_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::skills_ai::handle_skills_ai_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::llm_readiness::handle_llm_readiness_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::generation::handle_generation_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::media_jobs::handle_media_jobs_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::workspace_data::handle_workspace_data_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::manuscripts::handle_manuscripts_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::topic_center::handle_topic_center_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::chat_sessions_wander::handle_chat_sessions_wander_channel(
        app, state, channel, &payload,
    ) {
        return result;
    }
    if let Some(result) = commands::bridge::handle_bridge_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::redclaw::handle_redclaw_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) =
        commands::command_execution::handle_command_execution_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::cli_runtime::handle_cli_runtime_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::runtime::handle_runtime_channel(app, state, channel, &payload) {
        return result;
    }
    match channel {
        _ => Err(format!(
            "{} host does not recognize channel `{channel}`.",
            app_brand_display_name()
        )),
    }
}
