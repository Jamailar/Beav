use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

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
use crate::scheduler::derived_background_tasks;
use crate::{now_i64, AppState};

const MEDIA_FOLLOWUP_POLL_INTERVAL_MS: u64 = 1_000;
const MEDIA_FOLLOWUP_TIMEOUT_MS: u64 = 60 * 60 * 1000;

pub(crate) fn spawn_media_job_followup(
    app: &AppHandle,
    runtime_mode: &str,
    session_id: &str,
    job_id: &str,
    image_count: usize,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let task = create_media_followup_task(&state, runtime_mode, session_id, job_id, image_count)?;
    emit_background_task_updated(app, &state, &task.id);

    let app_handle = app.clone();
    let task_id = task.id.clone();
    let job_id = job_id.to_string();
    let worker_job_id = job_id.clone();
    let session_id = session_id.to_string();
    thread::spawn(move || {
        run_media_followup_worker(app_handle, task_id, session_id, worker_job_id)
    });

    Ok(json!({
        "success": true,
        "taskId": task.id,
        "status": task.status,
        "jobId": job_id,
        "imageCount": image_count,
        "taskType": "media-followup",
    }))
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

fn run_media_followup_worker(app: AppHandle, task_id: String, session_id: String, job_id: String) {
    let state = app.state::<AppState>();
    let started = Instant::now();
    loop {
        if is_media_followup_cancelled(&state, &task_id) {
            emit_background_task_updated(&app, &state, &task_id);
            return;
        }

        let projection = match get_media_job_projection(&state, &job_id) {
            Ok(value) => value,
            Err(error) => {
                let summary = format!("读取图片任务状态失败：{error}");
                finish_media_followup_task(&state, &task_id, "failed", &summary, Some(error), None);
                emit_background_task_updated(&app, &state, &task_id);
                return;
            }
        };

        let status = projection
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match status {
            "completed" => {
                let artifacts = projection
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if artifacts.is_empty() {
                    let error = "图片任务完成，但没有产出可展示的图片。".to_string();
                    let _ = notify_session_with_media_result(
                        &app,
                        &state,
                        &session_id,
                        &build_failure_bridge_message(&job_id, &error),
                    );
                    finish_media_followup_task(
                        &state,
                        &task_id,
                        "failed",
                        &error,
                        Some(error.clone()),
                        Some(&projection),
                    );
                    emit_background_task_updated(&app, &state, &task_id);
                    return;
                }
                let notify_result = notify_session_with_media_result(
                    &app,
                    &state,
                    &session_id,
                    &build_success_bridge_message(&job_id, &artifacts),
                );
                match notify_result {
                    Ok(()) => finish_media_followup_task(
                        &state,
                        &task_id,
                        "completed",
                        "图片生成完成，结果已回传到聊天。",
                        None,
                        Some(&projection),
                    ),
                    Err(error) => finish_media_followup_task(
                        &state,
                        &task_id,
                        "failed",
                        "图片已生成完成，但回传聊天失败。",
                        Some(error),
                        Some(&projection),
                    ),
                }
                emit_background_task_updated(&app, &state, &task_id);
                return;
            }
            "failed" | "cancelled" | "dead_lettered" => {
                let error = projection_terminal_error(&projection);
                let _ = notify_session_with_media_result(
                    &app,
                    &state,
                    &session_id,
                    &build_failure_bridge_message(&job_id, &error),
                );
                finish_media_followup_task(
                    &state,
                    &task_id,
                    "failed",
                    "图片生成未完成，已回传失败结果。",
                    Some(error),
                    Some(&projection),
                );
                emit_background_task_updated(&app, &state, &task_id);
                return;
            }
            _ => {}
        }

        if started.elapsed().as_millis() as u64 >= MEDIA_FOLLOWUP_TIMEOUT_MS {
            let error = format!(
                "等待图片生成超时（{} 分钟）",
                MEDIA_FOLLOWUP_TIMEOUT_MS / 60_000
            );
            let _ = notify_session_with_media_result(
                &app,
                &state,
                &session_id,
                &build_failure_bridge_message(&job_id, &error),
            );
            finish_media_followup_task(
                &state,
                &task_id,
                "failed",
                "图片生成等待超时。",
                Some(error),
                None,
            );
            emit_background_task_updated(&app, &state, &task_id);
            return;
        }

        thread::sleep(Duration::from_millis(MEDIA_FOLLOWUP_POLL_INTERVAL_MS));
    }
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
            "execute_tools".to_string()
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
            "execute_tools",
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
        task.checkpoints.push(RuntimeCheckpointRecord::new(
            if status == "completed" {
                "media-followup.completed"
            } else {
                "media-followup.failed"
            },
            task.current_node
                .clone()
                .unwrap_or_else(|| "execute_tools".to_string()),
            summary.to_string(),
            projection.cloned(),
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
                "projection": projection.cloned(),
            })),
        );
        Ok(())
    });
}

fn is_media_followup_cancelled(state: &tauri::State<'_, AppState>, task_id: &str) -> bool {
    with_store(state, |store| {
        Ok(store
            .runtime_tasks
            .iter()
            .find(|item| item.id == task_id)
            .map(|item| item.status == "cancelled")
            .unwrap_or(true))
    })
    .unwrap_or(true)
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

fn emit_background_task_updated(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    task_id: &str,
) {
    let task = with_store(state, |store| {
        Ok(derived_background_tasks(&store).into_iter().find(|item| {
            item.get("id").and_then(Value::as_str) == Some(task_id)
                || item.get("executionId").and_then(Value::as_str) == Some(task_id)
                || item.get("sourceTaskId").and_then(Value::as_str) == Some(task_id)
        }))
    })
    .ok()
    .flatten();
    if let Some(task) = task {
        let _ = app.emit("background:task-updated", task);
    }
}
