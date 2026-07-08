use crate::json_util::{read_json_value, write_json_pretty};
use crate::persistence::with_store;
use crate::store::spaces as spaces_store;
use crate::{now_iso, payload_string, workspace_root, AppState};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

const SPACE_PROFILE_DIR: &str = "space-profile";
const INIT_STATE_FILE: &str = "init-state.json";
const SPACE_PROFILE_FILE: &str = "SpaceProfile.md";

pub fn handle_space_init_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "space-init:get"
            | "space-init:start"
            | "space-init:progress"
            | "space-init:complete"
            | "space-init:fail"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        let root = workspace_root(state)?;
        match channel {
            "space-init:get" => {
                let next = read_or_default_init_state(&root)?;
                let active_space_id =
                    with_store(state, |store| Ok(spaces_store::active_space_id(&store)))
                        .unwrap_or_else(|_| "unknown".to_string());
                println!(
                    "[space-init] get activeSpaceId={} status={} phase={} root={}",
                    active_space_id,
                    next.get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    next.get("phase")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    root.display()
                );
                Ok(next)
            }
            "space-init:start" => {
                let homepage_url = payload_string(payload, "homepageUrl").unwrap_or_default();
                let platform = payload_string(payload, "platform");
                let account_id = payload_string(payload, "accountId");
                let phase =
                    payload_string(payload, "phase").unwrap_or_else(|| "capture".to_string());
                let progress = payload
                    .get("progress")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let now = now_iso();
                let next = json!({
                    "schemaVersion": 1,
                    "status": "running",
                    "phase": phase,
                    "homepageUrl": homepage_url,
                    "platform": platform,
                    "accountId": account_id,
                    "progress": progress,
                    "startedAt": now,
                    "completedAt": null,
                    "lastError": null,
                    "updatedAt": now,
                });
                write_init_state(&root, &next)?;
                Ok(next)
            }
            "space-init:progress" => {
                let now = now_iso();
                let mut next = read_or_default_init_state(&root)?;
                if next.get("status").and_then(Value::as_str) != Some("completed") {
                    next["status"] = json!("running");
                    if let Some(phase) = payload_string(payload, "phase") {
                        next["phase"] = json!(phase);
                    }
                    if let Some(homepage_url) = payload_string(payload, "homepageUrl") {
                        next["homepageUrl"] = json!(homepage_url);
                    }
                    if let Some(platform) = payload_string(payload, "platform") {
                        next["platform"] = json!(platform);
                    }
                    if let Some(account_id) = payload_string(payload, "accountId") {
                        next["accountId"] = json!(account_id);
                    }
                    if let Some(progress) = payload.get("progress") {
                        next["progress"] = progress.clone();
                    }
                    if next.get("startedAt").and_then(Value::as_str).is_none() {
                        next["startedAt"] = json!(now.clone());
                    }
                    next["completedAt"] = json!(null);
                    next["updatedAt"] = json!(now);
                    write_init_state(&root, &next)?;
                }
                Ok(next)
            }
            "space-init:complete" => {
                let homepage_url = payload_string(payload, "homepageUrl").unwrap_or_default();
                let platform = payload_string(payload, "platform");
                let account_id = payload_string(payload, "accountId");
                let now = now_iso();
                if !payload
                    .get("skipProfileWrite")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    write_space_profile(&root, payload, &now)?;
                }
                let next = json!({
                    "schemaVersion": 1,
                    "status": "completed",
                    "phase": "completed",
                    "homepageUrl": homepage_url,
                    "platform": platform,
                    "accountId": account_id,
                    "progress": payload.get("progress").cloned().unwrap_or_else(|| json!({})),
                    "startedAt": string_from_existing_state(&root, "startedAt"),
                    "completedAt": now,
                    "lastError": null,
                    "updatedAt": now,
                });
                write_init_state(&root, &next)?;
                Ok(next)
            }
            "space-init:fail" => {
                let now = now_iso();
                let mut next = read_or_default_init_state(&root)?;
                next["status"] = json!("failed");
                next["lastError"] =
                    json!(payload_string(payload, "error")
                        .unwrap_or_else(|| "初始化失败".to_string()));
                next["updatedAt"] = json!(now);
                write_init_state(&root, &next)?;
                Ok(next)
            }
            _ => unreachable!(),
        }
    })())
}

pub(crate) fn complete_space_init_after_profile_definition(
    state: &State<'_, AppState>,
    profile_result: &Value,
) -> Result<Option<Value>, String> {
    let root = workspace_root(state)?;
    let current = read_or_default_init_state(&root)?;
    if current.get("status").and_then(Value::as_str) == Some("completed") {
        return Ok(None);
    }
    let phase = current
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = current
        .pointer("/progress/source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let should_complete = source == "space-initialization"
        || matches!(phase, "capture" | "chat" | "positioning");
    if !should_complete {
        return Ok(None);
    }

    let now = now_iso();
    let mut progress = current
        .get("progress")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if let Some(object) = progress.as_object_mut() {
        object.insert("uiStage".to_string(), json!("completed"));
        object.insert("styleDefinitionCompleted".to_string(), json!(true));
        object.insert("styleDefinitionCompletedAt".to_string(), json!(now.clone()));
        if let Some(summary) = profile_result.get("summary").cloned() {
            object.insert("styleDefinitionSummary".to_string(), summary);
        }
    }
    let next = json!({
        "schemaVersion": 1,
        "status": "completed",
        "phase": "completed",
        "homepageUrl": current.get("homepageUrl").cloned().unwrap_or(Value::Null),
        "platform": current.get("platform").cloned().unwrap_or(Value::Null),
        "accountId": current.get("accountId").cloned().unwrap_or(Value::Null),
        "progress": progress,
        "startedAt": current.get("startedAt").cloned().unwrap_or(Value::Null),
        "completedAt": now,
        "lastError": null,
        "updatedAt": now,
    });
    write_init_state(&root, &next)?;
    Ok(Some(next))
}

fn read_or_default_init_state(root: &Path) -> Result<Value, String> {
    let path = init_state_path(root);
    if let Some(value) = read_json_value(&path) {
        return Ok(value);
    }
    let now = now_iso();
    Ok(json!({
        "schemaVersion": 1,
        "status": "not_started",
        "phase": "branch",
        "homepageUrl": null,
        "platform": null,
        "accountId": null,
        "progress": {},
        "startedAt": null,
        "completedAt": null,
        "lastError": null,
        "updatedAt": now,
    }))
}

fn write_init_state(root: &Path, value: &Value) -> Result<(), String> {
    let profile_dir = space_profile_dir(root);
    fs::create_dir_all(&profile_dir).map_err(|error| error.to_string())?;
    write_json_pretty(&profile_dir.join(INIT_STATE_FILE), value)
}

fn write_space_profile(root: &Path, payload: &Value, timestamp: &str) -> Result<(), String> {
    let profile_dir = space_profile_dir(root);
    fs::create_dir_all(&profile_dir).map_err(|error| error.to_string())?;
    let account = payload.get("account").cloned().unwrap_or_else(|| json!({}));
    let username = first_payload_string(&account, &["username", "displayName", "name"])
        .unwrap_or_else(|| "未命名账号".to_string());
    let platform = payload_string(payload, "platform").unwrap_or_else(|| "unknown".to_string());
    let homepage_url = payload_string(payload, "homepageUrl").unwrap_or_default();
    let account_id = payload_string(payload, "accountId").unwrap_or_default();
    let follower_count = first_payload_number(&account, &["followerCount", "stats.followers"])
        .map(|value| value.to_string())
        .unwrap_or_else(|| "未知".to_string());
    let total_post_count = first_payload_number(
        &account,
        &["totalPostCount", "postCount", "stats.totalPosts"],
    )
    .unwrap_or(0);
    let total_like_count =
        first_payload_number(&account, &["totalLikeCount", "stats.totalLikes"]).unwrap_or(0);
    let body = format!(
        "# 空间档案\n\n\
更新时间：{timestamp}\n\n\
## 初始化账号\n\n\
- 平台：{platform}\n\
- 账号：{username}\n\
- 账号 ID：{account_id}\n\
- 主页：{homepage_url}\n\
- 粉丝数：{follower_count}\n\
- 总作品数：{total_post_count}\n\
- 总点赞数：{total_like_count}\n\n\
## 账号诊断\n\n\
待生成。\n"
    );
    fs::write(profile_dir.join(SPACE_PROFILE_FILE), body).map_err(|error| error.to_string())
}

fn string_from_existing_state(root: &Path, key: &str) -> Option<String> {
    read_json_value(&init_state_path(root)).and_then(|value| {
        value
            .get(key)
            .and_then(|item| item.as_str())
            .map(str::to_string)
    })
}

fn space_profile_dir(root: &Path) -> PathBuf {
    root.join(SPACE_PROFILE_DIR)
}

fn init_state_path(root: &Path) -> PathBuf {
    space_profile_dir(root).join(INIT_STATE_FILE)
}

fn first_payload_string(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        nested_value(value, path)
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn first_payload_number(value: &Value, paths: &[&str]) -> Option<i64> {
    paths.iter().find_map(|path| {
        let item = nested_value(value, path)?;
        if let Some(number) = item.as_i64() {
            return Some(number);
        }
        item.as_str()
            .and_then(|text| text.trim().replace(',', "").parse::<i64>().ok())
    })
}

fn nested_value<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |current, segment| current.get(segment))
}
