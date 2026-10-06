use std::path::PathBuf;

use serde_json::{json, Value};

use super::types::{AppStore, AssistantStateRecord};

#[derive(Default)]
pub(crate) struct AssistantConfigPatch {
    pub(crate) enabled: Option<bool>,
    pub(crate) auto_start: Option<bool>,
    pub(crate) keep_alive_when_no_window: Option<bool>,
    pub(crate) host: Option<String>,
    pub(crate) port: Option<i64>,
    pub(crate) feishu: Option<Value>,
    pub(crate) relay: Option<Value>,
    pub(crate) weixin: Option<Value>,
    pub(crate) knowledge_api: Option<Value>,
}

pub(crate) fn snapshot(store: &AppStore) -> AssistantStateRecord {
    store.assistant_state.clone()
}

pub(crate) fn reset_runtime_state_after_load(store: &mut AppStore) {
    store.assistant_state.listening = false;
    if store.assistant_state.last_error.as_deref()
        == Some("RedClaw assistant daemon local listener is running.")
    {
        store.assistant_state.last_error = Some("RedClaw assistant daemon is idle.".to_string());
    }
}

fn should_enable_daemon_by_default(state: &AssistantStateRecord) -> bool {
    if state.enabled || !state.auto_start || state.listening {
        return false;
    }

    if state.last_error.as_deref() == Some("RedClaw assistant daemon stopped.") {
        return false;
    }

    state.active_task_count == 0
        && state.queued_peer_count == 0
        && state.in_flight_keys.is_empty()
        && matches!(
            state.last_error.as_deref(),
            None | Some("RedClaw assistant daemon is idle.")
        )
}

pub(crate) fn enable_daemon_by_default_after_load(store: &mut AppStore) -> bool {
    if !should_enable_daemon_by_default(&store.assistant_state) {
        return false;
    }
    store.assistant_state.enabled = true;
    true
}

pub(crate) fn set_last_error(store: &mut AppStore, message: String) -> AssistantStateRecord {
    store.assistant_state.last_error = Some(message);
    snapshot(store)
}

pub(crate) fn mark_listener_running(
    store: &mut AppStore,
    sidecar_status: Option<Result<u32, String>>,
) -> AssistantStateRecord {
    store.assistant_state.listening = true;
    store.assistant_state.last_error =
        Some("RedClaw assistant daemon local listener is running.".to_string());
    if let Some(status) = sidecar_status {
        if let Some(object) = store.assistant_state.weixin.as_object_mut() {
            match status {
                Ok(pid) => {
                    object.insert("sidecarRunning".to_string(), json!(true));
                    object.insert("sidecarPid".to_string(), json!(pid));
                }
                Err(error) => {
                    object.insert("sidecarRunning".to_string(), json!(false));
                    object.insert("lastSidecarError".to_string(), json!(error.clone()));
                    store.assistant_state.last_error = Some(format!(
                        "RedClaw assistant daemon is running; sidecar failed: {error}"
                    ));
                }
            }
        }
    }
    snapshot(store)
}

pub(crate) fn apply_config(
    store: &mut AppStore,
    patch: AssistantConfigPatch,
    enable_listening: bool,
) -> AssistantStateRecord {
    if let Some(enabled) = patch.enabled {
        store.assistant_state.enabled = enabled;
    }
    if let Some(auto_start) = patch.auto_start {
        store.assistant_state.auto_start = auto_start;
    }
    if let Some(keep_alive) = patch.keep_alive_when_no_window {
        store.assistant_state.keep_alive_when_no_window = keep_alive;
    }
    if let Some(host) = patch.host {
        store.assistant_state.host = host;
    }
    if let Some(port) = patch.port {
        store.assistant_state.port = port;
    }
    if let Some(feishu) = patch.feishu {
        store.assistant_state.feishu = feishu;
    }
    if let Some(relay) = patch.relay {
        store.assistant_state.relay = relay;
    }
    if let Some(weixin) = patch.weixin {
        store.assistant_state.weixin = weixin;
    }
    if let Some(knowledge_api) = patch.knowledge_api {
        store.assistant_state.knowledge_api = knowledge_api;
    }
    if enable_listening {
        store.assistant_state.enabled = true;
        store.assistant_state.lock_state = "owner".to_string();
        store.assistant_state.last_error =
            Some("RedClaw assistant daemon is preparing local listener.".to_string());
    }
    snapshot(store)
}

pub(crate) fn mark_stopped(store: &mut AppStore) -> AssistantStateRecord {
    store.assistant_state.listening = false;
    store.assistant_state.enabled = false;
    if let Some(object) = store.assistant_state.weixin.as_object_mut() {
        object.insert("sidecarRunning".to_string(), json!(false));
        object.remove("sidecarPid");
    }
    store.assistant_state.last_error = Some("RedClaw assistant daemon stopped.".to_string());
    snapshot(store)
}

pub(crate) fn start_weixin_login(store: &mut AppStore, state_dir: &str) {
    if let Some(object) = store.assistant_state.weixin.as_object_mut() {
        object.insert("connected".to_string(), json!(false));
        object.insert("stateDir".to_string(), json!(state_dir));
    }
}

pub(crate) fn weixin_state_dir(store: &AppStore, fallback: PathBuf) -> PathBuf {
    store
        .assistant_state
        .weixin
        .get("stateDir")
        .and_then(|value| value.as_str())
        .map(PathBuf::from)
        .unwrap_or(fallback)
}

pub(crate) fn apply_weixin_login_state(
    store: &mut AppStore,
    sidecar_state: Option<&Value>,
) -> AssistantStateRecord {
    if let Some(object) = store.assistant_state.weixin.as_object_mut() {
        if let Some(sidecar_state) = sidecar_state {
            object.insert("connected".to_string(), json!(true));
            if let Some(account_id) = sidecar_state.get("accountId").cloned() {
                object.insert("accountId".to_string(), account_id.clone());
                object.insert("availableAccountIds".to_string(), json!([account_id]));
            }
            if let Some(user_id) = sidecar_state.get("userId").cloned() {
                object.insert("userId".to_string(), user_id);
            }
            if let Some(token) = sidecar_state.get("token").cloned() {
                object.insert("token".to_string(), token);
            }
        } else {
            object.insert("connected".to_string(), json!(false));
        }
    }
    snapshot(store)
}
