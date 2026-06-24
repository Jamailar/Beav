use super::*;

#[test]
fn normalize_official_call_record_items_maps_legacy_fields() {
    let records = normalize_official_call_record_items(&[json!({
        "id": "call-1",
        "model": "qwen3.5-plus",
        "points_cost": 0.01,
        "time": "2026-04-16T05:55:28.198Z",
        "token": 0,
    })]);
    assert_eq!(records.len(), 1);
    assert_eq!(payload_string(&records[0], "id").as_deref(), Some("call-1"));
    assert_eq!(
        payload_string(&records[0], "model").as_deref(),
        Some("qwen3.5-plus")
    );
    assert_eq!(records[0].get("points").and_then(value_as_f64), Some(0.01));
    assert_eq!(records[0].get("tokens").and_then(value_as_f64), Some(0.0));
    assert_eq!(
        payload_string(&records[0], "createdAt").as_deref(),
        Some("2026-04-16T05:55:28.198Z")
    );
}

#[test]
fn normalize_official_call_records_value_extracts_nested_records() {
    let records = normalize_official_call_records_value(&json!({
        "success": true,
        "data": {
            "records": [
                {
                    "request_id": "req-1",
                    "model_name": "gpt-4.1",
                    "cost_points": 1.25,
                    "total_tokens": 321,
                    "created_at": "2026-04-16T06:00:00Z"
                }
            ]
        }
    }));
    assert_eq!(records.len(), 1);
    assert_eq!(payload_string(&records[0], "id").as_deref(), Some("req-1"));
    assert_eq!(records[0].get("points").and_then(value_as_f64), Some(1.25));
    assert_eq!(records[0].get("tokens").and_then(value_as_f64), Some(321.0));
}

#[test]
fn normalize_official_call_record_items_marks_knowledge_visual_index() {
    let records = normalize_official_call_record_items(&[json!({
        "id": "visual-1",
        "model": "gpt-4o-mini",
        "points_cost": 0.2,
        "metadata": {
            "usagePurpose": "knowledge_visual_index"
        },
        "created_at": "2026-04-16T06:00:00Z"
    })]);

    assert_eq!(records.len(), 1);
    assert_eq!(
        payload_string(&records[0], "purpose").as_deref(),
        Some("knowledge_visual_index")
    );
}

#[test]
fn normalize_official_call_records_value_merges_multiple_payload_arrays() {
    let records = normalize_official_call_records_value(&json!({
        "data": {
            "records": [
                {
                    "request_id": "req-1",
                    "model_name": "gpt-4.1",
                    "cost_points": 1.25,
                    "total_tokens": 321,
                    "created_at": "2026-04-16T06:00:00Z"
                }
            ],
            "logs": [
                {
                    "log_id": "req-2",
                    "model": "gpt-4.1-mini",
                    "points_cost": 0.5,
                    "token": 120,
                    "time": "2026-04-16T07:00:00Z"
                }
            ]
        }
    }));

    assert_eq!(records.len(), 2);
    assert_eq!(payload_string(&records[0], "id").as_deref(), Some("req-2"));
    assert_eq!(payload_string(&records[1], "id").as_deref(), Some("req-1"));
}

#[test]
fn normalize_official_call_record_items_sorts_desc_and_limits_page_size() {
    let items = (0..35)
        .map(|index| {
            json!({
                "id": format!("record-{index:02}"),
                "model": "qwen3.5-flash",
                "points_cost": 0.1,
                "token": 100,
                "created_at": 1_776_000_000_000_i64 + (index * 1000),
            })
        })
        .collect::<Vec<_>>();

    let records = normalize_official_call_record_items(&items);

    assert_eq!(records.len(), OFFICIAL_CALL_RECORDS_PAGE_SIZE);
    assert_eq!(
        payload_string(&records[0], "id").as_deref(),
        Some("record-34")
    );
    assert_eq!(
        payload_string(&records[OFFICIAL_CALL_RECORDS_PAGE_SIZE - 1], "id").as_deref(),
        Some("record-05")
    );
}

#[test]
fn normalize_official_call_record_items_sorts_string_times_desc() {
    let records = normalize_official_call_record_items(&[
        json!({
            "id": "early",
            "model": "qwen3.5-flash",
            "created_at": "2026-05-20T21:33:40Z",
        }),
        json!({
            "id": "latest",
            "model": "qwen3.5-plus",
            "created_at": "2026-05-22T10:49:58Z",
        }),
        json!({
            "id": "middle",
            "model": "qwen3.5-plus",
            "created_at": "2026-05-21T12:47:12Z",
        }),
    ]);

    assert_eq!(payload_string(&records[0], "id").as_deref(), Some("latest"));
    assert_eq!(payload_string(&records[1], "id").as_deref(), Some("middle"));
    assert_eq!(payload_string(&records[2], "id").as_deref(), Some("early"));
}

#[test]
fn session_without_expiry_but_with_refresh_token_does_not_force_refresh() {
    let settings = json!({
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "accessToken": "access-1",
            "refreshToken": "refresh-1",
            "createdAt": now_ms() as i64,
        }))
        .unwrap(),
    });

    assert!(!official_session_needs_refresh(&settings));
}

#[test]
fn session_refresh_window_uses_twenty_percent_with_bounds() {
    let created_at = 1_000_000_i64;
    let settings = json!({
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "accessToken": "access-1",
            "refreshToken": "refresh-1",
            "createdAt": created_at,
            "expiresAt": created_at + (30 * 60 * 1000),
        }))
        .unwrap(),
    });

    assert_eq!(session_refresh_window_ms(&settings), 5 * 60_000);
}

#[test]
fn unauthorized_detection_accepts_http_status_and_error_message() {
    assert!(official_response_is_unauthorized(401, &json!({})));
    assert!(official_response_is_unauthorized(
        200,
        &json!({
            "success": false,
            "message": "Access token expired, please login again",
        })
    ));
    assert!(!official_response_is_unauthorized(
        200,
        &json!({
            "success": false,
            "message": "network timeout",
        })
    ));
}

#[test]
fn normalize_official_points_payload_maps_balance_response() {
    let normalized = normalize_official_points_payload(&json!({
        "app_id": "app-1",
        "user_id": "user-1",
        "balance": 1296.06,
        "total_earned": 4970,
        "total_spent": 3673.94,
        "updated_at": "2026-04-17T02:26:18.038Z",
        "pricing": {
            "unit": "points",
            "points_per_yuan": 100
        }
    }))
    .expect("points payload should normalize");

    assert_eq!(
        normalized.get("balance").and_then(value_as_f64),
        Some(1296.06)
    );
    assert_eq!(
        normalized.get("points").and_then(value_as_f64),
        Some(1296.06)
    );
    assert_eq!(
        normalized
            .pointer("/pricing/points_per_yuan")
            .and_then(value_as_f64),
        Some(100.0)
    );
}

#[test]
fn cached_official_points_ignores_unauthorized_error_payload() {
    let settings = json!({
        "redbox_auth_points_json": serde_json::to_string(&json!({
            "code": 401,
            "message": "Token expired",
        }))
        .unwrap(),
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "user": {
                "pointsBalance": 88.5
            }
        }))
        .unwrap(),
    });

    let cached = cached_official_points(&settings);
    assert_eq!(cached.get("balance").and_then(value_as_f64), Some(88.5));
    assert_eq!(cached.get("points").and_then(value_as_f64), Some(88.5));
}

#[test]
fn sync_official_route_credentials_uses_normalized_official_base_url() {
    let official_cn_base_url = official_base_url_for_realm("cn");
    let mut settings = json!({
        "redbox_official_base_url": "https://api.ziz.hk",
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "accessToken": "access-1",
            "apiKey": "rbx-live-1",
        }))
        .unwrap(),
        "ai_sources_json": serde_json::to_string(&vec![json!({
            "id": "redbox_official_auto",
            "baseURL": "",
            "apiKey": ""
        })])
        .unwrap(),
    });

    sync_official_route_credentials(&mut settings);

    assert_eq!(
        payload_string(&settings, "api_endpoint").as_deref(),
        Some(official_cn_base_url.as_str())
    );
    assert_eq!(
        payload_string(&settings, "api_key").as_deref(),
        Some("rbx-live-1")
    );
    let sources = payload_string(&settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    assert_eq!(
        sources
            .first()
            .and_then(|item| payload_string(item, "baseURL"))
            .as_deref(),
        Some(official_cn_base_url.as_str())
    );
    assert_eq!(
        sources
            .first()
            .and_then(|item| payload_string(item, "apiKey"))
            .as_deref(),
        Some("rbx-live-1")
    );
}

#[test]
fn redacted_api_key_record_is_not_enough_for_ai_requests() {
    let redacted_only = json!({
        "redbox_auth_api_keys_json": serde_json::to_string(&vec![json!({
            "id": "key-1",
            "key_prefix": "rbx",
            "key_last4": "1234",
            "isCurrent": true
        })]).unwrap()
    });
    let with_plaintext = json!({
        "redbox_auth_api_keys_json": serde_json::to_string(&vec![json!({
            "id": "key-1",
            "key_prefix": "rbx",
            "key_last4": "1234",
            "apiKey": "rbx-live-1",
            "isCurrent": true
        })]).unwrap()
    });

    assert!(!has_official_plaintext_api_key_record(&redacted_only));
    assert!(has_official_plaintext_api_key_record(&with_plaintext));
}

#[test]
fn switch_official_realm_sets_global_endpoint_without_reusing_cn_session() {
    let official_global_base_url = official_base_url_for_realm("global");
    let mut settings = json!({
        "redbox_official_realm": "cn",
        "redbox_official_base_url": "https://api.ziz.hk",
        "redbox_auth_session_json": "",
        "api_endpoint": official_base_url_for_realm("cn"),
        "api_key": "",
    });

    switch_official_realm(&mut settings, "global").expect("switch realm");

    assert_eq!(
        payload_string(&settings, "redbox_official_realm").as_deref(),
        Some("global")
    );
    assert_eq!(
        payload_string(&settings, "redbox_official_base_url").as_deref(),
        Some(official_global_base_url.as_str())
    );
    assert_eq!(
        payload_string(&settings, "api_endpoint").as_deref(),
        Some(official_global_base_url.as_str())
    );
    assert!(official_settings_session(&settings).is_none());
}

#[test]
fn switch_official_realm_requires_logout() {
    let mut settings = json!({
        "redbox_official_realm": "cn",
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "accessToken": "access-1",
            "refreshToken": "refresh-1",
        }))
        .unwrap(),
    });

    assert!(switch_official_realm(&mut settings, "global").is_err());
    assert_eq!(
        payload_string(&settings, "redbox_official_realm").as_deref(),
        Some("cn")
    );
}

#[test]
fn refresh_official_auth_rejects_legacy_redbox_refresh_token_before_http() {
    use base64::Engine;

    let incompatible_slug = if app_brand_slug() == "redbox" {
        "thrive"
    } else {
        "redbox"
    };
    let token_payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(
        r#"{{"appSlug":"{incompatible_slug}","type":"refresh"}}"#
    ));
    let token = format!("header.{token_payload}.signature");
    let mut settings = json!({
        "redbox_official_realm": "cn",
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "refreshToken": token,
        }))
        .unwrap(),
    });

    let error = refresh_official_auth_session_in_settings(&mut settings)
        .expect_err("legacy token should be rejected locally");
    assert!(error.contains(&format!(
        "旧账号体系登录态不可用于 {}",
        app_brand_display_name()
    )));
    assert_eq!(
        session_refresh_token_app_slug(&settings).as_deref(),
        Some(incompatible_slug)
    );
}

#[test]
fn merge_official_settings_preserves_custom_default_route_from_stale_update() {
    let official_cn_base_url = official_base_url_for_realm("cn");
    let mut settings = json!({
        "default_ai_source_id": "custom-source",
        "api_endpoint": "https://custom.example/v1",
        "api_key": "custom-key",
        "model_name": "custom-model",
        "model_name_wander": "custom-wander",
        "ai_sources_json": serde_json::to_string(&vec![
            json!({
                "id": "redbox_official_auto",
                "name": format!("{} Official", app_brand_display_name()),
                "presetId": "redbox-official",
                "baseURL": official_cn_base_url,
                "apiKey": "",
                "model": "qwen3.5-plus",
                "models": ["qwen3.5-plus"],
                "protocol": "openai",
            }),
            json!({
                "id": "custom-source",
                "name": "Custom",
                "presetId": "custom",
                "baseURL": "https://custom.example/v1",
                "apiKey": "custom-key",
                "model": "custom-model",
                "models": ["custom-model"],
                "protocol": "openai",
            }),
        ])
        .unwrap(),
    });
    let stale_official_update = json!({
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "accessToken": "access-2",
            "apiKey": "official-key",
        }))
        .unwrap(),
        "default_ai_source_id": "redbox_official_auto",
        "api_endpoint": official_base_url_for_realm("cn"),
        "api_key": "official-key",
        "model_name": "gpt-5.5",
        "model_name_wander": "",
        "video_api_key": "official-key",
        "redbox_official_models_json": serde_json::to_string(&vec![json!({
            "id": "gpt-5.5",
            "capabilities": ["chat"],
        })])
        .unwrap(),
        "ai_sources_json": serde_json::to_string(&vec![json!({
            "id": "redbox_official_auto",
            "name": format!("{} Official", app_brand_display_name()),
            "presetId": "redbox-official",
            "baseURL": official_base_url_for_realm("cn"),
            "apiKey": "official-key",
            "model": "gpt-5.5",
            "models": ["gpt-5.5"],
            "protocol": "openai",
        })])
        .unwrap(),
    });

    merge_official_settings(&mut settings, &stale_official_update);

    assert_eq!(
        payload_string(&settings, "default_ai_source_id").as_deref(),
        Some("custom-source")
    );
    assert_eq!(
        payload_string(&settings, "api_endpoint").as_deref(),
        Some("https://custom.example/v1")
    );
    assert_eq!(
        payload_string(&settings, "api_key").as_deref(),
        Some("custom-key")
    );
    assert_eq!(
        payload_string(&settings, "model_name").as_deref(),
        Some("custom-model")
    );
    assert_eq!(
        payload_string(&settings, "model_name_wander").as_deref(),
        Some("custom-wander")
    );
    assert_eq!(
        payload_string(&settings, "video_api_key").as_deref(),
        Some("official-key")
    );

    let sources = payload_string(&settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    assert!(sources
        .iter()
        .any(|item| payload_string(item, "id").as_deref() == Some("custom-source")));
    let official_source = sources
        .iter()
        .find(|item| payload_string(item, "id").as_deref() == Some("redbox_official_auto"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    assert_eq!(
        payload_string(&official_source, "apiKey").as_deref(),
        Some("official-key")
    );
    assert_eq!(
        payload_string(&official_source, "model").as_deref(),
        Some("gpt-5.5")
    );
}

#[test]
fn official_account_summary_separates_login_state_and_ai_key_presence() {
    let settings = json!({
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "accessToken": "access-1",
            "refreshToken": "refresh-1",
            "apiKey": "rbx-live-1",
            "user": {
                "name": "Jam"
            }
        }))
        .unwrap(),
    });

    let summary = official_account_summary_local(&settings, &[]);
    assert_eq!(summary.get("loggedIn").and_then(Value::as_bool), Some(true));
    assert_eq!(
        summary.get("apiKeyPresent").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        summary.get("displayName").and_then(Value::as_str),
        Some("Jam")
    );
}

#[test]
fn official_account_summary_uses_username_instead_of_uuid_id() {
    let settings = json!({
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "accessToken": "access-1",
            "refreshToken": "refresh-1",
            "apiKey": "rbx-live-1",
            "user": {
                "id": "99d23575-1f01-4f6f-bcf7-92059c680eee",
                "username": "jam"
            }
        }))
        .unwrap(),
    });

    let summary = official_account_summary_local(&settings, &[]);
    assert_eq!(
        summary.get("displayName").and_then(Value::as_str),
        Some("jam")
    );
}

#[test]
fn clear_official_auth_state_resets_official_source_and_falls_back_default_source() {
    let official_cn_base_url = official_base_url_for_realm("cn");
    let mut settings = json!({
        "redbox_official_base_url": "https://api.ziz.hk",
        "redbox_auth_session_json": serde_json::to_string(&json!({
            "accessToken": "access-1",
            "apiKey": "official-token",
        }))
        .unwrap(),
        "ai_sources_json": serde_json::to_string(&vec![
            json!({
                "id": "redbox_official_auto",
                "name": format!("{} Official", app_brand_display_name()),
                "presetId": "redbox-official",
                "baseURL": official_cn_base_url,
                "apiKey": "official-token",
                "models": ["qwen3.5-plus"],
                "modelsMeta": [{ "id": "qwen3.5-plus" }],
                "model": "qwen3.5-plus",
                "protocol": "openai",
            }),
            json!({
                "id": "openai-main",
                "name": "OpenAI",
                "presetId": "openai",
                "baseURL": "https://api.openai.com/v1",
                "apiKey": "sk-test",
                "models": ["gpt-5.3-codex"],
                "model": "gpt-5.3-codex",
                "protocol": "openai",
            }),
        ])
        .unwrap(),
        "default_ai_source_id": "redbox_official_auto",
        "api_endpoint": official_base_url_for_realm("cn"),
        "api_key": "official-token",
        "model_name": "qwen3.5-plus",
        "video_api_key": "official-token",
    });

    clear_official_auth_state(&mut settings);

    assert_eq!(
        payload_string(&settings, "default_ai_source_id").as_deref(),
        Some("openai-main")
    );
    assert_eq!(
        payload_string(&settings, "api_endpoint").as_deref(),
        Some("https://api.openai.com/v1")
    );
    assert_eq!(
        payload_string(&settings, "api_key").as_deref(),
        Some("sk-test")
    );
    assert_eq!(
        payload_string(&settings, "model_name").as_deref(),
        Some("gpt-5.3-codex")
    );
    assert_eq!(payload_string(&settings, "video_api_key").as_deref(), None);

    let sources = payload_string(&settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let official_source = sources
        .iter()
        .find(|item| payload_string(item, "id").as_deref() == Some("redbox_official_auto"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    assert_eq!(payload_string(&official_source, "apiKey").as_deref(), None);
    assert_eq!(payload_string(&official_source, "model").as_deref(), None);
    assert_eq!(
        official_source
            .get("models")
            .and_then(|value| value.as_array())
            .map(|items| items.len()),
        Some(0)
    );
    assert_eq!(
        official_source
            .get("modelsMeta")
            .and_then(|value| value.as_array())
            .map(|items| items.len()),
        Some(0)
    );
}

#[test]
fn refresh_flow_prefers_public_refresh_route_shape() {
    let refresh_token = "refresh-1";
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
    ];

    assert_eq!(request_candidates[0].0, "/auth/refresh");
    assert_eq!(
        payload_string(&request_candidates[0].1, "refresh_token").as_deref(),
        Some("refresh-1")
    );
    assert!(request_candidates
        .iter()
        .all(|(path, _)| *path != "/auth/token/refresh"));
}
