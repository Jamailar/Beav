use tauri::{AppHandle, Manager, State};

use crate::agent::{
    persist_chat_exchange, resolve_chat_exchange_context, resolve_chat_exchange_response_stage,
    update_post_exchange_maintenance, ChatExchangeRequest, PreparedSessionAgentTurn,
    SessionAgentTurnExecution,
};
use crate::commands::chat_state::{is_chat_runtime_cancel_requested, update_chat_runtime_state};
use crate::runtime::append_session_checkpoint;
use crate::skills::{active_hooks_for_event, build_resolved_skill_runtime_state};
use crate::tools::registry::base_tool_names_for_session_metadata;
use crate::{
    ensure_redclaw_onboarding_completed_with_defaults, handle_redclaw_onboarding_turn,
    workspace_root, AppState,
};

fn execute_skill_event_hooks(
    state: &State<'_, AppState>,
    session_id: &str,
    runtime_mode: &str,
    metadata: Option<&serde_json::Value>,
    message: &str,
    event: &str,
) -> Result<(), String> {
    let workspace = workspace_root(state).ok();
    crate::persistence::with_store_mut(state, |store| {
        let base_tools = base_tool_names_for_session_metadata(runtime_mode, metadata);
        let skill_state = build_resolved_skill_runtime_state(
            &store.skills,
            workspace.as_deref(),
            runtime_mode,
            metadata,
            &base_tools,
            Some(&crate::skills::SkillActivationContext {
                current_message: Some(message.to_string()),
                intent: metadata
                    .and_then(|value| value.get("intent"))
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string),
                touched_paths: Vec::new(),
                args: None,
            }),
        );
        for hook in active_hooks_for_event(&skill_state.active_skills, event, runtime_mode, message)
        {
            if hook.action_type != "checkpoint" {
                continue;
            }
            append_session_checkpoint(
                store,
                session_id,
                &format!("skill.hook.{event}"),
                hook.summary
                    .clone()
                    .or(hook.message.clone())
                    .unwrap_or_else(|| format!("skill hook fired: {event}")),
                hook.payload.clone(),
            );
        }
        Ok(())
    })
}

pub fn execute_prepared_session_agent_turn(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    turn: &PreparedSessionAgentTurn<'_>,
) -> Result<SessionAgentTurnExecution, String> {
    execute_session_agent_turn(app, state, turn.request_cloned())
}

pub fn execute_session_agent_turn(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: ChatExchangeRequest<'_>,
) -> Result<SessionAgentTurnExecution, String> {
    let checkpoint_summary = request.checkpoint_summary_text();
    let session_title_override = request
        .session_title_hint_override()
        .map(ToString::to_string);
    let ChatExchangeRequest {
        session_id,
        message,
        display_content,
        model_config,
        attachment,
        request_metadata,
        turn_kind,
        checkpoint_summary_override: _,
        session_title_override: _,
    } = request;
    let context = resolve_chat_exchange_context(state, session_id, request_metadata.clone(), turn_kind)?;
    execute_skill_event_hooks(
        state,
        &context.working_session_id,
        &context.runtime_mode,
        context.request_metadata.as_ref(),
        &message,
        "turnStart",
    )?;
    let _ = update_chat_runtime_state(
        state,
        &context.working_session_id,
        true,
        String::new(),
        None,
    );

    if context.runtime_mode == "redclaw"
        && context.should_handle_redclaw_onboarding
        && !context.allow_redclaw_onboarding
    {
        let _ = ensure_redclaw_onboarding_completed_with_defaults(state);
    }
    let onboarding_response = if context.allow_redclaw_onboarding {
        handle_redclaw_onboarding_turn(state, &message)?
    } else {
        None
    };
    let response_stage = resolve_chat_exchange_response_stage(
        app,
        state,
        &context,
        &message,
        model_config,
        onboarding_response,
    )?;
    let response = response_stage.response;
    if is_chat_runtime_cancel_requested(state, &context.working_session_id) {
        let _ = update_chat_runtime_state(
            state,
            &context.working_session_id,
            false,
            String::new(),
            Some("cancelled".to_string()),
        );
        return Err("chat generation cancelled".to_string());
    }
    let persistence = persist_chat_exchange(
        state,
        &context,
        &message,
        &display_content,
        attachment.clone(),
        &response,
        turn_kind,
        checkpoint_summary,
        session_title_override,
    )?;
    execute_skill_event_hooks(
        state,
        &persistence.final_session_id,
        &context.runtime_mode,
        context.request_metadata.as_ref(),
        &message,
        "turnComplete",
    )?;
    let _ = update_chat_runtime_state(
        state,
        &persistence.final_session_id,
        false,
        response.clone(),
        None,
    );
    if let Some(app_handle) = app.cloned() {
        let response_for_maintenance = response.clone();
        std::thread::spawn(move || {
            let state = app_handle.state::<AppState>();
            let _ = update_post_exchange_maintenance(&state, &response_for_maintenance);
        });
    }

    Ok(SessionAgentTurnExecution {
        session_id: persistence.final_session_id,
        response,
        title_update: persistence.title_update,
        emitted_live_events: response_stage.emitted_live_events,
    })
}
