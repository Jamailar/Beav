use crate::commands::library::persist_media_workspace_catalog;
use crate::manuscript_package::{
    animation_layers_from_remotion_scene, hydrate_editor_project_motion_from_remotion,
    normalized_remotion_render_config, persist_remotion_composition_artifacts,
};
use crate::persistence::{with_store, with_store_mut};
use crate::skills::{load_skill_bundle_sections_from_sources, split_skill_body};
use crate::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use tauri::{AppHandle, State};

const DEFAULT_TIMELINE_CLIP_MS: i64 = 4000;
const IMAGE_TIMELINE_CLIP_MS: i64 = 500;
const DEFAULT_MIN_CLIP_MS: i64 = 1000;
const DEFAULT_EDITOR_MOTION_PROMPT: &str =
    "请根据当前时间线和脚本，生成适合短视频的动画节奏与标题强调。";

fn min_clip_duration_ms_for_asset_kind(asset_kind: &str) -> i64 {
    if asset_kind.eq_ignore_ascii_case("image") {
        IMAGE_TIMELINE_CLIP_MS
    } else {
        DEFAULT_MIN_CLIP_MS
    }
}

fn ensure_editor_project_ai_state(
    project: &mut Value,
) -> Result<&mut serde_json::Map<String, Value>, String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let ai = project_object
        .entry("ai".to_string())
        .or_insert_with(|| json!({}));
    if !ai.is_object() {
        *ai = json!({});
    }
    let ai_object = ai
        .as_object_mut()
        .ok_or_else(|| "Editor project ai must be an object".to_string())?;
    ai_object
        .entry("motionPrompt".to_string())
        .or_insert(json!(DEFAULT_EDITOR_MOTION_PROMPT));
    ai_object
        .entry("lastEditBrief".to_string())
        .or_insert(Value::Null);
    ai_object
        .entry("lastMotionBrief".to_string())
        .or_insert(Value::Null);
    let approval = ai_object
        .entry("scriptApproval".to_string())
        .or_insert_with(|| json!({}));
    if !approval.is_object() {
        *approval = json!({});
    }
    let approval_object = approval
        .as_object_mut()
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    approval_object
        .entry("status".to_string())
        .or_insert(json!("pending"));
    approval_object
        .entry("lastScriptUpdateAt".to_string())
        .or_insert(Value::Null);
    approval_object
        .entry("lastScriptUpdateSource".to_string())
        .or_insert(Value::Null);
    approval_object
        .entry("confirmedAt".to_string())
        .or_insert(Value::Null);
    Ok(ai_object)
}

fn package_script_state_value(project: &Value) -> Value {
    let approval = project
        .pointer("/ai/scriptApproval")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "status": "pending",
                "lastScriptUpdateAt": Value::Null,
                "lastScriptUpdateSource": Value::Null,
                "confirmedAt": Value::Null
            })
        });
    json!({
        "body": project
            .pointer("/script/body")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
        "approval": approval
    })
}

fn mark_editor_project_script_pending(
    project: &mut Value,
    content: &str,
    source: &str,
) -> Result<(), String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let script = project_object
        .entry("script".to_string())
        .or_insert_with(|| json!({}));
    if !script.is_object() {
        *script = json!({});
    }
    if let Some(script_object) = script.as_object_mut() {
        script_object.insert("body".to_string(), json!(content));
    }
    let ai_object = ensure_editor_project_ai_state(project)?;
    ai_object.insert("lastEditBrief".to_string(), Value::Null);
    ai_object.insert("lastMotionBrief".to_string(), Value::Null);
    let approval = ai_object
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    approval.insert("status".to_string(), json!("pending"));
    approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    approval.insert("lastScriptUpdateSource".to_string(), json!(source));
    approval.insert("confirmedAt".to_string(), Value::Null);
    Ok(())
}

fn confirm_editor_project_script(project: &mut Value) -> Result<Value, String> {
    let ai_object = ensure_editor_project_ai_state(project)?;
    let approval = ai_object
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    if approval
        .get("lastScriptUpdateAt")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    }
    approval.insert("status".to_string(), json!("confirmed"));
    approval.insert("confirmedAt".to_string(), json!(now_i64()));
    Ok(project
        .pointer("/ai/scriptApproval")
        .cloned()
        .unwrap_or(Value::Null))
}

fn first_orchestration_output_artifact(orchestration: &Value) -> Result<(String, String), String> {
    let output = orchestration
        .get("outputs")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "动画子代理没有返回输出".to_string())?;
    let status = output
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if status != "completed" {
        let summary = output
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("动画子代理执行失败");
        return Err(summary.to_string());
    }
    let artifact = output
        .get("artifact")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            output
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("动画子代理未返回 artifact")
                .to_string()
        })?;
    let summary = output
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok((artifact.to_string(), summary))
}

fn run_animation_director_subagent(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    model_config: Option<&Value>,
    user_input: &str,
) -> Result<(Value, String), String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let base_prompt_patch =
        load_redbox_prompt("runtime/agents/video_editor/animation_director.txt")
            .unwrap_or_default();
    let skill_prompt_patch = build_remotion_best_practices_prompt_patch(state, user_input);
    let system_prompt_patch = [base_prompt_patch, skill_prompt_patch]
        .into_iter()
        .filter(|item| !item.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let metadata = json!({
        "intent": "direct_answer",
        "useRealSubagents": true,
        "subagentRoles": ["animation-director"],
        "allowedTools": ["redbox_fs"],
        "systemPromptPatch": system_prompt_patch,
    });
    let route =
        crate::runtime::runtime_direct_route_record("video-editor", user_input, Some(&metadata));
    let task_id = make_id("video-animation");
    let orchestration =
        crate::commands::runtime_orchestration::run_subagent_orchestration_for_task(
            Some(app),
            state,
            &settings_snapshot,
            "video-editor",
            &task_id,
            session_id,
            &route,
            user_input,
            Some(&metadata),
            model_config,
        )?;
    let (artifact, summary) = first_orchestration_output_artifact(&orchestration)?;
    let parsed = parse_json_value_from_text(&artifact)
        .ok_or_else(|| "动画子代理返回的 artifact 不是合法 JSON".to_string())?;
    Ok((parsed, summary))
}

fn selected_remotion_rule_names(bundle: &crate::skills::SkillBundleSections) -> Vec<String> {
    let mut rules = bundle.rules.keys().cloned().collect::<Vec<_>>();
    rules.sort();
    rules
}

fn build_remotion_best_practices_prompt_patch(
    state: &State<'_, AppState>,
    _user_input: &str,
) -> String {
    let workspace = workspace_root(state).ok();
    let bundle =
        load_skill_bundle_sections_from_sources("remotion-best-practices", workspace.as_deref());
    let (_, skill_body) = split_skill_body(&bundle.body);
    let mut sections = Vec::<String>::new();
    if !skill_body.trim().is_empty() {
        sections.push(skill_body);
    }
    for rule_name in selected_remotion_rule_names(&bundle) {
        let Some(rule_body) = bundle.rules.get(&rule_name) else {
            continue;
        };
        let (_, rule_content) = split_skill_body(rule_body);
        if rule_content.trim().is_empty() {
            continue;
        }
        sections.push(format!("## Loaded rule: {rule_name}\n{rule_content}"));
    }
    sections.join("\n\n")
}

fn persist_package_script_body(
    package_path: &std::path::Path,
    file_name: &str,
    content: &str,
    metadata: Option<&serde_json::Map<String, Value>>,
    source: &str,
) -> Result<(Value, Value), String> {
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        if let Some(metadata_object) = metadata {
            for (key, value) in metadata_object {
                object.insert(key.clone(), value.clone());
            }
        }
        object.insert("updatedAt".to_string(), json!(now_i64()));
        object
            .entry("title".to_string())
            .or_insert(json!(title_from_relative_path(file_name)));
        object
            .entry("entry".to_string())
            .or_insert(json!(get_default_package_entry(file_name)));
        object
            .entry("draftType".to_string())
            .or_insert(json!(get_draft_type_from_file_name(file_name)));
        object
            .entry("packageKind".to_string())
            .or_insert(json!(get_package_kind_from_file_name(file_name)));
    }
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    write_text_file(
        &package_entry_path(package_path, file_name, Some(&manifest)),
        content,
    )?;

    if matches!(
        get_package_kind_from_file_name(file_name),
        Some("video" | "audio")
    ) {
        let mut project = ensure_editor_project(package_path)?;
        mark_editor_project_script_pending(&mut project, content, source)?;
        write_json_value(&package_editor_project_path(package_path), &project)?;
        return Ok((
            get_manuscript_package_state(package_path)?,
            package_script_state_value(&project),
        ));
    }

    Ok((
        get_manuscript_package_state(package_path)?,
        json!({
            "body": content,
            "approval": {
                "status": "pending",
                "lastScriptUpdateAt": Value::Null,
                "lastScriptUpdateSource": source,
                "confirmedAt": Value::Null
            }
        }),
    ))
}

fn default_clip_duration_ms_for_asset(asset: &MediaAssetRecord) -> i64 {
    if media_asset_kind(asset) == "image" {
        IMAGE_TIMELINE_CLIP_MS
    } else {
        DEFAULT_TIMELINE_CLIP_MS
    }
}

fn timeline_clip_asset_kind(clip: &Value) -> String {
    clip.get("metadata")
        .and_then(|value| value.get("assetKind"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .or_else(|| {
            clip.pointer("/media_references/DEFAULT_MEDIA/metadata/mimeType")
                .and_then(|value| value.as_str())
                .map(|mime_type| {
                    if mime_type.starts_with("audio/") {
                        "audio".to_string()
                    } else if mime_type.starts_with("video/") {
                        "video".to_string()
                    } else {
                        "image".to_string()
                    }
                })
        })
        .unwrap_or_else(|| "video".to_string())
}

fn editor_runtime_state_value(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Value, String> {
    let guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard.get(file_path).cloned();
    Ok(match record {
        Some(record) => json!({
            "filePath": record.file_path,
            "sessionId": record.session_id,
            "playheadSeconds": record.playhead_seconds,
            "selectedClipId": record.selected_clip_id,
            "selectedClipIds": record.selected_clip_ids,
            "activeTrackId": record.active_track_id,
            "selectedTrackIds": record.selected_track_ids,
            "selectedSceneId": record.selected_scene_id,
            "previewTab": record.preview_tab,
            "canvasRatioPreset": record.canvas_ratio_preset,
            "activePanel": record.active_panel,
            "drawerPanel": record.drawer_panel,
            "sceneItemTransforms": record.scene_item_transforms,
            "sceneItemVisibility": record.scene_item_visibility,
            "sceneItemOrder": record.scene_item_order,
            "sceneItemLocks": record.scene_item_locks,
            "sceneItemGroups": record.scene_item_groups,
            "focusedGroupId": record.focused_group_id,
            "trackUi": record.track_ui,
            "viewportScrollLeft": record.viewport_scroll_left,
            "viewportMaxScrollLeft": record.viewport_max_scroll_left,
            "viewportScrollTop": record.viewport_scroll_top,
            "viewportMaxScrollTop": record.viewport_max_scroll_top,
            "timelineZoomPercent": record.timeline_zoom_percent,
            "canUndo": !record.undo_stack.is_empty(),
            "canRedo": !record.redo_stack.is_empty(),
            "updatedAt": record.updated_at,
        }),
        None => json!({
            "filePath": file_path,
            "sessionId": Value::Null,
            "playheadSeconds": 0.0,
            "selectedClipId": Value::Null,
            "selectedClipIds": json!([]),
            "activeTrackId": Value::Null,
            "selectedTrackIds": json!([]),
            "selectedSceneId": Value::Null,
            "previewTab": Value::Null,
            "canvasRatioPreset": Value::Null,
            "activePanel": Value::Null,
            "drawerPanel": Value::Null,
            "sceneItemTransforms": Value::Null,
            "sceneItemVisibility": Value::Null,
            "sceneItemOrder": Value::Null,
            "sceneItemLocks": Value::Null,
            "sceneItemGroups": Value::Null,
            "focusedGroupId": Value::Null,
            "trackUi": Value::Null,
            "viewportScrollLeft": 0.0,
            "viewportMaxScrollLeft": 0.0,
            "viewportScrollTop": 0.0,
            "viewportMaxScrollTop": 0.0,
            "timelineZoomPercent": 100.0,
            "canUndo": false,
            "canRedo": false,
            "updatedAt": now_ms(),
        }),
    })
}

fn editor_runtime_state_record(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Option<EditorRuntimeStateRecord>, String> {
    let guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    Ok(guard.get(file_path).cloned())
}

fn empty_editor_runtime_state_record(file_path: &str) -> EditorRuntimeStateRecord {
    EditorRuntimeStateRecord {
        file_path: file_path.to_string(),
        session_id: None,
        playhead_seconds: 0.0,
        selected_clip_id: None,
        selected_clip_ids: Some(json!([])),
        active_track_id: None,
        selected_track_ids: Some(json!([])),
        selected_scene_id: None,
        preview_tab: None,
        canvas_ratio_preset: None,
        active_panel: None,
        drawer_panel: None,
        scene_item_transforms: None,
        scene_item_visibility: None,
        scene_item_order: None,
        scene_item_locks: None,
        scene_item_groups: None,
        focused_group_id: None,
        track_ui: None,
        viewport_scroll_left: 0.0,
        viewport_max_scroll_left: 0.0,
        viewport_scroll_top: 0.0,
        viewport_max_scroll_top: 0.0,
        timeline_zoom_percent: 100.0,
        undo_stack: Vec::new(),
        redo_stack: Vec::new(),
        updated_at: now_ms(),
    }
}

fn push_editor_project_undo_snapshot(
    state: &State<'_, AppState>,
    file_path: &str,
    project: &Value,
) -> Result<(), String> {
    let mut guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard
        .entry(file_path.to_string())
        .or_insert_with(|| empty_editor_runtime_state_record(file_path));
    record.undo_stack.push(project.clone());
    if record.undo_stack.len() > 80 {
        record.undo_stack.remove(0);
    }
    record.redo_stack.clear();
    record.updated_at = now_ms();
    Ok(())
}

fn restore_editor_project_from_history(
    state: &State<'_, AppState>,
    file_path: &str,
    full_path: &Path,
    direction: &str,
) -> Result<Value, String> {
    let current_project = ensure_editor_project(full_path)?;
    let mut guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard
        .entry(file_path.to_string())
        .or_insert_with(|| empty_editor_runtime_state_record(file_path));
    let source_stack = if direction == "redo" {
        &mut record.redo_stack
    } else {
        &mut record.undo_stack
    };
    let Some(next_project) = source_stack.pop() else {
        return Ok(json!({
            "success": false,
            "error": if direction == "redo" { "Nothing to redo" } else { "Nothing to undo" }
        }));
    };
    if direction == "redo" {
        record.undo_stack.push(current_project.clone());
    } else {
        record.redo_stack.push(current_project.clone());
    }
    record.updated_at = now_ms();
    drop(guard);
    write_json_value(&package_editor_project_path(full_path), &next_project)?;
    Ok(json!({
        "success": true,
        "state": get_manuscript_package_state(full_path)?
    }))
}

fn merge_json_objects(base: &Value, patch: &Value) -> Value {
    match (base, patch) {
        (Value::Object(base_object), Value::Object(patch_object)) => {
            let mut merged = base_object.clone();
            for (key, value) in patch_object {
                let next = if let Some(existing) = merged.get(key) {
                    merge_json_objects(existing, value)
                } else {
                    value.clone()
                };
                merged.insert(key.clone(), next);
            }
            Value::Object(merged)
        }
        (_, value) => value.clone(),
    }
}

fn merge_remotion_scene_patch(existing: &Value, patch: &Value) -> Value {
    if !patch.is_object() {
        return existing.clone();
    }
    let mut merged = merge_json_objects(existing, patch);
    let patch_scenes = patch
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if patch_scenes.is_empty() {
        return merged;
    }
    let existing_scenes = existing
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next_scenes = existing_scenes.clone();
    for (index, patch_scene) in patch_scenes.iter().enumerate() {
        let target_index = patch_scene
            .get("id")
            .and_then(Value::as_str)
            .and_then(|scene_id| {
                existing_scenes.iter().position(|scene| {
                    scene
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|value| value == scene_id)
                        .unwrap_or(false)
                })
            })
            .or_else(|| (index < next_scenes.len()).then_some(index))
            .unwrap_or(next_scenes.len());
        let merged_scene = next_scenes
            .get(target_index)
            .map(|scene| merge_json_objects(scene, patch_scene))
            .unwrap_or_else(|| patch_scene.clone());
        if target_index < next_scenes.len() {
            next_scenes[target_index] = merged_scene;
        } else {
            next_scenes.push(merged_scene);
        }
    }
    if let Some(object) = merged.as_object_mut() {
        object.insert("scenes".to_string(), Value::Array(next_scenes));
    }
    merged
}

fn remotion_scene_summary_items(composition: &Value) -> Vec<Value> {
    composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|scene| {
            let entity_count = scene
                .get("entities")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            let overlay_count = scene
                .get("overlays")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            json!({
                "id": scene.get("id").cloned().unwrap_or(Value::Null),
                "clipId": scene.get("clipId").cloned().unwrap_or(Value::Null),
                "assetId": scene.get("assetId").cloned().unwrap_or(Value::Null),
                "startFrame": scene.get("startFrame").cloned().unwrap_or_else(|| json!(0)),
                "durationInFrames": scene.get("durationInFrames").cloned().unwrap_or_else(|| json!(0)),
                "entityCount": entity_count,
                "overlayCount": overlay_count,
                "overlayTitle": scene.get("overlayTitle").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn remotion_asset_metadata(project: &Value) -> Vec<Value> {
    project
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|asset| {
            json!({
                "id": asset.get("id").cloned().unwrap_or(Value::Null),
                "title": asset.get("title").cloned().unwrap_or(Value::Null),
                "kind": asset.get("kind").cloned().unwrap_or(Value::Null),
                "src": asset.get("src").cloned().unwrap_or(Value::Null),
                "mimeType": asset.get("mimeType").cloned().unwrap_or(Value::Null),
                "durationMs": asset.get("durationMs").cloned().unwrap_or(Value::Null),
                "metadata": asset.get("metadata").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn remotion_context_value(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_path: &str,
) -> Result<Value, String> {
    let project = ensure_editor_project(package_path)?;
    let fallback = build_remotion_config_from_editor_project(&project);
    let composition = read_json_value_or(package_remotion_path(package_path).as_path(), fallback);
    let runtime_state = editor_runtime_state_record(state, file_path)?;
    let fps = composition
        .get("fps")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let playhead_seconds = runtime_state
        .as_ref()
        .map(|record| record.playhead_seconds)
        .unwrap_or(0.0)
        .max(0.0);
    let playhead_frame = (playhead_seconds * fps as f64).round() as i64;
    let scenes = composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let transitions = composition
        .get("transitions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let active_scene = runtime_state
        .as_ref()
        .and_then(|record| record.selected_scene_id.as_deref())
        .and_then(|scene_id| {
            scenes.iter().find(|scene| {
                scene
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|value| value == scene_id)
                    .unwrap_or(false)
            })
        })
        .cloned()
        .or_else(|| {
            scenes
                .iter()
                .find(|scene| {
                    let start_frame = scene.get("startFrame").and_then(Value::as_i64).unwrap_or(0);
                    let duration_in_frames = scene
                        .get("durationInFrames")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        .max(1);
                    playhead_frame >= start_frame
                        && playhead_frame < start_frame + duration_in_frames
                })
                .cloned()
        })
        .or_else(|| scenes.first().cloned())
        .unwrap_or(Value::Null);
    let scene_ids_at_playhead = scenes
        .iter()
        .filter(|scene| {
            let start_frame = scene.get("startFrame").and_then(Value::as_i64).unwrap_or(0);
            let duration_in_frames = scene
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(1);
            playhead_frame >= start_frame && playhead_frame < start_frame + duration_in_frames
        })
        .filter_map(|scene| {
            scene
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "composition": {
            "title": composition.get("title").cloned().unwrap_or(Value::Null),
            "entryCompositionId": composition.get("entryCompositionId").cloned().unwrap_or_else(|| json!("RedBoxVideoMotion")),
            "width": composition.get("width").cloned().unwrap_or_else(|| json!(1080)),
            "height": composition.get("height").cloned().unwrap_or_else(|| json!(1920)),
            "fps": composition.get("fps").cloned().unwrap_or_else(|| json!(30)),
            "durationInFrames": composition.get("durationInFrames").cloned().unwrap_or_else(|| json!(90)),
            "renderMode": composition.get("renderMode").cloned().unwrap_or_else(|| json!("motion-layer")),
            "backgroundColor": composition.get("backgroundColor").cloned().unwrap_or(Value::Null),
            "sceneCount": scenes.len(),
            "transitionCount": transitions.len(),
            "render": normalized_remotion_render_config(
                composition.get("render"),
                composition.get("title").and_then(Value::as_str).unwrap_or("RedBox Motion"),
                composition.get("renderMode").and_then(Value::as_str).unwrap_or("motion-layer"),
            )
        },
        "scenes": remotion_scene_summary_items(&composition),
        "transitions": transitions,
        "activeScene": active_scene,
        "assetMetadata": remotion_asset_metadata(&project),
        "selectionMapping": {
            "selectedClipId": runtime_state.as_ref().and_then(|record| record.selected_clip_id.clone()),
            "selectedSceneId": runtime_state.as_ref().and_then(|record| record.selected_scene_id.clone()).or_else(|| active_scene.get("id").and_then(Value::as_str).map(ToString::to_string)),
            "playheadSeconds": playhead_seconds,
            "playheadFrame": playhead_frame,
            "sceneIdsAtPlayhead": scene_ids_at_playhead,
            "activeSceneId": active_scene.get("id").cloned().unwrap_or(Value::Null),
            "activeSceneClipId": active_scene.get("clipId").cloned().unwrap_or(Value::Null),
        }
    }))
}

fn sync_project_transitions_from_remotion_scene(
    project: &mut Value,
    composition: &Value,
) -> Result<(), String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    project_object.insert(
        "transitions".to_string(),
        composition
            .get("transitions")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    Ok(())
}

pub(crate) fn timeline_clip_duration_ms(clip: &Value) -> i64 {
    let asset_kind = timeline_clip_asset_kind(clip);
    let min_duration_ms = min_clip_duration_ms_for_asset_kind(&asset_kind);
    clip.get("metadata")
        .and_then(|value| value.get("durationMs"))
        .and_then(|value| value.as_i64())
        .unwrap_or_else(|| {
            if asset_kind.eq_ignore_ascii_case("image") {
                IMAGE_TIMELINE_CLIP_MS
            } else {
                DEFAULT_TIMELINE_CLIP_MS
            }
        })
        .max(min_duration_ms)
}

fn media_asset_kind(asset: &MediaAssetRecord) -> &'static str {
    let mime_type = asset.mime_type.clone().unwrap_or_default();
    if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type.starts_with("video/") {
        "video"
    } else {
        "image"
    }
}

fn default_track_name_for_asset(asset: &MediaAssetRecord) -> &'static str {
    if media_asset_kind(asset) == "audio" {
        "A1"
    } else {
        "V1"
    }
}

fn timeline_track_kind(track_name: &str) -> &'static str {
    if track_name.starts_with('A') {
        "Audio"
    } else if track_name.starts_with('S')
        || track_name.starts_with('T')
        || track_name.starts_with('C')
    {
        "Subtitle"
    } else {
        "Video"
    }
}

fn build_timeline_clip_from_asset(
    asset: &MediaAssetRecord,
    desired_order: usize,
    duration_ms: Option<i64>,
) -> Value {
    let duration_value = duration_ms
        .filter(|value| *value > 0)
        .unwrap_or_else(|| default_clip_duration_ms_for_asset(asset))
        .max(min_clip_duration_ms_for_asset_kind(media_asset_kind(asset)));
    json!({
        "OTIO_SCHEMA": "Clip.2",
        "name": asset.title.clone().unwrap_or_else(|| asset.id.clone()),
        "source_range": Value::Null,
        "media_references": {
            "DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                "available_range": Value::Null,
                "metadata": {
                    "assetId": asset.id,
                    "mimeType": asset.mime_type
                }
            }
        },
        "active_media_reference_key": "DEFAULT_MEDIA",
        "metadata": {
            "clipId": create_timeline_clip_id(),
            "assetId": asset.id,
            "assetKind": media_asset_kind(asset),
            "source": "media-library",
            "order": desired_order,
            "durationMs": json!(duration_value),
            "trimInMs": 0,
            "trimOutMs": 0,
            "enabled": true,
            "addedAt": now_iso()
        }
    })
}

fn build_timeline_subtitle_clip(
    desired_order: usize,
    text: &str,
    duration_ms: Option<i64>,
) -> Value {
    let duration_value = duration_ms
        .filter(|value| *value > 0)
        .unwrap_or(2000)
        .max(500);
    let clip_name = {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            format!("字幕 {}", desired_order + 1)
        } else {
            trimmed.to_string()
        }
    };
    json!({
        "OTIO_SCHEMA": "Clip.2",
        "name": clip_name,
        "source_range": Value::Null,
        "media_references": {
            "DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": "",
                "available_range": Value::Null,
                "metadata": {
                    "mimeType": "text/plain",
                    "assetId": Value::Null
                }
            }
        },
        "active_media_reference_key": "DEFAULT_MEDIA",
        "metadata": {
            "clipId": create_timeline_clip_id(),
            "assetId": Value::Null,
            "assetKind": "subtitle",
            "source": "subtitle-editor",
            "order": desired_order,
            "durationMs": json!(duration_value),
            "trimInMs": 0,
            "trimOutMs": 0,
            "enabled": true,
            "subtitleStyle": {
                "position": "bottom",
                "fontSize": 34,
                "color": "#ffffff",
                "backgroundColor": "rgba(6, 8, 12, 0.58)",
                "emphasisColor": "#facc15",
                "align": "center",
                "fontWeight": 700,
                "textTransform": "none",
                "letterSpacing": 0,
                "borderRadius": 22,
                "paddingX": 20,
                "paddingY": 12,
                "emphasisWords": []
            },
            "addedAt": now_iso()
        }
    })
}

fn build_timeline_text_clip(desired_order: usize, text: &str, duration_ms: Option<i64>) -> Value {
    let duration_value = duration_ms
        .filter(|value| *value > 0)
        .unwrap_or(2500)
        .max(600);
    let clip_name = {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            format!("文本 {}", desired_order + 1)
        } else {
            trimmed.to_string()
        }
    };
    json!({
        "OTIO_SCHEMA": "Clip.2",
        "name": clip_name,
        "source_range": Value::Null,
        "media_references": {
            "DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": "",
                "available_range": Value::Null,
                "metadata": {
                    "mimeType": "text/plain",
                    "assetId": Value::Null
                }
            }
        },
        "active_media_reference_key": "DEFAULT_MEDIA",
        "metadata": {
            "clipId": create_timeline_clip_id(),
            "assetId": Value::Null,
            "assetKind": "text",
            "source": "text-editor",
            "order": desired_order,
            "durationMs": json!(duration_value),
            "trimInMs": 0,
            "trimOutMs": 0,
            "enabled": true,
            "textStyle": {
                "fontSize": 42,
                "color": "#ffffff",
                "backgroundColor": "rgba(15, 23, 42, 0.42)",
                "align": "center",
                "fontWeight": 700
            },
            "addedAt": now_iso()
        }
    })
}

#[derive(Clone)]
struct SrtSegment {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

fn parse_srt_timestamp(value: &str) -> Option<i64> {
    let normalized = value.trim().replace('.', ",");
    let mut parts = normalized.split(':');
    let hours = parts.next()?.trim().parse::<i64>().ok()?;
    let minutes = parts.next()?.trim().parse::<i64>().ok()?;
    let seconds_and_millis = parts.next()?.trim();
    if parts.next().is_some() {
        return None;
    }
    let (seconds, millis) = seconds_and_millis.split_once(',')?;
    let seconds = seconds.trim().parse::<i64>().ok()?;
    let millis = millis.trim().parse::<i64>().ok()?;
    Some((((hours * 60 + minutes) * 60 + seconds) * 1000) + millis)
}

fn parse_srt_segments(content: &str) -> Vec<SrtSegment> {
    content
        .replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|block| {
            let lines = block
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>();
            if lines.is_empty() {
                return None;
            }
            let timing_line_index = lines.iter().position(|line| line.contains("-->"))?;
            let timing_line = lines.get(timing_line_index)?;
            let (start_raw, end_raw) = timing_line.split_once("-->")?;
            let start_ms = parse_srt_timestamp(start_raw)?;
            let end_ms = parse_srt_timestamp(end_raw)?;
            if end_ms <= start_ms {
                return None;
            }
            let text = lines
                .iter()
                .skip(timing_line_index + 1)
                .map(|line| line.trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            if text.is_empty() {
                return None;
            }
            Some(SrtSegment {
                start_ms,
                end_ms,
                text,
            })
        })
        .collect()
}

fn format_srt_timestamp(value_ms: i64) -> String {
    let safe = value_ms.max(0);
    let hours = safe / 3_600_000;
    let minutes = (safe % 3_600_000) / 60_000;
    let seconds = (safe % 60_000) / 1000;
    let millis = safe % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn serialize_srt_segments(segments: &[SrtSegment]) -> String {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            format!(
                "{}\n{} --> {}\n{}",
                index + 1,
                format_srt_timestamp(segment.start_ms),
                format_srt_timestamp(segment.end_ms),
                segment.text.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn build_fallback_srt_segments(transcript: &str, duration_ms: i64) -> Vec<SrtSegment> {
    let normalized = transcript.trim();
    if normalized.is_empty() {
        return Vec::new();
    }
    vec![SrtSegment {
        start_ms: 0,
        end_ms: duration_ms.max(800),
        text: normalized.to_string(),
    }]
}

fn resolve_project_media_source_path(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    source: &str,
) -> Result<(std::path::PathBuf, bool), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("当前片段缺少素材路径".to_string());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let bytes = run_curl_bytes("GET", trimmed, None, &[], None)?;
        let temp_root = store_root(state)?.join("tmp");
        fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;
        let extension = std::path::Path::new(trimmed)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("media");
        let target = temp_root.join(format!("subtitle-source-{}.{}", now_ms(), extension));
        fs::write(&target, bytes).map_err(|error| error.to_string())?;
        return Ok((target, true));
    }

    let Some(raw_path) = resolve_local_path(trimmed) else {
        return Err("当前片段的素材路径不可解析".to_string());
    };
    let mut candidates = Vec::new();
    if raw_path.is_absolute() {
        candidates.push(raw_path);
    } else {
        candidates.push(raw_path.clone());
        candidates.push(package_path.join(&raw_path));
        if let Ok(media_root_path) = media_root(state) {
            candidates.push(media_root_path.join(&raw_path));
        }
        if let Ok(workspace_root_path) = workspace_root(state) {
            candidates.push(workspace_root_path.join(&raw_path));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|path| (path, false))
        .ok_or_else(|| format!("找不到素材文件: {trimmed}"))
}

fn ensure_editor_track(project: &mut Value, track_id: &str, kind: &str) -> Result<(), String> {
    if project
        .get("tracks")
        .and_then(Value::as_array)
        .map(|tracks| {
            tracks.iter().any(|track| {
                track
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == track_id)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
    {
        return Ok(());
    }
    let order = editor_project_tracks_mut(project)?.len();
    editor_project_tracks_mut(project)?.push(json!({
        "id": track_id,
        "kind": kind,
        "name": track_id,
        "order": order,
        "ui": {
            "hidden": false,
            "locked": false,
            "muted": false,
            "solo": false,
            "collapsed": false,
            "volume": 1.0
        }
    }));
    Ok(())
}

fn editor_default_subtitle_style(
    source_item_id: &str,
    subtitle_file: &str,
    style_patch: Option<&Value>,
) -> Value {
    let mut style = json!({
        "position": "bottom",
        "fontSize": 34,
        "color": "#ffffff",
        "backgroundColor": "rgba(6, 8, 12, 0.58)",
        "emphasisColor": "#facc15",
        "align": "center",
        "fontWeight": 700,
        "textTransform": "none",
        "letterSpacing": 0,
        "borderRadius": 22,
        "paddingX": 20,
        "paddingY": 12,
        "animation": "fade-up",
        "presetId": "classic-bottom",
        "segmentationMode": "punctuationOrPause",
        "linesPerCaption": 1,
        "emphasisWords": [],
        "sourceItemId": source_item_id,
        "subtitleFile": subtitle_file
    });
    if let (Some(target), Some(source)) = (
        style.as_object_mut(),
        style_patch.and_then(Value::as_object),
    ) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    style
}

fn upsert_editor_project_last_subtitle_transcription(
    project: &mut Value,
    source_item_id: &str,
    subtitle_file: &str,
    segment_count: usize,
) -> Result<(), String> {
    let ai = ensure_editor_project_ai_state(project)?;
    ai.insert(
        "lastSubtitleTranscription".to_string(),
        json!({
            "sourceItemId": source_item_id,
            "subtitleFile": subtitle_file,
            "segmentCount": segment_count,
            "updatedAt": now_i64()
        }),
    );
    Ok(())
}

fn editor_project_items_mut(project: &mut Value) -> Result<&mut Vec<Value>, String> {
    project
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Editor project items missing".to_string())
}

fn editor_project_tracks_mut(project: &mut Value) -> Result<&mut Vec<Value>, String> {
    project
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Editor project tracks missing".to_string())
}

fn ensure_motion_track(project: &mut Value) -> Result<(), String> {
    let tracks = editor_project_tracks_mut(project)?;
    if tracks.iter().any(|track| {
        track
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value == "M1")
            .unwrap_or(false)
    }) {
        return Ok(());
    }
    let next_order = tracks
        .iter()
        .filter_map(|track| track.get("order").and_then(|value| value.as_i64()))
        .max()
        .unwrap_or(-1)
        + 1;
    tracks.push(json!({
        "id": "M1",
        "kind": "motion",
        "name": "M1",
        "order": next_order,
        "ui": {
            "hidden": false,
            "locked": false,
            "muted": false,
            "solo": false,
            "collapsed": false,
            "volume": 1.0
        }
    }));
    Ok(())
}

fn editor_project_animation_layers_mut(project: &mut Value) -> Result<&mut Vec<Value>, String> {
    let object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let layers = object
        .entry("animationLayers".to_string())
        .or_insert_with(|| json!([]));
    if !layers.is_array() {
        *layers = json!([]);
    }
    layers
        .as_array_mut()
        .ok_or_else(|| "Editor project animationLayers missing".to_string())
}

fn default_motion_item_from_media(media_item: &Value, project: &Value, index: usize) -> Value {
    let item_id = media_item
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("item");
    let from_ms = media_item
        .get("fromMs")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let duration_ms = media_item
        .get("durationMs")
        .and_then(|value| value.as_i64())
        .unwrap_or(DEFAULT_TIMELINE_CLIP_MS)
        .max(500);
    let asset_id = media_item
        .get("assetId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let asset_title = project
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == asset_id)
                    .unwrap_or(false)
            })
        })
        .and_then(|asset| asset.get("title").and_then(|value| value.as_str()))
        .unwrap_or("镜头");
    let template_id = match index % 5 {
        0 => "slow-zoom-in",
        1 => "pan-left",
        2 => "pan-right",
        3 => "slide-up",
        _ => "slow-zoom-out",
    };
    json!({
        "id": format!("motion:{item_id}"),
        "type": "motion",
        "trackId": "M1",
        "bindItemId": item_id,
        "fromMs": from_ms,
        "durationMs": duration_ms,
        "templateId": template_id,
        "props": {
            "overlayTitle": asset_title,
            "overlayBody": Value::Null,
            "overlays": []
        },
        "enabled": true
    })
}

fn normalize_motion_item(raw: &Value, fallback: &Value) -> Value {
    json!({
        "id": raw.get("id").cloned().unwrap_or_else(|| fallback.get("id").cloned().unwrap_or_else(|| json!(make_id("motion-item")))),
        "type": "motion",
        "trackId": "M1",
        "bindItemId": raw.get("bindItemId").cloned().or_else(|| fallback.get("bindItemId").cloned()).unwrap_or(Value::Null),
        "fromMs": raw.get("fromMs").cloned().or_else(|| fallback.get("fromMs").cloned()).unwrap_or(json!(0)),
        "durationMs": raw.get("durationMs").cloned().or_else(|| fallback.get("durationMs").cloned()).unwrap_or(json!(2000)),
        "templateId": raw.get("templateId").cloned().or_else(|| fallback.get("templateId").cloned()).unwrap_or(json!("static")),
        "props": raw.get("props").cloned().or_else(|| fallback.get("props").cloned()).unwrap_or_else(|| json!({})),
        "enabled": raw.get("enabled").cloned().or_else(|| fallback.get("enabled").cloned()).unwrap_or(json!(true))
    })
}

fn sync_project_motion_items_from_remotion_scene(
    project: &mut Value,
    composition: &Value,
) -> Result<(), String> {
    ensure_motion_track(project)?;
    let fps = composition
        .get("fps")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let scenes = composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let animation_layers = animation_layers_from_remotion_scene(composition, fps);
    let media_lookup = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.to_string();
            Some((id, item))
        })
        .collect::<BTreeMap<_, _>>();

    editor_project_animation_layers_mut(project)?.clear();
    editor_project_animation_layers_mut(project)?.extend(animation_layers.clone());

    editor_project_items_mut(project)?
        .retain(|item| item.get("type").and_then(Value::as_str) != Some("motion"));

    let motion_items = scenes
        .iter()
        .map(|scene| {
            let bind_item_id = scene
                .get("clipId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let fallback_media = media_lookup.get(&bind_item_id);
            let from_ms = fallback_media
                .and_then(|item| item.get("fromMs").and_then(Value::as_i64))
                .unwrap_or_else(|| {
                    ((scene
                        .get("startFrame")
                        .and_then(Value::as_i64)
                        .unwrap_or(0) as f64
                        / fps as f64)
                        * 1000.0)
                        .round() as i64
                })
                .max(0);
            let duration_ms = ((scene
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .unwrap_or(1) as f64
                / fps as f64)
                * 1000.0)
                .round() as i64;
            json!({
                "id": scene.get("id").cloned().unwrap_or_else(|| json!(make_id("motion-item"))),
                "type": "motion",
                "trackId": "M1",
                "bindItemId": if bind_item_id.is_empty() { Value::Null } else { json!(bind_item_id) },
                "fromMs": from_ms,
                "durationMs": duration_ms.max(300),
                "templateId": scene.get("motionPreset").cloned().unwrap_or_else(|| json!("static")),
                "props": {
                    "overlayTitle": scene.get("overlayTitle").cloned().unwrap_or(Value::Null),
                    "overlayBody": scene.get("overlayBody").cloned().unwrap_or(Value::Null),
                    "overlays": scene.get("overlays").cloned().unwrap_or_else(|| json!([])),
                    "entities": scene.get("entities").cloned().unwrap_or_else(|| json!([]))
                },
                "enabled": true
            })
        })
        .collect::<Vec<_>>();

    editor_project_items_mut(project)?.extend(motion_items);
    Ok(())
}

fn generate_motion_items_for_project(
    state: &State<'_, AppState>,
    project: &Value,
    instructions: &str,
    selected_item_ids: &[String],
    model_config: Option<&Value>,
) -> Result<(Vec<Value>, String), String> {
    let media_items = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.get("type").and_then(|value| value.as_str()) == Some("media"))
        .filter(|item| {
            if selected_item_ids.is_empty() {
                return true;
            }
            item.get("id")
                .and_then(|value| value.as_str())
                .map(|value| selected_item_ids.iter().any(|selected| selected == value))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    if media_items.is_empty() {
        return Err("当前工程没有可生成动画的媒体片段".to_string());
    }

    let fallback_items = media_items
        .iter()
        .enumerate()
        .map(|(index, item)| default_motion_item_from_media(item, project, index))
        .collect::<Vec<_>>();
    let user_prompt = format!(
        "请基于当前脚本和媒体片段，生成 motion item 列表。\n\
只输出 JSON，不要输出解释。\n\
结构：{{\"brief\":string,\"items\":[{{\"bindItemId\":string,\"fromMs\":number,\"durationMs\":number,\"templateId\":\"static|slow-zoom-in|slow-zoom-out|pan-left|pan-right|slide-up|slide-down\",\"props\":{{\"overlayTitle\":string|null,\"overlayBody\":string|null,\"overlays\":[{{\"id\":string,\"text\":string,\"startFrame\":number,\"durationInFrames\":number,\"position\":\"top|center|bottom\",\"animation\":\"fade-up|fade-in|slide-left|pop\",\"fontSize\":number}}]}}}}]}}\n\
要求：\n\
1. 每个 item 必须绑定现有 bindItemId。\n\
2. fromMs / durationMs 要落在绑定片段范围内或与其基本一致。\n\
3. 模板只允许 static, slow-zoom-in, slow-zoom-out, pan-left, pan-right, slide-up, slide-down。\n\
4. 适合短视频节奏，前段更强，后段更稳。\n\
5. 如果你不确定，就保守生成 overlayTitle，不要编造复杂文案。\n\
\n\
脚本：{}\n\
目标片段：{}",
        instructions,
        serde_json::to_string(&media_items).map_err(|error| error.to_string())?
    );
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let raw = generate_structured_response_with_settings(
        &settings_snapshot,
        model_config,
        "你是 RedClaw 的短视频动画导演。只输出严格 JSON。",
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let normalized_items = parsed
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    normalize_motion_item(
                        item,
                        fallback_items.get(index).unwrap_or(&fallback_items[0]),
                    )
                })
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .unwrap_or(fallback_items);
    let brief = parsed
        .get("brief")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw);
    Ok((normalized_items, brief))
}

fn normalize_editor_ai_command(raw: &Value) -> Option<Value> {
    let command_type = raw.get("type").and_then(|value| value.as_str())?;
    match command_type {
        "upsert_assets" => Some(json!({
            "type": "upsert_assets",
            "assets": raw.get("assets").cloned().unwrap_or_else(|| json!([]))
        })),
        "add_track" => Some(json!({
            "type": "add_track",
            "kind": raw.get("kind").cloned().unwrap_or(json!("video")),
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null)
        })),
        "delete_tracks" => Some(json!({
            "type": "delete_tracks",
            "trackIds": raw.get("trackIds").cloned().unwrap_or_else(|| json!([]))
        })),
        "update_item" => Some(json!({
            "type": "update_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "delete_item" => Some(json!({
            "type": "delete_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null)
        })),
        "split_item" => Some(json!({
            "type": "split_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "splitMs": raw.get("splitMs").cloned().unwrap_or(json!(0))
        })),
        "move_items" => Some(json!({
            "type": "move_items",
            "itemIds": raw.get("itemIds").cloned().unwrap_or_else(|| json!([])),
            "deltaMs": raw.get("deltaMs").cloned().unwrap_or(json!(0)),
            "targetTrackId": raw.get("targetTrackId").cloned().unwrap_or(Value::Null)
        })),
        "retime_item" => Some(json!({
            "type": "retime_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "fromMs": raw.get("fromMs").cloned().unwrap_or(Value::Null),
            "durationMs": raw.get("durationMs").cloned().unwrap_or(Value::Null)
        })),
        "set_track_ui" => Some(json!({
            "type": "set_track_ui",
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "reorder_tracks" => Some(json!({
            "type": "reorder_tracks",
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null),
            "direction": raw.get("direction").cloned().unwrap_or(json!("up"))
        })),
        "update_stage_item" => Some(json!({
            "type": "update_stage_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or(Value::Null),
            "visible": raw.get("visible").cloned().unwrap_or(Value::Null),
            "locked": raw.get("locked").cloned().unwrap_or(Value::Null),
            "groupId": raw.get("groupId").cloned().unwrap_or(Value::Null)
        })),
        "animation_layer_create" => Some(json!({
            "type": "animation_layer_create",
            "layer": raw.get("layer").cloned().unwrap_or_else(|| json!({}))
        })),
        "animation_layer_update" => Some(json!({
            "type": "animation_layer_update",
            "layerId": raw.get("layerId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "animation_layer_delete" => Some(json!({
            "type": "animation_layer_delete",
            "layerId": raw.get("layerId").cloned().unwrap_or(Value::Null)
        })),
        _ => None,
    }
}

fn generate_editor_commands_for_project(
    state: &State<'_, AppState>,
    project: &Value,
    instructions: &str,
    model_config: Option<&Value>,
) -> Result<(Vec<Value>, String), String> {
    let user_prompt = format!(
        "把用户的编辑要求转换成结构化命令 JSON。\n\
只输出 JSON，不要输出解释。\n\
允许命令：add_track, delete_tracks, update_item, delete_item, split_item, move_items, retime_item, set_track_ui, reorder_tracks, update_stage_item。\n\
输出结构：{{\"brief\":string,\"commands\":[...]}}\n\
规则：\n\
1. 只能引用现有 itemId / trackId。\n\
2. 不要生成 motion item；motion 相关生成单独走 generate-motion-items。\n\
3. patch 只包含必要字段。\n\
4. 如果用户指令模糊，给出最保守的命令。\n\
\n\
当前工程 JSON：{}\n\
用户要求：{}",
        serde_json::to_string(project).map_err(|error| error.to_string())?,
        instructions
    );
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let raw = generate_structured_response_with_settings(
        &settings_snapshot,
        model_config,
        "你是 RedClaw 的视频编辑命令规划器。只输出严格 JSON。",
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let commands = parsed
        .get("commands")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_editor_ai_command)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let brief = parsed
        .get("brief")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw);
    Ok((commands, brief))
}

fn apply_editor_commands(project: &mut Value, commands: &[Value]) -> Result<(), String> {
    ensure_motion_track(project)?;
    for command in commands {
        let command_type = command
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match command_type {
            "upsert_assets" => {
                let assets = command
                    .get("assets")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let current_assets = project
                    .get_mut("assets")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project assets missing".to_string())?;
                for asset in assets {
                    let asset_id = asset
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if asset_id.is_empty() {
                        continue;
                    }
                    if let Some(existing) = current_assets.iter_mut().find(|item| {
                        item.get("id").and_then(|value| value.as_str()) == Some(asset_id)
                    }) {
                        *existing = asset.clone();
                    } else {
                        current_assets.push(asset.clone());
                    }
                }
            }
            "add_track" => {
                let kind = command
                    .get("kind")
                    .and_then(|value| value.as_str())
                    .unwrap_or("video");
                let prefix = match kind {
                    "audio" => "A",
                    "subtitle" => "S",
                    "text" => "T",
                    "motion" => "M",
                    _ => "V",
                };
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        let tracks = project
                            .get("tracks")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let max_index = tracks
                            .iter()
                            .filter_map(|track| {
                                let id = track
                                    .get("id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                if !id.starts_with(prefix) {
                                    return None;
                                }
                                id[1..].parse::<i64>().ok()
                            })
                            .max()
                            .unwrap_or(0);
                        format!("{prefix}{}", max_index + 1)
                    });
                let order = editor_project_tracks_mut(project)?.len();
                editor_project_tracks_mut(project)?.push(json!({
                    "id": track_id,
                    "kind": kind,
                    "name": track_id,
                    "order": order,
                    "ui": {
                        "hidden": false,
                        "locked": false,
                        "muted": false,
                        "solo": false,
                        "collapsed": false,
                        "volume": 1.0
                    }
                }));
            }
            "delete_tracks" => {
                let track_ids = command
                    .get("trackIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_tracks_mut(project)?.retain(|track| {
                    let track_id = track
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !track_ids.iter().any(|value| value == track_id)
                });
                editor_project_items_mut(project)?.retain(|item| {
                    let track_id = item
                        .get("trackId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !track_ids.iter().any(|value| value == track_id)
                });
                for (order, track) in editor_project_tracks_mut(project)?.iter_mut().enumerate() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("order".to_string(), json!(order));
                    }
                }
            }
            "add_item" => {
                if let Some(item) = command.get("item") {
                    editor_project_items_mut(project)?.push(item.clone());
                }
            }
            "update_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(item) = editor_project_items_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(item_id))
                {
                    if let (Some(target), Some(source)) = (item.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            "delete_item" => {
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![command.get("itemId").cloned().unwrap_or(Value::Null)]);
                let normalized = item_ids
                    .iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !normalized.iter().any(|value| value == item_id)
                });
            }
            "delete_items" => {
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !item_ids.iter().any(|value| value == item_id)
                });
            }
            "split_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let split_ms = command
                    .get("splitMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let items = editor_project_items_mut(project)?;
                let Some(index) = items.iter().position(|item| {
                    item.get("id").and_then(|value| value.as_str()) == Some(item_id)
                }) else {
                    continue;
                };
                let mut original = items[index].clone();
                let from_ms = original
                    .get("fromMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let duration_ms = original
                    .get("durationMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                if split_ms <= from_ms || split_ms >= from_ms + duration_ms {
                    continue;
                }
                let first_duration = split_ms - from_ms;
                let second_duration = duration_ms - first_duration;
                if let Some(object) = original.as_object_mut() {
                    object.insert("durationMs".to_string(), json!(first_duration));
                }
                items[index] = original;
                let mut second = items[index].clone();
                if let Some(object) = second.as_object_mut() {
                    object.insert("id".to_string(), json!(make_id("item")));
                    object.insert("fromMs".to_string(), json!(split_ms));
                    object.insert("durationMs".to_string(), json!(second_duration));
                    if let Some(trim_in_ms) =
                        object.get("trimInMs").and_then(|value| value.as_i64())
                    {
                        object.insert("trimInMs".to_string(), json!(trim_in_ms + first_duration));
                    }
                }
                items.insert(index + 1, second);
            }
            "move_items" => {
                let delta_ms = command
                    .get("deltaMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let target_track_id = command
                    .get("targetTrackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string);
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                for item in editor_project_items_mut(project)?.iter_mut() {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if !item_ids.iter().any(|value| value == item_id) {
                        continue;
                    }
                    if let Some(object) = item.as_object_mut() {
                        let from_ms = object
                            .get("fromMs")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(0);
                        object.insert("fromMs".to_string(), json!((from_ms + delta_ms).max(0)));
                        if let Some(track_id) = target_track_id.as_ref() {
                            object.insert("trackId".to_string(), json!(track_id));
                        }
                    }
                }
            }
            "retime_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if let Some(item) = editor_project_items_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(item_id))
                {
                    if let Some(object) = item.as_object_mut() {
                        if let Some(from_ms) = command.get("fromMs") {
                            object.insert("fromMs".to_string(), from_ms.clone());
                        }
                        if let Some(duration_ms) = command.get("durationMs") {
                            object.insert("durationMs".to_string(), duration_ms.clone());
                        }
                    }
                }
            }
            "set_track_ui" => {
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(track) = editor_project_tracks_mut(project)?
                    .iter_mut()
                    .find(|track| {
                        track.get("id").and_then(|value| value.as_str()) == Some(track_id)
                    })
                {
                    let current_ui = track.get("ui").cloned().unwrap_or_else(|| json!({}));
                    let mut next_ui = current_ui;
                    if let (Some(target), Some(source)) =
                        (next_ui.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                    if let Some(object) = track.as_object_mut() {
                        object.insert("ui".to_string(), next_ui);
                    }
                }
            }
            "reorder_tracks" => {
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let direction = command
                    .get("direction")
                    .and_then(|value| value.as_str())
                    .unwrap_or("up");
                let tracks = editor_project_tracks_mut(project)?;
                let Some(index) = tracks.iter().position(|track| {
                    track.get("id").and_then(|value| value.as_str()) == Some(track_id)
                }) else {
                    continue;
                };
                let target_index = if direction == "down" {
                    (index + 1).min(tracks.len().saturating_sub(1))
                } else {
                    index.saturating_sub(1)
                };
                let track = tracks.remove(index);
                tracks.insert(target_index, track);
                for (order, track) in tracks.iter_mut().enumerate() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("order".to_string(), json!(order));
                    }
                }
            }
            "update_stage_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let stage = project
                    .get_mut("stage")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| "Editor project stage missing".to_string())?;
                if let Some(transform_patch) = command.get("patch").and_then(Value::as_object) {
                    let transforms = stage
                        .entry("itemTransforms".to_string())
                        .or_insert_with(|| json!({}));
                    let entry = transforms
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemTransforms missing".to_string())?
                        .entry(item_id.to_string())
                        .or_insert_with(|| json!({}));
                    if let (Some(target), Some(source)) =
                        (entry.as_object_mut(), Some(transform_patch))
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
                if let Some(visible) = command.get("visible") {
                    stage
                        .entry("itemVisibility".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemVisibility missing".to_string())?
                        .insert(item_id.to_string(), visible.clone());
                }
                if let Some(locked) = command.get("locked") {
                    stage
                        .entry("itemLocks".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemLocks missing".to_string())?
                        .insert(item_id.to_string(), locked.clone());
                }
                if let Some(group_id) = command.get("groupId") {
                    stage
                        .entry("itemGroups".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemGroups missing".to_string())?
                        .insert(item_id.to_string(), group_id.clone());
                }
            }
            "animation_layer_create" => {
                let layer = command.get("layer").cloned().unwrap_or_else(|| json!({}));
                editor_project_animation_layers_mut(project)?.push(layer);
            }
            "animation_layer_update" => {
                let layer_id = command.get("layerId").and_then(Value::as_str).unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(layer) = editor_project_animation_layers_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(layer_id))
                {
                    if let (Some(target), Some(source)) = (layer.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            "animation_layer_delete" => {
                let layer_id = command.get("layerId").and_then(Value::as_str).unwrap_or("");
                editor_project_animation_layers_mut(project)?
                    .retain(|item| item.get("id").and_then(Value::as_str) != Some(layer_id));
            }
            _ => {}
        }
    }
    normalize_editor_project_timeline(project)?;
    Ok(())
}

fn normalize_editor_project_timeline(project: &mut Value) -> Result<(), String> {
    let tracks = project
        .get("tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut ordered_tracks = tracks;
    ordered_tracks.sort_by_key(|track| {
        track
            .get("order")
            .and_then(|value| value.as_i64())
            .unwrap_or(0)
    });
    let main_video_track_id = ordered_tracks
        .iter()
        .find(|track| track.get("kind").and_then(|value| value.as_str()) == Some("video"))
        .and_then(|track| track.get("id").and_then(|value| value.as_str()))
        .map(ToString::to_string);
    let motion_track_ids = ordered_tracks
        .iter()
        .filter(|track| track.get("kind").and_then(Value::as_str) == Some("motion"))
        .filter_map(|track| {
            track
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    if !motion_track_ids.is_empty() {
        let layers = editor_project_animation_layers_mut(project)?;
        let original_order = layers
            .iter()
            .enumerate()
            .filter_map(|(index, layer)| {
                layer
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_string(), index))
            })
            .collect::<BTreeMap<_, _>>();
        let mut rebuilt_layers = Vec::new();
        for track_id in &motion_track_ids {
            let mut track_layers = layers
                .iter()
                .filter(|layer| {
                    layer.get("trackId").and_then(Value::as_str) == Some(track_id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            track_layers.sort_by(|left, right| {
                let left_from = left.get("fromMs").and_then(Value::as_i64).unwrap_or(0);
                let right_from = right.get("fromMs").and_then(Value::as_i64).unwrap_or(0);
                if left_from != right_from {
                    return left_from.cmp(&right_from);
                }
                let left_id = left.get("id").and_then(Value::as_str).unwrap_or("");
                let right_id = right.get("id").and_then(Value::as_str).unwrap_or("");
                original_order
                    .get(left_id)
                    .unwrap_or(&0usize)
                    .cmp(original_order.get(right_id).unwrap_or(&0usize))
            });
            let mut cursor = 0_i64;
            for (z_index, mut layer) in track_layers.into_iter().enumerate() {
                let from_ms = layer
                    .get("fromMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(cursor);
                let duration_ms = layer
                    .get("durationMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(300);
                if let Some(object) = layer.as_object_mut() {
                    object.insert("trackId".to_string(), json!(track_id));
                    object.insert("fromMs".to_string(), json!(from_ms));
                    object.insert("durationMs".to_string(), json!(duration_ms));
                    object.insert("zIndex".to_string(), json!(z_index));
                }
                cursor = from_ms + duration_ms;
                rebuilt_layers.push(layer);
            }
        }
        let known_motion_tracks = motion_track_ids.iter().cloned().collect::<BTreeSet<_>>();
        rebuilt_layers.extend(
            layers
                .iter()
                .filter(|layer| {
                    layer
                        .get("trackId")
                        .and_then(Value::as_str)
                        .map(|track_id| !known_motion_tracks.contains(track_id))
                        .unwrap_or(true)
                })
                .cloned(),
        );
        *layers = rebuilt_layers;
    }
    let projected_motion_items = projected_motion_items_from_animation_layers(project);
    let items = editor_project_items_mut(project)?;
    items.retain(|item| item.get("type").and_then(Value::as_str) != Some("motion"));
    items.extend(projected_motion_items);
    let items = editor_project_items_mut(project)?;
    let original_order = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            item.get("id")
                .and_then(|value| value.as_str())
                .map(|id| (id.to_string(), index))
        })
        .collect::<BTreeMap<_, _>>();
    let mut rebuilt = Vec::new();
    for track in &ordered_tracks {
        let Some(track_id) = track.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let mut track_items = items
            .iter()
            .filter(|item| item.get("trackId").and_then(|value| value.as_str()) == Some(track_id))
            .cloned()
            .collect::<Vec<_>>();
        track_items.sort_by(|left, right| {
            let left_from = left
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let right_from = right
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            if left_from != right_from {
                return left_from.cmp(&right_from);
            }
            let left_id = left
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let right_id = right
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            original_order
                .get(left_id)
                .unwrap_or(&0usize)
                .cmp(original_order.get(right_id).unwrap_or(&0usize))
        });
        let mut cursor = 0_i64;
        for mut item in track_items {
            let from_ms = item
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let duration_ms = item
                .get("durationMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let next_from_ms = if main_video_track_id.as_deref() == Some(track_id) {
                cursor
            } else {
                from_ms.max(cursor)
            };
            if let Some(object) = item.as_object_mut() {
                object.insert("fromMs".to_string(), json!(next_from_ms));
            }
            cursor = next_from_ms + duration_ms.max(0);
            rebuilt.push(item);
        }
    }
    let known_track_ids = ordered_tracks
        .iter()
        .filter_map(|track| {
            track
                .get("id")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        })
        .collect::<BTreeSet<_>>();
    let remainder = items
        .iter()
        .filter(|item| {
            item.get("trackId")
                .and_then(|value| value.as_str())
                .map(|track_id| !known_track_ids.contains(track_id))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    rebuilt.extend(remainder);
    *items = rebuilt;
    Ok(())
}

fn ensure_package_asset_entry(
    package_path: &std::path::Path,
    asset: &MediaAssetRecord,
) -> Result<(), String> {
    let mut assets = read_json_value_or(&package_assets_path(package_path), json!({ "items": [] }));
    let Some(items) = assets.get_mut("items").and_then(Value::as_array_mut) else {
        return Err("Package assets items missing".to_string());
    };
    let next_entry = json!({
        "assetId": asset.id,
        "title": asset.title.clone(),
        "mimeType": asset.mime_type.clone(),
        "relativePath": asset.relative_path.clone(),
        "absolutePath": asset.absolute_path.clone(),
        "mediaPath": asset.absolute_path.clone().or(asset.relative_path.clone()),
        "previewUrl": asset.preview_url.clone(),
        "boundManuscriptPath": asset.bound_manuscript_path.clone(),
        "exists": asset.exists,
        "updatedAt": asset.updated_at.clone(),
    });
    if let Some(existing) = items.iter_mut().find(|item| {
        item.get("assetId")
            .and_then(|value| value.as_str())
            .map(|value| value == asset.id)
            .unwrap_or(false)
    }) {
        *existing = next_entry;
    } else {
        items.push(next_entry);
    }
    write_json_value(&package_assets_path(package_path), &assets)?;
    let editor_project_path = package_editor_project_path(package_path);
    if editor_project_path.exists() {
        let mut editor_project = read_json_value_or(&editor_project_path, json!({}));
        if let Some(editor_assets) = editor_project
            .get_mut("assets")
            .and_then(Value::as_array_mut)
        {
            let editor_asset = json!({
                "id": asset.id,
                "kind": infer_editor_asset_kind(
                    asset.mime_type.as_deref(),
                    asset.absolute_path.as_deref().or(asset.relative_path.as_deref())
                ),
                "title": asset.title.clone().unwrap_or_else(|| asset.id.clone()),
                "src": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                "mimeType": asset.mime_type.clone(),
                "durationMs": Value::Null,
                "metadata": {
                    "relativePath": asset.relative_path.clone(),
                    "absolutePath": asset.absolute_path.clone(),
                    "previewUrl": asset.preview_url.clone(),
                    "boundManuscriptPath": asset.bound_manuscript_path.clone(),
                    "exists": asset.exists
                }
            });
            if let Some(existing) = editor_assets.iter_mut().find(|item| {
                item.get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == asset.id)
                    .unwrap_or(false)
            }) {
                *existing = editor_asset;
            } else {
                editor_assets.push(editor_asset);
            }
            write_json_value(&editor_project_path, &editor_project)?;
        }
    }
    Ok(())
}

fn split_timeline_clip_value(clip: &Value, clip_id: &str, split_ratio: f64) -> (Value, Value) {
    let min_duration = min_clip_duration_ms_for_asset_kind(&timeline_clip_asset_kind(clip));
    let current_duration = timeline_clip_duration_ms(clip);
    let first_duration = ((current_duration as f64) * split_ratio).round() as i64;
    let first_duration = first_duration.max(min_duration);
    let second_duration = (current_duration - first_duration).max(min_duration);

    let mut first_clip = clip.clone();
    if let Some(object) = first_clip
        .get_mut("metadata")
        .and_then(Value::as_object_mut)
    {
        object.insert("clipId".to_string(), json!(clip_id));
        object.insert("durationMs".to_string(), json!(first_duration));
    }

    let mut second_clip = clip.clone();
    if let Some(object) = second_clip
        .get_mut("metadata")
        .and_then(Value::as_object_mut)
    {
        let trim_in = object
            .get("trimInMs")
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        object.insert("clipId".to_string(), json!(create_timeline_clip_id()));
        object.insert("durationMs".to_string(), json!(second_duration));
        object.insert("trimInMs".to_string(), json!(trim_in + first_duration));
    }

    (first_clip, second_clip)
}

pub fn handle_manuscripts_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !channel.starts_with("manuscripts:") {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "manuscripts:list" => {
                let root = manuscripts_root(state)?;
                serde_json::to_value(list_tree(&root, &root)?).map_err(|error| error.to_string())
            }
            "manuscripts:read" => {
                let relative = payload_value_as_string(&payload).unwrap_or_default();
                let path = resolve_manuscript_path(state, &relative)?;
                if path.is_dir()
                    && is_manuscript_package_name(
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    let file_name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("");
                    let manifest = read_json_value_or(&package_manifest_path(&path), json!({}));
                    let content =
                        fs::read_to_string(package_entry_path(&path, file_name, Some(&manifest)))
                            .unwrap_or_default();
                    return Ok(json!({
                        "content": content,
                        "metadata": manifest
                    }));
                }
                let content = fs::read_to_string(&path).unwrap_or_default();
                Ok(json!({
                    "content": content,
                    "metadata": {
                        "id": slug_from_relative_path(&relative),
                        "title": title_from_relative_path(&relative),
                        "draftType": get_draft_type_from_file_name(&relative),
                    }
                }))
            }
            "manuscripts:save" => {
                let target = payload_string(&payload, "path").unwrap_or_default();
                let content = payload_string(&payload, "content").unwrap_or_default();
                let path = resolve_manuscript_path(state, &target)?;
                if path.is_dir()
                    && is_manuscript_package_name(
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    let file_name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("");
                    let (next_state, script_state) = persist_package_script_body(
                        &path,
                        file_name,
                        &content,
                        payload_field(&payload, "metadata").and_then(Value::as_object),
                        "user",
                    )?;
                    return Ok(json!({
                        "success": true,
                        "state": next_state,
                        "script": script_state
                    }));
                }
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(&path, content).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true }))
            }
            "manuscripts:create-folder" => {
                let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
                let name =
                    payload_string(&payload, "name").unwrap_or_else(|| "New Folder".to_string());
                let relative = join_relative(&parent_path, &name);
                let path = resolve_manuscript_path(state, &relative)?;
                fs::create_dir_all(&path).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
            }
            "manuscripts:create-file" => {
                let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
                let name =
                    payload_string(&payload, "name").unwrap_or_else(|| "Untitled.md".to_string());
                let content = payload_string(&payload, "content").unwrap_or_default();
                let fallback_extension = if is_manuscript_package_name(&name) {
                    ""
                } else {
                    ".md"
                };
                let relative = normalize_relative_path(&join_relative(
                    &parent_path,
                    &ensure_manuscript_file_name(&name, fallback_extension),
                ));
                let path = resolve_manuscript_path(state, &relative)?;
                if is_manuscript_package_name(&relative) {
                    let title = payload_string(&payload, "title")
                        .unwrap_or_else(|| title_from_relative_path(&relative));
                    create_manuscript_package(&path, &content, &relative, &title)?;
                } else {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                    }
                    fs::write(&path, content).map_err(|error| error.to_string())?;
                }
                Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
            }
            "manuscripts:upgrade-to-package" => {
                let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
                let target_kind =
                    payload_string(&payload, "targetKind").unwrap_or_else(|| "article".to_string());
                let target_extension = if target_kind == "post" {
                    POST_DRAFT_EXTENSION
                } else {
                    ARTICLE_DRAFT_EXTENSION
                };
                let new_path =
                    upgrade_markdown_manuscript_to_package(state, &source_path, target_extension)?;
                Ok(json!({ "success": true, "newPath": new_path }))
            }
            "manuscripts:delete" => {
                let relative = payload_value_as_string(&payload).unwrap_or_default();
                let path = resolve_manuscript_path(state, &relative)?;
                if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
                } else if path.exists() {
                    fs::remove_file(&path).map_err(|error| error.to_string())?;
                }
                Ok(json!({ "success": true }))
            }
            "manuscripts:rename" => {
                let old_path = payload_string(&payload, "oldPath").unwrap_or_default();
                let new_name = payload_string(&payload, "newName").unwrap_or_default();
                if new_name.is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少新名称" }));
                }
                let source = resolve_manuscript_path(state, &old_path)?;
                let source_name = source
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                let parent_rel = normalize_relative_path(
                    old_path
                        .rsplit_once('/')
                        .map(|(parent, _)| parent)
                        .unwrap_or(""),
                );
                let mut target_relative = join_relative(&parent_rel, &new_name);
                if !target_relative.contains('.') {
                    if source_name.ends_with(ARTICLE_DRAFT_EXTENSION) {
                        target_relative = format!(
                            "{}{}",
                            normalize_relative_path(&target_relative),
                            ARTICLE_DRAFT_EXTENSION
                        );
                    } else if source_name.ends_with(POST_DRAFT_EXTENSION) {
                        target_relative = format!(
                            "{}{}",
                            normalize_relative_path(&target_relative),
                            POST_DRAFT_EXTENSION
                        );
                    } else if source_name.ends_with(VIDEO_DRAFT_EXTENSION) {
                        target_relative = format!(
                            "{}{}",
                            normalize_relative_path(&target_relative),
                            VIDEO_DRAFT_EXTENSION
                        );
                    } else if source_name.ends_with(AUDIO_DRAFT_EXTENSION) {
                        target_relative = format!(
                            "{}{}",
                            normalize_relative_path(&target_relative),
                            AUDIO_DRAFT_EXTENSION
                        );
                    } else if source.is_file() {
                        target_relative = ensure_markdown_extension(&target_relative);
                    } else {
                        target_relative = normalize_relative_path(&target_relative);
                    }
                } else if source.is_file() && !source_name.contains('.') {
                    target_relative = ensure_markdown_extension(&target_relative);
                } else {
                    target_relative = normalize_relative_path(&target_relative);
                }
                let target = resolve_manuscript_path(state, &target_relative)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::rename(&source, &target).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "newPath": target_relative }))
            }
            "manuscripts:move" => {
                let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
                let target_dir = payload_string(&payload, "targetDir").unwrap_or_default();
                let source = resolve_manuscript_path(state, &source_path)?;
                let file_name = source
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "Invalid manuscript source".to_string())?;
                let target_relative =
                    normalize_relative_path(&join_relative(&target_dir, file_name));
                let target = resolve_manuscript_path(state, &target_relative)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::rename(&source, &target).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "newPath": target_relative }))
            }
            "manuscripts:get-package-state" => {
                let file_path = payload_value_as_string(&payload).unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir()
                    || !is_manuscript_package_name(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:get-editor-project" => {
                let file_path = payload_value_as_string(&payload)
                    .or_else(|| payload_string(&payload, "filePath"))
                    .unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                Ok(json!({
                    "success": true,
                    "project": ensure_editor_project(&full_path)?,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:save-editor-project" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let mut project = payload_field(&payload, "project")
                    .cloned()
                    .unwrap_or(Value::Null);
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let existing_project = ensure_editor_project(&full_path)?;
                let next_script_body = project
                    .pointer("/script/body")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string);
                let existing_script_body = existing_project
                    .pointer("/script/body")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string);
                if let Some(script_body) = next_script_body.as_deref() {
                    if existing_script_body.as_deref() != Some(script_body) {
                        mark_editor_project_script_pending(&mut project, script_body, "user")?;
                    } else {
                        let _ = ensure_editor_project_ai_state(&mut project)?;
                    }
                }
                let _ = hydrate_editor_project_motion_from_remotion(&mut project, &full_path)?;
                if existing_project != project {
                    push_editor_project_undo_snapshot(state, &file_path, &existing_project)?;
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                if let Some(script_body) = next_script_body.as_deref() {
                    let manifest =
                        read_json_value_or(package_manifest_path(&full_path).as_path(), json!({}));
                    let entry_path = package_entry_path(&full_path, &file_path, Some(&manifest));
                    write_text_file(&entry_path, script_body)?;
                }
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:duplicate-editor-project-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                if file_path.is_empty() || clip_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and clipId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let items = project
                    .pointer_mut("/items")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project items missing".to_string())?;
                let Some(source_item) = items
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(clip_id.as_str()))
                    .cloned()
                else {
                    return Ok(
                        json!({ "success": false, "error": "Clip not found in editor project" }),
                    );
                };
                let mut duplicate = source_item;
                let from_ms = payload_field(&payload, "fromMs")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(|| {
                        duplicate.get("fromMs").and_then(Value::as_i64).unwrap_or(0)
                            + duplicate
                                .get("durationMs")
                                .and_then(Value::as_i64)
                                .unwrap_or(0)
                    });
                if let Some(object) = duplicate.as_object_mut() {
                    object.insert("id".to_string(), json!(create_timeline_clip_id()));
                    object.insert("fromMs".to_string(), json!(from_ms.max(0)));
                    if let Some(track_id) = payload_string(&payload, "trackId") {
                        object.insert("trackId".to_string(), json!(track_id));
                    }
                }
                items.push(duplicate);
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:replace-editor-project-clip-asset" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
                if file_path.is_empty() || clip_id.is_empty() || asset_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath, clipId, and assetId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let items = project
                    .pointer_mut("/items")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project items missing".to_string())?;
                let Some(target_item) = items
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(clip_id.as_str()))
                else {
                    return Ok(
                        json!({ "success": false, "error": "Clip not found in editor project" }),
                    );
                };
                if let Some(object) = target_item.as_object_mut() {
                    object.insert("assetId".to_string(), json!(asset_id));
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:add-editor-project-marker" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let markers = project
                    .as_object_mut()
                    .ok_or_else(|| "Editor project malformed".to_string())?
                    .entry("markers".to_string())
                    .or_insert_with(|| json!([]));
                let markers = markers
                    .as_array_mut()
                    .ok_or_else(|| "Editor project markers malformed".to_string())?;
                markers.push(json!({
                    "id": make_id("marker"),
                    "frame": payload_field(&payload, "frame").and_then(Value::as_i64).unwrap_or(0).max(0),
                    "color": payload_string(&payload, "color").unwrap_or_else(|| "#3B82F6".to_string()),
                    "label": payload_string(&payload, "label").unwrap_or_default(),
                }));
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:update-editor-project-marker" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let marker_id = payload_string(&payload, "markerId").unwrap_or_default();
                if file_path.is_empty() || marker_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and markerId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let markers = project
                    .as_object_mut()
                    .and_then(|object| object.get_mut("markers"))
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project markers missing".to_string())?;
                let Some(marker) = markers.iter_mut().find(|item| {
                    item.get("id").and_then(Value::as_str) == Some(marker_id.as_str())
                }) else {
                    return Ok(
                        json!({ "success": false, "error": "Marker not found in editor project" }),
                    );
                };
                if let Some(object) = marker.as_object_mut() {
                    if let Some(frame) = payload_field(&payload, "frame").and_then(Value::as_i64) {
                        object.insert("frame".to_string(), json!(frame.max(0)));
                    }
                    if let Some(color) = payload_string(&payload, "color") {
                        object.insert("color".to_string(), json!(color));
                    }
                    if let Some(label) = payload_string(&payload, "label") {
                        object.insert("label".to_string(), json!(label));
                    }
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:delete-editor-project-marker" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let marker_id = payload_string(&payload, "markerId").unwrap_or_default();
                if file_path.is_empty() || marker_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and markerId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let markers = project
                    .as_object_mut()
                    .and_then(|object| object.get_mut("markers"))
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project markers missing".to_string())?;
                let before = markers.len();
                markers.retain(|marker| {
                    marker.get("id").and_then(Value::as_str) != Some(marker_id.as_str())
                });
                if before == markers.len() {
                    return Ok(
                        json!({ "success": false, "error": "Marker not found in editor project" }),
                    );
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:undo-editor-project" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                restore_editor_project_from_history(state, &file_path, &full_path, "undo")
            }
            "manuscripts:redo-editor-project" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                restore_editor_project_from_history(state, &file_path, &full_path, "redo")
            }
            "manuscripts:import-legacy-editor-project" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let file_name = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled");
                let project = build_editor_project_from_legacy(&full_path, file_name)?;
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:apply-editor-commands" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let commands = payload_field(&payload, "commands")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                apply_editor_commands(&mut project, &commands)?;
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:generate-motion-items" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let instructions = payload_string(&payload, "instructions").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let selected_item_ids = payload_field(&payload, "selectedItemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                let (motion_items, brief) = generate_motion_items_for_project(
                    state,
                    &project,
                    &instructions,
                    &selected_item_ids,
                    payload_field(&payload, "modelConfig"),
                )?;
                ensure_motion_track(&mut project)?;
                let target_bind_ids = motion_items
                    .iter()
                    .filter_map(|item| {
                        item.get("bindItemId")
                            .and_then(|value| value.as_str())
                            .map(ToString::to_string)
                    })
                    .collect::<Vec<_>>();
                editor_project_items_mut(&mut project)?.retain(|item| {
                    if item.get("type").and_then(|value| value.as_str()) != Some("motion") {
                        return true;
                    }
                    let bind_item_id = item
                        .get("bindItemId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !target_bind_ids.iter().any(|value| value == bind_item_id)
                });
                editor_project_items_mut(&mut project)?.extend(motion_items.clone());
                if let Some(ai) = project.get_mut("ai").and_then(Value::as_object_mut) {
                    ai.insert("lastMotionBrief".to_string(), json!(brief.clone()));
                    ai.insert("motionPrompt".to_string(), json!(instructions));
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({
                    "success": true,
                    "brief": brief,
                    "items": motion_items,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:generate-editor-commands" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let instructions = payload_string(&payload, "instructions").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let project = ensure_editor_project(&full_path)?;
                let (commands, brief) = generate_editor_commands_for_project(
                    state,
                    &project,
                    &instructions,
                    payload_field(&payload, "modelConfig"),
                )?;
                Ok(json!({
                    "success": true,
                    "brief": brief,
                    "commands": commands
                }))
            }
            "manuscripts:get-package-script-state" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let project = ensure_editor_project(&full_path)?;
                Ok(json!({
                    "success": true,
                    "script": package_script_state_value(&project)
                }))
            }
            "manuscripts:update-package-script" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let content = payload_string(&payload, "content").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let file_name = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled");
                let source = payload_string(&payload, "source")
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "ai".to_string());
                let (next_state, script_state) =
                    persist_package_script_body(&full_path, file_name, &content, None, &source)?;
                Ok(json!({
                    "success": true,
                    "state": next_state,
                    "script": script_state
                }))
            }
            "manuscripts:confirm-package-script" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                let approval = confirm_editor_project_script(&mut project)?;
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({
                    "success": true,
                    "script": package_script_state_value(&project),
                    "approval": approval,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:transcribe-package-subtitles" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let source_item_id = payload_string(&payload, "clipId")
                    .or_else(|| payload_string(&payload, "itemId"))
                    .unwrap_or_default();
                if file_path.is_empty() || source_item_id.is_empty() {
                    return Ok(json!({
                        "success": false,
                        "error": "filePath and clipId are required"
                    }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }

                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let Some((endpoint, api_key, model_name)) =
                    resolve_transcription_settings(&settings_snapshot)
                else {
                    return Ok(json!({
                        "success": false,
                        "error": "未配置音频转写服务，请先在设置中填写 transcription endpoint/model。"
                    }));
                };

                let mut project = ensure_editor_project(&full_path)?;
                let source_item = project
                    .get("items")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(|value| value == source_item_id)
                                .unwrap_or(false)
                        })
                    })
                    .cloned();
                let Some(source_item) = source_item else {
                    return Ok(json!({ "success": false, "error": "Source clip not found" }));
                };
                if source_item.get("type").and_then(Value::as_str) != Some("media") {
                    return Ok(json!({
                        "success": false,
                        "error": "当前只支持对音频/视频素材片段识别字幕"
                    }));
                }

                let asset_id = source_item
                    .get("assetId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let asset = project
                    .get("assets")
                    .and_then(Value::as_array)
                    .and_then(|assets| {
                        assets.iter().find(|asset| {
                            asset
                                .get("id")
                                .and_then(Value::as_str)
                                .map(|value| value == asset_id)
                                .unwrap_or(false)
                        })
                    })
                    .cloned();
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "Source asset not found" }));
                };

                let asset_kind = asset.get("kind").and_then(Value::as_str).unwrap_or("video");
                if asset_kind != "audio" && asset_kind != "video" {
                    return Ok(json!({
                        "success": false,
                        "error": "当前片段不是音频或视频素材"
                    }));
                }

                let media_source = asset
                    .get("src")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if media_source.is_empty() {
                    return Ok(json!({ "success": false, "error": "当前片段缺少素材路径" }));
                }
                let mime_type = asset
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(if asset_kind == "audio" {
                        "audio/*"
                    } else {
                        "video/*"
                    });

                let from_ms = source_item
                    .get("fromMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0);
                let duration_ms = source_item
                    .get("durationMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(DEFAULT_TIMELINE_CLIP_MS)
                    .max(500);
                let trim_in_ms = source_item
                    .get("trimInMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0);

                let (local_media_path, should_cleanup_media) =
                    resolve_project_media_source_path(state, &full_path, &media_source)?;
                let raw_srt = crate::desktop_io::run_curl_transcription_with_response_format(
                    &endpoint,
                    api_key.as_deref(),
                    &model_name,
                    &local_media_path,
                    mime_type,
                    Some("srt"),
                );
                if should_cleanup_media {
                    let _ = fs::remove_file(&local_media_path);
                }
                let raw_srt = raw_srt?;

                let parsed_segments = parse_srt_segments(&raw_srt);
                let source_segments = if parsed_segments.is_empty() {
                    build_fallback_srt_segments(&raw_srt, duration_ms)
                } else {
                    parsed_segments
                };
                if source_segments.is_empty() {
                    return Ok(json!({ "success": false, "error": "转写结果为空" }));
                }

                let clip_end_ms = trim_in_ms + duration_ms;
                let clip_relative_segments = source_segments
                    .into_iter()
                    .filter_map(|segment| {
                        let intersect_start = segment.start_ms.max(trim_in_ms);
                        let intersect_end = segment.end_ms.min(clip_end_ms);
                        if intersect_end <= intersect_start {
                            return None;
                        }
                        Some(SrtSegment {
                            start_ms: (intersect_start - trim_in_ms).max(0),
                            end_ms: (intersect_end - trim_in_ms).max(0),
                            text: segment.text.trim().to_string(),
                        })
                    })
                    .filter(|segment| !segment.text.is_empty() && segment.end_ms > segment.start_ms)
                    .collect::<Vec<_>>();

                let clip_relative_segments = if clip_relative_segments.is_empty() {
                    build_fallback_srt_segments(&raw_srt, duration_ms)
                } else {
                    clip_relative_segments
                };
                if clip_relative_segments.is_empty() {
                    return Ok(json!({ "success": false, "error": "没有可写入时间轴的字幕片段" }));
                }

                let target_track_id = payload_string(&payload, "track")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        project
                            .get("tracks")
                            .and_then(Value::as_array)
                            .and_then(|tracks| {
                                tracks.iter().find_map(|track| {
                                    let kind =
                                        track.get("kind").and_then(Value::as_str).unwrap_or("");
                                    let id = track.get("id").and_then(Value::as_str).unwrap_or("");
                                    if kind == "subtitle" && !id.trim().is_empty() {
                                        Some(id.to_string())
                                    } else {
                                        None
                                    }
                                })
                            })
                    })
                    .unwrap_or_else(|| "S1".to_string());
                ensure_editor_track(&mut project, &target_track_id, "subtitle")?;

                let subtitle_dir = full_path.join("subtitles");
                fs::create_dir_all(&subtitle_dir).map_err(|error| error.to_string())?;
                let subtitle_file_name = format!(
                    "{}.srt",
                    source_item_id
                        .chars()
                        .map(|ch| match ch {
                            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => ch,
                            _ => '-',
                        })
                        .collect::<String>()
                );
                let subtitle_relative_path = format!("subtitles/{subtitle_file_name}");
                let subtitle_file_path = subtitle_dir.join(&subtitle_file_name);
                write_text_file(
                    &subtitle_file_path,
                    &serialize_srt_segments(&clip_relative_segments),
                )?;

                let style_template = editor_default_subtitle_style(
                    &source_item_id,
                    &subtitle_relative_path,
                    payload_field(&payload, "subtitleStyle"),
                );
                let inserted_items = clip_relative_segments
                    .iter()
                    .enumerate()
                    .map(|(index, segment)| {
                        let mut style = style_template.clone();
                        if let Some(style_object) = style.as_object_mut() {
                            style_object.insert("segmentIndex".to_string(), json!(index));
                            style_object.insert("startMs".to_string(), json!(segment.start_ms));
                            style_object.insert("endMs".to_string(), json!(segment.end_ms));
                        }
                        json!({
                            "id": make_id("subtitle-item"),
                            "type": "subtitle",
                            "trackId": target_track_id,
                            "text": segment.text,
                            "fromMs": from_ms + segment.start_ms,
                            "durationMs": (segment.end_ms - segment.start_ms).max(240),
                            "style": style,
                            "enabled": true
                        })
                    })
                    .collect::<Vec<_>>();
                let first_inserted_item_id = inserted_items
                    .first()
                    .and_then(|item| item.get("id").and_then(Value::as_str))
                    .map(ToString::to_string);
                {
                    let items = editor_project_items_mut(&mut project)?;
                    items.retain(|item| {
                        if item.get("type").and_then(Value::as_str) != Some("subtitle") {
                            return true;
                        }
                        item.get("style")
                            .and_then(Value::as_object)
                            .and_then(|style| style.get("sourceItemId"))
                            .and_then(Value::as_str)
                            .map(|value| value != source_item_id)
                            .unwrap_or(true)
                    });
                    items.extend(inserted_items);
                }
                upsert_editor_project_last_subtitle_transcription(
                    &mut project,
                    &source_item_id,
                    &subtitle_relative_path,
                    clip_relative_segments.len(),
                )?;
                normalize_editor_project_timeline(&mut project)?;
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({
                    "success": true,
                    "clipId": source_item_id,
                    "subtitleCount": clip_relative_segments.len(),
                    "subtitleFile": subtitle_relative_path,
                    "insertedClipId": first_inserted_item_id,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:get-editor-runtime-state" => {
                let file_path = payload_value_as_string(&payload)
                    .or_else(|| payload_string(&payload, "filePath"))
                    .unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                Ok(json!({
                    "success": true,
                    "state": editor_runtime_state_value(state, &file_path)?
                }))
            }
            "manuscripts:get-remotion-context" => {
                let file_path = payload_value_as_string(&payload)
                    .or_else(|| payload_string(&payload, "filePath"))
                    .unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                Ok(json!({
                    "success": true,
                    "state": remotion_context_value(state, &full_path, &file_path)?
                }))
            }
            "manuscripts:update-editor-runtime-state" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let mut guard = state
                    .editor_runtime_states
                    .lock()
                    .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
                let previous = guard.get(&file_path).cloned();
                let updated_at = now_ms();
                guard.insert(
                    file_path.clone(),
                    EditorRuntimeStateRecord {
                        file_path: file_path.clone(),
                        session_id: payload_string(&payload, "sessionId"),
                        playhead_seconds: payload_field(&payload, "playheadSeconds")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        selected_clip_id: payload_string(&payload, "selectedClipId"),
                        selected_clip_ids: payload_field(&payload, "selectedClipIds")
                            .cloned()
                            .or_else(|| {
                                previous
                                    .as_ref()
                                    .and_then(|record| record.selected_clip_ids.clone())
                            }),
                        active_track_id: payload_string(&payload, "activeTrackId"),
                        selected_track_ids: payload_field(&payload, "selectedTrackIds")
                            .cloned()
                            .or_else(|| {
                                previous
                                    .as_ref()
                                    .and_then(|record| record.selected_track_ids.clone())
                            }),
                        selected_scene_id: payload_string(&payload, "selectedSceneId"),
                        preview_tab: payload_string(&payload, "previewTab"),
                        canvas_ratio_preset: payload_string(&payload, "canvasRatioPreset"),
                        active_panel: payload_string(&payload, "activePanel"),
                        drawer_panel: payload_string(&payload, "drawerPanel"),
                        scene_item_transforms: payload_field(&payload, "sceneItemTransforms")
                            .cloned(),
                        scene_item_visibility: payload_field(&payload, "sceneItemVisibility")
                            .cloned(),
                        scene_item_order: payload_field(&payload, "sceneItemOrder").cloned(),
                        scene_item_locks: payload_field(&payload, "sceneItemLocks").cloned(),
                        scene_item_groups: payload_field(&payload, "sceneItemGroups").cloned(),
                        focused_group_id: payload_string(&payload, "focusedGroupId"),
                        track_ui: payload_field(&payload, "trackUi").cloned(),
                        viewport_scroll_left: payload_field(&payload, "viewportScrollLeft")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        viewport_max_scroll_left: payload_field(&payload, "viewportMaxScrollLeft")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        viewport_scroll_top: payload_field(&payload, "viewportScrollTop")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        viewport_max_scroll_top: payload_field(&payload, "viewportMaxScrollTop")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        timeline_zoom_percent: payload_field(&payload, "timelineZoomPercent")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(100.0),
                        undo_stack: previous
                            .as_ref()
                            .map(|record| record.undo_stack.clone())
                            .unwrap_or_default(),
                        redo_stack: previous
                            .as_ref()
                            .map(|record| record.redo_stack.clone())
                            .unwrap_or_default(),
                        updated_at,
                    },
                );
                drop(guard);
                Ok(json!({
                    "success": true,
                    "state": editor_runtime_state_value(state, &file_path)?
                }))
            }
            "manuscripts:update-package-track-ui" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let track_ui = payload_field(&payload, "trackUi")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                write_json_value(&package_track_ui_path(&full_path), &track_ui)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:update-package-scene-ui" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let scene_ui = payload_field(&payload, "sceneUi")
                    .cloned()
                    .unwrap_or_else(|| {
                        json!({
                            "itemVisibility": {},
                            "itemOrder": [],
                            "itemLocks": {},
                            "itemGroups": {},
                            "focusedGroupId": Value::Null
                        })
                    });
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                write_json_value(&package_scene_ui_path(&full_path), &scene_ui)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:add-package-track" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let kind = payload_string(&payload, "kind").unwrap_or_else(|| "video".to_string());
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let (prefix, kind_label) = match kind.as_str() {
                    "audio" => ("A", "Audio"),
                    "subtitle" | "caption" | "text" => ("S", "Subtitle"),
                    _ => ("V", "Video"),
                };
                let existing_indexes = timeline
                    .pointer("/tracks/children")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|track| {
                        track
                            .get("name")
                            .and_then(|value| value.as_str())
                            .map(ToString::to_string)
                    })
                    .filter(|name| name.starts_with(prefix))
                    .filter_map(|name| name[1..].parse::<i64>().ok())
                    .collect::<Vec<_>>();
                let next_index = existing_indexes.into_iter().max().unwrap_or(0) + 1;
                let _ = ensure_timeline_track(
                    &mut timeline,
                    &format!("{prefix}{next_index}"),
                    kind_label,
                );
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:delete-package-track" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let track_id = payload_string(&payload, "trackId").unwrap_or_default();
                if file_path.is_empty() || track_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and trackId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let Some(track_index) = tracks.iter().position(|track| {
                    track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(|value| value == track_id)
                        .unwrap_or(false)
                }) else {
                    return Ok(json!({ "success": false, "error": "Track not found in timeline" }));
                };
                let track_kind = timeline_track_kind(&track_id);
                let same_kind_count = tracks
                    .iter()
                    .filter(|track| {
                        track
                            .get("name")
                            .and_then(|value| value.as_str())
                            .map(timeline_track_kind)
                            .unwrap_or("Video")
                            == track_kind
                    })
                    .count();
                if same_kind_count <= 1 {
                    return Ok(
                        json!({ "success": false, "error": "At least one track per media kind must remain" }),
                    );
                }
                let has_children = tracks[track_index]
                    .get("children")
                    .and_then(Value::as_array)
                    .map(|children| !children.is_empty())
                    .unwrap_or(false);
                if has_children {
                    return Ok(
                        json!({ "success": false, "error": "Only empty tracks can be deleted" }),
                    );
                }
                tracks.remove(track_index);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:move-package-track" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let track_id = payload_string(&payload, "trackId").unwrap_or_default();
                let direction =
                    payload_string(&payload, "direction").unwrap_or_else(|| "up".to_string());
                if file_path.is_empty() || track_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and trackId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let Some(track_index) = tracks.iter().position(|track| {
                    track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(|value| value == track_id)
                        .unwrap_or(false)
                }) else {
                    return Ok(json!({ "success": false, "error": "Track not found in timeline" }));
                };
                let target_index = if direction == "down" {
                    (track_index + 1).min(tracks.len().saturating_sub(1))
                } else {
                    track_index.saturating_sub(1)
                };
                if target_index == track_index {
                    return Ok(
                        json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }),
                    );
                }
                let track = tracks.remove(track_index);
                tracks.insert(target_index, track);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:add-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
                if file_path.is_empty() || asset_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and assetId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let asset = with_store(state, |store| {
                    Ok(store
                        .media_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "Media asset not found" }));
                };
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let preferred_track_name = payload_string(&payload, "track")
                    .unwrap_or_else(|| default_track_name_for_asset(&asset).to_string());
                let kind_label = if preferred_track_name.starts_with('A') {
                    "Audio"
                } else {
                    "Video"
                };
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, kind_label);
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;
                let desired_order = payload_field(&payload, "order")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(target_children.len() as i64)
                    .clamp(0, target_children.len() as i64)
                    as usize;
                let clip = build_timeline_clip_from_asset(
                    &asset,
                    desired_order,
                    payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
                );
                let inserted_clip_id = clip
                    .get("metadata")
                    .and_then(|value| value.get("clipId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                target_children.insert(desired_order, clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                ensure_package_asset_entry(&full_path, &asset)?;
                Ok(json!({
                    "success": true,
                    "insertedClipId": inserted_clip_id,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:insert-package-subtitle-at-playhead" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                    .map(|record| record.playhead_seconds)
                    .unwrap_or(0.0)
                    .max(0.0);
                let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let preferred_track_name = payload_string(&payload, "track")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        timeline
                            .pointer("/tracks/children")
                            .and_then(Value::as_array)
                            .and_then(|tracks| {
                                tracks
                                    .iter()
                                    .filter_map(|track| {
                                        track
                                            .get("name")
                                            .and_then(|value| value.as_str())
                                            .map(ToString::to_string)
                                    })
                                    .filter(|name| name.starts_with('S'))
                                    .last()
                            })
                            .unwrap_or_else(|| "S1".to_string())
                    });
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, "Subtitle");
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;

                let mut desired_order = target_children.len();
                if let Some(order) =
                    payload_field(&payload, "order").and_then(|value| value.as_i64())
                {
                    desired_order = order.clamp(0, target_children.len() as i64) as usize;
                } else {
                    let mut cursor_ms = 0_i64;
                    for (index, clip) in target_children.iter().enumerate() {
                        let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                        if playhead_ms <= cursor_ms {
                            desired_order = index;
                            break;
                        }
                        desired_order = index + 1;
                        cursor_ms = next_cursor_ms;
                        if playhead_ms < next_cursor_ms {
                            break;
                        }
                    }
                }

                let clip = build_timeline_subtitle_clip(
                    desired_order,
                    &payload_string(&payload, "text").unwrap_or_default(),
                    payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
                );
                let inserted_clip_id = clip
                    .get("metadata")
                    .and_then(|value| value.get("clipId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                target_children.insert(desired_order.min(target_children.len()), clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({
                    "success": true,
                    "insertedClipId": inserted_clip_id,
                    "playheadSeconds": playhead_seconds,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:insert-package-clip-at-playhead" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
                if file_path.is_empty() || asset_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and assetId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let asset = with_store(state, |store| {
                    Ok(store
                        .media_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "Media asset not found" }));
                };

                let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                    .map(|record| record.playhead_seconds)
                    .unwrap_or(0.0)
                    .max(0.0);
                let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let requested_track = payload_string(&payload, "track")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let default_track_name = default_track_name_for_asset(&asset).to_string();
                let track_prefix = if default_track_name.starts_with('A') {
                    'A'
                } else {
                    'V'
                };
                let preferred_track_name = requested_track.unwrap_or_else(|| {
                    timeline
                        .pointer("/tracks/children")
                        .and_then(Value::as_array)
                        .and_then(|tracks| {
                            tracks
                                .iter()
                                .filter_map(|track| {
                                    track
                                        .get("name")
                                        .and_then(|value| value.as_str())
                                        .map(ToString::to_string)
                                })
                                .filter(|name| name.starts_with(track_prefix))
                                .last()
                        })
                        .unwrap_or(default_track_name)
                });
                let kind_label = if preferred_track_name.starts_with('A') {
                    "Audio"
                } else {
                    "Video"
                };
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, kind_label);
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;

                let mut desired_order = target_children.len();
                let mut split_target: Option<(usize, f64)> = None;
                if let Some(order) =
                    payload_field(&payload, "order").and_then(|value| value.as_i64())
                {
                    desired_order = order.clamp(0, target_children.len() as i64) as usize;
                } else {
                    let mut cursor_ms = 0_i64;
                    for (index, clip) in target_children.iter().enumerate() {
                        let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                        if playhead_ms > cursor_ms && playhead_ms < next_cursor_ms {
                            let duration_ms = (next_cursor_ms - cursor_ms).max(1000);
                            let split_ratio = ((playhead_ms - cursor_ms) as f64
                                / duration_ms as f64)
                                .clamp(0.1, 0.9);
                            split_target = Some((index, split_ratio));
                            desired_order = index + 1;
                            break;
                        }
                        if playhead_ms <= cursor_ms {
                            desired_order = index;
                            break;
                        }
                        desired_order = index + 1;
                        cursor_ms = next_cursor_ms;
                    }
                }

                if let Some((split_index, split_ratio)) = split_target {
                    let original_clip = target_children.remove(split_index);
                    let original_clip_id =
                        timeline_clip_identity(&original_clip, &preferred_track_name, split_index);
                    let (first_clip, second_clip) =
                        split_timeline_clip_value(&original_clip, &original_clip_id, split_ratio);
                    target_children.insert(split_index, first_clip);
                    target_children.insert(split_index + 1, second_clip);
                }

                let clip = build_timeline_clip_from_asset(
                    &asset,
                    desired_order,
                    payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
                );
                let inserted_clip_id = clip
                    .get("metadata")
                    .and_then(|value| value.get("clipId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let safe_order = desired_order.min(target_children.len());
                target_children.insert(safe_order, clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                ensure_package_asset_entry(&full_path, &asset)?;
                Ok(json!({
                    "success": true,
                    "insertedClipId": inserted_clip_id,
                    "playheadSeconds": playhead_seconds,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:insert-package-text-at-playhead" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                    .map(|record| record.playhead_seconds)
                    .unwrap_or(0.0)
                    .max(0.0);
                let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let preferred_track_name = payload_string(&payload, "track")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        timeline
                            .pointer("/tracks/children")
                            .and_then(Value::as_array)
                            .and_then(|tracks| {
                                tracks
                                    .iter()
                                    .filter_map(|track| {
                                        track
                                            .get("name")
                                            .and_then(|value| value.as_str())
                                            .map(ToString::to_string)
                                    })
                                    .filter(|name| name.starts_with('T'))
                                    .last()
                            })
                            .unwrap_or_else(|| "T1".to_string())
                    });
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, "Subtitle");
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;

                let mut desired_order = target_children.len();
                let mut cursor_ms = 0_i64;
                for (index, clip) in target_children.iter().enumerate() {
                    let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                    if playhead_ms <= cursor_ms {
                        desired_order = index;
                        break;
                    }
                    desired_order = index + 1;
                    cursor_ms = next_cursor_ms;
                    if playhead_ms < next_cursor_ms {
                        break;
                    }
                }

                let mut clip = build_timeline_text_clip(
                    desired_order,
                    &payload_string(&payload, "text").unwrap_or_default(),
                    payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
                );
                if let Some(text_style) = payload_field(&payload, "textStyle").cloned() {
                    if let Some(metadata) = clip.get_mut("metadata").and_then(Value::as_object_mut)
                    {
                        metadata.insert("textStyle".to_string(), text_style);
                    }
                }
                let inserted_clip_id = clip
                    .get("metadata")
                    .and_then(|value| value.get("clipId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                target_children.insert(desired_order.min(target_children.len()), clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({
                    "success": true,
                    "insertedClipId": inserted_clip_id,
                    "playheadSeconds": playhead_seconds,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:attach-external-files" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir()
                    || !is_manuscript_package_name(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let picked = pick_files_native("选择要导入的素材文件", false, true)?;
                if picked.is_empty() {
                    return Ok(json!({ "success": true, "canceled": true, "imported": [] }));
                }
                let imports_root = media_root(state)?.join("imports");
                fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
                let mut imported = Vec::<Value>::new();
                for file in picked {
                    let (relative_name, target) = copy_file_into_dir(&file, &imports_root)?;
                    let (mime_type, _kind, _) = guess_mime_and_kind(&target);
                    let asset = with_store_mut(state, |store| {
                        let asset = MediaAssetRecord {
                            id: make_id("media"),
                            source: "imported".to_string(),
                            project_id: None,
                            title: file
                                .file_name()
                                .and_then(|value| value.to_str())
                                .map(ToString::to_string),
                            prompt: None,
                            provider: None,
                            provider_template: None,
                            model: None,
                            aspect_ratio: None,
                            size: None,
                            quality: None,
                            mime_type: Some(mime_type.clone()),
                            relative_path: Some(format!("imports/{}", relative_name)),
                            bound_manuscript_path: Some(file_path.clone()),
                            created_at: now_iso(),
                            updated_at: now_iso(),
                            absolute_path: Some(target.display().to_string()),
                            preview_url: Some(file_url_for_path(&target)),
                            exists: true,
                        };
                        store.media_assets.push(asset.clone());
                        Ok(asset)
                    })?;
                    persist_media_workspace_catalog(state)?;
                    ensure_package_asset_entry(&full_path, &asset)?;
                    let track = if mime_type.starts_with("audio/") {
                        "A1"
                    } else {
                        "V1"
                    };
                    let _ = handle_manuscripts_channel(
                        app,
                        state,
                        "manuscripts:add-package-clip",
                        &json!({
                            "filePath": file_path,
                            "assetId": asset.id,
                            "track": track,
                        }),
                    );
                    imported.push(json!({
                        "absolutePath": target.display().to_string(),
                        "title": asset.title,
                        "mimeType": mime_type,
                        "assetId": asset.id,
                    }));
                }
                Ok(json!({
                    "success": true,
                    "canceled": false,
                    "imported": imported,
                    "state": get_manuscript_package_state(&full_path)?,
                }))
            }
            "manuscripts:update-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                if file_path.is_empty() || clip_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and clipId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut clip_to_move: Option<Value> = None;
                let mut current_track_index = 0usize;
                for (track_index, track) in tracks.iter_mut().enumerate() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    if let Some(index) = children
                        .iter()
                        .position(|clip| timeline_clip_identity(clip, &track_name, 0) == clip_id)
                    {
                        clip_to_move = Some(children.remove(index));
                        current_track_index = track_index;
                        break;
                    }
                }
                let Some(mut clip) = clip_to_move else {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                };
                let target_track_name = payload_string(&payload, "track").unwrap_or_else(|| {
                    tracks[current_track_index]
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("V1")
                        .to_string()
                });
                let target_track = ensure_timeline_track(
                    &mut timeline,
                    &target_track_name,
                    if target_track_name.starts_with('A') {
                        "Audio"
                    } else {
                        "Video"
                    },
                );
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline target children missing".to_string())?;
                let desired_order = payload_field(&payload, "order")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(target_children.len() as i64)
                    .clamp(0, target_children.len() as i64)
                    as usize;
                if let Some(metadata) = clip.get_mut("metadata").and_then(Value::as_object_mut) {
                    metadata.insert("clipId".to_string(), json!(clip_id));
                    if let Some(duration_ms) = payload_field(&payload, "durationMs") {
                        metadata.insert("durationMs".to_string(), duration_ms.clone());
                    }
                    if let Some(trim_in_ms) = payload_field(&payload, "trimInMs") {
                        metadata.insert("trimInMs".to_string(), trim_in_ms.clone());
                    }
                    if let Some(trim_out_ms) = payload_field(&payload, "trimOutMs") {
                        metadata.insert("trimOutMs".to_string(), trim_out_ms.clone());
                    }
                    if let Some(enabled) = payload_field(&payload, "enabled") {
                        metadata.insert("enabled".to_string(), enabled.clone());
                    }
                    if let Some(asset_kind) = payload_field(&payload, "assetKind") {
                        metadata.insert("assetKind".to_string(), asset_kind.clone());
                    }
                    if let Some(subtitle_style) = payload_field(&payload, "subtitleStyle") {
                        metadata.insert("subtitleStyle".to_string(), subtitle_style.clone());
                    }
                    if let Some(text_style) = payload_field(&payload, "textStyle") {
                        metadata.insert("textStyle".to_string(), text_style.clone());
                    }
                    if let Some(transition_style) = payload_field(&payload, "transitionStyle") {
                        metadata.insert("transitionStyle".to_string(), transition_style.clone());
                    }
                }
                if let Some(name) = payload_string(&payload, "name") {
                    if let Some(object) = clip.as_object_mut() {
                        object.insert("name".to_string(), json!(name));
                    }
                }
                target_children.insert(desired_order, clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:delete-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut removed = false;
                for track in tracks.iter_mut() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    if let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    {
                        let before = children.len();
                        children
                            .retain(|clip| timeline_clip_identity(clip, &track_name, 0) != clip_id);
                        if before != children.len() {
                            removed = true;
                        }
                    }
                }
                if !removed {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                }
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:split-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                let split_ratio = payload_field(&payload, "splitRatio")
                    .and_then(|value| value.as_f64())
                    .unwrap_or(0.5)
                    .clamp(0.1, 0.9);
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut split_done = false;
                for track in tracks.iter_mut() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    let mut next_children = Vec::new();
                    for clip in children.iter() {
                        let mut clip_value = clip.clone();
                        next_children.push(clip_value.clone());
                        if timeline_clip_identity(clip, &track_name, 0) != clip_id {
                            continue;
                        }
                        let min_duration =
                            min_clip_duration_ms_for_asset_kind(&timeline_clip_asset_kind(clip));
                        let current_duration = timeline_clip_duration_ms(clip);
                        let first_duration =
                            ((current_duration as f64) * split_ratio).round() as i64;
                        let first_duration = first_duration.max(min_duration);
                        let second_duration = (current_duration - first_duration).max(min_duration);
                        if let Some(obj) = clip_value
                            .get_mut("metadata")
                            .and_then(Value::as_object_mut)
                        {
                            obj.insert("clipId".to_string(), json!(clip_id.clone()));
                            obj.insert("durationMs".to_string(), json!(first_duration));
                        }
                        if let Some(last) = next_children.last_mut() {
                            *last = clip_value.clone();
                        }
                        let mut new_clip = clip.clone();
                        if let Some(obj) =
                            new_clip.get_mut("metadata").and_then(Value::as_object_mut)
                        {
                            let trim_in = obj.get("trimInMs").and_then(|v| v.as_i64()).unwrap_or(0);
                            obj.insert("clipId".to_string(), json!(create_timeline_clip_id()));
                            obj.insert("durationMs".to_string(), json!(second_duration));
                            obj.insert("trimInMs".to_string(), json!(trim_in + first_duration));
                        }
                        next_children.push(new_clip);
                        split_done = true;
                    }
                    *children = next_children;
                    if split_done {
                        break;
                    }
                }
                if !split_done {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                }
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:save-remotion-scene" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_state = get_manuscript_package_state(&full_path)?;
                let title = package_state
                    .pointer("/manifest/title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("RedBox Motion")
                    .to_string();
                let clips = package_state
                    .pointer("/timelineSummary/clips")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let existing_scene = read_json_value_or(
                    package_remotion_path(&full_path).as_path(),
                    build_default_remotion_scene(&title, &clips),
                );
                let raw_scene = payload_field(&payload, "scene")
                    .cloned()
                    .unwrap_or(Value::Null);
                let merged_scene = merge_remotion_scene_patch(&existing_scene, &raw_scene);
                let normalized =
                    normalize_ai_remotion_scene(&merged_scene, &existing_scene, &clips, &title);
                let mut project = ensure_editor_project(&full_path)?;
                sync_project_motion_items_from_remotion_scene(&mut project, &normalized)?;
                sync_project_transitions_from_remotion_scene(&mut project, &normalized)?;
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                persist_remotion_composition_artifacts(&full_path, &normalized)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:generate-remotion-scene" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let instructions = payload_string(&payload, "instructions").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_state = get_manuscript_package_state(&full_path)?;
                let title = package_state
                    .pointer("/manifest/title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("RedBox Motion")
                    .to_string();
                let clips = package_state
                    .pointer("/timelineSummary/clips")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let remotion_context = remotion_context_value(state, &full_path, &file_path)?;
                let fallback = read_json_value_or(
                    package_remotion_path(&full_path).as_path(),
                    build_default_remotion_scene(&title, &clips),
                );
                let prompt = format!(
                "请基于当前视频脚本、时间线和当前 Remotion 工程状态，为 RedBox 设计一份 Remotion JSON 动画方案。\n\
要求：\n\
1. 一个视频工程对应一个 Remotion 工程文件；默认只维护一个主 scene（通常就是 scene-1），后续动画默认都加到这个 scene 里，而不是按底层片段数量机械拆多个场景。\n\
2. 先确定动画主体元素，再设计动画表达。像“苹果下落”必须先落成一个 element，例如 `shape=apple`，再给它配置 `fall-bounce` 等动画；不要退化成说明性文字。\n\
3. 只有当脚本明确要求动画跟随某个现有镜头时，才填写 clipId / assetId；否则它们保持为空，让动画独立存在于默认 scene / M1 动画轨道。\n\
4. Remotion 的时序是按帧控制的；请用 durationInFrames 和 overlay.startFrame / overlay.durationInFrames 表达节奏，不要描述宿主不存在的自由动画系统。\n\
5. 每个场景内部等价于一个 Sequence，overlay.startFrame + overlay.durationInFrames 必须落在该场景 durationInFrames 之内。\n\
6. 如需真正的对象动画（例如苹果掉落、图形弹跳、logo reveal），优先使用 scenes[].entities[]，不要退化成说明性文字。\n\
7. entities 支持 text / shape / image / svg / video / group；shape 优先使用 rect / circle / apple。\n\
8. 对象动画优先用 entities[].animations[] 表达，例如 fall-bounce、slide-in-left、pop、fade-in。\n\
9. 不要通过文字轨道片段模拟动画；动画只能体现在 Remotion scene / M1 动画轨道。\n\
10. 不要修改 src / assetKind / trimInFrames，这些字段由宿主兜底；如果是独立动画层，src 可以为空。\n\
11. overlayTitle 用场景标题，overlayBody 用屏幕文案或强调点；主体动画本身必须在 entities 里。\n\
12. 如果任务涉及镜头切换，可以使用顶层 transitions[]，字段必须遵守 leftClipId / rightClipId / presentation / timing / durationInFrames；不要把转场偷偷降级成说明文字。\n\
\n\
工程标题：{}\n\
脚本：{}\n\
Remotion 读取结果 JSON：{}\n\
时间线片段 JSON：{}",
                title,
                instructions,
                serde_json::to_string(&remotion_context).map_err(|error| error.to_string())?,
                serde_json::to_string(&clips).map_err(|error| error.to_string())?
            );
                let model_config = payload_field(&payload, "modelConfig").cloned();
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let resolved_config =
                    resolve_chat_config(&settings_snapshot, model_config.as_ref());
                let session_id = payload_string(&payload, "sessionId");
                let model_config_summary = model_config
                    .as_ref()
                    .and_then(Value::as_object)
                    .map(|object| {
                        format!(
                            "baseURL={} | modelName={} | protocol={} | apiKeyPresent={}",
                            object.get("baseURL").and_then(Value::as_str).unwrap_or(""),
                            object
                                .get("modelName")
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                            object.get("protocol").and_then(Value::as_str).unwrap_or(""),
                            object
                                .get("apiKey")
                                .and_then(Value::as_str)
                                .map(|value| !value.trim().is_empty())
                                .unwrap_or(false)
                        )
                    })
                    .unwrap_or_else(|| "none".to_string());
                let resolved_config_summary = resolved_config
                    .as_ref()
                    .map(|config| {
                        format!(
                            "base_url={} | model_name={} | protocol={} | api_key_present={}",
                            config.base_url,
                            config.model_name,
                            config.protocol,
                            config
                                .api_key
                                .as_ref()
                                .map(|value| !value.trim().is_empty())
                                .unwrap_or(false)
                        )
                    })
                    .unwrap_or_else(|| "none".to_string());
                let start_log = format!(
                    "[video][remotion_generate] start | filePath={} | sessionId={} | clips={} | instructionsChars={} | payloadModelConfig={} | resolvedConfig={}",
                    file_path,
                    session_id.clone().unwrap_or_default(),
                    clips.len(),
                    instructions.chars().count(),
                    model_config_summary,
                    resolved_config_summary
                );
                eprintln!("{}", start_log);
                append_debug_log_state(state, start_log);
                let (candidate, subagent_summary) = run_animation_director_subagent(
                    app,
                    state,
                    session_id.as_deref(),
                    model_config.as_ref(),
                    &prompt,
                )?;
                let raw_log = format!(
                    "[video][remotion_generate] subagent-response | parsedJson=true | summary={}",
                    subagent_summary.replace('\n', "\\n")
                );
                eprintln!("{}", raw_log);
                append_debug_log_state(state, raw_log);
                let normalized = normalize_ai_remotion_scene(&candidate, &fallback, &clips, &title);
                let mut project = ensure_editor_project(&full_path)?;
                sync_project_motion_items_from_remotion_scene(&mut project, &normalized)?;
                sync_project_transitions_from_remotion_scene(&mut project, &normalized)?;
                if let Some(ai) = project.get_mut("ai").and_then(Value::as_object_mut) {
                    ai.insert(
                        "lastMotionBrief".to_string(),
                        json!(subagent_summary.clone()),
                    );
                    ai.insert("motionPrompt".to_string(), json!(instructions));
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                let normalized_scene_count = normalized
                    .get("scenes")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let normalized_log = format!(
                    "[video][remotion_generate] normalized | scenes={} | title={}",
                    normalized_scene_count,
                    normalized
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                );
                eprintln!("{}", normalized_log);
                append_debug_log_state(state, normalized_log);
                persist_remotion_composition_artifacts(&full_path, &normalized)?;
                Ok(json!({
                    "success": true,
                    "state": get_manuscript_package_state(&full_path)?,
                    "summary": subagent_summary
                }))
            }
            "manuscripts:render-remotion-video" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let project = ensure_editor_project(&full_path)?;
                let mut scene = read_json_value_or(
                    package_remotion_path(&full_path).as_path(),
                    build_remotion_config_from_editor_project(&project),
                );
                let render_mode = payload_string(&payload, "renderMode")
                    .filter(|value| value == "full" || value == "motion-layer")
                    .unwrap_or_else(|| {
                        scene
                            .get("renderMode")
                            .and_then(Value::as_str)
                            .filter(|value| *value == "full" || *value == "motion-layer")
                            .unwrap_or("motion-layer")
                            .to_string()
                    });
                if let Some(object) = scene.as_object_mut() {
                    object.insert("renderMode".to_string(), json!(render_mode.clone()));
                }
                let export_dir = full_path.join("exports");
                fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
                let file_stem = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(slug_from_relative_path)
                    .unwrap_or_else(|| "redbox-video".to_string());
                let extension = if render_mode == "motion-layer" {
                    "mov"
                } else {
                    "mp4"
                };
                let output_path =
                    export_dir.join(format!("{file_stem}-remotion-{}.{extension}", now_ms()));
                let render_result = render_remotion_video(&scene, &output_path)?;
                let scene_title = scene
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("RedBox Motion")
                    .to_string();
                if let Some(object) = scene.as_object_mut() {
                    object.insert(
                        "render".to_string(),
                        normalized_remotion_render_config(
                            Some(&json!({
                                "defaultOutName": render_result.get("defaultOutName").cloned().unwrap_or(Value::Null),
                                "codec": render_result.get("codec").cloned().unwrap_or(Value::Null),
                                "imageFormat": render_result.get("imageFormat").cloned().unwrap_or(Value::Null),
                                "pixelFormat": render_result.get("pixelFormat").cloned().unwrap_or(Value::Null),
                                "proResProfile": render_result.get("proResProfile").cloned().unwrap_or(Value::Null),
                                "outputPath": output_path.display().to_string(),
                                "renderedAt": now_i64(),
                                "durationInFrames": render_result.get("durationInFrames").cloned().unwrap_or(Value::Null),
                                "renderMode": render_mode,
                                "compositionId": render_result.get("compositionId").cloned().unwrap_or_else(|| json!("RedBoxVideoMotion"))
                            })),
                            &scene_title,
                            &render_mode,
                        ),
                    );
                }
                persist_remotion_composition_artifacts(&full_path, &scene)?;
                Ok(json!({
                    "success": true,
                    "outputPath": output_path.display().to_string(),
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:get-layout" => {
                let path = manuscript_layouts_path(state)?;
                if path.exists() {
                    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                    let layout: Value =
                        serde_json::from_str(&content).map_err(|error| error.to_string())?;
                    Ok(layout)
                } else {
                    Ok(json!({}))
                }
            }
            "manuscripts:save-layout" => {
                let path = manuscript_layouts_path(state)?;
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(
                    &path,
                    serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?;
                Ok(json!({ "success": true }))
            }
            "manuscripts:format-wechat" => {
                let title = payload_string(&payload, "title").unwrap_or_default();
                let content = payload_string(&payload, "content").unwrap_or_default();
                Ok(json!({
                    "success": true,
                    "html": markdown_to_html(&title, &content),
                    "plainText": content,
                }))
            }
            _ => Err(format!(
                "RedBox host does not recognize channel `{channel}`."
            )),
        }
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_project_motion_items_from_remotion_scene_updates_animation_layers_and_items() {
        let mut project = json!({
            "tracks": [{
                "id": "M1",
                "kind": "motion",
                "name": "M1",
                "order": 0,
                "ui": {
                    "hidden": false,
                    "locked": false,
                    "muted": false,
                    "solo": false,
                    "collapsed": false,
                    "volume": 1.0
                }
            }],
            "items": [{
                "id": "old-motion",
                "type": "motion",
                "trackId": "M1",
                "fromMs": 0,
                "durationMs": 1000,
                "templateId": "static",
                "props": {},
                "enabled": true
            }, {
                "id": "clip-1",
                "type": "media",
                "trackId": "V1",
                "assetId": "asset-1",
                "fromMs": 0,
                "durationMs": 1000,
                "trimInMs": 0,
                "trimOutMs": 0,
                "enabled": true
            }],
            "animationLayers": [{
                "id": "old-motion",
                "name": "旧动画",
                "trackId": "M1",
                "enabled": true,
                "fromMs": 0,
                "durationMs": 1000,
                "zIndex": 0,
                "renderMode": "motion-layer",
                "componentType": "scene-sequence",
                "props": { "templateId": "static" },
                "entities": [],
                "bindings": []
            }]
        });
        let composition = json!({
            "fps": 30,
            "renderMode": "motion-layer",
            "scenes": [{
                "id": "scene-1",
                "clipId": Value::Null,
                "assetId": Value::Null,
                "startFrame": 0,
                "durationInFrames": 30,
                "motionPreset": "static",
                "overlayTitle": "苹果下落",
                "overlayBody": Value::Null,
                "overlays": [],
                "entities": [{
                    "id": "apple-1",
                    "type": "shape",
                    "shape": "apple",
                    "color": "#FF0000",
                    "x": 100,
                    "y": 0,
                    "width": 120,
                    "height": 120,
                    "animations": [{
                        "id": "anim-1",
                        "kind": "fall-bounce",
                        "fromFrame": 0,
                        "durationInFrames": 30
                    }]
                }]
            }]
        });

        sync_project_motion_items_from_remotion_scene(&mut project, &composition).unwrap();

        let layers = project
            .get("animationLayers")
            .and_then(Value::as_array)
            .expect("animation layers should exist");
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].get("id").and_then(Value::as_str), Some("scene-1"));
        assert_eq!(
            layers[0]
                .pointer("/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
        assert_eq!(
            layers[0]
                .pointer("/entities/0/color")
                .and_then(Value::as_str),
            Some("#FF0000")
        );

        let motion_items = project
            .get("items")
            .and_then(Value::as_array)
            .expect("items should exist")
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("motion"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(motion_items.len(), 1);
        assert_eq!(
            motion_items[0].get("id").and_then(Value::as_str),
            Some("scene-1")
        );
        assert_eq!(
            motion_items[0]
                .pointer("/props/entities/0/animations/0/kind")
                .and_then(Value::as_str),
            Some("fall-bounce")
        );
        assert_eq!(
            motion_items[0]
                .pointer("/props/entities/0/color")
                .and_then(Value::as_str),
            Some("#FF0000")
        );
    }

    #[test]
    fn selected_remotion_rule_names_loads_all_builtin_remotion_rules() {
        let bundle = load_skill_bundle_sections_from_sources("remotion-best-practices", None);
        let rules = selected_remotion_rule_names(&bundle);
        assert!(rules.contains(&"animations.md".to_string()));
        assert!(rules.contains(&"assets.md".to_string()));
        assert!(rules.contains(&"calculate-metadata.md".to_string()));
        assert!(rules.contains(&"compositions.md".to_string()));
        assert!(rules.contains(&"sequencing.md".to_string()));
        assert!(rules.contains(&"subtitles.md".to_string()));
        assert!(rules.contains(&"text-animations.md".to_string()));
        assert!(rules.contains(&"timing.md".to_string()));
        assert!(rules.contains(&"transitions.md".to_string()));
    }

    #[test]
    fn merge_remotion_scene_patch_preserves_unmodified_existing_scene_data() {
        let existing = json!({
            "title": "Demo",
            "fps": 30,
            "scenes": [{
                "id": "scene-1",
                "startFrame": 0,
                "durationInFrames": 90,
                "overlayTitle": "旧标题",
                "entities": [{
                    "id": "apple-1",
                    "type": "shape",
                    "shape": "apple"
                }]
            }]
        });
        let patch = json!({
            "scenes": [{
                "id": "scene-1",
                "overlayTitle": "新标题"
            }]
        });

        let merged = merge_remotion_scene_patch(&existing, &patch);
        assert_eq!(
            merged
                .pointer("/scenes/0/overlayTitle")
                .and_then(Value::as_str),
            Some("新标题")
        );
        assert_eq!(
            merged
                .pointer("/scenes/0/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
    }
}
