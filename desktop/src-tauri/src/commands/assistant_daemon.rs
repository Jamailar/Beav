use crate::persistence::{with_store, with_store_mut};
use crate::store::assistant as assistant_store;
use crate::*;
use serde_json::{json, Value};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, State};

pub fn ensure_assistant_daemon_running(
    app: &AppHandle,
    state: &State<'_, AppState>,
    respect_auto_start: bool,
) -> Result<Option<Value>, String> {
    let assistant_snapshot = with_store(state, |store| Ok(assistant_store::snapshot(&store)))?;
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
            Ok(assistant_store::set_last_error(
                store,
                "Feishu websocket 接入尚未实现，请先切回 webhook 模式。".to_string(),
            ))
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
        let snapshot = assistant_store::mark_listener_running(store, sidecar_status);
        Ok(assistant_state_value(&snapshot))
    })?;
    let snapshot = with_store(state, |store| Ok(assistant_store::snapshot(&store)))?;
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
                let snapshot = assistant_store::snapshot(&store);
                let value = assistant_state_value(&snapshot);
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
                    let patch = assistant_store::AssistantConfigPatch {
                        enabled: payload_field(payload, "enabled").and_then(|v| v.as_bool()),
                        auto_start: payload_field(payload, "autoStart").and_then(|v| v.as_bool()),
                        keep_alive_when_no_window: payload_field(payload, "keepAliveWhenNoWindow")
                            .and_then(|v| v.as_bool()),
                        host: payload_string(payload, "host"),
                        port: payload_field(payload, "port").and_then(|v| v.as_i64()),
                        feishu: payload_field(payload, "feishu").cloned(),
                        relay: payload_field(payload, "relay").cloned(),
                        weixin: payload_field(payload, "weixin").cloned(),
                        knowledge_api: payload_field(payload, "knowledgeApi").cloned(),
                    };
                    let snapshot = assistant_store::apply_config(store, patch, enable_listening);
                    Ok(assistant_state_value(&snapshot))
                })?;
                if enable_listening {
                    if let Some(updated) = ensure_assistant_daemon_running(app, state, false)? {
                        return Ok(updated);
                    }
                    return Ok(status);
                }
                let snapshot = with_store(state, |store| Ok(assistant_store::snapshot(&store)))?;
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
                    let snapshot = assistant_store::mark_stopped(store);
                    Ok(assistant_state_value(&snapshot))
                })?;
                let snapshot = with_store(state, |store| Ok(assistant_store::snapshot(&store)))?;
                emit_assistant_status(app, &snapshot);
                Ok(status)
            }
            "assistant:daemon-weixin-login-start" => {
                let result = with_store_mut(state, |store| {
                    let session_key = make_id("wx-login");
                    let state_dir = format!("{}/assistant/weixin", store_root(state)?.display());
                    assistant_store::start_weixin_login(store, &state_dir);
                    Ok(json!({
                        "success": true,
                        "sessionKey": session_key,
                        "qrcodeUrl": format!("redbox://assistant/weixin-login/{}", session_key),
                        "message": format!("{} 已生成本地微信登录会话。若已配置 sidecar，请使用 sidecar 日志中的真实二维码完成登录。", app_brand_display_name()),
                        "stateDir": state_dir
                    }))
                })?;
                Ok(result)
            }
            "assistant:daemon-weixin-login-wait" => {
                let state_dir = with_store(state, |store| {
                    let fallback = store_root(state)
                        .unwrap_or_else(|_| PathBuf::from("."))
                        .join("assistant")
                        .join("weixin");
                    Ok(assistant_store::weixin_state_dir(&store, fallback))
                })?;
                let sidecar_state = read_weixin_sidecar_state(&state_dir);
                let result = with_store_mut(state, |store| {
                    assistant_store::apply_weixin_login_state(store, sidecar_state.as_ref());
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
            "background-workers:get-pool-state" => {
                Ok(crate::build_background_worker_summary(state))
            }
            _ => unreachable!(),
        }
    })())
}
