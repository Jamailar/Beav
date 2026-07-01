use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager};

use super::get_media_job_projection;
use crate::agent::{persist_chat_exchange, resolve_chat_exchange_context, SessionAgentTurnKind};
use crate::commands::chat_state::{begin_chat_runtime_state, update_chat_runtime_state};
use crate::events::emit_chat_sequence;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_runtime_task_trace, mark_task_running, runtime_direct_route_record,
    set_runtime_graph_node, RuntimeArtifact, RuntimeCheckpointRecord, RuntimeTaskRecord,
};
use crate::store::runtime_tasks as runtime_tasks_store;
use crate::{file_url_for_path, now_i64, AppState};

const MEDIA_FOLLOWUP_TIMEOUT_MS: u64 = 60 * 60 * 1000;

#[derive(Clone)]
struct MediaFollowupCandidate {
    task_id: String,
    runtime_mode: String,
    session_id: String,
    job_id: String,
    kind: String,
    expected_count: usize,
    progress_notified_count: usize,
    progress_notification_status: String,
    progress_retry_not_before: i64,
    created_at: i64,
}

pub(crate) fn spawn_media_job_followup(
    app: &AppHandle,
    runtime_mode: &str,
    session_id: &str,
    job_id: &str,
    image_count: usize,
) -> Result<Value, String> {
    spawn_media_job_followup_for_kind(app, runtime_mode, session_id, job_id, "image", image_count)
}

pub(crate) fn spawn_media_job_followup_for_kind(
    app: &AppHandle,
    runtime_mode: &str,
    session_id: &str,
    job_id: &str,
    kind: &str,
    expected_count: usize,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let task = create_media_followup_task(
        &state,
        runtime_mode,
        session_id,
        job_id,
        kind,
        expected_count,
    )?;
    Ok(json!({
        "success": true,
        "taskId": task.id,
        "status": task.status,
        "jobId": job_id,
        "kind": normalize_followup_kind(kind),
        "expectedCount": expected_count.max(1),
        "taskType": "media-followup",
    }))
}

pub(crate) fn tick_media_followups(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    let candidates = with_store(state, |store| {
        Ok(runtime_tasks_store::list_tasks(&store)
            .into_iter()
            .filter(|task| {
                task.task_type == "media-followup"
                    && matches!(task.status.as_str(), "pending" | "running")
            })
            .filter_map(|task| {
                let metadata = task.metadata.as_ref()?;
                Some(MediaFollowupCandidate {
                    task_id: task.id.clone(),
                    runtime_mode: task.runtime_mode.clone(),
                    session_id: metadata.get("sessionId")?.as_str()?.to_string(),
                    job_id: metadata.get("jobId")?.as_str()?.to_string(),
                    kind: metadata
                        .get("kind")
                        .and_then(Value::as_str)
                        .map(normalize_followup_kind)
                        .unwrap_or_else(|| "image".to_string()),
                    expected_count: metadata
                        .get("expectedCount")
                        .or_else(|| metadata.get("imageCount"))
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or(1),
                    progress_notified_count: metadata
                        .get("progressNotifiedCount")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or(0),
                    progress_notification_status: metadata
                        .get("progressNotificationStatus")
                        .and_then(Value::as_str)
                        .unwrap_or("idle")
                        .to_string(),
                    progress_retry_not_before: metadata
                        .get("progressRetryNotBefore")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    created_at: task.created_at,
                })
            })
            .collect::<Vec<_>>())
    })?;

    for candidate in candidates {
        let projection = match get_media_job_projection(state, &candidate.job_id) {
            Ok(value) => value,
            Err(error) => {
                if mark_media_followup_notifying(
                    state,
                    &candidate.task_id,
                    &format!(
                        "读取{}任务状态失败，准备回传结果。",
                        kind_label(&candidate.kind)
                    ),
                )? {
                    let followup_reply = build_failure_followup_reply(
                        &candidate.kind,
                        &candidate.job_id,
                        &format!("读取{}任务状态失败：{error}", kind_label(&candidate.kind)),
                    );
                    dispatch_media_followup_notification(
                        app,
                        candidate,
                        followup_reply,
                        Some(error),
                        None,
                    );
                }
                continue;
            }
        };

        let status = projection
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let artifact_count = projection
            .get("artifacts")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0);
        let expected_count = candidate.expected_count.max(1);

        if artifact_count >= expected_count {
            let artifacts = projection
                .get("artifacts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !artifacts.is_empty()
                && mark_media_followup_notifying(
                    state,
                    &candidate.task_id,
                    &format!("{}已生成完成，准备回传聊天。", kind_label(&candidate.kind)),
                )?
            {
                let followup_reply =
                    build_success_followup_reply(&candidate.kind, &candidate.job_id, &artifacts);
                dispatch_media_followup_notification(
                    app,
                    candidate,
                    followup_reply,
                    None,
                    Some(projection),
                );
            }
            continue;
        }

        if should_send_incremental_progress(
            artifact_count,
            expected_count,
            candidate.progress_notified_count,
            candidate.progress_notification_status.as_str(),
            candidate.progress_retry_not_before,
            now_i64(),
            candidate.runtime_mode.as_str(),
        ) {
            let delivered_count = artifact_count.min(expected_count);
            if mark_media_followup_progress_notifying(
                state,
                &candidate.task_id,
                delivered_count,
                candidate.expected_count,
                &candidate.kind,
            )? {
                let artifacts = projection
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let followup_reply = build_progress_followup_reply(
                    &candidate.job_id,
                    &candidate.kind,
                    delivered_count,
                    candidate.expected_count,
                    &artifacts,
                );
                dispatch_media_followup_progress_notification(
                    app,
                    candidate.clone(),
                    followup_reply,
                    delivered_count,
                );
                continue;
            }
        }
        if candidate.progress_notification_status == "sending" {
            continue;
        }

        if status == "completed" {
            let artifacts = projection
                .get("artifacts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if artifacts.is_empty() {
                if mark_media_followup_notifying(
                    state,
                    &candidate.task_id,
                    &format!(
                        "{}任务已结束，但没有可展示产物，准备回传失败结果。",
                        kind_label(&candidate.kind)
                    ),
                )? {
                    let error = format!(
                        "{}任务完成，但没有产出可展示产物。",
                        kind_label(&candidate.kind)
                    );
                    let followup_reply =
                        build_failure_followup_reply(&candidate.kind, &candidate.job_id, &error);
                    dispatch_media_followup_notification(
                        app,
                        candidate,
                        followup_reply,
                        Some(error),
                        Some(projection),
                    );
                }
                continue;
            }
            if mark_media_followup_notifying(
                state,
                &candidate.task_id,
                &format!("{}已生成完成，准备回传聊天。", kind_label(&candidate.kind)),
            )? {
                let followup_reply =
                    build_success_followup_reply(&candidate.kind, &candidate.job_id, &artifacts);
                dispatch_media_followup_notification(
                    app,
                    candidate,
                    followup_reply,
                    None,
                    Some(projection),
                );
            }
            continue;
        }

        if matches!(status, "failed" | "cancelled" | "dead_lettered") {
            if mark_media_followup_notifying(
                state,
                &candidate.task_id,
                &format!(
                    "{}任务已结束，准备回传失败结果。",
                    kind_label(&candidate.kind)
                ),
            )? {
                let error = projection_terminal_error(&projection);
                let artifacts = projection
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let followup_reply = if artifacts.is_empty() {
                    build_failure_followup_reply(&candidate.kind, &candidate.job_id, &error)
                } else {
                    build_partial_failure_followup_reply(
                        &candidate.kind,
                        &candidate.job_id,
                        &artifacts,
                        artifact_count.min(expected_count),
                        expected_count,
                        &error,
                    )
                };
                dispatch_media_followup_notification(
                    app,
                    candidate,
                    followup_reply,
                    Some(error),
                    Some(projection),
                );
            }
            continue;
        }

        let elapsed_ms = now_i64().saturating_sub(candidate.created_at) as u64;
        if elapsed_ms >= MEDIA_FOLLOWUP_TIMEOUT_MS
            && mark_media_followup_notifying(
                state,
                &candidate.task_id,
                &format!(
                    "{}生成等待超时，准备回传失败结果。",
                    kind_label(&candidate.kind)
                ),
            )?
        {
            let error = format!(
                "等待{}生成超时（{} 分钟）",
                kind_label(&candidate.kind),
                MEDIA_FOLLOWUP_TIMEOUT_MS / 60_000
            );
            let followup_reply =
                build_failure_followup_reply(&candidate.kind, &candidate.job_id, &error);
            dispatch_media_followup_notification(
                app,
                candidate,
                followup_reply,
                Some(error),
                Some(projection),
            );
        }
    }

    Ok(())
}

fn should_send_incremental_progress(
    artifact_count: usize,
    expected_count: usize,
    progress_notified_count: usize,
    progress_notification_status: &str,
    progress_retry_not_before: i64,
    now: i64,
    _runtime_mode: &str,
) -> bool {
    artifact_count > progress_notified_count
        && artifact_count < expected_count.max(1)
        && progress_notification_status != "sending"
        && now >= progress_retry_not_before
}

fn create_media_followup_task(
    state: &tauri::State<'_, AppState>,
    runtime_mode: &str,
    session_id: &str,
    job_id: &str,
    kind: &str,
    expected_count: usize,
) -> Result<RuntimeTaskRecord, String> {
    let kind = normalize_followup_kind(kind);
    let expected_count = expected_count.max(1);
    let unit = kind_unit(&kind);
    let label = kind_label(&kind);
    let title = format!("{label}结果回传 · {expected_count} {unit}");
    let goal = format!("等待 {expected_count} {unit}{label}生成完成，并在当前聊天中回传结果。");
    let metadata = json!({
        "intent": "long_running_task",
        "forceLongRunningTask": true,
        "title": title,
        "kind": kind,
        "jobId": job_id,
        "sessionId": session_id,
        "imageCount": if kind == "image" { expected_count } else { 0 },
        "expectedCount": expected_count,
        "progressNotifiedCount": 0,
        "progressNotificationStatus": "idle",
        "progressRetryNotBefore": 0,
        "notificationStatus": "idle",
        "deliveryPolicy": "background_followup",
        "latestText": format!("等待{label}生成完成"),
    });
    let route = runtime_direct_route_record(runtime_mode, &goal, Some(&metadata));
    with_store_mut(state, |store| {
        let task = runtime_tasks_store::store_task(
            store,
            "media-followup",
            "pending",
            runtime_mode.to_string(),
            Some(session_id.to_string()),
            Some(goal.clone()),
            route,
            Some(metadata.clone()),
        );
        let task_id = task.id.clone();
        let snapshot = runtime_tasks_store::update_task(store, &task_id, |task| {
            mark_task_running(task, "waiting for media job completion");
            task.current_node = Some("execute_tools".to_string());
            set_runtime_graph_node(
                &mut task.graph,
                "plan",
                "completed",
                Some("follow-up task created".to_string()),
                None,
            );
            set_runtime_graph_node(
                &mut task.graph,
                "execute_tools",
                "running",
                Some("waiting for media job completion".to_string()),
                None,
            );
            task.clone()
        })
        .ok_or_else(|| "failed to initialize media follow-up task".to_string())?;
        append_runtime_task_trace(
            store,
            &task_id,
            "media-followup.started",
            Some(json!({
                "jobId": job_id,
                "kind": kind,
                "expectedCount": expected_count,
            })),
        );
        Ok(snapshot)
    })
}

fn normalize_followup_kind(kind: &str) -> String {
    match kind.trim() {
        "video" => "video".to_string(),
        "audio" => "audio".to_string(),
        "voice_clone" => "audio".to_string(),
        _ => "image".to_string(),
    }
}

fn kind_label(kind: &str) -> &'static str {
    match normalize_followup_kind(kind).as_str() {
        "video" => "视频",
        "audio" => "音频",
        _ => "图片",
    }
}

fn kind_unit(kind: &str) -> &'static str {
    match normalize_followup_kind(kind).as_str() {
        "video" => "条",
        "audio" => "段",
        _ => "张",
    }
}

fn mark_media_followup_notifying(
    state: &tauri::State<'_, AppState>,
    task_id: &str,
    latest_text: &str,
) -> Result<bool, String> {
    with_store_mut(state, |store| {
        Ok(runtime_tasks_store::update_task(store, task_id, |task| {
            if !matches!(task.status.as_str(), "pending" | "running") {
                return false;
            }
            task.status = "notifying".to_string();
            task.updated_at = now_i64();
            task.current_node = Some("respond".to_string());
            if let Some(metadata) = task.metadata.as_mut().and_then(Value::as_object_mut) {
                metadata.insert("latestText".to_string(), json!(latest_text));
                metadata.insert("notificationStatus".to_string(), json!("sending"));
            }
            set_runtime_graph_node(
                &mut task.graph,
                "execute_tools",
                "completed",
                Some("media job reached terminal state".to_string()),
                None,
            );
            true
        })
        .unwrap_or(false))
    })
}

fn mark_media_followup_progress_notifying(
    state: &tauri::State<'_, AppState>,
    task_id: &str,
    delivered_count: usize,
    total_count: usize,
    kind: &str,
) -> Result<bool, String> {
    let unit = kind_unit(kind);
    with_store_mut(state, |store| {
        let updated = runtime_tasks_store::update_task(store, task_id, |task| {
            if !matches!(task.status.as_str(), "pending" | "running") {
                return false;
            }
            let Some(metadata) = task.metadata.as_mut().and_then(Value::as_object_mut) else {
                return false;
            };
            let already_notified = metadata
                .get("progressNotifiedCount")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(0);
            let progress_status = metadata
                .get("progressNotificationStatus")
                .and_then(Value::as_str)
                .unwrap_or("idle");
            if delivered_count <= already_notified || progress_status == "sending" {
                return false;
            }
            metadata.insert(
                "latestText".to_string(),
                json!(format!(
                    "已生成 {delivered_count}/{total_count} {unit}，准备回传进度。"
                )),
            );
            metadata.insert("progressNotificationStatus".to_string(), json!("sending"));
            metadata.insert(
                "progressNotificationTarget".to_string(),
                json!(delivered_count),
            );
            metadata.insert("progressRetryNotBefore".to_string(), json!(0));
            task.updated_at = now_i64();
            true
        })
        .unwrap_or(false);
        if updated {
            append_runtime_task_trace(
                store,
                task_id,
                "media-followup.progress.pending",
                Some(json!({
                    "completedCount": delivered_count,
                    "expectedCount": total_count,
                    "kind": normalize_followup_kind(kind),
                })),
            );
        }
        Ok(updated)
    })
}

fn finish_media_followup_progress_notification(
    state: &tauri::State<'_, AppState>,
    task_id: &str,
    delivered_count: usize,
    total_count: usize,
    kind: &str,
    error: Option<String>,
) {
    let unit = kind_unit(kind);
    let _ = with_store_mut(state, |store| {
        let updated = runtime_tasks_store::update_task(store, task_id, |task| {
            let now = now_i64();
            task.updated_at = now;
            if let Some(metadata) = task.metadata.as_mut().and_then(Value::as_object_mut) {
                metadata.insert("progressNotificationStatus".to_string(), json!("idle"));
                metadata.insert(
                    "progressRetryNotBefore".to_string(),
                    json!(if error.is_some() { now + 5_000 } else { 0 }),
                );
                if error.is_none() {
                    metadata.insert("progressNotifiedCount".to_string(), json!(delivered_count));
                    metadata.insert(
                        "latestText".to_string(),
                        json!(format!(
                            "已回传进度 {delivered_count}/{total_count} {unit}。"
                        )),
                    );
                } else {
                    metadata.insert(
                        "latestText".to_string(),
                        json!(format!(
                            "进度回传失败（{delivered_count}/{total_count} {unit}），稍后重试。"
                        )),
                    );
                }
            }
            true
        })
        .unwrap_or(false);
        if updated {
            append_runtime_task_trace(
                store,
                task_id,
                if error.is_none() {
                    "media-followup.progress.sent"
                } else {
                    "media-followup.progress.failed"
                },
                Some(json!({
                    "completedCount": delivered_count,
                    "expectedCount": total_count,
                    "kind": normalize_followup_kind(kind),
                    "error": error,
                })),
            );
        }
        Ok(())
    });
}

fn dispatch_media_followup_progress_notification(
    app: &AppHandle,
    candidate: MediaFollowupCandidate,
    followup_reply: String,
    delivered_count: usize,
) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let notify_result = notify_session_with_media_result(
            &app_handle,
            &state,
            &candidate.session_id,
            &followup_reply,
        );
        match notify_result {
            Ok(()) => finish_media_followup_progress_notification(
                &state,
                &candidate.task_id,
                delivered_count,
                candidate.expected_count,
                &candidate.kind,
                None,
            ),
            Err(error) => finish_media_followup_progress_notification(
                &state,
                &candidate.task_id,
                delivered_count,
                candidate.expected_count,
                &candidate.kind,
                Some(error),
            ),
        }
    });
}

fn dispatch_media_followup_notification(
    app: &AppHandle,
    candidate: MediaFollowupCandidate,
    followup_reply: String,
    terminal_error: Option<String>,
    projection: Option<Value>,
) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let notify_result = notify_session_with_media_result(
            &app_handle,
            &state,
            &candidate.session_id,
            &followup_reply,
        );
        match notify_result {
            Ok(()) => {
                let summary = format!(
                    "{}生成完成，结果已回传到聊天。",
                    kind_label(&candidate.kind)
                );
                finish_media_followup_task(
                    &state,
                    &candidate.task_id,
                    "completed",
                    &summary,
                    None,
                    projection.as_ref(),
                )
            }
            Err(error) => {
                let summary = format!(
                    "{}任务已结束，但回传聊天失败。",
                    kind_label(&candidate.kind)
                );
                finish_media_followup_task(
                    &state,
                    &candidate.task_id,
                    "failed",
                    &summary,
                    Some(terminal_error.unwrap_or(error)),
                    projection.as_ref(),
                )
            }
        }
    });
}

fn notify_session_with_media_result(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    session_id: &str,
    response: &str,
) -> Result<(), String> {
    let context = resolve_chat_exchange_context(
        state,
        Some(session_id.to_string()),
        SessionAgentTurnKind::SessionBridge,
    )?;
    let _ = begin_chat_runtime_state(state, &context.working_session_id);
    let persistence = persist_chat_exchange(
        state,
        &context,
        "",
        "",
        None,
        response,
        false,
        SessionAgentTurnKind::SessionBridge,
        "Media generation follow-up delivered".to_string(),
        None,
    )?;
    let _ = update_chat_runtime_state(
        state,
        &persistence.final_session_id,
        false,
        response.to_string(),
        None,
    );
    emit_chat_sequence(
        app,
        &persistence.final_session_id,
        response,
        "",
        &context.runtime_mode,
        persistence.title_update,
    );
    Ok(())
}

fn finish_media_followup_task(
    state: &tauri::State<'_, AppState>,
    task_id: &str,
    status: &str,
    summary: &str,
    error: Option<String>,
    projection: Option<&Value>,
) {
    let _ = with_store_mut(state, |store| {
        let payload = runtime_tasks_store::update_task(store, task_id, |task| {
            let finished_at = now_i64();
            task.status = status.to_string();
            task.updated_at = finished_at;
            task.completed_at = Some(finished_at);
            task.last_error = error.clone();
            task.current_node = Some(if status == "completed" {
                "save_artifact".to_string()
            } else {
                "respond".to_string()
            });
            if let Some(metadata) = task.metadata.as_mut().and_then(Value::as_object_mut) {
                metadata.insert("latestText".to_string(), json!(summary));
                metadata.insert(
                    "notificationStatus".to_string(),
                    json!(if status == "completed" {
                        "sent"
                    } else {
                        "failed"
                    }),
                );
            }
            set_runtime_graph_node(
                &mut task.graph,
                "respond",
                if status == "completed" {
                    "completed"
                } else {
                    "failed"
                },
                Some(summary.to_string()),
                error.clone(),
            );
            if status == "completed" {
                let artifacts = projection
                    .map(runtime_artifacts_from_projection)
                    .unwrap_or_default();
                if !artifacts.is_empty() {
                    task.artifacts = artifacts;
                    set_runtime_graph_node(
                        &mut task.graph,
                        "save_artifact",
                        "completed",
                        Some("generated images saved".to_string()),
                        None,
                    );
                }
            }
            let payload = projection.map(|value| {
                json!({
                    "jobId": value.get("jobId").cloned().unwrap_or(Value::Null),
                    "status": value.get("status").cloned().unwrap_or(Value::Null),
                    "artifactCount": value
                        .get("artifacts")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0),
                })
            });
            task.checkpoints.push(RuntimeCheckpointRecord::new(
                if status == "completed" {
                    "media-followup.completed"
                } else {
                    "media-followup.failed"
                },
                task.current_node
                    .clone()
                    .unwrap_or_else(|| "respond".to_string()),
                summary.to_string(),
                payload.clone(),
            ));
            payload
        });
        append_runtime_task_trace(
            store,
            task_id,
            if status == "completed" {
                "completed"
            } else {
                "failed"
            },
            Some(json!({
                "summary": summary,
                "error": error,
                "projection": payload,
            })),
        );
        Ok(())
    });
}

fn runtime_artifacts_from_projection(projection: &Value) -> Vec<RuntimeArtifact> {
    let artifact_kind = match projection.get("kind").and_then(Value::as_str) {
        Some("video") => "generated-video",
        Some("audio") => "generated-audio",
        _ => "generated-image",
    };
    projection
        .get("artifacts")
        .and_then(Value::as_array)
        .map(|artifacts| {
            artifacts
                .iter()
                .enumerate()
                .map(|(index, artifact)| {
                    RuntimeArtifact::new(
                        artifact_kind,
                        artifact_label(artifact, index),
                        artifact
                            .get("absolutePath")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                        Some(artifact.clone()),
                        None,
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn artifact_label(artifact: &Value, index: usize) -> String {
    artifact
        .get("metadata")
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .or_else(|| artifact.get("title").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("生成图片 {}", index + 1))
}

fn build_progress_followup_reply(
    job_id: &str,
    kind: &str,
    completed_count: usize,
    total_count: usize,
    artifacts: &[Value],
) -> String {
    let _ = job_id;
    let label = kind_label(kind);
    let unit = kind_unit(kind);
    let gallery = markdown_gallery_from_artifacts(kind, artifacts);
    if gallery.trim().is_empty() {
        format!("{label}生成进度：已完成 {completed_count}/{total_count} {unit}。")
    } else {
        format!("已生成 {completed_count}/{total_count} {unit}。\n\n{gallery}")
    }
}

fn build_success_followup_reply(kind: &str, job_id: &str, artifacts: &[Value]) -> String {
    let _ = job_id;
    let label = kind_label(kind);
    let gallery = markdown_gallery_from_artifacts(kind, artifacts);
    if gallery.trim().is_empty() {
        format!("{label}已生成完成。")
    } else {
        format!("{label}已生成完成。\n\n{gallery}")
    }
}

fn build_partial_failure_followup_reply(
    kind: &str,
    job_id: &str,
    artifacts: &[Value],
    completed_count: usize,
    total_count: usize,
    error: &str,
) -> String {
    let _ = job_id;
    let label = kind_label(kind);
    let unit = kind_unit(kind);
    let gallery = markdown_gallery_from_artifacts(kind, artifacts);
    if gallery.trim().is_empty() {
        format!(
            "{label}生成部分完成：已生成 {completed_count}/{total_count} {unit}。剩余{label}未完成：{error}"
        )
    } else {
        format!(
            "{label}生成部分完成：已生成 {completed_count}/{total_count} {unit}。剩余{label}未完成：{error}\n\n{gallery}"
        )
    }
}

fn markdown_gallery_from_artifacts(kind: &str, artifacts: &[Value]) -> String {
    let normalized_kind = normalize_followup_kind(kind);
    artifacts
        .iter()
        .enumerate()
        .filter_map(|(index, artifact)| {
            let image_source = artifact
                .get("previewUrl")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    artifact
                        .get("absolutePath")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })?;
            let normalized_source = if image_source.starts_with("file://") {
                image_source.to_string()
            } else if Path::new(image_source).is_absolute()
                || image_source.starts_with("\\\\")
                || image_source.as_bytes().get(1).copied() == Some(b':')
            {
                file_url_for_path(Path::new(image_source))
            } else {
                image_source.to_string()
            };
            let label = sanitize_markdown_label(&artifact_label(artifact, index));
            if normalized_kind == "image" {
                Some(format!("![{}](<{}>)", label, normalized_source))
            } else {
                Some(format!("[{}](<{}>)", label, normalized_source))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn build_failure_followup_reply(kind: &str, job_id: &str, error: &str) -> String {
    let _ = job_id;
    let label = kind_label(kind);
    format!("{label}生成未完成：{error}")
}

fn projection_terminal_error(projection: &Value) -> String {
    projection
        .pointer("/attempt/lastError")
        .and_then(Value::as_str)
        .or_else(|| projection.pointer("/result/error").and_then(Value::as_str))
        .or_else(|| projection.get("cancelReason").and_then(Value::as_str))
        .unwrap_or("媒体生成失败")
        .to_string()
}

fn sanitize_markdown_label(label: &str) -> String {
    label.replace('[', " ").replace(']', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_notifications_stop_when_expected_count_is_reached() {
        assert!(!should_send_incremental_progress(
            4, 4, 3, "idle", 0, 10, "default"
        ));
    }

    #[test]
    fn progress_notifications_still_send_for_partial_artifacts() {
        assert!(should_send_incremental_progress(
            2, 4, 1, "idle", 0, 10, "default"
        ));
        assert!(!should_send_incremental_progress(
            2, 4, 2, "idle", 0, 10, "default"
        ));
        assert!(!should_send_incremental_progress(
            2, 4, 1, "sending", 0, 10, "default"
        ));
        assert!(!should_send_incremental_progress(
            2, 4, 1, "idle", 20, 10, "default"
        ));
        assert!(should_send_incremental_progress(
            2, 4, 1, "idle", 0, 10, "redclaw"
        ));
    }

    #[test]
    fn video_followup_uses_video_language_and_link_markdown() {
        let message = build_success_followup_reply(
            "video",
            "media-job-1",
            &[json!({
                "absolutePath": "/tmp/redbox-video.mp4",
                "metadata": { "title": "成片" }
            })],
        );
        assert!(message.contains("视频已生成完成"));
        assert!(message.contains("[成片](<file:///tmp/redbox-video.mp4>)"));
        assert!(!message.contains("![成片]"));
        assert!(!message.contains("session bridge"));
        assert!(!message.contains("jobId:"));
    }

    #[test]
    fn image_followup_keeps_image_markdown() {
        let message = build_success_followup_reply(
            "image",
            "media-job-1",
            &[json!({
                "absolutePath": "/tmp/redbox-image.png",
                "metadata": { "title": "图片" }
            })],
        );
        assert!(message.contains("图片已生成完成"));
        assert!(message.contains("![图片](<file:///tmp/redbox-image.png>)"));
        assert!(!message.contains("session bridge"));
        assert!(!message.contains("jobId:"));
    }

    #[test]
    fn progress_followup_reply_is_visible_content_only() {
        let message = build_progress_followup_reply(
            "media-job-1",
            "image",
            1,
            3,
            &[json!({
                "absolutePath": "/tmp/redbox-image.png",
                "metadata": { "title": "图片" }
            })],
        );

        assert!(message.starts_with("已生成 1/3 张。"));
        assert!(message.contains("![图片](<file:///tmp/redbox-image.png>)"));
        assert!(!message.contains("后台"));
        assert!(!message.contains("内部轮询"));
        assert!(!message.contains("jobId:"));
    }
}
