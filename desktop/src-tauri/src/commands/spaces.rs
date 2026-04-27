use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::persistence::{
    apply_workspace_hydration_snapshot, load_workspace_hydration_snapshot, with_store,
    with_store_mut,
};
use crate::{
    active_space_workspace_root_from_store, emit_space_changed,
    ensure_redclaw_space_writing_style_skill, make_id, now_iso, payload_string,
    payload_value_as_string, update_workspace_root_cache, AppState, SpaceRecord,
};

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
        "spaces:list" | "spaces:create" | "spaces:rename" | "spaces:switch"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "spaces:list" => spaces_list_value(state),
            "spaces:create" => {
                let name = payload_value_as_string(payload)
                    .or_else(|| payload_string(payload, "name"))
                    .unwrap_or_default();
                if name.is_empty() {
                    return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
                }

                let result = with_store_mut(state, |store| {
                    let timestamp = now_iso();
                    let space = SpaceRecord {
                        id: make_id("space"),
                        name,
                        created_at: timestamp.clone(),
                        updated_at: timestamp,
                    };
                    store.active_space_id = space.id.clone();
                    store.spaces.push(space.clone());
                    Ok(
                        json!({ "success": true, "space": space, "activeSpaceId": store.active_space_id }),
                    )
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
                        emit_space_changed(app, active_space_id);
                    }
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
