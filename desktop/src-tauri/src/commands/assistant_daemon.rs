use crate::persistence::{with_store, with_store_mut};
use crate::*;
use serde_json::{Value, json};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, State};

pub fn ensure_assistant_daemon_running(
    app: &AppHandle,
    state: &State<'_, AppState>,
    respect_auto_start: bool,
) -> Result<Option<Value>, String> {
    let assistant_snapshot = with_store(state, |store| Ok(store.assistant_state.clone()))?;
    if !assistant_snapshot.enabled || (respect_auto_start && !assistant_snapshot.auto_start) {
        return Ok(None);
    }

    let feishu_receive_mode = assistant_snapshot
        .feishu
        .get("receiveMode")
        .and_then(|value| value.as_str())
        .unwrap_or("webhook");
    if feishu_receive_mode == "websocket" {
        let snapshot = with_store_mut(state, |store| {
            store.assistant_state.last_error =
                Some("Feishu websocket 接入尚未实现，请先切回 webhook 模式。".to_string());
            Ok(store.assistant_state.clone())
        })?;
        emit_assistant_status(app, &snapshot);
        return Err("Feishu websocket 接入尚未实现，请先切回 webhook 模式。".to_string());
    }

    {
        let mut runtime_guard = state
            .assistant_runtime
            .lock()
            .map_err(|_| "assistant runtime lock 已损坏".to_string())?;
        if runtime_guard.is_none() {
            let stop = Arc::new(AtomicBool::new(false));
            let join = run_assistant_listener(
                app.clone(),
                assistant_snapshot.host.clone(),
                assistant_snapshot.port,
                stop.clone(),
            )?;
            *runtime_guard = Some(AssistantRuntime {
                stop,
                join: Some(join),
                host: assistant_snapshot.host.clone(),
                port: assistant_snapshot.port,
            });
        }
    }

    let sidecar_status = {
        let mut sidecar_guard = state
            .assistant_sidecar
            .lock()
            .map_err(|_| "assistant sidecar lock 已损坏".to_string())?;
        if sidecar_guard.is_none() {
            match spawn_weixin_sidecar(&assistant_snapshot.weixin) {
                Ok(Some(runtime)) => {
                    let pid = runtime.pid;
                    *sidecar_guard = Some(runtime);
                    Some(Ok(pid))
                }
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        } else {
            sidecar_guard.as_ref().map(|runtime| Ok(runtime.pid))
        }
    };

    let updated = with_store_mut(state, |store| {
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
        Ok(assistant_state_value(&store.assistant_state))
    })?;
    let snapshot = with_store(state, |store| Ok(store.assistant_state.clone()))?;
    emit_assistant_status(app, &snapshot);
    Ok(Some(updated))
}

pub fn handle_assistant_daemon_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "assistant:daemon-status"
            | "assistant:daemon-set-config"
            | "assistant:daemon-start"
            | "assistant:daemon-stop"
            | "assistant:daemon-weixin-login-start"
            | "assistant:daemon-weixin-login-wait"
            | "background-workers:get-pool-state"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "assistant:daemon-status" => with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("assistant:daemon-status:{}", started_at);
                let value = assistant_state_value(&store.assistant_state);
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "assistant:daemon-status",
                    started_at,
                    None,
                );
                Ok(value)
            }),
            "assistant:daemon-set-config" | "assistant:daemon-start" => {
                let enable_listening = channel == "assistant:daemon-start";
                let status = with_store_mut(state, |store| {
                    store.assistant_state.enabled = payload_field(payload, "enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(store.assistant_state.enabled);
                    store.assistant_state.auto_start = payload_field(payload, "autoStart")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(store.assistant_state.auto_start);
                    store.assistant_state.keep_alive_when_no_window =
                        payload_field(payload, "keepAliveWhenNoWindow")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(store.assistant_state.keep_alive_when_no_window);
                    if let Some(host) = payload_string(payload, "host") {
                        store.assistant_state.host = host;
                    }
                    if let Some(port) = payload_field(payload, "port").and_then(|v| v.as_i64()) {
                        store.assistant_state.port = port;
                    }
                    if let Some(feishu) = payload_field(payload, "feishu") {
                        store.assistant_state.feishu = feishu.clone();
                    }
                    if let Some(relay) = payload_field(payload, "relay") {
                        store.assistant_state.relay = relay.clone();
                    }
                    if let Some(weixin) = payload_field(payload, "weixin") {
                        store.assistant_state.weixin = weixin.clone();
                    }
                    if let Some(knowledge_api) = payload_field(payload, "knowledgeApi") {
                        store.assistant_state.knowledge_api = knowledge_api.clone();
                    }
                    if enable_listening {
                        store.assistant_state.enabled = true;
                        store.assistant_state.lock_state = "owner".to_string();
                        store.assistant_state.last_error = Some(
                            "RedClaw assistant daemon is preparing local listener.".to_string(),
                        );
                    }
                    Ok(assistant_state_value(&store.assistant_state))
                })?;
                if enable_listening {
                    if let Some(updated) = ensure_assistant_daemon_running(app, state, false)? {
                        return Ok(updated);
                    }
                    return Ok(status);
                }
                let snapshot = with_store(state, |store| Ok(store.assistant_state.clone()))?;
                emit_assistant_status(app, &snapshot);
                Ok(status)
            }
            "assistant:daemon-stop" => {
                if let Ok(mut runtime_guard) = state.assistant_runtime.lock() {
                    if let Some(mut runtime) = runtime_guard.take() {
                        runtime.stop.store(true, Ordering::Relaxed);
                        let _ = TcpStream::connect(format!("{}:{}", runtime.host, runtime.port));
                        if let Some(join) = runtime.join.take() {
                            let _ = join.join();
                        }
                    }
                }
                let _ = stop_assistant_sidecar(state);
                let status = with_store_mut(state, |store| {
                    store.assistant_state.listening = false;
                    store.assistant_state.enabled = false;
                    if let Some(object) = store.assistant_state.weixin.as_object_mut() {
                        object.insert("sidecarRunning".to_string(), json!(false));
                        object.remove("sidecarPid");
                    }
                    store.assistant_state.last_error =
                        Some("RedClaw assistant daemon stopped.".to_string());
                    Ok(assistant_state_value(&store.assistant_state))
                })?;
                let snapshot = with_store(state, |store| Ok(store.assistant_state.clone()))?;
                emit_assistant_status(app, &snapshot);
                Ok(status)
            }
            "assistant:daemon-weixin-login-start" => {
                let result = with_store_mut(state, |store| {
                    let session_key = make_id("wx-login");
                    let state_dir = format!("{}/assistant/weixin", store_root(state)?.display());
                    if let Some(object) = store.assistant_state.weixin.as_object_mut() {
                        object.insert("connected".to_string(), json!(false));
                        object.insert("stateDir".to_string(), json!(state_dir.clone()));
                    }
                    Ok(json!({
                        "success": true,
                        "sessionKey": session_key,
                        "qrcodeUrl": format!("redbox://assistant/weixin-login/{}", session_key),
                        "message": "RedBox 已生成本地微信登录会话。若已配置 sidecar，请使用 sidecar 日志中的真实二维码完成登录。",
                        "stateDir": state_dir
                    }))
                })?;
                Ok(result)
            }
            "assistant:daemon-weixin-login-wait" => {
                let state_dir = with_store(state, |store| {
                    Ok(store
                        .assistant_state
                        .weixin
                        .get("stateDir")
                        .and_then(|value| value.as_str())
                        .map(PathBuf::from)
                        .unwrap_or_else(|| {
                            store_root(state)
                                .unwrap_or_else(|_| PathBuf::from("."))
                                .join("assistant")
                                .join("weixin")
                        }))
                })?;
                let sidecar_state = read_weixin_sidecar_state(&state_dir);
                let result = with_store_mut(state, |store| {
                    if let Some(object) = store.assistant_state.weixin.as_object_mut() {
                        if let Some(sidecar_state) = sidecar_state.clone() {
                            object.insert("connected".to_string(), json!(true));
                            if let Some(account_id) = sidecar_state.get("accountId").cloned() {
                                object.insert("accountId".to_string(), account_id.clone());
                                object
                                    .insert("availableAccountIds".to_string(), json!([account_id]));
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
                    if let Some(sidecar_state) = sidecar_state {
                        Ok(json!({
                            "success": true,
                            "connected": true,
                            "message": "检测到微信 sidecar 登录状态。",
                            "accountId": sidecar_state.get("accountId").and_then(|value| value.as_str()).unwrap_or(""),
                            "userId": sidecar_state.get("userId").and_then(|value| value.as_str()).unwrap_or(""),
                            "stateDir": state_dir.display().to_string()
                        }))
                    } else {
                        Ok(json!({
                            "success": true,
                            "connected": false,
                            "message": "尚未检测到微信 sidecar 登录状态，请扫码后重试。",
                            "stateDir": state_dir.display().to_string()
                        }))
                    }
                })?;
                Ok(result)
            }
            "background-workers:get-pool-state" => Ok(json!({
                "json": [],
                "runtime": []
            })),
            _ => unreachable!(),
        }
    })())
}
