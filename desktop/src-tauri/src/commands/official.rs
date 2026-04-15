use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::persistence::{with_store, with_store_mut};
use crate::{
    create_official_payment_form, emit_redbox_auth_data_updated, emit_redbox_auth_session_updated,
    fetch_official_models_for_settings, make_id, normalize_official_auth_session, now_iso, now_ms,
    official_account_summary_local, official_auth_token_from_settings, official_fallback_products,
    official_points_snapshot, official_response_items, official_settings_api_keys,
    official_settings_call_records_list, official_settings_models, official_settings_orders,
    official_settings_points, official_settings_session, official_settings_wechat_login,
    official_sync_source_into_settings, official_unwrap_response_payload, open_payment_form,
    payload_field, payload_string, run_official_json_request, run_official_public_json_request,
    upsert_official_settings_session, write_settings_json_array, write_settings_json_value,
    AppState, REDBOX_OFFICIAL_BASE_URL,
};

fn cached_official_user(settings: &Value) -> Value {
    official_settings_session(settings)
        .and_then(|session| session.get("user").cloned())
        .unwrap_or_else(|| json!({}))
}

fn cached_official_points(settings: &Value) -> Value {
    official_settings_points(settings).unwrap_or_else(|| official_points_snapshot(settings))
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|item| item as f64))
        .or_else(|| value.as_u64().map(|item| item as f64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|item| item.trim().parse::<f64>().ok())
        })
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|item| i64::try_from(item).ok()))
        .or_else(|| value.as_f64().map(|item| item as i64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|item| item.trim().parse::<i64>().ok())
        })
}

fn payload_f64(payload: &Value, key: &str) -> Option<f64> {
    payload_field(payload, key).and_then(value_as_f64)
}

fn session_refresh_token(settings: &Value) -> Option<String> {
    official_settings_session(settings)
        .and_then(|session| {
            payload_string(&session, "refreshToken")
                .or_else(|| payload_string(&session, "refresh_token"))
        })
        .filter(|value| !value.trim().is_empty())
}

fn session_expires_at(settings: &Value) -> Option<i64> {
    official_settings_session(settings)
        .and_then(|session| session.get("expiresAt").and_then(value_as_i64))
}

fn official_session_needs_refresh(settings: &Value) -> bool {
    session_expires_at(settings)
        .map(|expires_at| expires_at <= (now_ms() as i64) + 60_000)
        .unwrap_or(false)
}

fn merge_session_with_existing(existing: Option<&Value>, session: &mut Value) {
    let Some(session_object) = session.as_object_mut() else {
        return;
    };
    let Some(existing_object) = existing.and_then(|value| value.as_object()) else {
        return;
    };

    let user_missing = session_object
        .get("user")
        .map(|value| value.is_null())
        .unwrap_or(true);
    if user_missing {
        if let Some(user) = existing_object.get("user") {
            session_object.insert("user".to_string(), user.clone());
        }
    }

    for key in [
        "refreshToken",
        "apiKey",
        "tokenType",
        "expiresAt",
        "createdAt",
    ] {
        let missing = match session_object.get(key) {
            Some(Value::String(text)) => text.trim().is_empty(),
            Some(Value::Null) => true,
            Some(_) => false,
            None => true,
        };
        if missing {
            if let Some(value) = existing_object.get(key) {
                session_object.insert(key.to_string(), value.clone());
            }
        }
    }

    session_object.insert("updatedAt".to_string(), json!(now_ms() as i64));
}

fn refresh_official_auth_session_in_settings(settings: &mut Value) -> Result<Value, String> {
    let refresh_token =
        session_refresh_token(settings).ok_or_else(|| "当前会话缺少 refresh token".to_string())?;
    let existing_session = official_settings_session(settings);
    let request_candidates = [
        (
            "/auth/refresh",
            json!({
                "refresh_token": refresh_token,
            }),
        ),
        (
            "/auth/refresh",
            json!({
                "refreshToken": refresh_token,
            }),
        ),
        (
            "/auth/refresh-token",
            json!({
                "refresh_token": refresh_token,
            }),
        ),
        (
            "/auth/token/refresh",
            json!({
                "refresh_token": refresh_token,
            }),
        ),
    ];
    let mut last_error = None;

    for (path, body) in request_candidates {
        match run_official_public_json_request(settings, "POST", path, Some(body.clone())) {
            Ok(response) => match normalize_official_auth_session(&response) {
                Ok(mut session) => {
                    merge_session_with_existing(existing_session.as_ref(), &mut session);
                    upsert_official_settings_session(settings, Some(&session));
                    return Ok(session);
                }
                Err(error) => {
                    last_error = Some(error);
                }
            },
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "刷新登录态失败".to_string()))
}

fn sync_remote_orders_into_settings(settings: &mut Value, order: &Value) {
    let out_trade_no = payload_string(order, "out_trade_no")
        .or_else(|| payload_string(order, "outTradeNo"))
        .unwrap_or_default();
    if out_trade_no.is_empty() {
        return;
    }
    let mut orders = official_settings_orders(settings);
    let mut updated = false;
    for item in &mut orders {
        let current = payload_string(item, "out_trade_no")
            .or_else(|| payload_string(item, "outTradeNo"))
            .unwrap_or_default();
        if current == out_trade_no {
            *item = order.clone();
            updated = true;
            break;
        }
    }
    if !updated {
        orders.insert(0, order.clone());
    }
    write_settings_json_array(settings, "redbox_auth_orders_json", &orders);
}

fn query_remote_order_status(settings: &Value, out_trade_no: &str) -> Option<Value> {
    let normalized = out_trade_no.trim();
    if normalized.is_empty() {
        return None;
    }
    let encoded = normalized.replace(' ', "%20");
    let remote = run_official_json_request(
        settings,
        "GET",
        &format!("/payments/orders/status?out_trade_no={encoded}"),
        None,
    )
    .or_else(|_| {
        run_official_json_request(
            settings,
            "GET",
            &format!("/payments/orders/{encoded}"),
            None,
        )
    })
    .or_else(|_| {
        run_official_json_request(
            settings,
            "GET",
            &format!("/billing/orders/status?out_trade_no={encoded}"),
            None,
        )
    })
    .or_else(|_| {
        run_official_json_request(settings, "GET", &format!("/billing/orders/{encoded}"), None)
    })
    .or_else(|_| run_official_json_request(settings, "GET", &format!("/orders/{encoded}"), None))
    .ok()?;
    Some(official_unwrap_response_payload(&remote))
}

fn fetch_remote_official_call_records(settings: &Value) -> Result<Vec<Value>, String> {
    let mut errors = Vec::new();
    for path in [
        "/users/me/ai-usage-logs?page=1&limit=50",
        "/users/me/records",
        "/users/me/logs",
    ] {
        match run_official_json_request(settings, "GET", path, None) {
            Ok(response) => {
                let items = official_response_items(&response);
                if !items.is_empty() {
                    return Ok(items);
                }
            }
            Err(error) => errors.push(format!("{path}: {error}")),
        }
    }

    match run_official_json_request(settings, "GET", "/users/me/points", None) {
        Ok(response) => {
            let items = official_response_items(&response);
            if !items.is_empty() {
                return Ok(items);
            }
        }
        Err(error) => errors.push(format!("/users/me/points: {error}")),
    }

    Err(format!(
        "官方后端未提供调用记录接口：{}",
        errors.join(" | ")
    ))
}

fn update_official_session_user(settings: &mut Value, user: &Value) {
    let next_session = official_settings_session(settings).map(|mut session| {
        if let Some(object) = session.as_object_mut() {
            object.insert("user".to_string(), user.clone());
            object.insert("updatedAt".to_string(), json!(now_ms() as i64));
        }
        session
    });
    if let Some(session_value) = next_session.as_ref() {
        upsert_official_settings_session(settings, Some(session_value));
    }
}

fn refresh_official_cached_data_into_settings(settings: &mut Value) -> Result<Value, String> {
    if official_settings_session(settings).is_none()
        || official_auth_token_from_settings(settings).is_none()
    {
        return Err("官方账号未登录".to_string());
    }

    let mut refreshed = false;

    if official_session_needs_refresh(settings) {
        let _ = refresh_official_auth_session_in_settings(settings);
    }

    if let Ok(response) = run_official_json_request(settings, "GET", "/users/me", None) {
        let user = official_unwrap_response_payload(&response);
        update_official_session_user(settings, &user);
        refreshed = true;
    }

    if let Ok(response) = run_official_json_request(settings, "GET", "/users/me/points", None) {
        let points = official_unwrap_response_payload(&response);
        write_settings_json_value(settings, "redbox_auth_points_json", &points);
        refreshed = true;
    }

    let models = fetch_official_models_for_settings(settings);
    if !models.is_empty() {
        write_settings_json_array(settings, "redbox_official_models_json", &models);
        official_sync_source_into_settings(settings, &models);
        refreshed = true;
    }

    if let Ok(records) = fetch_remote_official_call_records(settings) {
        write_settings_json_array(settings, "redbox_auth_call_records_json", &records);
        refreshed = true;
    }

    if !refreshed {
        return Err("官方数据刷新失败".to_string());
    }

    Ok(json!({
        "user": cached_official_user(settings),
        "points": cached_official_points(settings),
        "models": official_settings_models(settings),
        "records": official_settings_call_records_list(settings),
        "refreshedAt": now_iso(),
    }))
}

pub(crate) fn refresh_official_cached_data(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    if official_settings_session(&settings_snapshot).is_none()
        || official_auth_token_from_settings(&settings_snapshot).is_none()
    {
        return Err("官方账号未登录".to_string());
    }

    let mut updated_settings = settings_snapshot.clone();
    let refreshed = refresh_official_cached_data_into_settings(&mut updated_settings)?;

    with_store_mut(state, |store| {
        let Some(target) = store.settings.as_object_mut() else {
            store.settings = updated_settings.clone();
            return Ok(());
        };
        let source: serde_json::Map<String, Value> =
            updated_settings.as_object().cloned().unwrap_or_default();
        for key in [
            "redbox_auth_session_json",
            "redbox_auth_points_json",
            "redbox_official_models_json",
            "redbox_auth_call_records_json",
            "ai_sources_json",
            "default_ai_source_id",
            "api_endpoint",
            "api_key",
            "model_name",
            "model_name_wander",
            "model_name_chatroom",
            "model_name_knowledge",
            "model_name_redclaw",
            "video_endpoint",
            "video_api_key",
            "video_model",
        ] {
            if let Some(value) = source.get(key) {
                target.insert(key.to_string(), value.clone());
            }
        }
        Ok(())
    })?;

    let _ = app.emit(
        "settings:updated",
        json!({
            "updatedAt": now_iso(),
            "source": "official-background-refresh",
        }),
    );
    emit_redbox_auth_data_updated(app, refreshed.clone());
    Ok(refreshed)
}

pub(crate) fn trigger_official_cached_data_refresh(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        if let Err(error) = refresh_official_cached_data(&app, &state) {
            eprintln!("[RedBox official refresh] {error}");
        }
    });
}

pub fn handle_official_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "redbox-auth:get-config"
        | "redbox-auth:get-session-cached"
        | "redbox-auth:get-session"
        | "redbox-auth:logout"
        | "redbox-auth:send-sms-code"
        | "redbox-auth:login-sms"
        | "redbox-auth:register-sms"
        | "redbox-auth:wechat-url"
        | "redbox-auth:wechat-status"
        | "redbox-auth:login-wechat-code"
        | "redbox-auth:refresh"
        | "redbox-auth:me"
        | "redbox-auth:points"
        | "redbox-auth:models"
        | "redbox-auth:api-keys:list"
        | "redbox-auth:api-keys:create"
        | "redbox-auth:api-keys:set-current"
        | "redbox-auth:products"
        | "redbox-auth:call-records"
        | "redbox-auth:create-page-pay-order"
        | "redbox-auth:create-wechat-native-order"
        | "redbox-auth:order-status"
        | "redbox-auth:open-payment-form"
        | "official:auth:get-session"
        | "official:auth:set-session"
        | "official:auth:clear-session"
        | "official:models:list"
        | "official:account:summary"
        | "official:billing:products"
        | "official:billing:list-orders"
        | "official:billing:create-order"
        | "official:billing:list-calls" => (|| -> Result<Value, String> {
            match channel {
                "redbox-auth:get-config" => Ok(json!({
                    "success": true,
                    "gatewayBase": "https://api.ziz.hk",
                    "appSlug": "redbox",
                    "defaultWechatState": "redconvert-desktop",
                })),
                "redbox-auth:get-session-cached" => with_store(state, |store| {
                    Ok(json!({
                        "success": true,
                        "session": official_settings_session(&store.settings)
                    }))
                }),
                "redbox-auth:get-session" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    let session = official_settings_session(&settings);
                    let models = if session.is_some() {
                        fetch_official_models_for_settings(&settings)
                    } else {
                        official_settings_models(&settings)
                    };
                    write_settings_json_array(
                        &mut settings,
                        "redbox_official_models_json",
                        &models,
                    );
                    if session.is_some() && !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                    store.settings = settings.clone();
                    Ok(json!({
                        "success": true,
                        "session": official_settings_session(&settings),
                        "routeSynced": session.is_some(),
                    }))
                }),
                "redbox-auth:logout" => {
                    let response = with_store_mut(state, |store| {
                        let mut settings = store.settings.clone();
                        upsert_official_settings_session(&mut settings, None);
                        if let Some(object) = settings.as_object_mut() {
                            object.insert("api_key".to_string(), json!(""));
                            object.insert("redbox_auth_points_json".to_string(), json!(""));
                            object.insert("redbox_auth_call_records_json".to_string(), json!("[]"));
                        }
                        store.settings = settings;
                        Ok(json!({ "success": true, "routing": { "cleared": true } }))
                    })?;
                    emit_redbox_auth_session_updated(app, None);
                    Ok(response)
                }
                "redbox-auth:send-sms-code" => {
                    let phone = payload_string(payload, "phone").unwrap_or_default();
                    if phone.trim().is_empty() {
                        Ok(json!({ "success": false, "error": "请输入手机号" }))
                    } else {
                        let request = json!({ "phone": phone });
                        let result = with_store(state, |store| {
                            run_official_public_json_request(
                                &store.settings,
                                "POST",
                                "/auth/send-sms-code",
                                Some(request.clone()),
                            )
                        });
                        match result {
                            Ok(_) => Ok(json!({ "success": true })),
                            Err(error) => Ok(json!({ "success": false, "error": error })),
                        }
                    }
                }
                "redbox-auth:login-sms" | "redbox-auth:register-sms" => {
                    let phone = payload_string(payload, "phone").unwrap_or_default();
                    let code = payload_string(payload, "code").unwrap_or_default();
                    let invite_code = payload_string(payload, "inviteCode");
                    if phone.trim().is_empty() || code.trim().is_empty() {
                        return Ok(json!({ "success": false, "error": "请输入手机号和验证码" }));
                    }
                    let response = with_store_mut(state, |store| {
                        let mut settings = store.settings.clone();
                        let response = run_official_public_json_request(
                            &settings,
                            "POST",
                            if channel == "redbox-auth:login-sms" {
                                "/auth/login/sms"
                            } else {
                                "/auth/register/sms"
                            },
                            Some(json!({
                                "phone": phone,
                                "code": code,
                                "invite_code": invite_code.clone().filter(|value| !value.trim().is_empty()),
                            })),
                        )?;
                        let session = normalize_official_auth_session(&response)?;
                        upsert_official_settings_session(&mut settings, Some(&session));
                        let models = fetch_official_models_for_settings(&settings);
                        write_settings_json_array(
                            &mut settings,
                            "redbox_official_models_json",
                            &models,
                        );
                        if !models.is_empty() {
                            official_sync_source_into_settings(&mut settings, &models);
                        }
                        store.settings = settings;
                        Ok(json!({ "success": true, "session": session, "routeSynced": true }))
                    })?;
                    emit_redbox_auth_session_updated(app, response.get("session").cloned());
                    trigger_official_cached_data_refresh(app.clone());
                    Ok(response)
                }
                "redbox-auth:wechat-url" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    let state_text = payload_string(payload, "state")
                        .unwrap_or_else(|| "redconvert-desktop".to_string());
                    let response = run_official_public_json_request(
                        &settings,
                        "GET",
                        &format!(
                            "/auth/login/wechat/url?state={}",
                            state_text.replace(' ', "%20")
                        ),
                        None,
                    )?;
                    let payload = official_unwrap_response_payload(&response);
                    let data = json!({
                        "enabled": payload_field(&payload, "enabled").and_then(|value| value.as_bool()).unwrap_or(true),
                        "sessionId": payload_string(&payload, "session_id").or_else(|| payload_string(&payload, "sessionId")).unwrap_or_default(),
                        "qrContentUrl": payload_string(&payload, "qr_content_url").or_else(|| payload_string(&payload, "qrContentUrl")).or_else(|| payload_string(&payload, "url")).unwrap_or_default(),
                        "url": payload_string(&payload, "url").unwrap_or_default(),
                        "expiresIn": payload_field(&payload, "expires_in").or_else(|| payload_field(&payload, "expiresIn")).and_then(|value| value.as_i64()).unwrap_or(120),
                        "status": payload_string(&payload, "status").unwrap_or_else(|| "PENDING".to_string()),
                        "createdAt": now_ms(),
                    });
                    write_settings_json_value(
                        &mut settings,
                        "redbox_auth_wechat_login_json",
                        &data,
                    );
                    store.settings = settings;
                    Ok(json!({ "success": true, "data": data }))
                }),
                "redbox-auth:wechat-status" => {
                    let response = with_store_mut(state, |store| {
                        let mut settings = store.settings.clone();
                        let pending =
                            official_settings_wechat_login(&settings).unwrap_or_else(|| json!({}));
                        let requested_session_id =
                            payload_string(payload, "sessionId").unwrap_or_default();
                        let pending_session_id =
                            payload_string(&pending, "sessionId").unwrap_or_default();
                        let session_id = if requested_session_id.is_empty() {
                            pending_session_id
                        } else {
                            requested_session_id
                        };
                        if session_id.is_empty() {
                            return Ok(json!({ "success": false, "error": "sessionId 不能为空" }));
                        }
                        let response = run_official_public_json_request(
                            &settings,
                            "GET",
                            &format!(
                                "/auth/login/wechat/status?session_id={}",
                                session_id.replace(' ', "%20")
                            ),
                            None,
                        )?;
                        let payload = official_unwrap_response_payload(&response);
                        let status = payload_string(&payload, "status")
                            .unwrap_or_else(|| "PENDING".to_string())
                            .to_uppercase();
                        let session = if status == "CONFIRMED" {
                            payload
                                .get("auth_payload")
                                .map(normalize_official_auth_session)
                                .transpose()?
                        } else {
                            None
                        };
                        if let Some(ref session_value) = session {
                            upsert_official_settings_session(&mut settings, Some(session_value));
                            let models = fetch_official_models_for_settings(&settings);
                            write_settings_json_array(
                                &mut settings,
                                "redbox_official_models_json",
                                &models,
                            );
                            if !models.is_empty() {
                                official_sync_source_into_settings(&mut settings, &models);
                            }
                        }
                        let result = json!({
                            "success": true,
                            "data": {
                                "status": status,
                                "sessionId": session_id,
                                "session": session,
                                "raw": payload,
                            }
                        });
                        store.settings = settings;
                        Ok(result)
                    })?;
                    if response
                        .pointer("/data/status")
                        .and_then(|value| value.as_str())
                        == Some("CONFIRMED")
                    {
                        emit_redbox_auth_session_updated(
                            app,
                            response
                                .pointer("/data/session")
                                .cloned()
                                .filter(|value| !value.is_null()),
                        );
                        trigger_official_cached_data_refresh(app.clone());
                    }
                    Ok(response)
                }
                "redbox-auth:login-wechat-code" => {
                    let code = payload_string(payload, "code").unwrap_or_default();
                    if code.trim().is_empty() {
                        return Ok(json!({ "success": false, "error": "缺少微信授权 code" }));
                    }
                    let response = with_store_mut(state, |store| {
                        let mut settings = store.settings.clone();
                        let response = run_official_public_json_request(
                            &settings,
                            "POST",
                            "/auth/login/wechat",
                            Some(json!({ "code": code })),
                        )?;
                        let session = normalize_official_auth_session(&response)?;
                        upsert_official_settings_session(&mut settings, Some(&session));
                        let models = fetch_official_models_for_settings(&settings);
                        write_settings_json_array(
                            &mut settings,
                            "redbox_official_models_json",
                            &models,
                        );
                        if !models.is_empty() {
                            official_sync_source_into_settings(&mut settings, &models);
                        }
                        store.settings = settings;
                        Ok(json!({ "success": true, "session": session, "routeSynced": true }))
                    })?;
                    emit_redbox_auth_session_updated(app, response.get("session").cloned());
                    trigger_official_cached_data_refresh(app.clone());
                    Ok(response)
                }
                "redbox-auth:refresh" => {
                    let response = with_store_mut(state, |store| {
                        let mut settings = store.settings.clone();
                        if official_settings_session(&settings).is_none() {
                            return Ok(json!({ "success": false, "error": "官方账号未登录" }));
                        }
                        let mut token_refreshed = false;
                        match refresh_official_auth_session_in_settings(&mut settings) {
                            Ok(_) => {
                                token_refreshed = true;
                            }
                            Err(error) => {
                                if official_session_needs_refresh(&settings) {
                                    return Ok(json!({ "success": false, "error": error }));
                                }
                            }
                        }
                        let refreshed = refresh_official_cached_data_into_settings(&mut settings)?;
                        let session = official_settings_session(&settings);
                        store.settings = settings;
                        Ok(json!({
                            "success": true,
                            "queued": false,
                            "tokenRefreshed": token_refreshed,
                            "requestedAt": now_iso(),
                            "session": session,
                            "data": refreshed,
                        }))
                    })?;
                    if response.get("success").and_then(|value| value.as_bool()) == Some(true) {
                        emit_redbox_auth_session_updated(
                            app,
                            response
                                .get("session")
                                .cloned()
                                .filter(|value| !value.is_null()),
                        );
                        if let Some(data) = response.get("data").cloned() {
                            emit_redbox_auth_data_updated(app, data);
                        }
                    }
                    Ok(response)
                }
                "redbox-auth:me" => with_store(state, |store| {
                    Ok(json!({
                        "success": true,
                        "user": cached_official_user(&store.settings),
                    }))
                }),
                "redbox-auth:points" => with_store(state, |store| {
                    Ok(json!({
                        "success": true,
                        "points": cached_official_points(&store.settings),
                    }))
                }),
                "redbox-auth:models" => with_store(state, |store| {
                    Ok(json!({
                        "success": true,
                        "models": official_settings_models(&store.settings),
                    }))
                }),
                "redbox-auth:api-keys:list" => with_store(state, |store| {
                    Ok(json!({
                        "success": true,
                        "keys": official_settings_api_keys(&store.settings)
                    }))
                }),
                "redbox-auth:api-keys:create" => with_store_mut(state, |store| {
                    let name =
                        payload_string(payload, "name").unwrap_or_else(|| "默认 Key".to_string());
                    let mut settings = store.settings.clone();
                    let mut keys = official_settings_api_keys(&settings);
                    let key_value = format!("rbx_{}", make_id("key"));
                    let item = json!({
                        "id": make_id("api-key"),
                        "name": name,
                        "apiKey": key_value,
                        "createdAt": now_iso(),
                        "isCurrent": keys.is_empty(),
                    });
                    if keys.is_empty() {
                        if let Some(session) =
                            official_settings_session(&settings).map(|mut session| {
                                if let Some(object) = session.as_object_mut() {
                                    object.insert("apiKey".to_string(), json!(key_value));
                                }
                                session
                            })
                        {
                            upsert_official_settings_session(&mut settings, Some(&session));
                        }
                    }
                    keys.insert(0, item.clone());
                    write_settings_json_array(&mut settings, "redbox_auth_api_keys_json", &keys);
                    store.settings = settings;
                    Ok(json!({ "success": true, "data": item }))
                }),
                "redbox-auth:api-keys:set-current" => {
                    let api_key = payload_string(payload, "apiKey").unwrap_or_default();
                    if api_key.trim().is_empty() {
                        return Ok(json!({ "success": false, "error": "缺少 API Key" }));
                    }
                    let response = with_store_mut(state, |store| {
                        let mut settings = store.settings.clone();
                        let mut keys = official_settings_api_keys(&settings);
                        for item in &mut keys {
                            let is_match = payload_string(item, "apiKey")
                                .map(|value| value == api_key)
                                .unwrap_or(false);
                            if let Some(object) = item.as_object_mut() {
                                object.insert("isCurrent".to_string(), json!(is_match));
                            }
                        }
                        write_settings_json_array(
                            &mut settings,
                            "redbox_auth_api_keys_json",
                            &keys,
                        );
                        let session = official_settings_session(&settings).map(|mut session| {
                            if let Some(object) = session.as_object_mut() {
                                object.insert("apiKey".to_string(), json!(api_key));
                                object.insert("updatedAt".to_string(), json!(now_ms() as i64));
                            }
                            session
                        });
                        let models = fetch_official_models_for_settings(&settings);
                        write_settings_json_array(
                            &mut settings,
                            "redbox_official_models_json",
                            &models,
                        );
                        if let Some(ref session_value) = session {
                            upsert_official_settings_session(&mut settings, Some(session_value));
                            if !models.is_empty() {
                                official_sync_source_into_settings(&mut settings, &models);
                            }
                        }
                        store.settings = settings;
                        Ok(
                            json!({ "success": true, "session": session, "routeSynced": session.is_some() }),
                        )
                    })?;
                    emit_redbox_auth_session_updated(
                        app,
                        response
                            .get("session")
                            .cloned()
                            .filter(|value| !value.is_null()),
                    );
                    trigger_official_cached_data_refresh(app.clone());
                    Ok(response)
                }
                "redbox-auth:products" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    if official_session_needs_refresh(&settings) {
                        let _ = refresh_official_auth_session_in_settings(&mut settings);
                    }
                    let remote =
                        run_official_json_request(&settings, "GET", "/payments/products", None)
                            .or_else(|_| {
                                run_official_json_request(
                                    &settings,
                                    "GET",
                                    "/billing/products",
                                    None,
                                )
                            })
                            .or_else(|_| {
                                run_official_json_request(&settings, "GET", "/products", None)
                            })
                            .ok();
                    let products = remote
                        .as_ref()
                        .map(official_response_items)
                        .filter(|items| !items.is_empty())
                        .unwrap_or_else(official_fallback_products);
                    store.settings = settings;
                    Ok(json!({ "success": true, "products": products }))
                }),
                "redbox-auth:call-records" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    if official_session_needs_refresh(&settings) {
                        let _ = refresh_official_auth_session_in_settings(&mut settings);
                    }
                    let cached_records = official_settings_call_records_list(&settings);
                    let remote = fetch_remote_official_call_records(&settings);
                    let mut error = None;
                    let records = match remote {
                        Ok(records) => {
                            write_settings_json_array(
                                &mut settings,
                                "redbox_auth_call_records_json",
                                &records,
                            );
                            records
                        }
                        Err(next_error) => {
                            error = Some(next_error);
                            cached_records
                        }
                    };
                    store.settings = settings;
                    if let Some(message) = error {
                        let has_records = !records.is_empty();
                        return Ok(json!({
                            "success": has_records,
                            "records": records,
                            "error": message,
                        }));
                    }
                    Ok(json!({ "success": true, "records": records }))
                }),
                "redbox-auth:create-page-pay-order" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    if official_session_needs_refresh(&settings) {
                        let _ = refresh_official_auth_session_in_settings(&mut settings);
                    }
                    let amount = payload_f64(payload, "amount").unwrap_or(9.9);
                    let subject = payload_string(payload, "subject")
                        .unwrap_or_else(|| format!("积分充值 ¥{amount:.2}"));
                    let order = run_official_json_request(
                        &settings,
                        "POST",
                        "/payments/orders/page-pay",
                        Some(json!({
                            "product_id": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                            "productId": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                            "amount": amount,
                            "amount_yuan": amount,
                            "subject": subject,
                            "title": subject,
                            "points_to_deduct": payload_field(payload, "pointsToDeduct").and_then(|value| value.as_i64()).unwrap_or(0),
                            "pointsToDeduct": payload_field(payload, "pointsToDeduct").and_then(|value| value.as_i64()).unwrap_or(0),
                        })),
                    )
                    .map(|response| official_unwrap_response_payload(&response))
                    .unwrap_or_else(|_| {
                        let out_trade_no = make_id("order");
                        let payment_form = create_official_payment_form(&out_trade_no, amount, &subject);
                        json!({
                            "id": out_trade_no,
                            "out_trade_no": out_trade_no,
                            "outTradeNo": out_trade_no,
                            "status": "PENDING",
                            "trade_status": "PENDING",
                            "amount": amount,
                            "subject": subject,
                            "payment_form": payment_form,
                            "created_at": now_iso(),
                        })
                    });
                    let mut orders = official_settings_orders(&settings);
                    orders.insert(0, order.clone());
                    write_settings_json_array(&mut settings, "redbox_auth_orders_json", &orders);
                    store.settings = settings;
                    Ok(json!({ "success": true, "order": order }))
                }),
                "redbox-auth:create-wechat-native-order" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    if official_session_needs_refresh(&settings) {
                        let _ = refresh_official_auth_session_in_settings(&mut settings);
                    }
                    let amount = payload_f64(payload, "amount").unwrap_or(9.9);
                    let out_trade_no = make_id("wxpay");
                    let order = run_official_json_request(
                        &settings,
                        "POST",
                        "/payments/orders/wechat-native",
                        Some(json!({
                            "product_id": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                            "productId": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                            "amount": amount,
                            "amount_yuan": amount,
                            "subject": payload_string(payload, "subject").unwrap_or_else(|| format!("积分充值 ¥{amount:.2}")),
                        })),
                    )
                    .or_else(|_| {
                        run_official_json_request(
                            &settings,
                            "POST",
                            "/wechat/pay/native",
                            Some(json!({
                                "amount": amount,
                                "out_trade_no": out_trade_no,
                            })),
                        )
                    })
                    .map(|response| official_unwrap_response_payload(&response))
                    .unwrap_or_else(|_| {
                        json!({
                            "id": out_trade_no,
                            "out_trade_no": out_trade_no,
                            "outTradeNo": out_trade_no,
                            "status": "PENDING",
                            "trade_status": "PENDING",
                            "amount": amount,
                            "code_url": format!("weixin://wxpay/bizpayurl?pr={}", out_trade_no),
                            "created_at": now_iso(),
                        })
                    });
                    let mut orders = official_settings_orders(&settings);
                    orders.insert(0, order.clone());
                    write_settings_json_array(&mut settings, "redbox_auth_orders_json", &orders);
                    store.settings = settings;
                    Ok(json!({ "success": true, "order": order }))
                }),
                "redbox-auth:order-status" => with_store_mut(state, |store| {
                    let out_trade_no = payload_string(payload, "outTradeNo").unwrap_or_default();
                    let mut settings = store.settings.clone();
                    if official_session_needs_refresh(&settings) {
                        let _ = refresh_official_auth_session_in_settings(&mut settings);
                    }
                    let order =
                        query_remote_order_status(&settings, &out_trade_no).unwrap_or_else(|| {
                            official_settings_orders(&settings)
                                .into_iter()
                                .find(|item| {
                                    payload_string(item, "out_trade_no")
                                        .or_else(|| payload_string(item, "outTradeNo"))
                                        .map(|value| value == out_trade_no)
                                        .unwrap_or(false)
                                })
                                .unwrap_or_else(|| {
                                    json!({
                                        "out_trade_no": out_trade_no,
                                        "outTradeNo": out_trade_no,
                                        "status": "PENDING",
                                        "trade_status": "PENDING",
                                    })
                                })
                        });
                    sync_remote_orders_into_settings(&mut settings, &order);
                    store.settings = settings;
                    Ok(json!({ "success": true, "order": order }))
                }),
                "redbox-auth:open-payment-form" => {
                    let payment_form = payload_string(payload, "paymentForm").unwrap_or_default();
                    match open_payment_form(&payment_form) {
                        Ok(opened) => Ok(json!({ "success": true, "opened": opened })),
                        Err(error) => Ok(json!({ "success": false, "error": error })),
                    }
                }
                "official:auth:get-session" => with_store(state, |store| {
                    let session = official_settings_session(&store.settings);
                    Ok(json!({ "success": true, "session": session }))
                }),
                "official:auth:set-session" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    let session = payload_field(payload, "session")
                        .cloned()
                        .unwrap_or(payload.clone());
                    if let Some(object) = settings.as_object_mut() {
                        object.insert(
                            "redbox_auth_session_json".to_string(),
                            json!(serde_json::to_string(&session)
                                .unwrap_or_else(|_| "{}".to_string())),
                        );
                    }
                    let models = official_settings_models(&settings);
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                    store.settings = settings;
                    Ok(json!({ "success": true, "session": session }))
                }),
                "official:auth:clear-session" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    if let Some(object) = settings.as_object_mut() {
                        object.insert("redbox_auth_session_json".to_string(), json!(""));
                    }
                    store.settings = settings;
                    Ok(json!({ "success": true }))
                }),
                "official:models:list" => with_store_mut(state, |store| {
                    let mut models = official_settings_models(&store.settings);
                    if models.is_empty() {
                        if let Ok(remote) =
                            run_official_json_request(&store.settings, "GET", "/models", None)
                        {
                            models = official_response_items(&remote);
                        }
                    }
                    let mut settings = store.settings.clone();
                    if let Some(object) = settings.as_object_mut() {
                        object.insert(
                            "redbox_official_models_json".to_string(),
                            json!(
                                serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())
                            ),
                        );
                    }
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                    store.settings = settings;
                    Ok(json!({ "success": true, "models": models }))
                }),
                "official:account:summary" => with_store(state, |store| {
                    let models = official_settings_models(&store.settings);
                    let remote =
                        run_official_json_request(&store.settings, "GET", "/account", None)
                            .or_else(|_| {
                                run_official_json_request(&store.settings, "GET", "/me", None)
                            })
                            .ok();
                    Ok(json!({
                        "success": true,
                        "summary": remote.unwrap_or_else(|| official_account_summary_local(&store.settings, &models))
                    }))
                }),
                "official:billing:products" => with_store(state, |store| {
                    let remote = run_official_json_request(
                        &store.settings,
                        "GET",
                        "/billing/products",
                        None,
                    )
                    .or_else(|_| {
                        run_official_json_request(&store.settings, "GET", "/products", None)
                    })
                    .ok();
                    let products = remote
                        .as_ref()
                        .map(official_response_items)
                        .filter(|items| !items.is_empty())
                        .unwrap_or_else(official_fallback_products);
                    Ok(json!({ "success": true, "products": products }))
                }),
                "official:billing:list-orders" => with_store(state, |store| {
                    let remote =
                        run_official_json_request(&store.settings, "GET", "/billing/orders", None)
                            .or_else(|_| {
                                run_official_json_request(&store.settings, "GET", "/orders", None)
                            })
                            .ok();
                    let orders = remote
                        .as_ref()
                        .map(official_response_items)
                        .unwrap_or_default();
                    Ok(json!({ "success": true, "orders": orders }))
                }),
                "official:billing:create-order" => with_store(state, |store| {
                    let product_id = payload_string(payload, "productId").unwrap_or_default();
                    let amount = payload_f64(payload, "amount");
                    let body = json!({
                        "product_id": product_id,
                        "productId": payload_string(payload, "productId"),
                        "amount": amount,
                        "currency": payload_string(payload, "currency").unwrap_or_else(|| "CNY".to_string()),
                    });
                    let order = run_official_json_request(
                        &store.settings,
                        "POST",
                        "/billing/orders",
                        Some(body.clone()),
                    )
                    .or_else(|_| {
                        run_official_json_request(&store.settings, "POST", "/orders", Some(body))
                    })
                    .unwrap_or_else(|_| {
                        json!({
                            "id": make_id("official-order"),
                            "status": "PENDING",
                            "trade_status": "PENDING",
                            "payment_url": REDBOX_OFFICIAL_BASE_URL,
                            "amount": amount.unwrap_or(0.0),
                            "product_id": product_id,
                            "created_at": now_iso(),
                        })
                    });
                    Ok(json!({ "success": true, "order": order }))
                }),
                "official:billing:list-calls" => with_store(state, |store| {
                    match fetch_remote_official_call_records(&store.settings) {
                        Ok(records) => Ok(json!({ "success": true, "records": records })),
                        Err(error) => {
                            Ok(json!({ "success": false, "records": [], "error": error }))
                        }
                    }
                }),
                _ => unreachable!("channel prefiltered"),
            }
        })(),
        _ => return None,
    };

    Some(result)
}
