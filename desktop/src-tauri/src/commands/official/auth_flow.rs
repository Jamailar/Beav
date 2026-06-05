use super::*;
use crate::store::settings as settings_store;

fn update_wechat_login_snapshot(settings: &mut Value, session_id: &str, status: &str, raw: &Value) {
    let mut snapshot = official_settings_wechat_login(settings).unwrap_or_else(|| json!({}));
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("sessionId".to_string(), json!(session_id));
        object.insert("status".to_string(), json!(status));
        object.insert("updatedAt".to_string(), json!(now_ms()));
        object.insert("raw".to_string(), raw.clone());
        if status == "CONFIRMED" {
            object.insert("confirmedAt".to_string(), json!(now_ms()));
        }
    }
    write_settings_json_value(settings, "redbox_auth_wechat_login_json", &snapshot);
}

pub(super) fn handle_auth_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
    _request_generation: Option<u64>,
) -> Option<Result<Value, String>> {
    match channel {
        "redbox-auth:set-realm" => Some((|| -> Result<Value, String> {
            let realm = payload_string(payload, "realm").unwrap_or_default();
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            switch_official_realm(&mut settings, &realm)?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-realm-switch",
                Some(json!({
                    "realm": official_realm_from_settings(&settings),
                    "realms": official_realms_payload(&official_realm_from_settings(&settings)),
                })),
                None,
            )?;
            Ok(json!({
                "success": true,
                "activeRealm": official_realm_from_settings(&settings),
                "realms": official_realms_payload(&official_realm_from_settings(&settings)),
                "session": official_settings_session(&settings),
            }))
        })()),
        "redbox-auth:get-session-cached" => Some((|| -> Result<Value, String> {
            with_store(state, |store| {
                Ok(json!({
                    "success": true,
                    "session": official_settings_session(&settings_store::settings_snapshot(&store))
                }))
            })
        })()),
        "redbox-auth:bootstrap" => Some((|| -> Result<Value, String> {
            let reason = payload_string(payload, "reason").unwrap_or_else(|| "manual".to_string());
            bootstrap_official_auth_session(app, state, &reason)
        })()),
        "redbox-auth:get-session" => Some((|| -> Result<Value, String> {
            bootstrap_official_auth_session(app, state, "get-session")
        })()),
        "redbox-auth:logout" => Some((|| -> Result<Value, String> {
            log_official_auth(state, "logout-request", "manual logout");
            let logout_generation = auth::bump_auth_generation(state, "logout")?;
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            clear_official_auth_state(&mut settings);
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-logout",
                None,
                Some(logout_generation),
            )?;
            let _ = auth::mark_auth_logged_out(app, state);
            Ok(json!({ "success": true, "routing": { "cleared": true } }))
        })()),
        "redbox-auth:send-sms-code" => Some((|| -> Result<Value, String> {
            let phone = payload_string(payload, "phone").unwrap_or_default();
            if phone.trim().is_empty() {
                Ok(json!({ "success": false, "error": "请输入手机号" }))
            } else {
                let settings_snapshot =
                    with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
                let request = json!({ "phone": phone });
                let result = run_official_public_json_request(
                    &settings_snapshot,
                    "POST",
                    "/auth/send-sms-code",
                    Some(request),
                );
                match result {
                    Ok(_) => Ok(json!({ "success": true })),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        })()),
        "redbox-auth:login-sms" | "redbox-auth:register-sms" => {
            Some((|| -> Result<Value, String> {
                let phone = payload_string(payload, "phone").unwrap_or_default();
                let code = payload_string(payload, "code").unwrap_or_default();
                let invite_code = payload_string(payload, "inviteCode");
                if phone.trim().is_empty() || code.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "请输入手机号和验证码" }));
                }
                let settings_snapshot =
                    with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
                let mut settings = settings_snapshot.clone();
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
                let _ = ensure_official_ai_api_key_in_settings(&mut settings)?;
                sync_official_route_credentials(&mut settings);
                seed_official_models_from_cache(&mut settings);
                let login_generation = auth::bump_auth_generation(
                    state,
                    if channel == "redbox-auth:login-sms" {
                        "login-sms"
                    } else {
                        "register-sms"
                    },
                )?;
                apply_official_settings_update(
                    app,
                    state,
                    &settings,
                    if channel == "redbox-auth:login-sms" {
                        "official-login-sms"
                    } else {
                        "official-register-sms"
                    },
                    None,
                    Some(login_generation),
                )?;
                log_official_auth(
                    state,
                    "login-success",
                    format!(
                        "mode={} sessionAccess={} refreshToken={} expiresAt={}",
                        if channel == "redbox-auth:login-sms" {
                            "sms-login"
                        } else {
                            "sms-register"
                        },
                        payload_string(&session, "accessToken").is_some(),
                        payload_string(&session, "refreshToken").is_some(),
                        payload_i64(&session, "expiresAt").unwrap_or_default()
                    ),
                );
                let response = json!({ "success": true, "session": session, "routeSynced": true });
                emit_redbox_auth_session_updated(app, response.get("session").cloned());
                trigger_official_cached_data_refresh(app.clone());
                Ok(response)
            })())
        }
        "redbox-auth:wechat-url" => Some((|| -> Result<Value, String> {
            let mut settings =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
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
            write_settings_json_value(&mut settings, "redbox_auth_wechat_login_json", &data);
            with_store_mut(state, |store| {
                settings_store::replace_settings(store, settings);
                Ok(json!({ "success": true, "data": data }))
            })
        })()),
        "redbox-auth:wechat-status" => Some((|| -> Result<Value, String> {
            let _guard = state
                .official_wechat_status_lock
                .lock()
                .map_err(|_| "微信登录状态锁已损坏".to_string())?;
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let pending = official_settings_wechat_login(&settings).unwrap_or_else(|| json!({}));
            let requested_session_id = payload_string(payload, "sessionId").unwrap_or_default();
            let pending_session_id = payload_string(&pending, "sessionId").unwrap_or_default();
            let session_id = if requested_session_id.is_empty() {
                pending_session_id
            } else {
                requested_session_id
            };
            if session_id.is_empty() {
                return Ok(json!({ "success": false, "error": "sessionId 不能为空" }));
            }
            let existing_status = payload_string(&pending, "status")
                .unwrap_or_default()
                .to_uppercase();
            let existing_session_id = payload_string(&pending, "sessionId").unwrap_or_default();
            if existing_status == "CONFIRMED"
                && existing_session_id == session_id
                && official_settings_session(&settings).is_some()
            {
                return Ok(json!({
                    "success": true,
                    "data": {
                        "status": "CONFIRMED",
                        "sessionId": session_id,
                        "session": official_settings_session(&settings),
                        "raw": pending.get("raw").cloned().unwrap_or_else(|| json!({})),
                    }
                }));
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
            if existing_status != status || status == "CONFIRMED" || status == "SCANNED" {
                log_official_auth(
                    state,
                    "wechat-status",
                    format!(
                        "sessionId={} previous={} next={}",
                        session_id, existing_status, status
                    ),
                );
            }
            update_wechat_login_snapshot(&mut settings, &session_id, &status, &payload);
            let session = if status == "CONFIRMED" {
                Some(normalize_official_auth_session(&payload)?)
            } else {
                None
            };
            if let Some(ref session_value) = session {
                upsert_official_settings_session(&mut settings, Some(session_value));
                let _ = ensure_official_ai_api_key_in_settings(&mut settings)?;
                sync_official_route_credentials(&mut settings);
                seed_official_models_from_cache(&mut settings);
            }
            let response = json!({
                "result": {
                    "success": true,
                    "data": {
                        "status": status,
                        "sessionId": session_id,
                        "session": session,
                        "raw": payload,
                    }
                },
                "settings": settings,
                "session": session,
                "status": status,
            });
            if response.pointer("/status").and_then(|value| value.as_str()) == Some("CONFIRMED") {
                if let Some(settings) = response.get("settings") {
                    let login_generation = auth::bump_auth_generation(state, "login-wechat-poll")?;
                    apply_official_settings_update(
                        app,
                        state,
                        settings,
                        "official-wechat-confirmed",
                        None,
                        Some(login_generation),
                    )?;
                }
                if let Some(session) = response.get("session") {
                    log_official_auth(
                        state,
                        "login-success",
                        format!(
                            "mode=wechat-poll sessionAccess={} refreshToken={} expiresAt={}",
                            payload_string(session, "accessToken").is_some(),
                            payload_string(session, "refreshToken").is_some(),
                            payload_i64(session, "expiresAt").unwrap_or_default()
                        ),
                    );
                }
                emit_redbox_auth_session_updated(
                    app,
                    response
                        .pointer("/session")
                        .cloned()
                        .filter(|value| !value.is_null()),
                );
                trigger_official_cached_data_refresh(app.clone());
            }
            Ok(response
                .get("result")
                .cloned()
                .unwrap_or_else(|| json!({ "success": false })))
        })()),
        "redbox-auth:login-wechat-code" => Some((|| -> Result<Value, String> {
            let code = payload_string(payload, "code").unwrap_or_default();
            if code.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少微信授权 code" }));
            }
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let response = run_official_public_json_request(
                &settings,
                "POST",
                "/auth/login/wechat",
                Some(json!({ "code": code })),
            )?;
            let session = normalize_official_auth_session(&response)?;
            upsert_official_settings_session(&mut settings, Some(&session));
            let _ = ensure_official_ai_api_key_in_settings(&mut settings)?;
            sync_official_route_credentials(&mut settings);
            seed_official_models_from_cache(&mut settings);
            let login_generation = auth::bump_auth_generation(state, "login-wechat-code")?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-login-wechat-code",
                None,
                Some(login_generation),
            )?;
            log_official_auth(
                state,
                "login-success",
                format!(
                    "mode=wechat-code sessionAccess={} refreshToken={} expiresAt={}",
                    payload_string(&session, "accessToken").is_some(),
                    payload_string(&session, "refreshToken").is_some(),
                    payload_i64(&session, "expiresAt").unwrap_or_default()
                ),
            );
            let response = json!({ "success": true, "session": session, "routeSynced": true });
            emit_redbox_auth_session_updated(app, response.get("session").cloned());
            trigger_official_cached_data_refresh(app.clone());
            Ok(response)
        })()),
        "redbox-auth:refresh" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            if !official_session_logged_in(&settings_snapshot) {
                return Ok(json!({ "success": false, "error": "官方账号未登录" }));
            }
            let started = trigger_official_cached_data_refresh(app.clone());
            let response = json!({
                "success": true,
                "queued": true,
                "started": started,
                "alreadyInFlight": !started,
                "requestedAt": now_iso(),
                "session": official_settings_session(&settings_snapshot),
            });
            Ok(response)
        })()),
        "redbox-auth:me" => Some((|| -> Result<Value, String> {
            with_store(state, |store| {
                let settings = settings_store::settings_snapshot(&store);
                Ok(json!({
                    "success": true,
                    "user": cached_official_user(&settings),
                }))
            })
        })()),
        "official:auth:get-session" => Some((|| -> Result<Value, String> {
            with_store(state, |store| {
                let settings = settings_store::settings_snapshot(&store);
                let session = official_settings_session(&settings);
                Ok(json!({ "success": true, "session": session }))
            })
        })()),
        "official:auth:set-session" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let session = payload_field(payload, "session")
                .cloned()
                .unwrap_or(payload.clone());
            upsert_official_settings_session(&mut settings, Some(&session));
            sync_official_route_credentials(&mut settings);
            let models = official_settings_models(&settings);
            if !models.is_empty() {
                official_sync_source_into_settings(&mut settings, &models, false);
            }
            let generation = auth::bump_auth_generation(state, "official-auth-set-session")?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-auth-set-session",
                None,
                Some(generation),
            )?;
            Ok(json!({ "success": true, "session": session }))
        })()),
        "official:auth:clear-session" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            clear_official_auth_state(&mut settings);
            let generation = auth::bump_auth_generation(state, "official-auth-clear-session")?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-auth-clear-session",
                None,
                Some(generation),
            )?;
            Ok(json!({ "success": true }))
        })()),
        _ => None,
    }
}
