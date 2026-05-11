use serde_json::{Value, json};
use std::fs;
use tauri::{AppHandle, State};

use crate::persistence::{
    apply_workspace_hydration_snapshot, load_workspace_hydration_snapshot, with_store,
    with_store_mut,
};
use crate::{
    AppState, active_space_workspace_root_from_store, emit_space_changed, emit_space_renamed,
    ensure_redclaw_space_writing_style_skill, now_iso, payload_string, payload_value_as_string,
    update_workspace_root_cache,
};

pub(crate) const SPACE_CREATION_DISABLED_ERROR: &str = "创建新空间功能已关闭";

pub(crate) fn spaces_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        Ok(json!({
            "spaces": store.spaces.clone(),
            "activeSpaceId": store.active_space_id,
        }))
    })
}

#[tauri::command]
pub async fn spaces_list(state: State<'_, AppState>) -> Result<Value, String> {
    spaces_list_value(&state)
}

pub fn handle_spaces_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "spaces:list" | "spaces:create" | "spaces:rename" | "spaces:switch" | "spaces:delete"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "spaces:list" => spaces_list_value(state),
            "spaces:create" => {
                Ok(json!({ "success": false, "error": SPACE_CREATION_DISABLED_ERROR }))
            }
            "spaces:rename" => {
                let Some(id) = payload_string(payload, "id") else {
                    return Ok(json!({ "success": false, "error": "缺少空间 id" }));
                };
                let Some(name) = payload_string(payload, "name") else {
                    return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
                };
                let result = with_store_mut(state, |store| {
                    let active_space_id = store.active_space_id.clone();
                    let renamed_active_space = active_space_id == id;
                    let Some(space) = store.spaces.iter_mut().find(|item| item.id == id) else {
                        return Ok(json!({ "success": false, "error": "空间不存在" }));
                    };
                    space.name = name;
                    space.updated_at = now_iso();
                    Ok(json!({
                        "success": true,
                        "space": space.clone(),
                        "activeSpaceId": active_space_id,
                        "renamedActiveSpace": renamed_active_space,
                    }))
                })?;
                if result
                    .get("renamedActiveSpace")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
                {
                    if let Some(active_space_id) =
                        result.get("activeSpaceId").and_then(|value| value.as_str())
                    {
                        let space_name = result
                            .get("space")
                            .and_then(|value| value.get("name"))
                            .and_then(|value| value.as_str())
                            .unwrap_or(active_space_id);
                        emit_space_renamed(app, active_space_id, space_name);
                    }
                }
                Ok(result)
            }
            "spaces:delete" => {
                let Some(id) =
                    payload_value_as_string(payload).or_else(|| payload_string(payload, "id"))
                else {
                    return Ok(json!({ "success": false, "error": "缺少空间 id" }));
                };
                if id == "default" {
                    return Ok(json!({ "success": false, "error": "默认空间不能删除" }));
                }

                let (target_root, deleted_active_space) = with_store(state, |store| {
                    if !store.spaces.iter().any(|item| item.id == id) {
                        return Err("空间不存在".to_string());
                    }
                    Ok((
                        active_space_workspace_root_from_store(&store, &id, &state.store_path)?,
                        store.active_space_id == id,
                    ))
                })?;

                if target_root.exists() {
                    fs::remove_dir_all(&target_root)
                        .map_err(|error| format!("删除空间目录失败: {error}"))?;
                }

                let result = with_store_mut(state, |store| {
                    let Some(index) = store.spaces.iter().position(|item| item.id == id) else {
                        return Ok(json!({ "success": false, "error": "空间不存在" }));
                    };
                    store.spaces.remove(index);
                    if deleted_active_space {
                        store.active_space_id = "default".to_string();
                    }
                    Ok(json!({
                        "success": true,
                        "deletedSpaceId": id,
                        "activeSpaceId": store.active_space_id,
                        "deletedActiveSpace": deleted_active_space,
                    }))
                })?;

                if deleted_active_space {
                    if let Some(root) = with_store(state, |store| {
                        Ok(Some(active_space_workspace_root_from_store(
                            &store,
                            &store.active_space_id,
                            &state.store_path,
                        )?))
                    })? {
                        let snapshot = load_workspace_hydration_snapshot(&root);
                        let _ = with_store_mut(state, |store| {
                            apply_workspace_hydration_snapshot(store, snapshot);
                            Ok(())
                        });
                    }
                }

                if let Some(active_space_id) =
                    result.get("activeSpaceId").and_then(|value| value.as_str())
                {
                    if deleted_active_space {
                        let settings_snapshot =
                            with_store(state, |store| Ok(store.settings.clone()))?;
                        let _ = update_workspace_root_cache(
                            state,
                            &settings_snapshot,
                            active_space_id,
                        )?;
                        let _ = ensure_redclaw_space_writing_style_skill(state)?;
                    }
                    emit_space_changed(app, active_space_id);
                }

                Ok(result)
            }
            "spaces:switch" => {
                let next_id =
                    payload_value_as_string(payload).or_else(|| payload_string(payload, "spaceId"));
                let Some(space_id) = next_id else {
                    return Ok(json!({ "success": false, "error": "缺少空间 id" }));
                };
                let result = with_store_mut(state, |store| {
                    if !store.spaces.iter().any(|item| item.id == space_id) {
                        return Ok(json!({ "success": false, "error": "空间不存在" }));
                    }
                    store.active_space_id = space_id.clone();
                    Ok(json!({ "success": true, "activeSpaceId": store.active_space_id }))
                })?;

                if let Some(root) = with_store(state, |store| {
                    Ok(Some(active_space_workspace_root_from_store(
                        &store,
                        &store.active_space_id,
                        &state.store_path,
                    )?))
                })? {
                    let snapshot = load_workspace_hydration_snapshot(&root);
                    let _ = with_store_mut(state, |store| {
                        apply_workspace_hydration_snapshot(store, snapshot);
                        Ok(())
                    });
                }

                if let Some(active_space_id) =
                    result.get("activeSpaceId").and_then(|value| value.as_str())
                {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let _ =
                        update_workspace_root_cache(state, &settings_snapshot, active_space_id)?;
                    let _ = ensure_redclaw_space_writing_style_skill(state)?;
                    emit_space_changed(app, active_space_id);
                }

                Ok(result)
            }
            _ => unreachable!(),
        }
    })())
}
