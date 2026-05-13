use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{hash_map::DefaultHasher, BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::State;

use crate::json_util::{json_string, read_json_value, write_json_pretty};
use crate::persistence::with_store;
use crate::{now_iso, storage_safe_file_stem, workspace_root, AppState};

const ACCOUNT_SCHEMA_VERSION: i64 = 1;
const ACCOUNTS_BATCH_LIMIT: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AccountCatalog {
    schema_version: i64,
    accounts: Vec<AccountSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AccountSummary {
    id: String,
    platform: String,
    platform_user_id: Option<String>,
    username: String,
    homepage_url: Option<String>,
    avatar_url: Option<String>,
    bound_space_id: Option<String>,
    post_count: i64,
    comment_count: i64,
    media_count: i64,
    last_imported_at: Option<String>,
    last_learned_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AccountImportSessionRequest {
    platform: String,
    homepage_url: Option<String>,
    platform_user_id: Option<String>,
    username: Option<String>,
    avatar_url: Option<String>,
    bio: Option<String>,
    profile: Value,
    options: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AccountPostBatchRequest {
    session_id: Option<String>,
    platform: Option<String>,
    posts: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AccountCommentBatchRequest {
    session_id: Option<String>,
    platform: Option<String>,
    post_id: Option<String>,
    comments: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AccountMediaBatchRequest {
    session_id: Option<String>,
    platform: Option<String>,
    media: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AccountImportCompleteRequest {
    status: Option<String>,
    imported_post_count: Option<i64>,
    failed_post_count: Option<i64>,
    last_error: Option<String>,
}

pub(crate) fn handle_accounts_http_request(
    state: &State<'_, AppState>,
    method: &str,
    path: &str,
    body: &str,
) -> Result<(u16, &'static str, Value), String> {
    let normalized_path = normalize_request_path(path);
    let subpath = normalized_path
        .strip_prefix("/api/accounts")
        .unwrap_or("")
        .trim_start_matches('/');

    match (method, subpath) {
        ("OPTIONS", _) => Ok((204, "No Content", json!({}))),
        ("GET", "") | ("GET", "health") => Ok((200, "OK", accounts_health(state)?)),
        ("POST", "import-sessions") => {
            let request: AccountImportSessionRequest = serde_json::from_str(body)
                .map_err(|error| format!("account import session request 无法解析: {error}"))?;
            Ok((200, "OK", create_import_session(state, request)?))
        }
        ("POST", _) if subpath.ends_with("/posts/batch") => {
            let account_id = subpath
                .strip_suffix("/posts/batch")
                .unwrap_or_default()
                .trim_matches('/');
            let request: AccountPostBatchRequest = serde_json::from_str(body)
                .map_err(|error| format!("account posts batch request 无法解析: {error}"))?;
            Ok((200, "OK", upsert_posts_batch(state, account_id, request)?))
        }
        ("POST", _) if subpath.ends_with("/comments/batch") => {
            let account_id = subpath
                .strip_suffix("/comments/batch")
                .unwrap_or_default()
                .trim_matches('/');
            let request: AccountCommentBatchRequest = serde_json::from_str(body)
                .map_err(|error| format!("account comments batch request 无法解析: {error}"))?;
            Ok((
                200,
                "OK",
                upsert_comments_batch(state, account_id, request)?,
            ))
        }
        ("POST", _) if subpath.ends_with("/media/batch") => {
            let account_id = subpath
                .strip_suffix("/media/batch")
                .unwrap_or_default()
                .trim_matches('/');
            let request: AccountMediaBatchRequest = serde_json::from_str(body)
                .map_err(|error| format!("account media batch request 无法解析: {error}"))?;
            Ok((200, "OK", upsert_media_batch(state, account_id, request)?))
        }
        ("POST", _)
            if subpath.starts_with("import-sessions/") && subpath.ends_with("/complete") =>
        {
            let session_id = subpath
                .trim_start_matches("import-sessions/")
                .trim_end_matches("/complete")
                .trim_matches('/');
            let request: AccountImportCompleteRequest = serde_json::from_str(body)
                .map_err(|error| format!("account import complete request 无法解析: {error}"))?;
            Ok((
                200,
                "OK",
                complete_import_session(state, session_id, request)?,
            ))
        }
        _ => Ok((
            404,
            "Not Found",
            json!({
                "success": false,
                "error": "Accounts API route not found",
                "path": normalized_path,
            }),
        )),
    }
}

pub(crate) fn handle_accounts_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "accounts:health" | "accounts:list" | "accounts:get"
    ) {
        return None;
    }
    Some(match channel {
        "accounts:health" => accounts_health(state),
        "accounts:list" => {
            let catalog = load_catalog_for_state(state);
            catalog.map(|catalog| json!({ "success": true, "accounts": catalog.accounts }))
        }
        "accounts:get" => account_detail(state, payload),
        _ => unreachable!(),
    })
}

pub(crate) fn platform_accounts_for_active_space(state: &State<'_, AppState>) -> Value {
    let catalog = load_catalog_for_state(state).unwrap_or_default();
    platform_accounts_from_catalog(&catalog)
}

pub(crate) fn build_account_prompt_section(state: &State<'_, AppState>) -> Option<String> {
    let catalog = load_catalog_for_state(state).ok()?;
    let account = catalog
        .accounts
        .iter()
        .filter(|item| item.bound_space_id.is_some())
        .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
        .or_else(|| {
            catalog
                .accounts
                .iter()
                .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
        })?;
    let root = account_root(state, &account.platform, &account.id).ok()?;
    let creator_profile = fs::read_to_string(root.join("CreatorProfile.md")).unwrap_or_default();
    let style_skill =
        fs::read_to_string(root.join("writing-style-skill").join("SKILL.md")).unwrap_or_default();
    let memory_candidates =
        fs::read_to_string(root.join("memory-candidates.json")).unwrap_or_default();
    if creator_profile.trim().is_empty() && style_skill.trim().is_empty() {
        return None;
    }
    let mut lines = Vec::new();
    lines.push("## 当前空间运营账号上下文".to_string());
    lines.push(format!(
        "- 平台: {}\n- 账号: {}\n- 账号 ID: {}\n- 已导入历史内容: {} 条",
        account.platform,
        account.username,
        account.platform_user_id.clone().unwrap_or_default(),
        account.post_count,
    ));
    lines.push("使用规则：".to_string());
    lines.push(
        "- 当前空间绑定该账号时，选题、写稿、改稿、视频脚本和 RedClaw 运营默认遵守账号写作风格。"
            .to_string(),
    );
    lines.push(
        "- 不要把账号历史内容全文塞进回答；只引用与当前任务有关的风格、禁区和证据。".to_string(),
    );
    lines.push("- 长期记忆只代表从账号历史中抽取的稳定偏好；如果用户现场表达了更新要求，以用户最新要求为准。".to_string());
    if !creator_profile.trim().is_empty() {
        lines.push("<account_creator_profile_md>".to_string());
        lines.push(truncate_for_prompt(&creator_profile, 9000));
        lines.push("</account_creator_profile_md>".to_string());
    }
    if !style_skill.trim().is_empty() {
        lines.push("<account_writing_style_skill_md>".to_string());
        lines.push(truncate_for_prompt(&style_skill, 8000));
        lines.push("</account_writing_style_skill_md>".to_string());
    }
    if !memory_candidates.trim().is_empty() {
        lines.push("<account_memory_candidates_json>".to_string());
        lines.push(truncate_for_prompt(&memory_candidates, 4000));
        lines.push("</account_memory_candidates_json>".to_string());
    }
    Some(lines.join("\n"))
}

pub(crate) fn sync_completed_transcript_from_knowledge(
    state: &State<'_, AppState>,
    note_id: &str,
    meta: &Value,
    transcript: &str,
) -> Result<Value, String> {
    sync_knowledge_transcription_to_accounts(state, note_id, meta, Some(transcript), None)
}

pub(crate) fn sync_failed_transcription_from_knowledge(
    state: &State<'_, AppState>,
    note_id: &str,
    meta: &Value,
    error: &str,
) -> Result<Value, String> {
    sync_knowledge_transcription_to_accounts(state, note_id, meta, None, Some(error))
}

fn accounts_health(state: &State<'_, AppState>) -> Result<Value, String> {
    let catalog = load_catalog_for_state(state)?;
    Ok(json!({
        "success": true,
        "batchLimit": ACCOUNTS_BATCH_LIMIT,
        "accountCount": catalog.accounts.len(),
        "platformAccounts": platform_accounts_from_catalog(&catalog),
        "routes": {
            "importSessions": "/api/accounts/import-sessions",
            "postsBatch": "/api/accounts/{accountId}/posts/batch",
            "commentsBatch": "/api/accounts/{accountId}/comments/batch",
            "mediaBatch": "/api/accounts/{accountId}/media/batch",
            "completeImportSession": "/api/accounts/import-sessions/{sessionId}/complete"
        }
    }))
}

fn create_import_session(
    state: &State<'_, AppState>,
    request: AccountImportSessionRequest,
) -> Result<Value, String> {
    let platform = normalize_platform(&request.platform)?;
    let account_id = account_id_for_request(&request);
    let now = now_iso();
    let root = account_root(state, &platform, &account_id)?;
    fs::create_dir_all(root.join("posts")).map_err(|error| error.to_string())?;
    fs::create_dir_all(root.join("comments")).map_err(|error| error.to_string())?;
    fs::create_dir_all(root.join("media")).map_err(|error| error.to_string())?;

    let username =
        normalized_string(request.username.clone()).unwrap_or_else(|| "未命名账号".to_string());
    let profile = json!({
        "schemaVersion": ACCOUNT_SCHEMA_VERSION,
        "id": account_id,
        "platform": platform,
        "platformUserId": normalized_string(request.platform_user_id.clone()),
        "username": username,
        "displayName": username,
        "homepageUrl": normalized_string(request.homepage_url.clone()),
        "avatarUrl": normalized_string(request.avatar_url.clone()),
        "bio": normalized_string(request.bio.clone()).unwrap_or_default(),
        "stats": request.profile.get("stats").cloned().unwrap_or_else(|| json!({})),
        "positioning": "",
        "audience": "",
        "contentPillars": [],
        "toneTags": [],
        "forbiddenTopics": [],
        "learningSummaryPath": "learning-summary.md",
        "raw": request.profile,
        "createdAt": now,
        "updatedAt": now,
    });
    write_json_pretty(&root.join("profile.json"), &profile)?;

    let session_id = format!(
        "account-import-{}",
        short_hash(&format!("{account_id}:{now}"))
    );
    let import_state = json!({
        "activeSessionId": session_id,
        "sessions": [{
            "id": session_id,
            "platform": platform,
            "accountId": account_id,
            "status": "running",
            "requestedPostLimit": request.options.get("postLimit").cloned().unwrap_or(Value::Null),
            "importedPostCount": 0,
            "failedPostCount": 0,
            "cursor": {},
            "startedAt": now,
            "updatedAt": now,
            "completedAt": Value::Null,
            "lastError": Value::Null,
        }]
    });
    write_json_pretty(&root.join("import-state.json"), &import_state)?;
    refresh_account_learning_artifacts(&root, state)?;
    let synced_memory_count = sync_account_memory_candidates(state, &root).unwrap_or(0);

    let mut catalog = load_catalog_for_state(state).unwrap_or_default();
    let summary = AccountSummary {
        id: account_id.clone(),
        platform: platform.clone(),
        platform_user_id: normalized_string(request.platform_user_id),
        username: username.clone(),
        homepage_url: normalized_string(request.homepage_url),
        avatar_url: normalized_string(request.avatar_url),
        bound_space_id: active_space_id(state).ok(),
        post_count: existing_post_count(&root),
        comment_count: 0,
        media_count: 0,
        last_imported_at: Some(now.clone()),
        last_learned_at: None,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    upsert_catalog_account(&mut catalog, summary);
    save_catalog_for_state(state, &catalog)?;

    Ok(json!({
        "success": true,
        "workspace": active_workspace_value(state)?,
        "account": {
            "id": account_id,
            "platform": platform,
            "username": username,
        },
        "session": {
            "id": session_id,
            "status": "running",
        },
        "syncedMemoryCount": synced_memory_count
    }))
}

fn upsert_posts_batch(
    state: &State<'_, AppState>,
    account_id: &str,
    request: AccountPostBatchRequest,
) -> Result<Value, String> {
    if account_id.trim().is_empty() {
        return Err("accountId 不能为空".to_string());
    }
    if request.posts.is_empty() {
        return Err("posts 不能为空".to_string());
    }
    if request.posts.len() > ACCOUNTS_BATCH_LIMIT {
        return Err(format!(
            "单次 posts batch 最多支持 {ACCOUNTS_BATCH_LIMIT} 条"
        ));
    }

    let mut catalog = load_catalog_for_state(state).unwrap_or_default();
    let account = catalog
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .ok_or_else(|| "账号档案不存在".to_string())?;
    let root = account_root(state, &account.platform, account_id)?;
    let posts_root = root.join("posts");
    fs::create_dir_all(&posts_root).map_err(|error| error.to_string())?;

    let mut inserted = 0_i64;
    let mut updated = 0_i64;
    let mut failed = Vec::new();
    let now = now_iso();
    for post in request.posts {
        let post_id = post_identifier(&post);
        if post_id.is_empty() {
            failed.push(json!({ "error": "missing post id" }));
            continue;
        }
        let path = posts_root.join(format!("note-{}.json", storage_safe_file_stem(&post_id)));
        let existed = path.exists();
        let mut payload = post;
        if let Some(object) = payload.as_object_mut() {
            object.insert("schemaVersion".to_string(), json!(ACCOUNT_SCHEMA_VERSION));
            object.insert("accountId".to_string(), json!(account_id));
            object.insert("platform".to_string(), json!(account.platform));
            if post_has_video_media(&Value::Object(object.clone())) {
                object.insert("requiresTranscript".to_string(), json!(true));
                if !post_has_transcript(&Value::Object(object.clone())) {
                    object
                        .entry("transcriptionStatus".to_string())
                        .or_insert_with(|| json!("waiting"));
                }
            }
            object
                .entry("capturedAt".to_string())
                .or_insert_with(|| json!(now));
            object.insert("updatedAt".to_string(), json!(now));
        }
        match write_json_pretty(&path, &payload) {
            Ok(()) if existed => updated += 1,
            Ok(()) => inserted += 1,
            Err(error) => failed.push(json!({ "postId": post_id, "error": error })),
        }
    }

    let post_count = existing_post_count(&root);
    if let Some(item) = catalog
        .accounts
        .iter_mut()
        .find(|item| item.id == account_id)
    {
        item.post_count = post_count;
        item.last_imported_at = Some(now.clone());
        item.updated_at = now.clone();
    }
    save_catalog_for_state(state, &catalog)?;
    update_import_state_counts(&root, request.session_id.as_deref(), post_count, &now, None)?;
    let learning = refresh_account_learning_if_ready(&root, state, &mut catalog, account_id, &now)?;
    save_catalog_for_state(state, &catalog)?;

    Ok(json!({
        "success": true,
        "inserted": inserted,
        "updated": updated,
        "skipped": 0,
        "failed": failed,
        "postCount": post_count,
        "syncedMemoryCount": learning.synced_memory_count,
        "learningStatus": learning.status,
        "pendingVideoTranscriptions": learning.pending_video_transcriptions,
        "failedVideoTranscriptions": learning.failed_video_transcriptions,
    }))
}

fn upsert_comments_batch(
    state: &State<'_, AppState>,
    account_id: &str,
    request: AccountCommentBatchRequest,
) -> Result<Value, String> {
    if account_id.trim().is_empty() {
        return Err("accountId 不能为空".to_string());
    }
    if request.comments.is_empty() {
        return Err("comments 不能为空".to_string());
    }
    if request.comments.len() > ACCOUNTS_BATCH_LIMIT {
        return Err(format!(
            "单次 comments batch 最多支持 {ACCOUNTS_BATCH_LIMIT} 条"
        ));
    }

    let mut catalog = load_catalog_for_state(state).unwrap_or_default();
    let account = catalog
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .ok_or_else(|| "账号档案不存在".to_string())?;
    validate_request_platform(request.platform.as_deref(), &account.platform)?;

    let root = account_root(state, &account.platform, account_id)?;
    let comments_root = root.join("comments");
    fs::create_dir_all(&comments_root).map_err(|error| error.to_string())?;

    let fallback_post_id =
        normalized_string(request.post_id).unwrap_or_else(|| "unknown".to_string());
    let mut grouped: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for comment in request.comments {
        let post_id = comment_post_identifier(&comment).unwrap_or_else(|| fallback_post_id.clone());
        grouped.entry(post_id).or_default().push(comment);
    }

    let mut inserted = 0_i64;
    let mut updated = 0_i64;
    let mut failed = Vec::new();
    let now = now_iso();
    for (post_id, comments) in grouped {
        let path = comments_root.join(format!(
            "note-{}.comments.json",
            storage_safe_file_stem(&post_id)
        ));
        let mut document = read_json_value(&path).unwrap_or_else(|| {
            json!({
                "schemaVersion": ACCOUNT_SCHEMA_VERSION,
                "accountId": account_id,
                "platform": account.platform,
                "postId": post_id,
                "comments": [],
                "createdAt": now,
                "updatedAt": now,
            })
        });
        let existing_comments = document
            .get_mut("comments")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| format!("comments 文件结构无效: {}", path.display()))?;

        for mut comment in comments {
            let comment_id = comment_identifier(&comment);
            if let Some(object) = comment.as_object_mut() {
                object.insert("schemaVersion".to_string(), json!(ACCOUNT_SCHEMA_VERSION));
                object.insert("accountId".to_string(), json!(account_id));
                object.insert("platform".to_string(), json!(account.platform));
                object.insert("postId".to_string(), json!(post_id));
                object
                    .entry("capturedAt".to_string())
                    .or_insert_with(|| json!(now));
                object.insert("updatedAt".to_string(), json!(now));
            }
            let existing_index = if comment_id.is_empty() {
                None
            } else {
                existing_comments
                    .iter()
                    .position(|item| comment_identifier(item) == comment_id)
            };
            if let Some(index) = existing_index {
                existing_comments[index] = comment;
                updated += 1;
            } else {
                existing_comments.push(comment);
                inserted += 1;
            }
        }

        if let Some(object) = document.as_object_mut() {
            object.insert("schemaVersion".to_string(), json!(ACCOUNT_SCHEMA_VERSION));
            object.insert("accountId".to_string(), json!(account_id));
            object.insert("platform".to_string(), json!(account.platform));
            object.insert("postId".to_string(), json!(post_id));
            object.insert("updatedAt".to_string(), json!(now));
        }
        if let Err(error) = write_json_pretty(&path, &document) {
            failed.push(json!({ "postId": post_id, "error": error }));
        }
    }

    let comment_count = existing_comment_count(&root);
    if let Some(item) = catalog
        .accounts
        .iter_mut()
        .find(|item| item.id == account_id)
    {
        item.comment_count = comment_count;
        item.last_imported_at = Some(now.clone());
        item.updated_at = now.clone();
    }
    save_catalog_for_state(state, &catalog)?;

    Ok(json!({
        "success": true,
        "sessionId": request.session_id,
        "inserted": inserted,
        "updated": updated,
        "skipped": 0,
        "failed": failed,
        "commentCount": comment_count,
    }))
}

fn upsert_media_batch(
    state: &State<'_, AppState>,
    account_id: &str,
    request: AccountMediaBatchRequest,
) -> Result<Value, String> {
    if account_id.trim().is_empty() {
        return Err("accountId 不能为空".to_string());
    }
    if request.media.is_empty() {
        return Err("media 不能为空".to_string());
    }
    if request.media.len() > ACCOUNTS_BATCH_LIMIT {
        return Err(format!(
            "单次 media batch 最多支持 {ACCOUNTS_BATCH_LIMIT} 条"
        ));
    }

    let mut catalog = load_catalog_for_state(state).unwrap_or_default();
    let account = catalog
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .ok_or_else(|| "账号档案不存在".to_string())?;
    validate_request_platform(request.platform.as_deref(), &account.platform)?;

    let root = account_root(state, &account.platform, account_id)?;
    let media_root = root.join("media");
    fs::create_dir_all(&media_root).map_err(|error| error.to_string())?;

    let mut inserted = 0_i64;
    let mut updated = 0_i64;
    let mut failed = Vec::new();
    let now = now_iso();
    for media in request.media {
        let media_id = media_identifier(&media);
        if media_id.is_empty() {
            failed.push(json!({ "error": "missing media id" }));
            continue;
        }
        let path = media_root.join(format!("media-{}.json", storage_safe_file_stem(&media_id)));
        let existed = path.exists();
        let payload = normalize_media_payload(media, account_id, &account.platform, &now);
        match write_json_pretty(&path, &payload) {
            Ok(()) if existed => updated += 1,
            Ok(()) => inserted += 1,
            Err(error) => failed.push(json!({ "mediaId": media_id, "error": error })),
        }
    }

    let media_count = existing_media_count(&root);
    if let Some(item) = catalog
        .accounts
        .iter_mut()
        .find(|item| item.id == account_id)
    {
        item.media_count = media_count;
        item.last_imported_at = Some(now.clone());
        item.updated_at = now.clone();
    }
    save_catalog_for_state(state, &catalog)?;

    Ok(json!({
        "success": true,
        "sessionId": request.session_id,
        "inserted": inserted,
        "updated": updated,
        "skipped": 0,
        "failed": failed,
        "mediaCount": media_count,
    }))
}

fn complete_import_session(
    state: &State<'_, AppState>,
    session_id: &str,
    request: AccountImportCompleteRequest,
) -> Result<Value, String> {
    let root = find_account_root_by_session(state, session_id)?
        .ok_or_else(|| "导入会话不存在".to_string())?;
    let now = now_iso();
    let status = request.status.unwrap_or_else(|| "completed".to_string());
    update_import_state_counts(
        &root,
        Some(session_id),
        request
            .imported_post_count
            .unwrap_or_else(|| existing_post_count(&root)),
        &now,
        Some(json!({
            "status": status,
            "failedPostCount": request.failed_post_count.unwrap_or(0),
            "lastError": request.last_error,
            "completedAt": now,
        })),
    )?;
    let mut catalog = load_catalog_for_state(state).unwrap_or_default();
    let learning = refresh_account_learning_if_ready(&root, state, &mut catalog, "", &now)?;
    save_catalog_for_state(state, &catalog)?;
    Ok(json!({
        "success": true,
        "sessionId": session_id,
        "status": status,
        "syncedMemoryCount": learning.synced_memory_count,
        "learningStatus": learning.status,
        "pendingVideoTranscriptions": learning.pending_video_transcriptions,
        "failedVideoTranscriptions": learning.failed_video_transcriptions,
    }))
}

fn platform_accounts_from_catalog(catalog: &AccountCatalog) -> Value {
    let platforms = ["xiaohongshu", "douyin", "bilibili"];
    let mut map = serde_json::Map::new();
    for platform in platforms {
        let account = catalog
            .accounts
            .iter()
            .filter(|item| item.platform == platform)
            .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
            .map(|item| {
                json!({
                    "bound": true,
                    "source": "account_profile",
                    "profileId": item.id,
                    "username": item.username,
                    "id": item.platform_user_id,
                    "platform": item.platform,
                })
            })
            .unwrap_or_else(|| {
                json!({
                    "bound": false,
                    "source": Value::Null,
                    "profileId": Value::Null,
                    "username": Value::Null,
                    "id": Value::Null,
                    "platform": platform,
                })
            });
        map.insert(platform.to_string(), account);
    }
    Value::Object(map)
}

fn account_detail(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let account_id = payload
        .get("accountId")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "accountId 不能为空".to_string())?;
    let catalog = load_catalog_for_state(state).unwrap_or_default();
    let account = catalog
        .accounts
        .iter()
        .find(|item| item.id == account_id)
        .cloned()
        .ok_or_else(|| "账号档案不存在".to_string())?;
    let root = account_root(state, &account.platform, &account.id)?;
    let memory_candidates = read_json_value(&root.join("memory-candidates.json"))
        .unwrap_or_else(|| json!({ "candidates": [] }));
    Ok(json!({
        "success": true,
        "account": account,
        "profile": read_json_value(&root.join("profile.json")).unwrap_or_else(|| json!({})),
        "posts": account_post_summaries(&root),
        "media": account_media_summaries(&root),
        "comments": account_comment_summaries(&root),
        "learningState": read_json_value(&root.join("learning-state.json")).unwrap_or_else(|| json!({})),
        "creatorProfile": read_text_if_exists(&root.join("CreatorProfile.md")),
        "writingStyleSkill": read_text_if_exists(&root.join("writing-style-skill").join("SKILL.md")),
        "learningSummary": read_text_if_exists(&root.join("learning-summary.md")),
        "memoryCandidates": memory_candidates,
        "artifactPaths": {
            "root": root.to_string_lossy().to_string(),
            "profile": root.join("profile.json").to_string_lossy().to_string(),
            "creatorProfile": root.join("CreatorProfile.md").to_string_lossy().to_string(),
            "writingStyleSkill": root.join("writing-style-skill").join("SKILL.md").to_string_lossy().to_string(),
            "learningSummary": root.join("learning-summary.md").to_string_lossy().to_string(),
            "memoryCandidates": root.join("memory-candidates.json").to_string_lossy().to_string(),
        }
    }))
}

fn sync_knowledge_transcription_to_accounts(
    state: &State<'_, AppState>,
    note_id: &str,
    meta: &Value,
    transcript: Option<&str>,
    transcription_error: Option<&str>,
) -> Result<Value, String> {
    let mut candidates = BTreeSet::new();
    push_transcription_candidate(&mut candidates, note_id);
    if let Some(stripped) = note_id.strip_prefix("knowledge-") {
        push_transcription_candidate(&mut candidates, stripped);
    }
    for key in [
        "externalId",
        "dedupeKey",
        "sourceUrl",
        "sourceLink",
        "videoUrl",
    ] {
        if let Some(value) = json_string(meta, key) {
            push_transcription_candidate(&mut candidates, &value);
        }
    }

    let mut catalog = load_catalog_for_state(state).unwrap_or_default();
    let accounts = catalog.accounts.clone();
    let now = now_iso();
    let mut accounts_updated = 0_i64;
    let mut posts_updated = 0_i64;
    let mut refreshed_accounts = Vec::new();

    for account in accounts {
        let root = account_root(state, &account.platform, &account.id)?;
        let posts_root = root.join("posts");
        let mut account_changed = false;
        for path in json_files_in_dir(&posts_root) {
            let Some(mut post) = read_json_value(&path) else {
                continue;
            };
            if !account_post_matches_transcription_candidates(&post, &candidates) {
                continue;
            }
            if let Some(object) = post.as_object_mut() {
                object.insert("requiresTranscript".to_string(), json!(true));
                object.insert("transcriptionSourceNoteId".to_string(), json!(note_id));
                object.insert("transcriptUpdatedAt".to_string(), json!(now));
                if let Some(transcript) = transcript {
                    object.insert("transcript".to_string(), json!(transcript));
                    object.insert("transcriptionStatus".to_string(), json!("completed"));
                    object.insert("transcriptionError".to_string(), Value::Null);
                } else if let Some(error) = transcription_error {
                    object.insert("transcriptionStatus".to_string(), json!("failed"));
                    object.insert("transcriptionError".to_string(), json!(error));
                }
            }
            write_json_pretty(&path, &post)?;
            posts_updated += 1;
            account_changed = true;
        }
        if account_changed {
            accounts_updated += 1;
            if transcript.is_some() {
                let learning = refresh_account_learning_if_ready(
                    &root,
                    state,
                    &mut catalog,
                    &account.id,
                    &now,
                )?;
                refreshed_accounts.push(json!({
                    "accountId": account.id,
                    "platform": account.platform,
                    "learningStatus": learning.status,
                    "pendingVideoTranscriptions": learning.pending_video_transcriptions,
                    "failedVideoTranscriptions": learning.failed_video_transcriptions,
                    "syncedMemoryCount": learning.synced_memory_count,
                }));
            } else {
                write_account_learning_state(&root, "transcription_failed", 0, 1, &now)?;
            }
        }
    }
    save_catalog_for_state(state, &catalog)?;
    Ok(json!({
        "success": true,
        "accountsUpdated": accounts_updated,
        "postsUpdated": posts_updated,
        "refreshedAccounts": refreshed_accounts,
    }))
}

fn push_transcription_candidate(candidates: &mut BTreeSet<String>, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    candidates.insert(trimmed.to_string());
    candidates.insert(storage_safe_file_stem(trimmed));
}

fn account_post_matches_transcription_candidates(
    post: &Value,
    candidates: &BTreeSet<String>,
) -> bool {
    [
        post_identifier(post),
        json_string(post, "knowledgeEntryId").unwrap_or_default(),
        json_string(post, "transcriptionSourceNoteId").unwrap_or_default(),
        json_string(post, "url").unwrap_or_default(),
    ]
    .iter()
    .any(|value| {
        let trimmed = value.trim();
        !trimmed.is_empty()
            && (candidates.contains(trimmed)
                || candidates.contains(&storage_safe_file_stem(trimmed)))
    })
}

fn account_post_summaries(root: &Path) -> Vec<Value> {
    let mut items = json_files_in_dir(&root.join("posts"))
        .into_iter()
        .filter_map(|path| {
            let value = read_json_value(&path)?;
            let post_id = post_identifier(&value);
            let media = value
                .get("media")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Some(json!({
                "id": if post_id.is_empty() { path.file_stem().and_then(|value| value.to_str()).unwrap_or_default().to_string() } else { post_id },
                "title": json_string(&value, "title").unwrap_or_else(|| "未命名内容".to_string()),
                "content": json_string(&value, "content").unwrap_or_default(),
                "url": json_string(&value, "url").unwrap_or_default(),
                "publishedAt": json_string(&value, "publishedAt").unwrap_or_default(),
                "capturedAt": json_string(&value, "capturedAt").unwrap_or_default(),
                "updatedAt": json_string(&value, "updatedAt").unwrap_or_default(),
                "platform": json_string(&value, "platform").unwrap_or_default(),
                "kind": json_string(&value, "kind").unwrap_or_default(),
                "stats": value.get("stats").cloned().unwrap_or_else(|| json!({})),
                "tags": value.get("tags").cloned().unwrap_or_else(|| json!([])),
                "media": media,
            }))
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        sort_time(right).cmp(&sort_time(left)).then_with(|| {
            json_string(right, "id")
                .unwrap_or_default()
                .cmp(&json_string(left, "id").unwrap_or_default())
        })
    });
    items
}

fn account_media_summaries(root: &Path) -> Vec<Value> {
    let mut items = json_files_in_dir(&root.join("media"))
        .into_iter()
        .filter_map(|path| {
            let value = read_json_value(&path)?;
            let media_id = media_identifier(&value);
            Some(json!({
                "id": if media_id.is_empty() { path.file_stem().and_then(|value| value.to_str()).unwrap_or_default().to_string() } else { media_id },
                "postId": json_string(&value, "postId").unwrap_or_default(),
                "platform": json_string(&value, "platform").unwrap_or_default(),
                "kind": json_string(&value, "kind").unwrap_or_else(|| "media".to_string()),
                "url": json_string(&value, "url").or_else(|| json_string(&value, "src")).unwrap_or_default(),
                "localPath": json_string(&value, "localPath").unwrap_or_default(),
                "index": value.get("index").cloned().unwrap_or_else(|| json!(0)),
                "capturedAt": json_string(&value, "capturedAt").unwrap_or_default(),
                "updatedAt": json_string(&value, "updatedAt").unwrap_or_default(),
            }))
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| sort_time(right).cmp(&sort_time(left)));
    items
}

fn account_comment_summaries(root: &Path) -> Vec<Value> {
    let mut items = Vec::new();
    for path in json_files_in_dir(&root.join("comments")) {
        let Some(value) = read_json_value(&path) else {
            continue;
        };
        let post_id = json_string(&value, "postId").unwrap_or_default();
        let platform = json_string(&value, "platform").unwrap_or_default();
        if let Some(comments) = value.get("comments").and_then(Value::as_array) {
            for comment in comments {
                let comment_id = comment_identifier(comment);
                items.push(json!({
                    "id": if comment_id.is_empty() { short_hash(&comment.to_string()) } else { comment_id },
                    "postId": json_string(comment, "postId").unwrap_or_else(|| post_id.clone()),
                    "platform": json_string(comment, "platform").unwrap_or_else(|| platform.clone()),
                    "author": json_string(comment, "author").unwrap_or_default(),
                    "text": json_string(comment, "text").unwrap_or_default(),
                    "likes": comment.get("likes").cloned().unwrap_or_else(|| json!(0)),
                    "replies": comment.get("replies").cloned().unwrap_or_else(|| json!(0)),
                    "createdAt": json_string(comment, "createdAt").unwrap_or_default(),
                    "capturedAt": json_string(comment, "capturedAt").unwrap_or_default(),
                    "updatedAt": json_string(comment, "updatedAt").unwrap_or_default(),
                }));
            }
        }
    }
    items.sort_by(|left, right| sort_time(right).cmp(&sort_time(left)));
    items
}

fn json_files_in_dir(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
                .collect()
        })
        .unwrap_or_default()
}

fn sort_time(value: &Value) -> String {
    json_string(value, "updatedAt")
        .or_else(|| json_string(value, "capturedAt"))
        .or_else(|| json_string(value, "publishedAt"))
        .or_else(|| json_string(value, "createdAt"))
        .unwrap_or_default()
}

fn load_catalog_for_state(state: &State<'_, AppState>) -> Result<AccountCatalog, String> {
    let path = accounts_root(state)?.join("catalog.json");
    if !path.exists() {
        return Ok(AccountCatalog {
            schema_version: ACCOUNT_SCHEMA_VERSION,
            accounts: Vec::new(),
        });
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut catalog: AccountCatalog = serde_json::from_str(&text).unwrap_or_default();
    if catalog.schema_version <= 0 {
        catalog.schema_version = ACCOUNT_SCHEMA_VERSION;
    }
    Ok(catalog)
}

fn read_text_if_exists(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn save_catalog_for_state(
    state: &State<'_, AppState>,
    catalog: &AccountCatalog,
) -> Result<(), String> {
    let root = accounts_root(state)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    write_json_pretty(&root.join("catalog.json"), catalog)
}

fn upsert_catalog_account(catalog: &mut AccountCatalog, account: AccountSummary) {
    if catalog.schema_version <= 0 {
        catalog.schema_version = ACCOUNT_SCHEMA_VERSION;
    }
    if let Some(existing) = catalog
        .accounts
        .iter_mut()
        .find(|item| item.id == account.id)
    {
        let created_at = if existing.created_at.is_empty() {
            account.created_at.clone()
        } else {
            existing.created_at.clone()
        };
        *existing = AccountSummary {
            created_at,
            ..account
        };
        return;
    }
    catalog.accounts.push(account);
}

fn mark_account_learned(catalog: &mut AccountCatalog, account_id: &str, learned_at: &str) {
    if let Some(item) = catalog
        .accounts
        .iter_mut()
        .find(|item| item.id == account_id)
    {
        item.last_learned_at = Some(learned_at.to_string());
        item.updated_at = learned_at.to_string();
    }
}

struct AccountLearningRefreshOutcome {
    status: String,
    synced_memory_count: usize,
    pending_video_transcriptions: i64,
    failed_video_transcriptions: i64,
}

fn refresh_account_learning_if_ready(
    root: &Path,
    state: &State<'_, AppState>,
    catalog: &mut AccountCatalog,
    account_id: &str,
    now: &str,
) -> Result<AccountLearningRefreshOutcome, String> {
    let account_id = if account_id.trim().is_empty() {
        read_json_value(&root.join("profile.json"))
            .and_then(|value| json_string(&value, "id"))
            .unwrap_or_default()
    } else {
        account_id.to_string()
    };
    let pending_video_transcriptions = video_transcription_count(root, "pending");
    let failed_video_transcriptions = video_transcription_count(root, "failed");
    if pending_video_transcriptions > 0 {
        write_account_learning_state(
            root,
            "waiting_transcription",
            pending_video_transcriptions,
            failed_video_transcriptions,
            now,
        )?;
        return Ok(AccountLearningRefreshOutcome {
            status: "waiting_transcription".to_string(),
            synced_memory_count: 0,
            pending_video_transcriptions,
            failed_video_transcriptions,
        });
    }
    if failed_video_transcriptions > 0 {
        write_account_learning_state(
            root,
            "transcription_failed",
            pending_video_transcriptions,
            failed_video_transcriptions,
            now,
        )?;
        return Ok(AccountLearningRefreshOutcome {
            status: "transcription_failed".to_string(),
            synced_memory_count: 0,
            pending_video_transcriptions,
            failed_video_transcriptions,
        });
    }

    refresh_account_learning_artifacts(root, state)?;
    let synced_memory_count = sync_account_memory_candidates(state, root)?;
    if !account_id.is_empty() {
        mark_account_learned(catalog, &account_id, now);
    }
    write_account_learning_state(root, "completed", 0, 0, now)?;
    Ok(AccountLearningRefreshOutcome {
        status: "completed".to_string(),
        synced_memory_count,
        pending_video_transcriptions: 0,
        failed_video_transcriptions: 0,
    })
}

fn write_account_learning_state(
    root: &Path,
    status: &str,
    pending_video_transcriptions: i64,
    failed_video_transcriptions: i64,
    now: &str,
) -> Result<(), String> {
    write_json_pretty(
        &root.join("learning-state.json"),
        &json!({
            "schemaVersion": ACCOUNT_SCHEMA_VERSION,
            "status": status,
            "pendingVideoTranscriptions": pending_video_transcriptions,
            "failedVideoTranscriptions": failed_video_transcriptions,
            "updatedAt": now,
        }),
    )
}

fn accounts_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("accounts");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn account_root(
    state: &State<'_, AppState>,
    platform: &str,
    account_id: &str,
) -> Result<PathBuf, String> {
    Ok(accounts_root(state)?.join(platform).join(account_id))
}

fn active_space_id(state: &State<'_, AppState>) -> Result<String, String> {
    crate::with_store(state, |store| Ok(store.active_space_id.clone()))
}

fn active_workspace_value(state: &State<'_, AppState>) -> Result<Value, String> {
    crate::with_store(state, |store| {
        let id = store.active_space_id.clone();
        let name = store
            .spaces
            .iter()
            .find(|space| space.id == id)
            .map(|space| space.name.clone())
            .unwrap_or_else(|| id.clone());
        Ok(json!({ "id": id, "name": name }))
    })
}

fn account_id_for_request(request: &AccountImportSessionRequest) -> String {
    if let Some(platform_user_id) = normalized_string(request.platform_user_id.clone()) {
        return format!("account-{}", storage_safe_file_stem(&platform_user_id));
    }
    if let Some(homepage_url) = normalized_string(request.homepage_url.clone()) {
        return format!("account-{}", short_hash(&homepage_url));
    }
    format!(
        "account-{}",
        short_hash(&format!("{}:{}", request.platform, now_iso()))
    )
}

fn normalize_platform(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    let platform = match normalized.as_str() {
        "xhs" | "rednote" | "xiaohongshu" | "小红书" => "xiaohongshu",
        "douyin" | "抖音" => "douyin",
        "bilibili" | "b站" | "哔哩哔哩" => "bilibili",
        "wechat" | "weixin" | "公众号" => "wechat",
        "youtube" => "youtube",
        "kuaishou" | "快手" => "kuaishou",
        "tiktok" => "tiktok",
        "instagram" => "instagram",
        "x" | "twitter" => "x",
        _ => normalized.as_str(),
    };
    if platform.is_empty()
        || !platform
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
    {
        return Err("平台标识无效".to_string());
    }
    Ok(platform.to_string())
}

fn normalized_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn compact_string_values(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn post_identifier(post: &Value) -> String {
    ["platformPostId", "noteId", "id", "url"]
        .iter()
        .filter_map(|key| post.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn post_has_video_media(post: &Value) -> bool {
    if json_string(post, "videoUrl").is_some() {
        return true;
    }
    post.get("media")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                let kind = json_string(item, "kind").unwrap_or_default().to_lowercase();
                let url = json_string(item, "url")
                    .or_else(|| json_string(item, "src"))
                    .unwrap_or_default()
                    .to_lowercase();
                kind.contains("video")
                    || url.contains(".mp4")
                    || url.contains(".m3u8")
                    || url.contains("video")
            })
        })
        .unwrap_or(false)
}

fn post_has_transcript(post: &Value) -> bool {
    json_string(post, "transcript")
        .or_else(|| json_string(post, "transcriptText"))
        .or_else(|| json_string(post, "subtitle"))
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn video_transcription_state(post: &Value) -> Option<&'static str> {
    if !post_has_video_media(post) {
        return None;
    }
    if post_has_transcript(post) {
        return Some("ready");
    }
    let status = json_string(post, "transcriptionStatus")
        .unwrap_or_default()
        .to_lowercase();
    if status == "failed" {
        Some("failed")
    } else {
        Some("pending")
    }
}

fn video_transcription_count(root: &Path, state: &str) -> i64 {
    json_files_in_dir(&root.join("posts"))
        .into_iter()
        .filter_map(|path| read_json_value(&path))
        .filter(|post| video_transcription_state(post) == Some(state))
        .count() as i64
}

fn comment_post_identifier(comment: &Value) -> Option<String> {
    ["postId", "platformPostId", "noteId"]
        .iter()
        .filter_map(|key| comment.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

fn comment_identifier(comment: &Value) -> String {
    ["commentId", "platformCommentId", "id", "url"]
        .iter()
        .filter_map(|key| comment.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn media_identifier(media: &Value) -> String {
    ["mediaId", "id", "url", "src", "localPath"]
        .iter()
        .filter_map(|key| media.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn normalize_media_payload(mut media: Value, account_id: &str, platform: &str, now: &str) -> Value {
    if let Some(object) = media.as_object_mut() {
        object.insert("schemaVersion".to_string(), json!(ACCOUNT_SCHEMA_VERSION));
        object.insert("accountId".to_string(), json!(account_id));
        object.insert("platform".to_string(), json!(platform));
        object
            .entry("capturedAt".to_string())
            .or_insert_with(|| json!(now));
        object.insert("updatedAt".to_string(), json!(now));
        return media;
    }
    json!({
        "schemaVersion": ACCOUNT_SCHEMA_VERSION,
        "accountId": account_id,
        "platform": platform,
        "value": media,
        "capturedAt": now,
        "updatedAt": now,
    })
}

fn existing_post_count(root: &Path) -> i64 {
    fs::read_dir(root.join("posts"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                })
                .count() as i64
        })
        .unwrap_or(0)
}

fn existing_comment_count(root: &Path) -> i64 {
    fs::read_dir(root.join("comments"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                })
                .map(|entry| {
                    read_json_value(&entry.path())
                        .and_then(|value| {
                            value
                                .get("comments")
                                .and_then(Value::as_array)
                                .map(|items| items.len() as i64)
                        })
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0)
}

fn existing_media_count(root: &Path) -> i64 {
    fs::read_dir(root.join("media"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                })
                .count() as i64
        })
        .unwrap_or(0)
}

fn validate_request_platform(
    request_platform: Option<&str>,
    account_platform: &str,
) -> Result<(), String> {
    if let Some(platform) = request_platform {
        let normalized = normalize_platform(platform)?;
        if normalized != account_platform {
            return Err("请求平台与账号档案平台不一致".to_string());
        }
    }
    Ok(())
}

fn update_import_state_counts(
    root: &Path,
    session_id: Option<&str>,
    imported_post_count: i64,
    now: &str,
    patch: Option<Value>,
) -> Result<(), String> {
    let path = root.join("import-state.json");
    if !path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let active_session_id = session_id.map(ToString::to_string).or_else(|| {
        value
            .get("activeSessionId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    });
    if let Some(sessions) = value.get_mut("sessions").and_then(Value::as_array_mut) {
        for session in sessions {
            let matches_session = active_session_id
                .as_ref()
                .map(|id| session.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .unwrap_or(true);
            if !matches_session {
                continue;
            }
            if let Some(object) = session.as_object_mut() {
                object.insert("importedPostCount".to_string(), json!(imported_post_count));
                object.insert("updatedAt".to_string(), json!(now));
                if let Some(patch) = patch.as_ref().and_then(Value::as_object) {
                    for (key, value) in patch {
                        object.insert(key.clone(), value.clone());
                    }
                }
            }
        }
    }
    write_json_pretty(&path, &value)
}

fn find_account_root_by_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let catalog = load_catalog_for_state(state).unwrap_or_default();
    for account in catalog.accounts {
        let root = account_root(state, &account.platform, &account.id)?;
        let path = root.join("import-state.json");
        if !path.exists() {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap_or_default();
        if text.contains(session_id) {
            return Ok(Some(root));
        }
    }
    Ok(None)
}

fn refresh_account_learning_artifacts(
    root: &Path,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    crate::profile_learning::refresh_own_account_profile(root, ACCOUNT_SCHEMA_VERSION, state)?;
    Ok(())
}

fn sync_account_memory_candidates(
    state: &State<'_, AppState>,
    root: &Path,
) -> Result<usize, String> {
    let profile = read_json_value(&root.join("profile.json")).unwrap_or_else(|| json!({}));
    let platform = json_string(&profile, "platform").unwrap_or_default();
    let username = json_string(&profile, "username").unwrap_or_else(|| "未命名账号".to_string());
    let account_id = json_string(&profile, "id").unwrap_or_default();
    if account_id.is_empty() {
        return Ok(0);
    }

    let path = root.join("memory-candidates.json");
    let mut document = read_json_value(&path).unwrap_or_else(|| json!({ "candidates": [] }));
    let mut synced_count = 0_usize;
    let now = now_iso();
    if let Some(candidates) = document
        .get_mut("candidates")
        .and_then(|value| value.as_array_mut())
    {
        for candidate in candidates {
            let text = json_string(candidate, "text").unwrap_or_default();
            if text.trim().is_empty() {
                continue;
            }
            let kind =
                json_string(candidate, "kind").unwrap_or_else(|| "account_profile".to_string());
            let candidate_hash = short_hash(&format!("{account_id}:{kind}:{text}"));
            let existing_memory_id = find_synced_memory_id(state, &candidate_hash)?;
            let memory_id = if let Some(memory_id) = existing_memory_id {
                memory_id
            } else {
                let confidence = candidate
                    .get("confidence")
                    .and_then(|value| value.as_f64())
                    .unwrap_or(0.7);
                let evidence_post_ids = candidate
                    .get("evidencePostIds")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let payload = json!({
                    "content": format!("账号 @{username}（{platform}）的长期偏好：{text}"),
                    "type": "account_profile",
                    "tags": compact_string_values(vec![
                        "account-profile".to_string(),
                        platform.clone(),
                        kind.clone(),
                    ]),
                    "entities": compact_string_values(vec![username.clone(), account_id.clone()]),
                    "scope": "space",
                    "confidence": confidence,
                    "source": {
                        "kind": "account_profile_import",
                        "accountId": account_id.clone(),
                        "platform": platform.clone(),
                        "username": username.clone(),
                        "candidateKind": kind.clone(),
                        "candidateHash": candidate_hash.clone(),
                        "evidencePostIds": evidence_post_ids,
                    }
                });
                match crate::memory::handle_memory_channel(state, "memory:add", &payload)
                    .transpose()?
                    .and_then(|value| json_string(&value, "id"))
                {
                    Some(memory_id) => {
                        synced_count += 1;
                        memory_id
                    }
                    None => continue,
                }
            };
            if let Some(object) = candidate.as_object_mut() {
                object.insert("status".to_string(), json!("synced"));
                object.insert("memoryId".to_string(), json!(memory_id));
                object.insert("syncedAt".to_string(), json!(now));
                object.insert("candidateHash".to_string(), json!(candidate_hash));
            }
        }
    }
    write_json_pretty(&path, &document)?;
    Ok(synced_count)
}

fn find_synced_memory_id(
    state: &State<'_, AppState>,
    candidate_hash: &str,
) -> Result<Option<String>, String> {
    with_store(state, |store| {
        Ok(store
            .memories
            .iter()
            .find(|memory| {
                memory.status.as_deref().unwrap_or("active") == "active"
                    && memory
                        .source
                        .as_ref()
                        .and_then(|source| source.get("candidateHash"))
                        .and_then(|value| value.as_str())
                        == Some(candidate_hash)
            })
            .map(|memory| memory.id.clone()))
    })
}

fn truncate_for_prompt(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut output = value.chars().take(max_chars).collect::<String>();
    output.push_str("\n...[truncated]");
    output
}

fn short_hash(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn normalize_request_path(path: &str) -> String {
    path.split('?')
        .next()
        .unwrap_or(path)
        .trim_end_matches('/')
        .to_string()
}
