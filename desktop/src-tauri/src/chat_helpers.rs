use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::{
    configure_background_command, decode_base64_bytes, generate_chat_response,
    invoke_structured_chat_by_protocol,
    load_redbox_prompt_or_embedded, markdown_to_html, now_ms, payload_field, payload_string,
    render_redbox_prompt, resolve_chat_config, resolve_local_path, run_curl_bytes, run_curl_json,
    url_encode_component, AdvisorRecord, WechatOfficialBindingRecord,
};

pub(crate) fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn write_text_file(path: &Path, content: &str) -> Result<(), String> {
    ensure_parent_dir(path)?;
    fs::write(path, content).map_err(|error| error.to_string())
}

pub(crate) fn wechat_binding_public_value(binding: &WechatOfficialBindingRecord) -> Value {
    json!({
        "id": binding.id,
        "name": binding.name,
        "appId": binding.app_id,
        "createdAt": binding.created_at,
        "updatedAt": binding.updated_at,
        "verifiedAt": binding.verified_at,
        "isActive": binding.is_active,
    })
}

pub(crate) fn fetch_wechat_access_token(app_id: &str, secret: &str) -> Result<String, String> {
    let url = format!(
        "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid={}&secret={}",
        url_encode_component(app_id),
        url_encode_component(secret)
    );
    let response = run_curl_json("GET", &url, None, &[], None)?;
    if let Some(token) = response
        .get("access_token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(token.to_string());
    }
    let errcode = response.get("errcode").cloned().unwrap_or(Value::Null);
    let errmsg = response
        .get("errmsg")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown error");
    Err(format!("WeChat token error {errcode}: {errmsg}"))
}

pub(crate) fn create_wechat_remote_draft(
    access_token: &str,
    title: &str,
    content: &str,
    digest: &str,
    thumb_media_id: &str,
) -> Result<String, String> {
    let url = format!(
        "https://api.weixin.qq.com/cgi-bin/draft/add?access_token={}",
        url_encode_component(access_token)
    );
    let response = run_curl_json(
        "POST",
        &url,
        None,
        &[],
        Some(json!({
            "articles": [{
                "title": title,
                "author": "RedClaw",
                "digest": digest,
                "content": markdown_to_html(title, content),
                "content_source_url": "",
                "thumb_media_id": thumb_media_id,
                "need_open_comment": 0,
                "only_fans_can_comment": 0
            }]
        })),
    )?;
    if let Some(media_id) = response
        .get("media_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(media_id.to_string());
    }
    let errcode = response.get("errcode").cloned().unwrap_or(Value::Null);
    let errmsg = response
        .get("errmsg")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown error");
    Err(format!("WeChat draft error {errcode}: {errmsg}"))
}

pub(crate) fn extract_cover_source(payload: &Value) -> Option<String> {
    let direct = payload_string(payload, "cover")
        .or_else(|| payload_string(payload, "coverUrl"))
        .or_else(|| payload_string(payload, "thumbUrl"))
        .or_else(|| payload_string(payload, "imageSource"));
    if direct.is_some() {
        return direct;
    }
    let metadata = payload_field(payload, "metadata")?;
    payload_string(metadata, "cover")
        .or_else(|| payload_string(metadata, "coverUrl"))
        .or_else(|| payload_string(metadata, "thumbUrl"))
        .or_else(|| payload_string(metadata, "imageSource"))
        .or_else(|| {
            payload_field(metadata, "images")
                .and_then(|value| value.as_array())
                .and_then(|items| items.first())
                .and_then(|first| {
                    first
                        .as_str()
                        .map(ToString::to_string)
                        .or_else(|| payload_string(first, "url"))
                        .or_else(|| payload_string(first, "src"))
                        .or_else(|| payload_string(first, "path"))
                        .or_else(|| payload_string(first, "dataUrl"))
                })
        })
}

pub(crate) fn materialize_image_source(source: &str, target_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let trimmed = source.trim();
    if let Some(data) = trimmed.strip_prefix("data:") {
        let extension = if data.starts_with("image/png") {
            "png"
        } else if data.starts_with("image/jpeg") || data.starts_with("image/jpg") {
            "jpg"
        } else if data.starts_with("image/gif") {
            "gif"
        } else {
            "png"
        };
        let encoded = data
            .split_once(',')
            .map(|(_, body)| body)
            .ok_or_else(|| "无效 data URL".to_string())?;
        let bytes = decode_base64_bytes(encoded)?;
        let path = target_dir.join(format!("cover-{}.{}", now_ms(), extension));
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        return Ok(path);
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let bytes = run_curl_bytes("GET", trimmed, None, &[], None)?;
        let path = target_dir.join(format!("cover-{}.jpg", now_ms()));
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        return Ok(path);
    }
    if let Some(path) = resolve_local_path(trimmed).filter(|path| path.exists()) {
        return Ok(path);
    }
    Err("未找到可用封面图".to_string())
}

pub(crate) fn upload_wechat_thumb_media(
    access_token: &str,
    image_path: &Path,
) -> Result<String, String> {
    let url = format!(
        "https://api.weixin.qq.com/cgi-bin/material/add_material?access_token={}&type=image",
        url_encode_component(access_token)
    );
    let mut command = std::process::Command::new("curl");
    configure_background_command(&mut command);
    let output = command
        .arg("-sS")
        .arg("-F")
        .arg(format!("media=@{}", image_path.display()))
        .arg(&url)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("WeChat media upload failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let value: Value =
        serde_json::from_str(&stdout).map_err(|error| format!("Invalid WeChat JSON: {error}"))?;
    if let Some(media_id) = value
        .get("media_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(media_id.to_string());
    }
    let errcode = value.get("errcode").cloned().unwrap_or(Value::Null);
    let errmsg = value
        .get("errmsg")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown error");
    Err(format!("WeChat media upload error {errcode}: {errmsg}"))
}

pub(crate) fn generate_response_with_settings(
    settings: &Value,
    model_config: Option<&Value>,
    prompt: &str,
) -> String {
    generate_chat_response(settings, model_config, prompt)
}

pub(crate) fn generate_structured_response_with_settings(
    settings: &Value,
    model_config: Option<&Value>,
    system_prompt: &str,
    user_prompt: &str,
    require_json: bool,
) -> Result<String, String> {
    let config = resolve_chat_config(settings, model_config)
        .ok_or_else(|| "当前未配置可用模型".to_string())?;
    invoke_structured_chat_by_protocol(
        &config.protocol,
        &config.base_url,
        config.api_key.as_deref(),
        &config.model_name,
        system_prompt,
        user_prompt,
        require_json,
    )
}

pub(crate) fn find_advisor_name(advisors: &[AdvisorRecord], advisor_id: &str) -> String {
    advisors
        .iter()
        .find(|item| item.id == advisor_id)
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "成员".to_string())
}

pub(crate) fn find_advisor_avatar(advisors: &[AdvisorRecord], advisor_id: &str) -> String {
    advisors
        .iter()
        .find(|item| item.id == advisor_id)
        .map(|item| item.avatar.clone())
        .unwrap_or_else(|| "🤖".to_string())
}

pub(crate) fn build_advisor_prompt(
    advisor: Option<&AdvisorRecord>,
    message: &str,
    context: Option<&Value>,
) -> String {
    let template = load_redbox_prompt_or_embedded(
        "runtime/advisors/reply_wrapper.txt",
        include_str!("../../prompts/library/runtime/advisors/reply_wrapper.txt"),
    );
    let advisor_name = advisor
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "智囊团成员".to_string());
    let advisor_personality = advisor
        .map(|item| item.personality.clone())
        .unwrap_or_default();
    let advisor_system_prompt = advisor
        .map(|item| item.system_prompt.clone())
        .unwrap_or_default();
    let context_block = context
        .map(|value| format!("补充上下文：\n{}\n\n", value))
        .unwrap_or_default();
    render_redbox_prompt(
        &template,
        &[
            ("advisor_name", advisor_name),
            ("advisor_personality", advisor_personality),
            ("advisor_system_prompt", advisor_system_prompt),
            ("context_block", context_block),
            ("message", message.to_string()),
        ],
    )
}
