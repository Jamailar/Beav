use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::get_media_job_projection;
use crate::agent::{
    build_session_bridge_turn, execute_prepared_session_agent_turn, PreparedSessionAgentTurn,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_runtime_task_trace, mark_task_running, runtime_direct_route_record,
    set_runtime_graph_node, store_runtime_task, RuntimeArtifact, RuntimeCheckpointRecord,
    RuntimeTaskRecord,
};
use crate::{now_i64, AppState};

const MEDIA_FOLLOWUP_TIMEOUT_MS: u64 = 60 * 60 * 1000;

#[derive(Clone)]
struct MediaFollowupCandidate {
    task_id: String,
    session_id: String,
    job_id: String,
    created_at: i64,
}

pub(crate) fn spawn_media_job_followup(
    app: &AppHandle,
    runtime_mode: &str,
    session_id: &str,
    job_id: &str,
    image_count: usize,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let task = create_media_followup_task(&state, runtime_mode, session_id, job_id, image_count)?;
    Ok(json!({
        "success": true,
        "taskId": task.id,
        "status": task.status,
        "jobId": job_id,
        "imageCount": image_count,
        "taskType": "media-followup",
    }))
}

pub(crate) fn tick_media_followups(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    let candidates = with_store(state, |store| {
        Ok(store
            .runtime_tasks
            .iter()
            .filter(|task| {
                task.task_type == "media-followup"
                    && matches!(task.status.as_str(), "pending" | "running")
            })
            .filter_map(|task| {
                let metadata = task.metadata.as_ref()?;
                Some(MediaFollowupCandidate {
                    task_id: task.id.clone(),
                    session_id: metadata.get("sessionId")?.as_str()?.to_string(),
                    job_id: metadata.get("jobId")?.as_str()?.to_string(),
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
                    "读取图片任务状态失败，准备回传结果。",
                )? {
                    let bridge_message = build_failure_bridge_message(
                        &candidate.job_id,
                        &format!("读取图片任务状态失败：{error}"),
                    );
                    dispatch_media_followup_notification(
                        app,
                        candidate,
                        bridge_message,
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
                    "图片任务已结束，但没有可展示产物，准备回传失败结果。",
                )? {
                    let error = "图片任务完成，但没有产出可展示的图片。".to_string();
                    let bridge_message = build_failure_bridge_message(&candidate.job_id, &error);
                    dispatch_media_followup_notification(
                        app,
                        candidate,
                        bridge_message,
                        Some(error),
                        Some(projection),
                    );
                }
                continue;
            }
            if mark_media_followup_notifying(
                state,
                &candidate.task_id,
                "图片已生成完成，准备回传聊天。",
            )? {
                let bridge_message = build_success_bridge_message(&candidate.job_id, &artifacts);
                dispatch_media_followup_notification(
                    app,
                    candidate,
                    bridge_message,
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
                "图片任务已结束，准备回传失败结果。",
            )? {
                let error = projection_terminal_error(&projection);
                let bridge_message = build_failure_bridge_message(&candidate.job_id, &error);
                dispatch_media_followup_notification(
                    app,
                    candidate,
                    bridge_message,
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
                "图片生成等待超时，准备回传失败结果。",
            )?
        {
            let error = format!(
                "等待图片生成超时（{} 分钟）",
                MEDIA_FOLLOWUP_TIMEOUT_MS / 60_000
            );
            let bridge_message = build_failure_bridge_message(&candidate.job_id, &error);
            dispatch_media_followup_notification(
                app,
                candidate,
                bridge_message,
                Some(error),
                Some(projection),
            );
        }
    }

    Ok(())
}

fn create_media_followup_task(
    state: &tauri::State<'_, AppState>,
    runtime_mode: &str,
    session_id: &str,
    job_id: &str,
    image_count: usize,
) -> Result<RuntimeTaskRecord, String> {
    let title = format!("图片结果回传 · {} 张", image_count.max(1));
    let goal = format!("等待 {image_count} 张图片生成完成，并在当前聊天中回传结果。");
    let metadata = json!({
        "intent": "long_running_task",
        "forceLongRunningTask": true,
        "title": title,
        "kind": "image",
        "jobId": job_id,
        "sessionId": session_id,
        "imageCount": image_count,
        "deliveryPolicy": "background_followup",
        "latestText": "等待图片生成完成",
    });
    let route = runtime_direct_route_record(runtime_mode, &goal, Some(&metadata));
    with_store_mut(state, |store| {
        let task = store_runtime_task(
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
        let task = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == task_id)
            .ok_or_else(|| "failed to initialize media follow-up task".to_string())?;
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
        let snapshot = task.clone();
        append_runtime_task_trace(
            store,
            &task_id,
            "media-followup.started",
            Some(json!({
                "jobId": job_id,
                "imageCount": image_count,
            })),
        );
        Ok(snapshot)
    })
}

fn mark_media_followup_notifying(
    state: &tauri::State<'_, AppState>,
    task_id: &str,
    latest_text: &str,
) -> Result<bool, String> {
    with_store_mut(state, |store| {
        let Some(task) = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == task_id)
        else {
            return Ok(false);
        };
        if !matches!(task.status.as_str(), "pending" | "running") {
            return Ok(false);
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
        Ok(true)
    })
}

fn dispatch_media_followup_notification(
    app: &AppHandle,
    candidate: MediaFollowupCandidate,
    bridge_message: String,
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
            &bridge_message,
        );
        match notify_result {
            Ok(()) => finish_media_followup_task(
                &state,
                &candidate.task_id,
                "completed",
                "图片生成完成，结果已回传到聊天。",
                None,
                projection.as_ref(),
            ),
            Err(error) => finish_media_followup_task(
                &state,
                &candidate.task_id,
                "failed",
                "图片任务已结束，但回传聊天失败。",
                Some(terminal_error.unwrap_or(error)),
                projection.as_ref(),
            ),
        }
    });
}

fn notify_session_with_media_result(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    session_id: &str,
    message: &str,
) -> Result<(), String> {
    let turn = PreparedSessionAgentTurn::session_bridge(build_session_bridge_turn(
        session_id.to_string(),
        message.to_string(),
    ));
    execute_prepared_session_agent_turn(Some(app), state, &turn).map(|_| ())
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
        let Some(task) = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == task_id)
        else {
            return Ok(());
        };
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
    projection
        .get("artifacts")
        .and_then(Value::as_array)
        .map(|artifacts| {
            artifacts
                .iter()
                .enumerate()
                .map(|(index, artifact)| {
                    RuntimeArtifact::new(
                        "generated-image",
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

fn build_success_bridge_message(job_id: &str, artifacts: &[Value]) -> String {
    let gallery = artifacts
        .iter()
        .enumerate()
        .filter_map(|(index, artifact)| {
            let absolute_path = artifact
                .get("absolutePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            Some(format!(
                "![{}]({})",
                sanitize_markdown_label(&artifact_label(artifact, index)),
                absolute_path
            ))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let final_reply = if gallery.trim().is_empty() {
        "图片已生成完成。".to_string()
    } else {
        format!("图片已生成完成。\n\n{gallery}")
    };
    format!(
        "你正在处理一个图片生成后台回传任务。不要提到后台任务、session bridge、系统提示或内部轮询。请直接把下面内容作为你对用户的最终回复，保持中文、保持 Markdown 图片语法，不要放进代码块。\n\njobId: {job_id}\n\n最终回复：\n{final_reply}"
    )
}

fn build_failure_bridge_message(job_id: &str, error: &str) -> String {
    let final_reply = format!("图片生成未完成：{error}");
    format!(
        "你正在处理一个图片生成后台回传任务。不要提到后台任务、session bridge、系统提示或内部轮询。请直接把下面内容作为你对用户的最终回复，保持中文，不要放进代码块。\n\njobId: {job_id}\n\n最终回复：\n{final_reply}"
    )
}

fn projection_terminal_error(projection: &Value) -> String {
    projection
        .pointer("/attempt/lastError")
        .and_then(Value::as_str)
        .or_else(|| projection.pointer("/result/error").and_then(Value::as_str))
        .or_else(|| projection.get("cancelReason").and_then(Value::as_str))
        .unwrap_or("图片生成失败")
        .to_string()
}

fn sanitize_markdown_label(label: &str) -> String {
    label.replace('[', " ").replace(']', " ")
}
