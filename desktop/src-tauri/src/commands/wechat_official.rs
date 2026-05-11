use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::persistence::{with_store, with_store_mut};
use crate::{
    AppState, WechatOfficialBindingRecord, create_wechat_remote_draft, extract_cover_source,
    fetch_wechat_access_token, make_id, materialize_image_source, now_iso, payload_field,
    payload_string, slug_from_relative_path, upload_wechat_thumb_media,
    wechat_binding_public_value, wechat_drafts_dir, write_text_file,
};

pub fn handle_wechat_official_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "wechat-official:get-status"
        | "wechat-official:bind"
        | "wechat-official:unbind"
        | "wechat-official:create-draft" => (|| -> Result<Value, String> {
            match channel {
                "wechat-official:get-status" => with_store(state, |store| {
                    let bindings = store
                        .wechat_official_bindings
                        .iter()
                        .map(wechat_binding_public_value)
                        .collect::<Vec<_>>();
                    let active_binding = store
                        .wechat_official_bindings
                        .iter()
                        .find(|item| item.is_active)
                        .map(wechat_binding_public_value);
                    Ok(json!({
                        "success": true,
                        "bindings": bindings,
                        "activeBinding": active_binding
                    }))
                }),
                "wechat-official:bind" => {
                    let app_id = payload_string(payload, "appId").unwrap_or_default();
                    let secret = payload_string(payload, "secret").unwrap_or_default();
                    if app_id.trim().is_empty() || secret.trim().is_empty() {
                        return Ok(json!({ "success": false, "error": "缺少 AppID 或 Secret" }));
                    }
                    let name = payload_string(payload, "name").unwrap_or_else(|| {
                        format!("微信公众号 {}", app_id.chars().take(6).collect::<String>())
                    });
                    let set_active = payload_field(payload, "setActive")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(true);
                    fetch_wechat_access_token(&app_id, &secret)?;
                    let verified_at = now_iso();
                    let binding = with_store_mut(state, |store| {
                        if set_active {
                            for item in &mut store.wechat_official_bindings {
                                item.is_active = false;
                            }
                        }
                        if let Some(existing) = store
                            .wechat_official_bindings
                            .iter_mut()
                            .find(|item| item.app_id == app_id)
                        {
                            existing.name = name.clone();
                            existing.secret = Some(secret.clone());
                            existing.updated_at = now_iso();
                            existing.verified_at = Some(verified_at.clone());
                            existing.is_active = set_active || existing.is_active;
                            return Ok(existing.clone());
                        }
                        let timestamp = now_iso();
                        let binding = WechatOfficialBindingRecord {
                            id: make_id("wechat-binding"),
                            name,
                            app_id,
                            secret: Some(secret),
                            created_at: timestamp.clone(),
                            updated_at: timestamp.clone(),
                            verified_at: Some(verified_at.clone()),
                            is_active: set_active || store.wechat_official_bindings.is_empty(),
                        };
                        store.wechat_official_bindings.push(binding.clone());
                        Ok(binding)
                    })?;
                    Ok(json!({ "success": true, "binding": wechat_binding_public_value(&binding) }))
                }
                "wechat-official:unbind" => {
                    let binding_id = payload_string(payload, "bindingId");
                    with_store_mut(state, |store| {
                        if let Some(binding_id) = binding_id {
                            store
                                .wechat_official_bindings
                                .retain(|item| item.id != binding_id);
                        } else {
                            store.wechat_official_bindings.clear();
                        }
                        if !store
                            .wechat_official_bindings
                            .iter()
                            .any(|item| item.is_active)
                        {
                            if let Some(first) = store.wechat_official_bindings.first_mut() {
                                first.is_active = true;
                            }
                        }
                        Ok(json!({ "success": true }))
                    })
                }
                "wechat-official:create-draft" => {
                    let content = payload_string(payload, "content").unwrap_or_default();
                    if content.trim().is_empty() {
                        return Ok(json!({ "success": false, "error": "稿件内容为空" }));
                    }
                    let binding_id = payload_string(payload, "bindingId");
                    let title =
                        payload_string(payload, "title").unwrap_or_else(|| "Untitled".to_string());
                    let binding = with_store(state, |store| {
                        Ok(binding_id
                            .as_deref()
                            .and_then(|id| {
                                store
                                    .wechat_official_bindings
                                    .iter()
                                    .find(|item| item.id == id)
                            })
                            .or_else(|| {
                                store
                                    .wechat_official_bindings
                                    .iter()
                                    .find(|item| item.is_active)
                            })
                            .cloned())
                    })?;
                    let Some(binding) = binding else {
                        return Ok(json!({ "success": false, "error": "请先绑定公众号" }));
                    };
                    let digest = content.chars().take(120).collect::<String>();
                    let thumb_media_id = payload_string(payload, "thumbMediaId")
                        .or_else(|| payload_string(payload, "coverMediaId"))
                        .or_else(|| {
                            payload_field(payload, "metadata")
                                .and_then(|metadata| payload_string(metadata, "thumbMediaId"))
                        })
                        .or_else(|| {
                            payload_field(payload, "metadata")
                                .and_then(|metadata| payload_string(metadata, "coverMediaId"))
                        });
                    let access_token = binding
                        .secret
                        .as_deref()
                        .and_then(|secret| fetch_wechat_access_token(&binding.app_id, secret).ok());
                    let mut resolved_thumb_media_id = thumb_media_id.clone();
                    if resolved_thumb_media_id.is_none() {
                        if let (Some(token), Some(cover_source)) =
                            (access_token.as_deref(), extract_cover_source(payload))
                        {
                            let cover_dir = wechat_drafts_dir(state)?.join("covers");
                            if let Ok(cover_path) =
                                materialize_image_source(&cover_source, &cover_dir)
                            {
                                resolved_thumb_media_id =
                                    upload_wechat_thumb_media(token, &cover_path).ok();
                            }
                        }
                    }
                    let remote_media_id = access_token.as_deref().and_then(|token| {
                        resolved_thumb_media_id.as_deref().and_then(|thumb| {
                            create_wechat_remote_draft(token, &title, &content, &digest, thumb).ok()
                        })
                    });
                    let remote_created = remote_media_id.is_some();
                    let media_id = remote_media_id.unwrap_or_else(|| make_id("wechat-draft"));
                    let draft_path = wechat_drafts_dir(state)?.join(format!(
                        "{}-{}.md",
                        slug_from_relative_path(&binding.name),
                        slug_from_relative_path(&media_id)
                    ));
                    let body = format!(
                        "# {}\n\n> Binding: {} ({})\n> Source: {}\n> Created: {}\n\n{}",
                        title,
                        binding.name,
                        binding.app_id,
                        payload_string(payload, "sourcePath").unwrap_or_default(),
                        now_iso(),
                        content
                    );
                    write_text_file(&draft_path, &body)?;
                    Ok(json!({
                        "success": true,
                        "title": title,
                        "digest": digest,
                        "mediaId": media_id,
                        "path": draft_path.display().to_string(),
                        "remote": remote_created
                    }))
                }
                _ => unreachable!("channel prefiltered"),
            }
        })(),
        _ => return None,
    };

    Some(result)
}
