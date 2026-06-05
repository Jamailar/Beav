use super::*;
use crate::fetch_official_models_for_settings;
use crate::store::settings as settings_store;

fn upsert_session_api_key(session: &mut Value, api_key: &str) {
    let normalized = api_key.trim();
    if normalized.is_empty() {
        return;
    }
    if let Some(object) = session.as_object_mut() {
        object.insert("apiKey".to_string(), json!(normalized));
        object.insert("updatedAt".to_string(), json!(now_ms() as i64));
    }
}

fn extract_official_api_key_value(response: &Value) -> Option<String> {
    let payload = official_unwrap_response_payload(response);
    payload_string(&payload, "key")
        .or_else(|| payload_string(&payload, "api_key"))
        .or_else(|| {
            payload
                .get("api_key")
                .and_then(|value| payload_string(value, "key"))
        })
        .or_else(|| {
            payload
                .get("apiKey")
                .and_then(|value| payload_string(value, "key"))
        })
        .filter(|value| !value.trim().is_empty())
}

fn normalize_official_api_key_record(response: &Value) -> Option<Value> {
    let payload = official_unwrap_response_payload(response);
    let api_key = payload
        .get("api_key")
        .cloned()
        .or_else(|| payload.get("apiKey").cloned())?;
    Some(json!({
        "id": payload_string(&api_key, "id").unwrap_or_default(),
        "name": payload_string(&api_key, "name").unwrap_or_else(|| "Default API Key".to_string()),
        "key_prefix": payload_string(&api_key, "key_prefix")
            .or_else(|| payload_string(&api_key, "keyPrefix"))
            .unwrap_or_default(),
        "key_last4": payload_string(&api_key, "key_last4")
            .or_else(|| payload_string(&api_key, "keyLast4"))
            .unwrap_or_default(),
        "is_active": payload_field(&api_key, "is_active")
            .or_else(|| payload_field(&api_key, "isActive"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "created_at": payload_field(&api_key, "created_at")
            .cloned()
            .or_else(|| payload_field(&api_key, "createdAt").cloned())
            .unwrap_or_else(|| json!(now_iso())),
        "last_used_at": payload_field(&api_key, "last_used_at")
            .cloned()
            .or_else(|| payload_field(&api_key, "lastUsedAt").cloned())
            .unwrap_or(Value::Null),
    }))
}

fn merge_official_api_key_records(settings: &mut Value, record: Option<Value>) {
    let Some(record) = record else {
        return;
    };
    let record_id = payload_string(&record, "id").unwrap_or_default();
    let record_prefix = payload_string(&record, "key_prefix").unwrap_or_default();
    let record_last4 = payload_string(&record, "key_last4").unwrap_or_default();
    let mut keys = official_settings_api_keys(settings);
    if let Some(existing) = keys.iter_mut().find(|item| {
        let id_matches =
            !record_id.is_empty() && payload_string(item, "id").unwrap_or_default() == record_id;
        let prefix_matches = !record_prefix.is_empty()
            && payload_string(item, "key_prefix").unwrap_or_default() == record_prefix;
        let last4_matches = !record_last4.is_empty()
            && payload_string(item, "key_last4").unwrap_or_default() == record_last4;
        id_matches || (prefix_matches && last4_matches)
    }) {
        if let Some(existing_object) = existing.as_object_mut() {
            let new_object = record.as_object().cloned().unwrap_or_default();
            let current_plaintext = existing_object
                .get("apiKey")
                .cloned()
                .unwrap_or(Value::Null);
            *existing_object = new_object;
            if !current_plaintext.is_null() {
                existing_object.insert("apiKey".to_string(), current_plaintext);
            }
        } else {
            *existing = record;
        }
    } else {
        keys.insert(0, record);
    }
    write_settings_json_array(settings, "redbox_auth_api_keys_json", &keys);
}

pub(super) fn has_official_plaintext_api_key_record(settings: &Value) -> bool {
    official_settings_api_keys(settings).iter().any(|item| {
        payload_string(item, "apiKey")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    })
}

pub(super) fn ensure_official_ai_api_key_in_settings(
    settings: &mut Value,
) -> Result<Option<String>, String> {
    if let Some(existing) = official_ai_api_key_from_settings(settings) {
        return Ok(Some(existing));
    }
    if let Some(local_plaintext) = official_settings_api_keys(settings)
        .iter()
        .find_map(|item| {
            let is_current = payload_field(item, "isCurrent")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_current {
                payload_string(item, "apiKey")
            } else {
                None
            }
        })
    {
        if let Some(mut session) = official_settings_session(settings) {
            upsert_session_api_key(&mut session, &local_plaintext);
            upsert_official_settings_session(settings, Some(&session));
        }
        sync_official_route_credentials(settings);
        return Ok(Some(local_plaintext));
    }
    let ensure_response = crate::run_official_json_request_response(
        settings,
        "POST",
        "/users/me/api-keys/ensure-default",
        Some(json!({ "name": "Default API Key" })),
    )?;
    let mut resolved_key = extract_official_api_key_value(&ensure_response.body);
    merge_official_api_key_records(
        settings,
        normalize_official_api_key_record(&ensure_response.body),
    );

    if resolved_key.is_none() && !has_official_plaintext_api_key_record(settings) {
        let created = crate::run_official_json_request_response(
            settings,
            "POST",
            "/users/me/api-keys",
            Some(json!({
                "name": format!("{} Desktop {}", app_brand_display_name(), now_iso())
            })),
        )?;
        resolved_key = extract_official_api_key_value(&created.body);
        merge_official_api_key_records(settings, normalize_official_api_key_record(&created.body));
    }

    if let Some(api_key) = resolved_key.clone() {
        if let Some(mut session) = official_settings_session(settings) {
            upsert_session_api_key(&mut session, &api_key);
            upsert_official_settings_session(settings, Some(&session));
        }
        sync_official_route_credentials(settings);
    }

    Ok(resolved_key)
}

pub(super) fn handle_api_keys_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
    request_generation: Option<u64>,
) -> Option<Result<Value, String>> {
    match channel {
        "redbox-auth:api-keys:list" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let remote =
                crate::run_official_json_request(&settings, "GET", "/users/me/api-keys", None)?;
            let remote_items = official_response_items(&remote);
            let local_items = official_settings_api_keys(&settings);
            let merged = remote_items
                .into_iter()
                .map(|item| {
                    let id = payload_string(&item, "id").unwrap_or_default();
                    let prefix = payload_string(&item, "key_prefix")
                        .or_else(|| payload_string(&item, "keyPrefix"))
                        .unwrap_or_default();
                    let last4 = payload_string(&item, "key_last4")
                        .or_else(|| payload_string(&item, "keyLast4"))
                        .unwrap_or_default();
                    let local_plaintext = local_items.iter().find_map(|local| {
                        let id_matches =
                            !id.is_empty() && payload_string(local, "id").unwrap_or_default() == id;
                        let prefix_matches = !prefix.is_empty()
                            && payload_string(local, "key_prefix").unwrap_or_default() == prefix;
                        let last4_matches = !last4.is_empty()
                            && payload_string(local, "key_last4").unwrap_or_default() == last4;
                        if id_matches || (prefix_matches && last4_matches) {
                            payload_string(local, "apiKey")
                        } else {
                            None
                        }
                    });
                    let mut object = item.as_object().cloned().unwrap_or_default();
                    if let Some(api_key) = local_plaintext {
                        object.insert("apiKey".to_string(), json!(api_key));
                    }
                    Value::Object(object)
                })
                .collect::<Vec<_>>();
            write_settings_json_array(&mut settings, "redbox_auth_api_keys_json", &merged);
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-api-key-list",
                None,
                request_generation,
            )?;
            Ok(json!({ "success": true, "keys": merged }))
        })()),
        "redbox-auth:api-keys:create" => Some((|| -> Result<Value, String> {
            let name =
                payload_string(payload, "name").unwrap_or_else(|| "Default API Key".to_string());
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let response = crate::run_official_json_request(
                &settings,
                "POST",
                "/users/me/api-keys",
                Some(json!({ "name": name })),
            )?;
            let mut item = normalize_official_api_key_record(&response).unwrap_or_else(|| {
                json!({
                    "id": "",
                    "name": "Default API Key",
                    "key_prefix": "",
                    "key_last4": "",
                    "is_active": true,
                    "created_at": now_iso(),
                    "last_used_at": Value::Null,
                })
            });
            if let Some(object) = item.as_object_mut() {
                object.insert(
                    "apiKey".to_string(),
                    json!(extract_official_api_key_value(&response).unwrap_or_default()),
                );
                object.insert("isCurrent".to_string(), json!(true));
            }
            merge_official_api_key_records(&mut settings, Some(item.clone()));
            if let Some(mut session) = official_settings_session(&settings) {
                if let Some(api_key) = payload_string(&item, "apiKey") {
                    upsert_session_api_key(&mut session, &api_key);
                    upsert_official_settings_session(&mut settings, Some(&session));
                }
            }
            let models = fetch_official_models_for_settings(&settings);
            write_settings_json_array(&mut settings, "redbox_official_models_json", &models);
            sync_official_route_credentials(&mut settings);
            if !models.is_empty() {
                official_sync_source_into_settings(&mut settings, &models, false);
            }
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-api-key-create",
                None,
                request_generation,
            )?;
            Ok(json!({ "success": true, "data": item }))
        })()),
        "redbox-auth:api-keys:set-current" => Some((|| -> Result<Value, String> {
            let api_key = payload_string(payload, "apiKey").unwrap_or_default();
            if api_key.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少 API Key" }));
            }
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let response = {
                let mut settings = settings_snapshot.clone();
                let mut keys = official_settings_api_keys(&settings);
                let key_present_locally = keys.iter().any(|item| {
                    payload_string(item, "apiKey")
                        .map(|value| value == api_key)
                        .unwrap_or(false)
                });
                if !key_present_locally {
                    return Ok(json!({
                        "success": false,
                        "error": "当前设备没有该 API Key 明文，无法切换为当前使用 Key。请新建一个 API Key。"
                    }));
                }
                for item in &mut keys {
                    let is_match = payload_string(item, "apiKey")
                        .map(|value| value == api_key)
                        .unwrap_or(false);
                    if let Some(object) = item.as_object_mut() {
                        object.insert("isCurrent".to_string(), json!(is_match));
                    }
                }
                write_settings_json_array(&mut settings, "redbox_auth_api_keys_json", &keys);
                let session = official_settings_session(&settings).map(|mut session| {
                    if let Some(object) = session.as_object_mut() {
                        object.insert("apiKey".to_string(), json!(api_key));
                        object.insert("updatedAt".to_string(), json!(now_ms() as i64));
                    }
                    session
                });
                let models = fetch_official_models_for_settings(&settings);
                write_settings_json_array(&mut settings, "redbox_official_models_json", &models);
                if let Some(ref session_value) = session {
                    upsert_official_settings_session(&mut settings, Some(session_value));
                    sync_official_route_credentials(&mut settings);
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models, false);
                    }
                }
                apply_official_settings_update(
                    app,
                    state,
                    &settings,
                    "official-api-key-set-current",
                    None,
                    request_generation,
                )?;
                json!({ "success": true, "session": session, "routeSynced": session.is_some() })
            };
            emit_redbox_auth_session_updated(
                app,
                response
                    .get("session")
                    .cloned()
                    .filter(|value| !value.is_null()),
            );
            trigger_official_cached_data_refresh(app.clone());
            Ok(response)
        })()),
        _ => None,
    }
}
