use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, State};

use crate::membership::{ensure_entitlement, ENTITLEMENT_SPACES_CREATE};
use crate::persistence::{
    apply_workspace_hydration_snapshot, load_workspace_hydration_snapshot, with_store,
    with_store_mut,
};
use crate::store::{settings as settings_store, spaces as spaces_store};
use crate::{
    active_space_workspace_root_from_store, emit_space_changed, emit_space_renamed,
    ensure_redclaw_space_writing_style_skill, make_id, now_iso, payload_string,
    payload_value_as_string, storage_safe_file_stem, update_workspace_root_cache, AppState,
};

pub(crate) fn spaces_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        let (spaces, active_space_id) = spaces_store::list_spaces_snapshot(&store);
        Ok(json!({
            "spaces": spaces,
            "activeSpaceId": active_space_id,
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
                if let Err(error) =
                    ensure_entitlement(state, ENTITLEMENT_SPACES_CREATE, "创始会员可创建新空间")
                {
                    return Ok(json!({ "success": false, "error": error }));
                }
                let Some(raw_name) = payload_string(payload, "name") else {
                    return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
                };
                let name = raw_name.trim().to_string();
                if name.is_empty() {
                    return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
                }
                let now = now_iso();
                let id_stem = storage_safe_file_stem(&name);
                let id = format!("{}-{}", id_stem, make_id("space"));
                let result = with_store_mut(state, |store| {
                    match spaces_store::create_space(store, id.clone(), name, &now) {
                        Ok(space) => Ok(json!({
                            "success": true,
                            "space": space,
                            "activeSpaceId": id,
                        })),
                        Err(error) => Ok(json!({ "success": false, "error": error })),
                    }
                })?;

                if let Some(active_space_id) =
                    result.get("activeSpaceId").and_then(|value| value.as_str())
                {
                    let settings_snapshot =
                        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
                    let _ =
                        update_workspace_root_cache(state, &settings_snapshot, active_space_id)?;
                    let _ = ensure_redclaw_space_writing_style_skill(state)?;
                    emit_space_changed(app, active_space_id);
                }

                Ok(result)
            }
            "spaces:rename" => {
                let Some(id) = payload_string(payload, "id") else {
                    return Ok(json!({ "success": false, "error": "缺少空间 id" }));
                };
                let Some(name) = payload_string(payload, "name") else {
                    return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
                };
                let result = with_store_mut(state, |store| {
                    match spaces_store::rename_space(store, &id, name, &now_iso()) {
                        Ok((space, active_space_id, renamed_active_space)) => Ok(json!({
                            "success": true,
                            "space": space,
                            "activeSpaceId": active_space_id,
                            "renamedActiveSpace": renamed_active_space,
                        })),
                        Err(error) => Ok(json!({ "success": false, "error": error })),
                    }
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
                    if !spaces_store::space_exists(&store, &id) {
                        return Err("空间不存在".to_string());
                    }
                    Ok((
                        active_space_workspace_root_from_store(&store, &id, &state.store_path)?,
                        spaces_store::is_active_space(&store, &id),
                    ))
                })?;

                if target_root.exists() {
                    fs::remove_dir_all(&target_root)
                        .map_err(|error| format!("删除空间目录失败: {error}"))?;
                }

                let result = with_store_mut(state, |store| {
                    match spaces_store::delete_space(store, &id, "default") {
                        Ok((active_space_id, deleted_active_space)) => Ok(json!({
                            "success": true,
                            "deletedSpaceId": id,
                            "activeSpaceId": active_space_id,
                            "deletedActiveSpace": deleted_active_space,
                        })),
                        Err(error) => Ok(json!({ "success": false, "error": error })),
                    }
                })?;

                if deleted_active_space {
                    if let Some(root) = with_store(state, |store| {
                        let active_space_id = spaces_store::active_space_id(&store);
                        Ok(Some(active_space_workspace_root_from_store(
                            &store,
                            &active_space_id,
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
                        let settings_snapshot = with_store(state, |store| {
                            Ok(settings_store::settings_snapshot(&store))
                        })?;
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
                let result =
                    with_store_mut(state, |store| {
                        match spaces_store::switch_active_space(store, &space_id) {
                            Ok(active_space_id) => {
                                Ok(json!({ "success": true, "activeSpaceId": active_space_id }))
                            }
                            Err(error) => Ok(json!({ "success": false, "error": error })),
                        }
                    })?;

                if let Some(root) = with_store(state, |store| {
                    let active_space_id = spaces_store::active_space_id(&store);
                    Ok(Some(active_space_workspace_root_from_store(
                        &store,
                        &active_space_id,
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
                    let settings_snapshot =
                        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
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
