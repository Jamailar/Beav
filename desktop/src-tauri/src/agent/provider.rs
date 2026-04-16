use serde_json::Value;
use tauri::{AppHandle, State};

use crate::agent::{ChatExchangeContext, ChatExchangeResponseStage};
use crate::skills::{build_resolved_skill_runtime_state, SkillActivationContext};
use crate::tools::packs::tool_names_for_runtime_mode;
use crate::tools::registry::base_tool_names_for_session_metadata;
use crate::{
    append_debug_log_state, generate_chat_response, resolve_chat_config,
    run_anthropic_interactive_chat_runtime, run_gemini_interactive_chat_runtime,
    run_openai_interactive_chat_runtime, workspace_root, AppState,
};

fn activation_context_for_request(
    metadata: Option<&Value>,
    message: &str,
) -> SkillActivationContext {
    SkillActivationContext {
        current_message: Some(message.to_string()),
        intent: metadata
            .and_then(|value| value.get("intent"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        touched_paths: [
            "associatedFilePath",
            "sourceManuscriptPath",
            "filePath",
            "path",
        ]
        .into_iter()
        .flat_map(|field| {
            let mut items = Vec::<String>::new();
            if let Some(single) = metadata
                .and_then(|value| value.get(field))
                .and_then(Value::as_str)
            {
                items.push(single.to_string());
            }
            if let Some(array) = metadata
                .and_then(|value| value.get(field))
                .and_then(Value::as_array)
            {
                items.extend(
                    array
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string),
                );
            }
            items
        })
        .collect(),
        args: None,
    }
}

fn merged_model_config_with_skill_overrides(
    state: &State<'_, AppState>,
    context: &ChatExchangeContext,
    model_config: Option<&Value>,
    message: &str,
) -> Option<Value> {
    let workspace = workspace_root(state).ok();
    let activation = activation_context_for_request(context.request_metadata.as_ref(), message);
    crate::persistence::with_store(state, |store| {
        let base_tools = base_tool_names_for_session_metadata(
            &context.runtime_mode,
            context.request_metadata.as_ref(),
        );
        let fallback_base = if base_tools.is_empty() {
            tool_names_for_runtime_mode(&context.runtime_mode)
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        } else {
            base_tools
        };
        let skill_state = build_resolved_skill_runtime_state(
            &store.skills,
            workspace.as_deref(),
            &context.runtime_mode,
            context.request_metadata.as_ref(),
            &fallback_base,
            Some(&activation),
        );
        let mut next = model_config.cloned().unwrap_or_else(|| Value::Object(Default::default()));
        let Some(object) = next.as_object_mut() else {
            return Ok(model_config.cloned());
        };
        if let Some(model_override) = skill_state.model_override {
            object.insert("modelName".to_string(), Value::String(model_override));
        }
        if let Some(effort_override) = skill_state.effort_override {
            object.insert(
                "reasoningEffort".to_string(),
                Value::String(effort_override),
            );
        }
        Ok(Some(next))
    })
    .ok()
    .flatten()
    .or_else(|| model_config.cloned())
}

pub fn resolve_chat_exchange_response_stage(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    context: &ChatExchangeContext,
    message: &str,
    model_config: Option<&Value>,
    onboarding_response: Option<(String, bool)>,
) -> Result<ChatExchangeResponseStage, String> {
    if let Some((local_response, _completed)) = onboarding_response {
        return Ok(ChatExchangeResponseStage {
            response: local_response,
            emitted_live_events: false,
        });
    }

    let effective_model_config =
        merged_model_config_with_skill_overrides(state, context, model_config, message);

    if let (Some(app), Some(config)) = (
        app,
        resolve_chat_config(&context.settings_snapshot, effective_model_config.as_ref()),
    ) {
        if matches!(config.protocol.as_str(), "openai" | "anthropic" | "gemini") {
            let interactive_result = match config.protocol.as_str() {
                "openai" => run_openai_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                    context.request_metadata.as_ref(),
                ),
                "anthropic" => run_anthropic_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                    context.request_metadata.as_ref(),
                ),
                "gemini" => run_gemini_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                    context.request_metadata.as_ref(),
                ),
                _ => unreachable!(),
            };
            match interactive_result {
                Ok(response) => {
                    return Ok(ChatExchangeResponseStage {
                        response,
                        emitted_live_events: emits_live_events_for_runtime_mode(
                            &context.runtime_mode,
                        ),
                    });
                }
                Err(error) => {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][{}][{}] interactive-runtime-failed | {}",
                            context.runtime_mode, context.working_session_id, error
                        ),
                    );
                    if context.runtime_mode == "wander" {
                        return Err(error);
                    }
                }
            }
        }
    }

    Ok(ChatExchangeResponseStage {
        response: generate_chat_response(
            &context.settings_snapshot,
            effective_model_config.as_ref(),
            message,
        ),
        emitted_live_events: false,
    })
}

fn emits_live_events_for_runtime_mode(runtime_mode: &str) -> bool {
    runtime_mode != "wander"
}

#[cfg(test)]
mod tests {
    use super::emits_live_events_for_runtime_mode;

    #[test]
    fn emits_live_events_for_runtime_mode_skips_wander_only() {
        assert!(emits_live_events_for_runtime_mode("chatroom"));
        assert!(emits_live_events_for_runtime_mode("redclaw"));
        assert!(!emits_live_events_for_runtime_mode("wander"));
    }
}
