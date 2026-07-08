use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{hash_map::DefaultHasher, BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::State;
use url::Url;

use crate::json_util::{json_string, read_json_value, write_json_pretty};
use crate::store::spaces as spaces_store;
use crate::{now_iso, storage_safe_file_stem, workspace_root, AppState};

const ACCOUNT_SCHEMA_VERSION: i64 = 1;
const ACCOUNTS_BATCH_LIMIT: usize = 64;
const ACCOUNT_MEDIA_DOWNLOAD_LIMIT_BYTES: usize = 200 * 1024 * 1024;

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
    follower_count: Option<i64>,
    total_post_count: Option<i64>,
    total_like_count: Option<i64>,
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
    profile: Value,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AccountCreateFromHomepageRequest {
    homepage_url: String,
    limit: Option<i64>,
}

struct InferredHomepageAccount {
    platform: String,
    platform_user_id: Option<String>,
    username: Option<String>,
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
        "accounts:health"
            | "accounts:list"
            | "accounts:get"
            | "accounts:create-from-homepage"
            | "accounts:posts-batch"
            | "accounts:comments-batch"
            | "accounts:media-batch"
            | "accounts:complete-import-session"
            | "accounts:delete"
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
        "accounts:create-from-homepage" => create_account_from_homepage(state, payload),
        "accounts:posts-batch" => (|| -> Result<Value, String> {
            let account_id = payload
                .get("accountId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "accountId 不能为空".to_string())?;
            let request: AccountPostBatchRequest =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            upsert_posts_batch(state, account_id, request)
        })(),
        "accounts:comments-batch" => (|| -> Result<Value, String> {
            let account_id = payload
                .get("accountId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "accountId 不能为空".to_string())?;
            let request: AccountCommentBatchRequest =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            upsert_comments_batch(state, account_id, request)
        })(),
        "accounts:media-batch" => (|| -> Result<Value, String> {
            let account_id = payload
                .get("accountId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "accountId 不能为空".to_string())?;
            let request: AccountMediaBatchRequest =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            upsert_media_batch(state, account_id, request)
        })(),
        "accounts:complete-import-session" => (|| -> Result<Value, String> {
            let session_id = payload
                .get("sessionId")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "sessionId 不能为空".to_string())?;
            let request: AccountImportCompleteRequest =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            complete_import_session(state, session_id, request)
        })(),
        "accounts:delete" => delete_account(state, payload),
        _ => unreachable!(),
    })
}

pub(crate) fn platform_accounts_for_active_space(state: &State<'_, AppState>) -> Value {
    let catalog = load_catalog_for_state(state).unwrap_or_default();
    platform_accounts_from_catalog(&catalog)
}

pub(crate) fn build_account_prompt_section(state: &State<'_, AppState>) -> Option<String> {
    let _ = state;
    None
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

    let mut catalog = load_catalog_for_state(state).unwrap_or_default();
    let summary = AccountSummary {
        id: account_id.clone(),
        platform: platform.clone(),
        platform_user_id: normalized_string(request.platform_user_id),
        username: username.clone(),
        homepage_url: normalized_string(request.homepage_url),
        avatar_url: normalized_string(request.avatar_url),
        bound_space_id: active_space_id(state).ok(),
        follower_count: follower_count_from_profile(&profile),
        total_post_count: total_post_count_from_profile(&profile),
        total_like_count: total_like_count_from_profile(&profile),
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
        "syncedMemoryCount": 0
    }))
}

fn create_account_from_homepage(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: AccountCreateFromHomepageRequest =
        serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
    let homepage_url = normalize_homepage_url(&request.homepage_url)?;
    let inferred = infer_homepage_account(&homepage_url)?;
    let limit = request.limit.unwrap_or(20).clamp(1, 200);
    let response = create_import_session(
        state,
        AccountImportSessionRequest {
            platform: inferred.platform.clone(),
            homepage_url: Some(homepage_url.clone()),
            platform_user_id: inferred.platform_user_id.clone(),
            username: inferred.username.clone(),
            avatar_url: None,
            bio: None,
            profile: json!({
                "source": "settings-homepage-url",
                "homepageUrl": homepage_url,
                "platform": inferred.platform.clone(),
                "platformUserId": inferred.platform_user_id.clone(),
                "username": inferred.username.clone(),
            }),
            options: json!({
                "postLimit": limit,
                "includeComments": true,
                "includeMedia": true,
                "source": "settings-homepage-url",
            }),
        },
    )?;
    Ok(json!({
        "success": true,
        "account": response.get("account").cloned().unwrap_or_else(|| json!({})),
        "session": response.get("session").cloned().unwrap_or_else(|| json!({})),
        "homepageUrl": homepage_url,
        "platform": inferred.platform,
        "limit": limit,
        "nextAction": Value::Null
    }))
}

fn delete_account(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let account_id = payload
        .get("accountId")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "accountId 不能为空".to_string())?;
    let mut catalog = load_catalog_for_state(state).unwrap_or_default();
    let Some(index) = catalog
        .accounts
        .iter()
        .position(|item| item.id == account_id)
    else {
        return Ok(json!({ "success": true, "deleted": false }));
    };
    let account = catalog.accounts.remove(index);
    let root = account_root(state, &account.platform, &account.id)?;
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|error| error.to_string())?;
    }
    save_catalog_for_state(state, &catalog)?;
    Ok(json!({ "success": true, "deleted": true, "accountId": account_id }))
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
    let imported_author = first_post_string(&request.posts, &["author", "nickname", "username"]);
    let imported_avatar = first_post_string(&request.posts, &["authorAvatarUrl", "avatarUrl"]);
    let imported_author_id = first_post_string(&request.posts, &["authorId", "platformUserId"]);
    let profile_follower_count = follower_count_from_profile(&request.profile);
    let profile_total_post_count = total_post_count_from_profile(&request.profile);
    let profile_total_like_count = total_like_count_from_profile(&request.profile);
    patch_account_profile_from_import(
        &root,
        &account,
        imported_author.as_deref(),
        imported_avatar.as_deref(),
        imported_author_id.as_deref(),
        Some(&request.profile),
    )?;

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
        let path = post_meta_path(&root, &post_id);
        let existed = path.exists();
        let mut payload = post;
        if let Some(object) = payload.as_object_mut() {
            object.insert("schemaVersion".to_string(), json!(ACCOUNT_SCHEMA_VERSION));
            object.insert("accountId".to_string(), json!(account_id));
            object.insert("platform".to_string(), json!(account.platform));
            object.insert("id".to_string(), json!(post_id));
            object.insert(
                "files".to_string(),
                json!({
                    "meta": "meta.json",
                    "content": "content.md",
                    "html": "content.html",
                    "comments": "comments.json",
                    "commentsMarkdown": "comments.md",
                }),
            );
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
        match write_post_document(&root, &post_id, &payload) {
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
        if let Some(username) = imported_author.clone() {
            if should_replace_catalog_username(item) {
                item.username = username;
            }
        }
        if let Some(avatar_url) = imported_avatar.clone() {
            if item
                .avatar_url
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                item.avatar_url = Some(avatar_url);
            }
        }
        if let Some(platform_user_id) = imported_author_id.clone() {
            if item
                .platform_user_id
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                item.platform_user_id = Some(platform_user_id);
            }
        }
        if let Some(follower_count) = profile_follower_count {
            item.follower_count = Some(follower_count);
        }
        if let Some(total_post_count) = profile_total_post_count {
            item.total_post_count = Some(total_post_count);
        } else if item.total_post_count.unwrap_or_default() <= 0 {
            item.total_post_count = Some(post_count);
        }
        if let Some(total_like_count) = profile_total_like_count {
            item.total_like_count = Some(total_like_count);
        } else if item.total_like_count.unwrap_or_default() <= 0 {
            item.total_like_count = Some(existing_post_like_count(&root));
        }
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
        let path = post_comments_path(&root, &post_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
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
            object.insert("commentsMarkdown".to_string(), json!("comments.md"));
        }
        if let Err(error) = write_json_pretty(&path, &document) {
            failed.push(json!({ "postId": post_id, "error": error }));
            continue;
        }
        if let Err(error) = write_comments_markdown(&root, &post_id, &document) {
            failed.push(json!({ "postId": post_id, "error": error }));
        }
        let _ = patch_post_comment_files(&root, &post_id, &now);
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
        let mut media = media;
        if let Err(error) = materialize_account_media(state, &root, &mut media, true) {
            if let Some(object) = media.as_object_mut() {
                object.insert("localizeError".to_string(), json!(error.clone()));
            }
            failed.push(json!({ "mediaId": media_id, "error": error }));
        }
        let payload = normalize_media_payload(media, account_id, &account.platform, &now);
        match write_json_pretty(&path, &payload) {
            Ok(()) if existed => {
                patch_post_media_local_path(&root, &payload, &now)?;
                updated += 1;
            }
            Ok(()) => {
                patch_post_media_local_path(&root, &payload, &now)?;
                inserted += 1;
            }
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
    let _ = backfill_account_media_files_from_knowledge(state, &root);
    Ok(json!({
        "success": true,
        "account": account,
        "profile": read_json_value(&root.join("profile.json")).unwrap_or_else(|| json!({})),
        "posts": account_post_summaries(&root),
        "media": account_media_summaries(&root),
        "comments": account_comment_summaries(&root),
        "captureRequest": read_json_value(&root.join("capture-request.json")).unwrap_or_else(|| json!({})),
        "learningState": read_json_value(&root.join("learning-state.json")).unwrap_or_else(|| json!({})),
        "artifactPaths": {
            "root": root.to_string_lossy().to_string(),
            "profile": root.join("profile.json").to_string_lossy().to_string(),
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
        for path in account_post_json_paths(&posts_root) {
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
    let mut items = account_post_json_paths(&root.join("posts"))
        .into_iter()
        .filter_map(|path| {
            let value = read_json_value(&path)?;
            let post_id = post_identifier(&value);
            let post_dir = path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| root.join("posts"));
            let content = json_string(&value, "content")
                .unwrap_or_else(|| read_text_if_exists(&post_dir.join("content.md")));
            let media = value
                .get("media")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Some(json!({
                "id": if post_id.is_empty() { path.file_stem().and_then(|value| value.to_str()).unwrap_or_default().to_string() } else { post_id },
                "title": json_string(&value, "title").unwrap_or_else(|| "未命名内容".to_string()),
                "content": content,
                "url": json_string(&value, "url").unwrap_or_default(),
                "publishedAt": json_string(&value, "publishedAt").unwrap_or_default(),
                "capturedAt": json_string(&value, "capturedAt").unwrap_or_default(),
                "updatedAt": json_string(&value, "updatedAt").unwrap_or_default(),
                "platform": json_string(&value, "platform").unwrap_or_default(),
                "kind": json_string(&value, "kind").unwrap_or_default(),
                "stats": value.get("stats").cloned().unwrap_or_else(|| json!({})),
                "tags": value.get("tags").cloned().unwrap_or_else(|| json!([])),
                "media": media,
                "files": value.get("files").cloned().unwrap_or_else(|| json!({})),
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
    for path in account_comment_json_paths(root) {
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
                    "author": comment_author_text(comment),
                    "text": comment_body_text(comment),
                    "likes": comment.get("likes").cloned().or_else(|| comment.get("metrics").and_then(|metrics| metrics.get("likes")).cloned()).unwrap_or_else(|| json!(0)),
                    "replies": comment.get("replies").cloned().or_else(|| comment.get("metrics").and_then(|metrics| metrics.get("replies")).cloned()).unwrap_or_else(|| json!(0)),
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

fn post_directory(root: &Path, post_id: &str) -> PathBuf {
    root.join("posts").join(storage_safe_file_stem(post_id))
}

fn post_meta_path(root: &Path, post_id: &str) -> PathBuf {
    post_directory(root, post_id).join("meta.json")
}

fn post_comments_path(root: &Path, post_id: &str) -> PathBuf {
    post_directory(root, post_id).join("comments.json")
}

fn write_post_document(root: &Path, post_id: &str, post: &Value) -> Result<(), String> {
    let dir = post_directory(root, post_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    write_json_pretty(&dir.join("meta.json"), post)?;
    let markdown = post_content_markdown(post);
    if !markdown.trim().is_empty() {
        fs::write(dir.join("content.md"), markdown).map_err(|error| error.to_string())?;
    }
    if let Some(html) = json_string(post, "html").or_else(|| json_string(post, "contentHtml")) {
        if !html.trim().is_empty() {
            fs::write(dir.join("content.html"), html).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn post_content_markdown(post: &Value) -> String {
    let title = json_string(post, "title").unwrap_or_default();
    let content = json_string(post, "content")
        .or_else(|| json_string(post, "text"))
        .or_else(|| json_string(post, "description"))
        .unwrap_or_default();
    let transcript = json_string(post, "transcript")
        .or_else(|| json_string(post, "transcriptText"))
        .unwrap_or_default();
    let source_url = json_string(post, "url")
        .or_else(|| json_string(post, "sourceUrl"))
        .unwrap_or_default();
    let mut lines = Vec::new();
    if !title.trim().is_empty() {
        lines.push(format!("# {}", title.trim()));
        lines.push(String::new());
    }
    if !source_url.trim().is_empty() {
        lines.push(format!("来源：{}", source_url.trim()));
        lines.push(String::new());
    }
    if !content.trim().is_empty() {
        lines.push(content.trim().to_string());
    }
    if !transcript.trim().is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("## 视频转录".to_string());
        lines.push(String::new());
        lines.push(transcript.trim().to_string());
    }
    lines.join("\n")
}

fn patch_post_comment_files(root: &Path, post_id: &str, now: &str) -> Result<(), String> {
    let path = post_meta_path(root, post_id);
    if !path.exists() {
        return Ok(());
    }
    let Some(mut post) = read_json_value(&path) else {
        return Ok(());
    };
    if let Some(object) = post.as_object_mut() {
        let mut files = object
            .get("files")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        files.insert("comments".to_string(), json!("comments.json"));
        files.insert("commentsMarkdown".to_string(), json!("comments.md"));
        object.insert("files".to_string(), Value::Object(files));
        object.insert("updatedAt".to_string(), json!(now));
    }
    write_json_pretty(&path, &post)
}

fn write_comments_markdown(root: &Path, post_id: &str, document: &Value) -> Result<(), String> {
    let comments = document
        .get("comments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut lines = Vec::new();
    lines.push(format!("# 评论区：{post_id}"));
    lines.push(String::new());
    lines.push(format!("评论数：{}", comments.len()));
    if let Some(captured_at) =
        json_string(document, "updatedAt").or_else(|| json_string(document, "capturedAt"))
    {
        lines.push(format!("更新时间：{captured_at}"));
    }
    lines.push(String::new());
    for (index, comment) in comments.iter().take(200).enumerate() {
        let author = comment_author_text(comment);
        let text = comment_body_text(comment);
        if text.trim().is_empty() {
            continue;
        }
        let likes = comment
            .get("likes")
            .or_else(|| {
                comment
                    .get("metrics")
                    .and_then(|metrics| metrics.get("likes"))
            })
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        lines.push(format!(
            "{}. {}{}：{}",
            index + 1,
            if author.trim().is_empty() {
                "匿名"
            } else {
                author.trim()
            },
            if likes > 0 {
                format!("（{}赞）", likes)
            } else {
                String::new()
            },
            text.trim()
        ));
    }
    fs::write(
        post_directory(root, post_id).join("comments.md"),
        lines.join("\n"),
    )
    .map_err(|error| error.to_string())
}

fn comment_author_text(comment: &Value) -> String {
    json_string(comment, "author")
        .or_else(|| {
            comment.get("author").and_then(|author| {
                json_string(author, "nickname").or_else(|| json_string(author, "name"))
            })
        })
        .or_else(|| json_string(comment, "nickname"))
        .unwrap_or_default()
}

fn comment_body_text(comment: &Value) -> String {
    json_string(comment, "text")
        .or_else(|| json_string(comment, "content"))
        .or_else(|| {
            comment
                .get("content")
                .and_then(|content| json_string(content, "text"))
        })
        .unwrap_or_default()
}

fn account_post_json_paths(posts_root: &Path) -> Vec<PathBuf> {
    let mut paths = json_files_in_dir(posts_root);
    if let Ok(entries) = fs::read_dir(posts_root) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                let meta_path = path.join("meta.json");
                if meta_path.exists() {
                    paths.push(meta_path);
                }
            }
        }
    }
    paths
}

fn account_comment_json_paths(root: &Path) -> Vec<PathBuf> {
    let mut paths = json_files_in_dir(&root.join("comments"));
    let posts_root = root.join("posts");
    if let Ok(entries) = fs::read_dir(posts_root) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                let comments_path = path.join("comments.json");
                if comments_path.exists() {
                    paths.push(comments_path);
                }
            }
        }
    }
    paths
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
    if !account_id.is_empty() {
        mark_account_learned(catalog, &account_id, now);
    }
    write_account_learning_state(root, "completed", 0, 0, now)?;
    Ok(AccountLearningRefreshOutcome {
        status: "completed".to_string(),
        synced_memory_count: 0,
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
    crate::with_store(state, |store| Ok(spaces_store::active_space_id(&store)))
}

fn active_workspace_value(state: &State<'_, AppState>) -> Result<Value, String> {
    crate::with_store(state, |store| {
        let (id, name) = spaces_store::active_workspace_snapshot(&store);
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

fn normalize_homepage_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("主页 URL 不能为空".to_string());
    }
    let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = Url::parse(&candidate).map_err(|error| format!("主页 URL 无效: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("主页 URL 只支持 http/https".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("主页 URL 不能包含账号密码".to_string());
    }
    Ok(parsed.to_string())
}

fn infer_homepage_account(homepage_url: &str) -> Result<InferredHomepageAccount, String> {
    let parsed = Url::parse(homepage_url).map_err(|error| error.to_string())?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = parsed.path().trim_matches('/');
    let parts = path
        .split('/')
        .filter(|item| !item.trim().is_empty())
        .collect::<Vec<_>>();
    if host.contains("xiaohongshu.com") {
        let user_id = parts
            .windows(2)
            .find_map(|window| {
                if window[0] == "profile" || (window[0] == "user" && window[1] != "profile") {
                    Some(window[1].to_string())
                } else {
                    None
                }
            })
            .or_else(|| {
                if parts.first() == Some(&"user") && parts.get(1) == Some(&"profile") {
                    parts.get(2).map(|value| value.to_string())
                } else {
                    None
                }
            });
        if user_id.is_none() {
            return Err("小红书主页 URL 需要包含 /user/profile/{id}".to_string());
        }
        return Ok(InferredHomepageAccount {
            platform: "xiaohongshu".to_string(),
            platform_user_id: user_id.clone(),
            username: user_id,
        });
    }
    if host.contains("douyin.com") {
        let user_id = parts
            .windows(2)
            .find_map(|window| (window[0] == "user").then(|| window[1].to_string()));
        return Ok(InferredHomepageAccount {
            platform: "douyin".to_string(),
            platform_user_id: user_id.clone(),
            username: user_id,
        });
    }
    if host == "space.bilibili.com" || host.ends_with(".space.bilibili.com") {
        let user_id = parts.first().map(|value| value.to_string());
        return Ok(InferredHomepageAccount {
            platform: "bilibili".to_string(),
            platform_user_id: user_id.clone(),
            username: user_id,
        });
    }
    if host.contains("tiktok.com") {
        let handle = parts
            .first()
            .map(|value| value.trim_start_matches('@').to_string())
            .filter(|value| !value.is_empty());
        return Ok(InferredHomepageAccount {
            platform: "tiktok".to_string(),
            platform_user_id: handle.clone(),
            username: handle,
        });
    }
    Err("暂不支持这个平台主页，请使用小红书、抖音、Bilibili 或 TikTok 主页 URL".to_string())
}

fn normalized_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn follower_count_from_profile(profile: &Value) -> Option<i64> {
    json_i64_at_paths(
        profile,
        &[
            "stats.followers",
            "stats.followerCount",
            "stats.fans",
            "stats.fansCount",
            "followers",
            "followerCount",
            "fans",
            "fansCount",
            "raw.fans",
            "raw.fans_count",
            "raw.follower_count",
            "raw.stats.followers",
            "raw.stats.followerCount",
            "raw.stats.fans",
            "raw.stats.fansCount",
            "raw.stats.follower_count",
        ],
    )
}

fn total_post_count_from_profile(profile: &Value) -> Option<i64> {
    json_i64_at_paths(
        profile,
        &[
            "stats.totalPosts",
            "stats.postCount",
            "stats.noteCount",
            "stats.notes",
            "stats.works",
            "stats.totalWorks",
            "totalPostCount",
            "postCount",
            "noteCount",
            "notes",
            "works",
            "raw.totalPosts",
            "raw.postCount",
            "raw.noteCount",
            "raw.notes",
            "raw.works",
            "raw.stats.totalPosts",
            "raw.stats.postCount",
            "raw.stats.noteCount",
            "raw.stats.notes",
            "raw.stats.works",
        ],
    )
}

fn total_like_count_from_profile(profile: &Value) -> Option<i64> {
    json_i64_at_paths(
        profile,
        &[
            "stats.totalLikes",
            "stats.likeCount",
            "stats.likes",
            "stats.likedCount",
            "stats.liked",
            "totalLikeCount",
            "likeCount",
            "likes",
            "likedCount",
            "liked",
            "raw.totalLikes",
            "raw.likeCount",
            "raw.likes",
            "raw.likedCount",
            "raw.liked",
            "raw.stats.totalLikes",
            "raw.stats.likeCount",
            "raw.stats.likes",
            "raw.stats.likedCount",
            "raw.stats.liked",
        ],
    )
}

fn json_i64_at_paths(value: &Value, paths: &[&str]) -> Option<i64> {
    for path in paths {
        let mut current = value;
        let mut found = true;
        for part in path.split('.') {
            match current.get(part) {
                Some(next) => current = next,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            if let Some(number) = json_count_value(current) {
                return Some(number);
            }
        }
    }
    None
}

fn json_count_value(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    let text = value.as_str()?.trim().replace(',', "");
    if text.is_empty() {
        return None;
    }
    if let Some(raw) = text.strip_suffix('万') {
        return raw
            .trim()
            .parse::<f64>()
            .ok()
            .map(|number| (number * 10_000.0).round() as i64);
    }
    text.parse::<i64>().ok()
}

fn first_post_string(posts: &[Value], keys: &[&str]) -> Option<String> {
    posts.iter().find_map(|post| {
        keys.iter()
            .find_map(|key| json_string(post, key))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn should_replace_catalog_username(account: &AccountSummary) -> bool {
    let username = account.username.trim();
    username.is_empty()
        || username == "未命名账号"
        || username == account.id
        || account.platform_user_id.as_deref() == Some(username)
}

fn patch_account_profile_from_import(
    root: &Path,
    account: &AccountSummary,
    username: Option<&str>,
    avatar_url: Option<&str>,
    platform_user_id: Option<&str>,
    profile_patch: Option<&Value>,
) -> Result<(), String> {
    let path = root.join("profile.json");
    let Some(mut profile) = read_json_value(&path) else {
        return Ok(());
    };
    let now = now_iso();
    if let Some(object) = profile.as_object_mut() {
        if let Some(value) = username.map(str::trim).filter(|value| !value.is_empty()) {
            let current = object
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if current.is_empty()
                || current == "未命名账号"
                || current == account.id
                || account.platform_user_id.as_deref() == Some(current)
            {
                object.insert("username".to_string(), json!(value));
                object.insert("displayName".to_string(), json!(value));
            }
        }
        if let Some(value) = avatar_url.map(str::trim).filter(|value| !value.is_empty()) {
            let current = object
                .get("avatarUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if current.is_empty() {
                object.insert("avatarUrl".to_string(), json!(value));
            }
        }
        if let Some(value) = platform_user_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let current = object
                .get("platformUserId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if current.is_empty() {
                object.insert("platformUserId".to_string(), json!(value));
            }
        }
        if let Some(patch) = profile_patch.and_then(Value::as_object) {
            for (source_key, target_key) in [
                ("username", "username"),
                ("displayName", "displayName"),
                ("avatarUrl", "avatarUrl"),
                ("bio", "bio"),
                ("homepageUrl", "homepageUrl"),
                ("platformUserId", "platformUserId"),
            ] {
                if let Some(value) = patch
                    .get(source_key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    object.insert(target_key.to_string(), json!(value));
                }
            }
            if let Some(stats) = patch.get("stats").filter(|value| value.is_object()) {
                object.insert("stats".to_string(), stats.clone());
            }
            object.insert("rawProfile".to_string(), Value::Object(patch.clone()));
        }
        object.insert("updatedAt".to_string(), json!(now));
    }
    write_json_pretty(&path, &profile)
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
    account_post_json_paths(&root.join("posts"))
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

fn backfill_account_media_files_from_knowledge(
    state: &State<'_, AppState>,
    root: &Path,
) -> Result<(), String> {
    let now = now_iso();
    for path in json_files_in_dir(&root.join("media")) {
        let Some(mut media) = read_json_value(&path) else {
            continue;
        };
        if media_local_path_exists(&media) {
            continue;
        }
        materialize_account_media(state, root, &mut media, false)?;
        if !media_local_path_exists(&media) {
            continue;
        }
        if let Some(object) = media.as_object_mut() {
            object.insert("updatedAt".to_string(), json!(now.clone()));
            object.remove("localizeError");
        }
        write_json_pretty(&path, &media)?;
        patch_post_media_local_path(root, &media, &now)?;
    }
    Ok(())
}

fn materialize_account_media(
    state: &State<'_, AppState>,
    root: &Path,
    media: &mut Value,
    allow_remote_download: bool,
) -> Result<(), String> {
    if media_local_path_exists(media) {
        return Ok(());
    }
    if let Some(local_path) = copy_account_media_from_knowledge(state, root, media)? {
        set_media_local_path(media, &local_path, "knowledge");
        return Ok(());
    }
    if !allow_remote_download {
        return Ok(());
    }
    let Some(source_url) = media_source_url(media) else {
        return Ok(());
    };
    let local_path = download_account_media(root, media, &source_url)?;
    set_media_local_path(media, &local_path, "remote");
    Ok(())
}

fn media_local_path_exists(media: &Value) -> bool {
    json_string(media, "localPath")
        .map(PathBuf::from)
        .is_some_and(|path| path.exists())
}

fn set_media_local_path(media: &mut Value, local_path: &Path, source: &str) {
    if let Some(object) = media.as_object_mut() {
        object.insert(
            "localPath".to_string(),
            json!(local_path.to_string_lossy().to_string()),
        );
        object.insert("localMediaSource".to_string(), json!(source));
    }
}

fn media_post_identifier(media: &Value) -> Option<String> {
    ["postId", "noteId", "platformPostId"]
        .iter()
        .filter_map(|key| media.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

fn media_source_url(media: &Value) -> Option<String> {
    ["url", "src", "sourceUrl", "downloadUrl"]
        .iter()
        .filter_map(|key| media.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .find(|value| value.starts_with("http://") || value.starts_with("https://"))
}

fn media_index(media: &Value) -> usize {
    media
        .get("index")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .map(|value| value as usize)
        .unwrap_or(0)
}

fn media_kind_text(media: &Value) -> String {
    json_string(media, "kind").unwrap_or_else(|| "media".to_string())
}

fn is_image_media_value(media: &Value) -> bool {
    let kind = media_kind_text(media).to_ascii_lowercase();
    if kind.contains("image") || kind.contains("cover") {
        return true;
    }
    media_source_url(media)
        .as_deref()
        .is_some_and(|source| is_image_extension(media_extension_from_source(source).as_deref()))
}

fn is_video_media_value(media: &Value) -> bool {
    let kind = media_kind_text(media).to_ascii_lowercase();
    if kind.contains("video") {
        return true;
    }
    media_source_url(media)
        .as_deref()
        .is_some_and(|source| is_video_extension(media_extension_from_source(source).as_deref()))
}

fn copy_account_media_from_knowledge(
    state: &State<'_, AppState>,
    root: &Path,
    media: &Value,
) -> Result<Option<PathBuf>, String> {
    let Some(post_id) = media_post_identifier(media) else {
        return Ok(None);
    };
    let workspace = workspace_root(state)?;
    let Some(source_path) = find_knowledge_media_file(&workspace, &post_id, media) else {
        return Ok(None);
    };
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin");
    let target_path = account_media_file_path(root, &post_id, &media_identifier(media), extension);
    if !target_path.exists() {
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
    }
    Ok(Some(target_path))
}

fn find_knowledge_media_file(workspace: &Path, post_id: &str, media: &Value) -> Option<PathBuf> {
    let entry_dir = workspace
        .join("knowledge")
        .join("redbook")
        .join(format!("knowledge-{}", storage_safe_file_stem(post_id)));
    if !entry_dir.exists() {
        return None;
    }
    if is_image_media_value(media) {
        return find_knowledge_image_file(&entry_dir, media_index(media));
    }
    if is_video_media_value(media) {
        return find_first_media_file(&entry_dir, &["mp4", "mov", "m4v", "webm", "mkv"], 3);
    }
    None
}

fn find_knowledge_image_file(entry_dir: &Path, index: usize) -> Option<PathBuf> {
    let images_dir = entry_dir.join("images");
    let mut images = files_with_extensions(&images_dir, &["webp", "jpg", "jpeg", "png", "avif"]);
    images.sort();
    for candidate_name in [
        format!("image-{}.webp", index + 1),
        format!("image-{}.jpg", index + 1),
        format!("image-{}.jpeg", index + 1),
        format!("image-{}.png", index + 1),
        format!("image-{}.avif", index + 1),
        format!("image-{index}.webp"),
        format!("image-{index}.jpg"),
        format!("image-{index}.jpeg"),
        format!("image-{index}.png"),
        format!("image-{index}.avif"),
    ] {
        let path = images_dir.join(candidate_name);
        if path.exists() {
            return Some(path);
        }
    }
    images
        .get(index)
        .cloned()
        .or_else(|| images.first().cloned())
}

fn find_first_media_file(root: &Path, extensions: &[&str], max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 || !root.exists() {
        return None;
    }
    for path in files_with_extensions(root, extensions) {
        return Some(path);
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_first_media_file(&path, extensions, max_depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn files_with_extensions(root: &Path, extensions: &[&str]) -> Vec<PathBuf> {
    fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .extension()
                            .and_then(|value| value.to_str())
                            .map(|extension| {
                                extensions
                                    .iter()
                                    .any(|item| extension.eq_ignore_ascii_case(item))
                            })
                            .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn download_account_media(root: &Path, media: &Value, source_url: &str) -> Result<PathBuf, String> {
    let parsed = Url::parse(source_url).map_err(|error| format!("媒体 URL 无效: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("媒体 URL 只支持 http/https".to_string());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent("Mozilla/5.0 RedBox/AccountMediaLocalizer")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(source_url)
        .send()
        .map_err(|error| format!("媒体下载失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("媒体下载失败: HTTP {status}"));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response
        .bytes()
        .map_err(|error| format!("媒体读取失败: {error}"))?;
    if bytes.is_empty() {
        return Err("媒体下载结果为空".to_string());
    }
    if bytes.len() > ACCOUNT_MEDIA_DOWNLOAD_LIMIT_BYTES {
        return Err("媒体文件过大".to_string());
    }
    if content_type.contains("application/json")
        || content_type.starts_with("text/")
        || bytes.first().copied() == Some(b'{')
    {
        return Err("媒体 URL 返回的不是媒体文件".to_string());
    }
    let post_id = media_post_identifier(media).unwrap_or_else(|| "unknown".to_string());
    let extension = media_extension_from_content(&content_type)
        .or_else(|| media_extension_from_source(source_url))
        .unwrap_or_else(|| {
            if is_video_media_value(media) {
                "mp4".to_string()
            } else {
                "webp".to_string()
            }
        });
    let target_path = account_media_file_path(root, &post_id, &media_identifier(media), &extension);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target_path, bytes).map_err(|error| error.to_string())?;
    Ok(target_path)
}

fn account_media_file_path(root: &Path, post_id: &str, media_id: &str, extension: &str) -> PathBuf {
    let media_stem = if media_id.trim().is_empty() {
        short_hash(post_id)
    } else {
        storage_safe_file_stem(media_id)
    };
    root.join("media-files")
        .join(storage_safe_file_stem(post_id))
        .join(format!("{media_stem}.{}", normalize_extension(extension)))
}

fn normalize_extension(extension: &str) -> String {
    extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .trim()
        .to_string()
        .if_empty("bin")
}

trait EmptyStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn media_extension_from_content(content_type: &str) -> Option<String> {
    let normalized = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "image/webp" => Some("webp".to_string()),
        "image/jpeg" | "image/jpg" => Some("jpg".to_string()),
        "image/png" => Some("png".to_string()),
        "image/gif" => Some("gif".to_string()),
        "image/avif" => Some("avif".to_string()),
        "video/mp4" => Some("mp4".to_string()),
        "video/quicktime" => Some("mov".to_string()),
        "video/webm" => Some("webm".to_string()),
        _ => None,
    }
}

fn media_extension_from_source(source: &str) -> Option<String> {
    if source.contains("format/webp") || source.contains("format=webp") {
        return Some("webp".to_string());
    }
    let parsed = Url::parse(source).ok();
    let path = parsed
        .as_ref()
        .map(Url::path)
        .unwrap_or(source)
        .split('?')
        .next()
        .unwrap_or(source);
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(normalize_extension)
        .filter(|value| !value.is_empty())
}

fn is_image_extension(extension: Option<&str>) -> bool {
    matches!(
        extension.map(|value| value.to_ascii_lowercase()).as_deref(),
        Some("webp" | "jpg" | "jpeg" | "png" | "gif" | "avif")
    )
}

fn is_video_extension(extension: Option<&str>) -> bool {
    matches!(
        extension.map(|value| value.to_ascii_lowercase()).as_deref(),
        Some("mp4" | "mov" | "m4v" | "webm" | "mkv")
    )
}

fn patch_post_media_local_path(root: &Path, media: &Value, now: &str) -> Result<(), String> {
    let Some(local_path) = json_string(media, "localPath") else {
        return Ok(());
    };
    let Some(post_id) = media_post_identifier(media) else {
        return Ok(());
    };
    let post_path = post_meta_path(root, &post_id);
    if !post_path.exists() {
        return Ok(());
    }
    let Some(mut post) = read_json_value(&post_path) else {
        return Ok(());
    };
    let media_id = media_identifier(media);
    let media_url = media_source_url(media).unwrap_or_default();
    let current_media_index = media_index(media);
    let mut changed = false;
    if let Some(items) = post.get_mut("media").and_then(Value::as_array_mut) {
        for item in items {
            let same_id = !media_id.is_empty() && media_identifier(item) == media_id;
            let same_url = !media_url.is_empty()
                && media_source_url(item)
                    .as_deref()
                    .map(|value| value == media_url)
                    .unwrap_or(false);
            let same_index = media_index(item) == current_media_index
                && media_post_identifier(item).as_deref() == Some(post_id.as_str());
            if same_id || same_url || same_index {
                if let Some(object) = item.as_object_mut() {
                    object.insert("localPath".to_string(), json!(local_path));
                    changed = true;
                }
            }
        }
    }
    if changed {
        if let Some(object) = post.as_object_mut() {
            object.insert("updatedAt".to_string(), json!(now));
        }
        write_json_pretty(&post_path, &post)?;
    }
    Ok(())
}

fn existing_post_count(root: &Path) -> i64 {
    account_post_json_paths(&root.join("posts"))
        .into_iter()
        .filter_map(|path| read_json_value(&path))
        .map(|post| {
            let id = post_identifier(&post);
            if id.is_empty() {
                short_hash(&post.to_string())
            } else {
                id
            }
        })
        .collect::<BTreeSet<_>>()
        .len() as i64
}

fn existing_post_like_count(root: &Path) -> i64 {
    account_post_json_paths(&root.join("posts"))
        .into_iter()
        .filter_map(|path| read_json_value(&path))
        .filter_map(|post| {
            json_i64_at_paths(
                &post,
                &[
                    "stats.likes",
                    "stats.likeCount",
                    "stats.likedCount",
                    "likes",
                    "likeCount",
                    "likedCount",
                ],
            )
        })
        .sum()
}

fn existing_comment_count(root: &Path) -> i64 {
    account_comment_json_paths(root)
        .into_iter()
        .map(|path| {
            read_json_value(&path)
                .and_then(|value| {
                    value
                        .get("comments")
                        .and_then(Value::as_array)
                        .map(|items| items.len() as i64)
                })
                .unwrap_or(0)
        })
        .sum()
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
