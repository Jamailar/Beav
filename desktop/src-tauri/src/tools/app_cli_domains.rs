use super::*;
use crate::store::settings as settings_store;
use crate::store::types::AppStore;

const TASK_BRIEF_MAX_STRING_CHARS: usize = 4_000;
const TASK_BRIEF_MAX_ARRAY_ITEMS: usize = 40;
const TASK_BRIEF_MAX_OBJECT_FIELDS: usize = 80;
const TASK_BRIEF_MAX_DEPTH: usize = 5;
const CAPTURE_DEFAULT_POLL_INTERVAL_MS: u64 = 1_500;
const CAPTURE_DEFAULT_MAX_WAIT_MS: u64 = 120_000;
const CAPTURE_MIN_POLL_INTERVAL_MS: u64 = 500;
const CAPTURE_MAX_POLL_INTERVAL_MS: u64 = 10_000;
const CAPTURE_MIN_WAIT_MS: u64 = 1_000;
const CAPTURE_MAX_WAIT_MS: u64 = 300_000;

fn value_success_is_false(value: &Value) -> bool {
    value.get("success").and_then(Value::as_bool) == Some(false)
}

fn capture_payload_field<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    payload_field(payload, key).or_else(|| {
        payload_field(payload, "options").and_then(|options| payload_field(options, key))
    })
}

fn capture_payload_string(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| capture_payload_field(payload, key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn capture_payload_bool(payload: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| capture_payload_field(payload, key).and_then(payload_bool_value))
}

fn capture_payload_i64(payload: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| capture_payload_field(payload, key).and_then(Value::as_i64))
}

fn sanitize_capture_url(raw: &str) -> String {
    raw.trim()
        .trim_matches(['<', '>'])
        .trim_end_matches(|ch| {
            matches!(
                ch,
                ')' | ']'
                    | '}'
                    | '>'
                    | ','
                    | '.'
                    | '!'
                    | '?'
                    | '，'
                    | '。'
                    | '！'
                    | '？'
                    | '、'
                    | '；'
                    | ';'
                    | '：'
                    | ':'
            )
        })
        .to_string()
}

fn parse_capture_url(raw: &str) -> Result<url::Url, String> {
    let sanitized = sanitize_capture_url(raw);
    if sanitized.is_empty() {
        return Err("capture.collect requires url".to_string());
    }
    let candidate = if sanitized.starts_with("http://") || sanitized.starts_with("https://") {
        sanitized
    } else {
        format!("https://{sanitized}")
    };
    let parsed =
        url::Url::parse(&candidate).map_err(|error| format!("invalid capture url: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("capture url must be http or https".to_string());
    }
    Ok(parsed)
}

fn capture_host_matches(parsed: &url::Url, domains: &[&str]) -> bool {
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    domains
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

fn infer_capture_platform(payload: &Value, parsed: &url::Url) -> Result<String, String> {
    let requested = capture_payload_string(payload, &["platform"])
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_ascii_lowercase();
    let normalized = match requested.as_str() {
        "" | "auto" => {
            if capture_host_matches(parsed, &["xiaohongshu.com", "rednote.com", "xhslink.com"]) {
                "xiaohongshu"
            } else if capture_host_matches(parsed, &["douyin.com", "iesdouyin.com"]) {
                "douyin"
            } else if capture_host_matches(parsed, &["youtube.com", "youtu.be"]) {
                "youtube"
            } else {
                return Err(format!(
                    "unsupported capture platform for host: {}",
                    parsed.host_str().unwrap_or_default()
                ));
            }
        }
        "xhs" | "xiaohongshu" | "rednote" => "xiaohongshu",
        "douyin" => "douyin",
        "youtube" | "yt" => "youtube",
        other => return Err(format!("unsupported capture platform: {other}")),
    };
    Ok(normalized.to_string())
}

fn infer_capture_target(
    payload: &Value,
    platform: &str,
    parsed: &url::Url,
) -> Result<String, String> {
    let requested = capture_payload_string(payload, &["target", "kind"])
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_ascii_lowercase();
    let normalized = match requested.as_str() {
        "" | "auto" => {
            if platform == "xiaohongshu" {
                let parts = parsed
                    .path_segments()
                    .map(|parts| parts.collect::<Vec<_>>())
                    .unwrap_or_default();
                if parts.first().copied() == Some("user")
                    && parts.get(1).copied() == Some("profile")
                {
                    "profile"
                } else if capture_host_matches(parsed, &["xhslink.com"])
                    && parts.first().copied() == Some("m")
                {
                    "profile"
                } else {
                    "content"
                }
            } else {
                "content"
            }
        }
        "content" | "item" | "note" | "video" | "post" => "content",
        "profile" | "home" | "homepage" | "account" | "user" => "profile",
        "comments" | "comment" => "comments",
        other => return Err(format!("unsupported capture target: {other}")),
    };
    if normalized == "profile" && platform != "xiaohongshu" {
        return Err(format!(
            "capture target profile is not supported for {platform}"
        ));
    }
    if normalized == "comments" && platform != "xiaohongshu" {
        return Err(
            "capture target comments is currently supported only for Xiaohongshu notes".to_string(),
        );
    }
    Ok(normalized.to_string())
}

fn capture_kind_for(platform: &str, target: &str) -> Result<&'static str, String> {
    match (platform, target) {
        ("xiaohongshu", "profile") => Ok("xhs-profile"),
        ("xiaohongshu", "content" | "comments") => Ok("xhs-note"),
        ("douyin", "content") => Ok("douyin-video"),
        ("youtube", "content") => Ok("youtube-video"),
        _ => Err(format!(
            "unsupported capture combination: platform={platform}, target={target}"
        )),
    }
}

fn clean_capture_external_id(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect()
}

fn infer_capture_external_id(kind: &str, parsed: &url::Url) -> Option<String> {
    let parts = parsed
        .path_segments()
        .map(|items| items.collect::<Vec<_>>())
        .unwrap_or_default();
    let raw = match kind {
        "youtube-video" => {
            let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
            if host == "youtu.be" || host.ends_with(".youtu.be") {
                parts.first().copied().unwrap_or_default().to_string()
            } else if parts.first().copied() == Some("watch") {
                parsed
                    .query_pairs()
                    .find_map(|(key, value)| (key == "v").then(|| value.to_string()))
                    .unwrap_or_default()
            } else if matches!(parts.first().copied(), Some("shorts" | "embed" | "live")) {
                parts.get(1).copied().unwrap_or_default().to_string()
            } else if parts.first().copied() == Some("clip") {
                parsed
                    .query_pairs()
                    .find_map(|(key, value)| (key == "v").then(|| value.to_string()))
                    .unwrap_or_default()
            } else {
                String::new()
            }
        }
        "xhs-note" => {
            if parts.first().copied() == Some("explore") {
                parts.get(1).copied().unwrap_or_default().to_string()
            } else if parts.first().copied() == Some("discovery")
                && parts.get(1).copied() == Some("item")
            {
                parts.get(2).copied().unwrap_or_default().to_string()
            } else {
                String::new()
            }
        }
        "xhs-profile" => {
            if parts.first().copied() == Some("user") && parts.get(1).copied() == Some("profile") {
                parts.get(2).copied().unwrap_or_default().to_string()
            } else {
                String::new()
            }
        }
        "douyin-video" => {
            if parts.first().copied() == Some("video") {
                parts.get(1).copied().unwrap_or_default().to_string()
            } else if parts.first().copied() == Some("share")
                && parts.get(1).copied() == Some("video")
            {
                parts.get(2).copied().unwrap_or_default().to_string()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    };
    let cleaned = clean_capture_external_id(&raw);
    (!cleaned.is_empty()).then_some(cleaned)
}

fn find_space_in_list(list: &Value, id: Option<&str>, name: Option<&str>) -> Option<Value> {
    let normalized_id = id.map(str::trim).filter(|value| !value.is_empty());
    let normalized_name = name.map(str::trim).filter(|value| !value.is_empty());
    list.get("spaces")
        .and_then(Value::as_array)?
        .iter()
        .find(|item| {
            let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            let item_name = item.get("name").and_then(Value::as_str).unwrap_or_default();
            normalized_id.map(|value| item_id == value).unwrap_or(false)
                || normalized_name
                    .map(|value| item_name.eq_ignore_ascii_case(value))
                    .unwrap_or(false)
        })
        .cloned()
}

fn find_category_by_name(list: &Value, name: &str) -> Option<Value> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return None;
    }
    list.get("categories")
        .and_then(Value::as_array)?
        .iter()
        .find(|item| {
            item.get("name")
                .and_then(Value::as_str)
                .map(|value| value.trim().eq_ignore_ascii_case(normalized))
                .unwrap_or(false)
        })
        .cloned()
}

fn redclaw_profile_doc_type(
    args: &CliArgs,
    payload: &Value,
    default_doc_type: Option<&str>,
) -> Option<String> {
    args.string(&["doc-type", "docType", "type"])
        .or_else(|| payload_string_alias(payload, &["docType", "doc-type", "type", "id"]))
        .or_else(|| args.positionals.first().cloned())
        .or_else(|| default_doc_type.map(ToString::to_string))
}

impl<'a> AppCliExecutor<'a> {
    pub(super) fn handle_session_resources(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        match tokens.first().map(String::as_str).unwrap_or("list") {
            "list" | "search" => self.handle_session_resources_list(payload),
            "get" => self.handle_session_resources_get(payload),
            other => Err(format!("unsupported session-resources action: {other}")),
        }
    }

    pub(super) fn handle_task_brief(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let action = tokens.first().map(String::as_str).unwrap_or("get");
        match action {
            "get" | "read" => self.handle_task_brief_get(payload),
            "update" | "save" => self.handle_task_brief_update(payload),
            "context" => {
                let mut next_payload = payload.as_object().cloned().unwrap_or_default();
                if !next_payload.contains_key("operation") {
                    if let Some(operation) = tokens.get(1).map(String::as_str) {
                        next_payload.insert("operation".to_string(), json!(operation));
                    }
                }
                self.handle_task_brief_context(&Value::Object(next_payload))
            }
            "goal" => {
                let mut next_payload = payload.as_object().cloned().unwrap_or_default();
                if !next_payload.contains_key("operation") {
                    if let Some(operation) = tokens.get(1).map(String::as_str) {
                        next_payload.insert("operation".to_string(), json!(operation));
                    }
                }
                self.handle_task_brief_goal(&Value::Object(next_payload))
            }
            other => Err(format!("unsupported taskBrief action: {other}")),
        }
    }

    pub(super) fn handle_task_brief_get(&self, payload: &Value) -> Result<Value, String> {
        let payload_session_id = payload_string(payload, "sessionId");
        let Some(session_id) = self.session_id.or(payload_session_id.as_deref()) else {
            return Err("taskBrief.get requires an active session".to_string());
        };
        with_store(self.state, |store| {
            let session = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .ok_or_else(|| "taskBrief.get could not find the active session".to_string())?;
            let brief = session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("taskBrief").cloned())
                .or_else(|| {
                    session
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.get("taskHints"))
                        .and_then(|task_hints| task_hints.get("taskBrief"))
                        .cloned()
                })
                .unwrap_or_else(|| json!({}));
            Ok(json!({
                "success": true,
                "sessionId": session_id,
                "taskBrief": brief
            }))
        })
    }

    pub(super) fn handle_task_brief_update(&self, payload: &Value) -> Result<Value, String> {
        let payload_session_id = payload_string(payload, "sessionId");
        let Some(session_id) = self.session_id.or(payload_session_id.as_deref()) else {
            return Err("taskBrief.update requires an active session".to_string());
        };
        let now = now_iso();
        let patch = build_task_brief_patch(payload, &now);
        with_store_mut(self.state, |store| {
            let session = store
                .chat_sessions
                .iter_mut()
                .find(|item| item.id == session_id)
                .ok_or_else(|| "taskBrief.update could not find the active session".to_string())?;
            let mut metadata_object = session
                .metadata
                .clone()
                .and_then(|metadata| metadata.as_object().cloned())
                .unwrap_or_default();
            let mut next_brief = metadata_object
                .get("taskBrief")
                .cloned()
                .or_else(|| {
                    metadata_object
                        .get("taskHints")
                        .and_then(|task_hints| task_hints.get("taskBrief"))
                        .cloned()
                })
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            let previous_revision = next_brief
                .get("revision")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if let Some(patch_object) = patch.as_object() {
                merge_task_brief_object(&mut next_brief, patch_object);
            }
            next_brief.insert("revision".to_string(), json!(previous_revision + 1));
            next_brief.insert("updatedAt".to_string(), json!(now));
            let task_brief = Value::Object(next_brief);
            metadata_object.insert("taskBrief".to_string(), task_brief.clone());
            session.metadata = Some(Value::Object(metadata_object));
            session.updated_at = now_iso();
            Ok(json!({
                "success": true,
                "sessionId": session_id,
                "taskBrief": task_brief
            }))
        })
    }

    pub(super) fn handle_task_brief_context(&self, payload: &Value) -> Result<Value, String> {
        let payload_session_id = payload_string(payload, "sessionId");
        let Some(session_id) = self.session_id.or(payload_session_id.as_deref()) else {
            return Err("taskBrief.context requires an active session".to_string());
        };
        let operation = payload_string(payload, "operation")
            .unwrap_or_else(|| "get".to_string())
            .trim()
            .to_ascii_lowercase();
        match operation.as_str() {
            "get" | "read" | "usage" => with_store(self.state, |store| {
                Ok(task_brief_context_usage_response(&store, session_id))
            }),
            "compact" | "new" | "new_context" | "new-context" => {
                let force = payload_bool(payload, &["force"]).unwrap_or(true);
                let result = with_store_mut(self.state, |store| {
                    let total_messages =
                        crate::runtime::session_message_count_for_session(store, session_id);
                    let snapshot = crate::runtime::update_session_context_record(
                        store, session_id, "manual", force,
                    );
                    Ok(match snapshot {
                        Some(record) => json!({
                            "success": true,
                            "sessionId": session_id,
                            "operation": "compact",
                            "compacted": true,
                            "message": format!(
                                "已归档 {} 条历史消息，保留最近 {} 条用于继续对话",
                                record.compacted_message_count,
                                record.tail_message_count
                            ),
                            "context": crate::runtime::session_context_value_for_session(store, session_id),
                            "usage": task_brief_context_usage_response(&store, session_id),
                            "totalMessages": total_messages,
                        }),
                        None => {
                            let usage = task_brief_context_usage_response(&store, session_id);
                            let threshold = usage
                                .get("context")
                                .and_then(|value| value.get("compactThreshold"))
                                .and_then(Value::as_i64)
                                .unwrap_or(crate::runtime::DEFAULT_SESSION_COMPACT_TARGET_TOKENS);
                            let effective = usage
                                .get("context")
                                .and_then(|value| value.get("estimatedEffectiveTokens"))
                                .and_then(Value::as_i64)
                                .unwrap_or(0);
                            json!({
                                "success": true,
                                "sessionId": session_id,
                                "operation": "compact",
                                "compacted": false,
                                "message": if total_messages <= crate::runtime::SESSION_CONTEXT_TAIL_MESSAGES as i64 {
                                    format!(
                                        "当前仅有 {} 条消息，至少需要超过 {} 条消息才有可归档内容",
                                        total_messages,
                                        crate::runtime::SESSION_CONTEXT_TAIL_MESSAGES
                                    )
                                } else {
                                    format!(
                                        "当前有效上下文约 {} tokens，尚未超过自动 compact 阈值 {}，且没有新的可归档历史",
                                        effective,
                                        threshold
                                    )
                                },
                                "usage": usage,
                                "totalMessages": total_messages,
                            })
                        }
                    })
                })?;
                if result
                    .get("compacted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let summary = result
                        .get("context")
                        .and_then(|value| value.get("summary"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let _ = with_store(self.state, |store| {
                        crate::runtime::append_compact_boundary_entry(
                            self.state, &store, session_id, summary,
                        )
                    });
                }
                Ok(result)
            }
            other => Err(format!(
                "taskBrief.context unsupported operation: {other}; expected get or compact"
            )),
        }
    }

    pub(super) fn handle_task_brief_goal(&self, payload: &Value) -> Result<Value, String> {
        let payload_session_id = payload_string(payload, "sessionId");
        let Some(session_id) = self.session_id.or(payload_session_id.as_deref()) else {
            return Err("taskBrief.goal requires an active session".to_string());
        };
        let operation = payload_string(payload, "operation")
            .unwrap_or_else(|| "get".to_string())
            .trim()
            .to_ascii_lowercase();
        let now = now_iso();
        with_store_mut(self.state, |store| {
            let session = store
                .chat_sessions
                .iter_mut()
                .find(|item| item.id == session_id)
                .ok_or_else(|| "taskBrief.goal could not find the active session".to_string())?;
            let mut metadata_object = session
                .metadata
                .clone()
                .and_then(|metadata| metadata.as_object().cloned())
                .unwrap_or_default();
            let mut next_brief = metadata_object
                .get("taskBrief")
                .cloned()
                .or_else(|| {
                    metadata_object
                        .get("taskHints")
                        .and_then(|task_hints| task_hints.get("taskBrief"))
                        .cloned()
                })
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            let current_goal = next_brief
                .get("goal")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if matches!(operation.as_str(), "get" | "read") {
                return Ok(json!({
                    "success": true,
                    "sessionId": session_id,
                    "goal": Value::Object(current_goal),
                    "taskBrief": Value::Object(next_brief),
                }));
            }

            let mut goal = current_goal.clone();
            match operation.as_str() {
                "create" => {
                    if !goal_is_finished(&goal)
                        && goal
                            .get("objective")
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.trim().is_empty())
                    {
                        return Err(
                            "taskBrief.goal create refused because an unfinished goal already exists"
                                .to_string(),
                        );
                    }
                    let objective = payload_string(payload, "objective")
                        .or_else(|| {
                            payload
                                .get("goal")
                                .and_then(|value| value.get("objective"))
                                .and_then(Value::as_str)
                                .map(ToString::to_string)
                        })
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| "taskBrief.goal create requires objective".to_string())?;
                    goal = Map::new();
                    goal.insert("objective".to_string(), json!(objective));
                    goal.insert("status".to_string(), json!("active"));
                    goal.insert("createdAt".to_string(), json!(now.clone()));
                    goal.insert("updatedAt".to_string(), json!(now.clone()));
                    if let Some(token_budget) = payload_field(payload, "tokenBudget")
                        .or_else(|| {
                            payload
                                .get("goal")
                                .and_then(|value| value.get("tokenBudget"))
                        })
                        .and_then(Value::as_i64)
                        .filter(|value| *value > 0)
                    {
                        goal.insert("tokenBudget".to_string(), json!(token_budget));
                    }
                }
                "update" | "complete" | "block" | "blocked" | "cancel" | "cancelled" => {
                    if goal.is_empty() {
                        return Err("taskBrief.goal update requires an existing goal".to_string());
                    }
                    let mut patch = payload
                        .get("goal")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    for key in ["objective", "status", "tokenBudget", "tokenUsage", "reason"] {
                        if let Some(value) = payload.get(key) {
                            patch.insert(key.to_string(), value.clone());
                        }
                    }
                    if matches!(operation.as_str(), "complete") {
                        patch.insert("status".to_string(), json!("complete"));
                    } else if matches!(operation.as_str(), "block" | "blocked") {
                        patch.insert("status".to_string(), json!("blocked"));
                    } else if matches!(operation.as_str(), "cancel" | "cancelled") {
                        patch.insert("status".to_string(), json!("cancelled"));
                    }
                    patch.remove("operation");
                    patch.remove("sessionId");
                    let sanitized = sanitize_task_brief_value(&Value::Object(patch), 0);
                    if let Some(patch_object) = sanitized.as_object() {
                        merge_task_brief_object(&mut goal, patch_object);
                    }
                    goal.insert("updatedAt".to_string(), json!(now.clone()));
                    match goal.get("status").and_then(Value::as_str) {
                        Some("complete") => {
                            goal.insert("completedAt".to_string(), json!(now.clone()));
                        }
                        Some("blocked") => {
                            goal.insert("blockedAt".to_string(), json!(now.clone()));
                        }
                        Some("cancelled") => {
                            goal.insert("cancelledAt".to_string(), json!(now.clone()));
                        }
                        _ => {}
                    }
                }
                other => {
                    return Err(format!(
                        "taskBrief.goal unsupported operation: {other}; expected get, create, or update"
                    ));
                }
            }

            next_brief.insert("goal".to_string(), Value::Object(goal.clone()));
            next_brief.insert("lastUpdatedAt".to_string(), json!(now.clone()));
            let previous_revision = next_brief
                .get("revision")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            next_brief.insert("revision".to_string(), json!(previous_revision + 1));
            let task_brief = Value::Object(next_brief);
            metadata_object.insert("taskBrief".to_string(), task_brief.clone());
            session.metadata = Some(Value::Object(metadata_object));
            session.updated_at = now_iso();
            Ok(json!({
                "success": true,
                "sessionId": session_id,
                "goal": Value::Object(goal),
                "taskBrief": task_brief,
            }))
        })
    }

    pub(super) fn handle_session_resources_list(&self, payload: &Value) -> Result<Value, String> {
        let payload_session_id = payload_string(payload, "sessionId");
        let Some(session_id) = self.session_id.or(payload_session_id.as_deref()) else {
            return Err("session.resources.list requires an active session".to_string());
        };
        let include_child_sessions =
            payload_bool(payload, &["includeChildSessions"]).unwrap_or(true);
        let limit = payload_field(payload, "limit")
            .and_then(Value::as_u64)
            .map(|value| value.clamp(1, 100) as usize)
            .or(Some(20));
        let kind = payload_string(payload, "kind");
        let query = payload_string(payload, "query");
        with_store(self.state, |store| {
            Ok(crate::runtime::session_resources_value_for_session(
                &store,
                session_id,
                include_child_sessions,
                limit,
                kind.as_deref(),
                query.as_deref(),
            ))
        })
    }

    pub(super) fn handle_session_resources_get(&self, payload: &Value) -> Result<Value, String> {
        let id = payload_string(payload, "id")
            .or_else(|| payload_string(payload, "reference"))
            .ok_or_else(|| "session.resources.get requires id or reference".to_string())?;
        let mut list_payload = json!({
            "limit": 100,
            "includeChildSessions": payload_bool(payload, &["includeChildSessions"]).unwrap_or(true),
        });
        if let Some(session_id) = payload_string(payload, "sessionId") {
            if let Some(object) = list_payload.as_object_mut() {
                object.insert("sessionId".to_string(), json!(session_id));
            }
        }
        let mut listed = self.handle_session_resources_list(&list_payload)?;
        let items = listed
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "session.resources.get failed to load resource list".to_string())?;
        let found = items.iter().find(|item| {
            item.get("id").and_then(Value::as_str) == Some(id.as_str())
                || item.get("reference").and_then(Value::as_str) == Some(id.as_str())
                || item.get("path").and_then(Value::as_str) == Some(id.as_str())
        });
        found
            .cloned()
            .map(|resource| json!({ "success": true, "item": resource }))
            .ok_or_else(|| format!("session resource not found: {id}"))
    }

    pub(super) fn handle_advisors(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("advisors")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => {
                let result = self.call_channel("advisors:list", json!({}))?;
                let mut advisors = result.as_array().cloned().unwrap_or_default();
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(20)
                    .clamp(1, 50) as usize;
                advisors.truncate(limit);
                Ok(json!({ "success": true, "advisors": advisors }))
            }
            "get" => {
                let advisor_id = args
                    .string(&["id", "advisor-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "advisors get requires --id".to_string())?;
                let result = self.call_channel("advisors:list", json!({}))?;
                let advisor = result.as_array().and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id")
                            .and_then(Value::as_str)
                            .map(|value| value == advisor_id)
                            .unwrap_or(false)
                    })
                });
                Ok(json!({ "success": advisor.is_some(), "advisor": advisor.cloned() }))
            }
            "list-templates" => self.call_channel("advisors:list-templates", json!({})),
            "create" => self.call_channel("advisors:create", merge_payload(&args.options, payload)),
            "update" => self.call_channel("advisors:update", merge_payload(&args.options, payload)),
            "delete" => self.call_channel(
                "advisors:delete",
                json!(args
                    .string(&["id", "advisor-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "advisors delete requires --id".to_string())?),
            ),
            _ => Err(format!("unsupported advisors action: {action}")),
        }
    }

    pub(super) fn handle_chat(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("chat")));
        };
        match action {
            "sessions" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                let args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "list" => {
                        let result = self.call_channel("chat:get-sessions", json!({}))?;
                        let mut sessions = result.as_array().cloned().unwrap_or_default();
                        let limit = args
                            .i64(&["limit"])
                            .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                            .unwrap_or(20)
                            .clamp(1, 50) as usize;
                        sessions.truncate(limit);
                        Ok(json!({ "success": true, "sessions": sessions }))
                    }
                    "get" => {
                        let session_id = args
                            .string(&["id", "session-id"])
                            .or_else(|| args.positionals.first().cloned())
                            .ok_or_else(|| "chat sessions get requires --id".to_string())?;
                        let result = self.call_channel("chat:get-sessions", json!({}))?;
                        let session = result.as_array().and_then(|items| {
                            items.iter().find(|item| {
                                item.get("id")
                                    .and_then(Value::as_str)
                                    .map(|value| value == session_id)
                                    .unwrap_or(false)
                            })
                        });
                        Ok(json!({ "success": session.is_some(), "session": session.cloned() }))
                    }
                    _ => Err(format!("unsupported chat sessions action: {sub}")),
                }
            }
            _ => Err(format!("unsupported chat action: {action}")),
        }
    }

    pub(super) fn handle_spaces(&self, tokens: &[String]) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("spaces")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("spaces:list", json!({})),
            "get" => {
                let id = args
                    .string(&["id", "space-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "spaces get requires --id".to_string())?;
                let result = self.call_channel("spaces:list", json!({}))?;
                let space = result
                    .get("spaces")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(|value| value == id)
                                .unwrap_or(false)
                        })
                    })
                    .cloned();
                Ok(json!({ "success": space.is_some(), "space": space }))
            }
            "create" => self.call_channel(
                "spaces:create",
                json!({
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces create requires --name".to_string())?
                }),
            ),
            "rename" => self.call_channel(
                "spaces:rename",
                json!({
                    "id": args
                        .string(&["id", "space-id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces rename requires --id".to_string())?,
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.get(1).cloned())
                        .ok_or_else(|| "spaces rename requires --name".to_string())?
                }),
            ),
            "delete" => self.call_channel(
                "spaces:delete",
                json!({
                    "id": args
                        .string(&["id", "space-id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces delete requires --id".to_string())?
                }),
            ),
            "switch" => self.call_channel(
                "spaces:switch",
                json!({
                    "spaceId": args
                        .string(&["id", "space-id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces switch requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported spaces action: {action}")),
        }
    }

    pub(super) fn handle_spaces_manage(&self, payload: &Value) -> Result<Value, String> {
        let operation = payload_string(payload, "operation")
            .map(|value| normalized_app_cli_action_key(&value))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                app_cli_error_json(
                    Some("spaces.manage"),
                    "OPERATION_REQUIRED",
                    "spaces.manage requires an operation",
                    false,
                    None,
                )
            })?;
        let request = consolidated_action_payload(payload);
        match operation.as_str() {
            "list" => self.call_channel("spaces:list", json!({})),
            "get" => self.handle_spaces_manage_get(&request),
            "create" => self.call_channel(
                "spaces:create",
                json!({
                    "name": payload_string_alias(&request, &["name", "spaceName"])
                        .ok_or_else(|| "spaces.manage create requires name".to_string())?
                }),
            ),
            "switch" => self.call_channel(
                "spaces:switch",
                json!({
                    "spaceId": payload_string_alias(&request, &["spaceId", "id"])
                        .ok_or_else(|| "spaces.manage switch requires spaceId".to_string())?
                }),
            ),
            "rename" => self.call_channel(
                "spaces:rename",
                json!({
                    "id": payload_string_alias(&request, &["id", "spaceId"])
                        .ok_or_else(|| "spaces.manage rename requires id".to_string())?,
                    "name": payload_string_alias(&request, &["name"])
                        .ok_or_else(|| "spaces.manage rename requires name".to_string())?
                }),
            ),
            "delete" => self.call_channel(
                "spaces:delete",
                json!({
                    "id": payload_string_alias(&request, &["id", "spaceId"])
                        .ok_or_else(|| "spaces.manage delete requires id".to_string())?
                }),
            ),
            "ensure" => self.handle_spaces_manage_ensure(&request),
            _ => Err(app_cli_error_json(
                Some("spaces.manage"),
                "UNSUPPORTED_OPERATION",
                &format!("unsupported spaces.manage operation: {operation}"),
                false,
                None,
            )),
        }
    }

    fn handle_spaces_manage_get(&self, payload: &Value) -> Result<Value, String> {
        let id = payload_string_alias(payload, &["id", "spaceId"]);
        let name = payload_string_alias(payload, &["name", "spaceName"]);
        if id.is_none() && name.is_none() {
            return Err("spaces.manage get requires id or name".to_string());
        }
        let list = self.call_channel("spaces:list", json!({}))?;
        let space = find_space_in_list(&list, id.as_deref(), name.as_deref());
        Ok(json!({ "success": space.is_some(), "space": space }))
    }

    fn handle_spaces_manage_ensure(&self, payload: &Value) -> Result<Value, String> {
        let name = payload_string_alias(payload, &["name", "spaceName"])
            .ok_or_else(|| "spaces.manage ensure requires name".to_string())?;
        let activate = payload_bool(payload, &["activate"]).unwrap_or(true);
        let list = self.call_channel("spaces:list", json!({}))?;
        if let Some(space) = find_space_in_list(&list, None, Some(&name)) {
            let space_id = space
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut switch_result = Value::Null;
            if activate && !space_id.is_empty() {
                switch_result =
                    self.call_channel("spaces:switch", json!({ "spaceId": space_id.clone() }))?;
                if value_success_is_false(&switch_result) {
                    return Ok(json!({
                        "success": false,
                        "created": false,
                        "space": space,
                        "switch": switch_result
                    }));
                }
            }
            return Ok(json!({
                "success": true,
                "created": false,
                "activated": activate,
                "space": space,
                "activeSpaceId": if activate { json!(space_id) } else { list.get("activeSpaceId").cloned().unwrap_or(Value::Null) },
                "switch": switch_result
            }));
        }
        let created = self.call_channel("spaces:create", json!({ "name": name }))?;
        if value_success_is_false(&created) {
            return Ok(json!({
                "success": false,
                "created": false,
                "space": Value::Null,
                "create": created
            }));
        }
        Ok(json!({
            "success": true,
            "created": true,
            "activated": true,
            "space": created.get("space").cloned().unwrap_or(Value::Null),
            "activeSpaceId": created.get("activeSpaceId").cloned().unwrap_or(Value::Null),
            "create": created
        }))
    }

    pub(super) fn handle_workspace_setup(&self, payload: &Value) -> Result<Value, String> {
        let space_name = payload_string_alias(payload, &["spaceName", "name"])
            .ok_or_else(|| "workspace.setup requires spaceName".to_string())?;
        let activate = payload_bool(payload, &["activate"]).unwrap_or(true);
        let mut category_names = value_string_list(payload_field(payload, "assetCategories"), 20);
        if category_names.is_empty() {
            category_names = value_string_list(payload_field(payload, "categories"), 20);
        }
        dedupe_string_list(&mut category_names, 20);

        let space_result = self.handle_spaces_manage(&json!({
            "operation": "ensure",
            "name": space_name,
            "activate": activate
        }))?;
        if value_success_is_false(&space_result) {
            return Ok(json!({
                "success": false,
                "space": space_result,
                "categories": []
            }));
        }

        let existing_categories = self.call_channel("subjects:categories:list", json!({}))?;
        let mut category_results = Vec::<Value>::new();
        for name in category_names {
            if find_category_by_name(&existing_categories, &name).is_some() {
                category_results.push(json!({
                    "name": name,
                    "status": "existing"
                }));
                continue;
            }
            let created =
                self.call_channel("subjects:categories:create", json!({ "name": name }))?;
            category_results.push(json!({
                "name": name,
                "status": if value_success_is_false(&created) { "failed" } else { "created" },
                "result": created
            }));
        }
        let success = category_results
            .iter()
            .all(|item| item.get("status").and_then(Value::as_str) != Some("failed"));
        Ok(json!({
            "success": success,
            "space": space_result,
            "categories": category_results
        }))
    }

    pub(super) fn handle_subjects(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("subjects")));
        };
        if action == "categories" {
            return self.handle_subject_categories(&tokens[1..], payload);
        }
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("subjects:list", json!({})),
            "get" => self.call_channel(
                "subjects:get",
                json!({
                    "id": subject_id_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "subjects get requires --id".to_string())?
                }),
            ),
            "search" => self.call_channel(
                "subjects:search",
                json!({
                    "query": subject_query_from_args_or_payload(&args, payload).unwrap_or_default(),
                    "categoryId": subject_category_from_args_or_payload(&args, payload)
                }),
            ),
            "create" => self.call_channel("subjects:create", merge_payload(&args.options, payload)),
            "update" => self.call_channel("subjects:update", merge_payload(&args.options, payload)),
            "delete" => self.call_channel(
                "subjects:delete",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| payload_string_alias(payload, &["id", "assetId", "subjectId"]))
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "subjects delete requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported subjects action: {action}")),
        }
    }

    pub(super) fn asset_payload_with_resolved_category(
        &self,
        payload: &Value,
    ) -> Result<Value, String> {
        let mut map = payload.as_object().cloned().unwrap_or_default();
        if map
            .get("categoryId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Ok(Value::Object(map));
        }
        let category_name = payload_string(payload, "categoryName")
            .or_else(|| {
                payload_string(payload, "kind")
                    .filter(|kind| kind.trim().eq_ignore_ascii_case("character"))
                    .map(|_| "角色".to_string())
            })
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(category_name) = category_name else {
            return Ok(Value::Object(map));
        };
        let categories_result = self.call_channel("subjects:categories:list", json!({}))?;
        let category_id = categories_result
            .get("categories")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?;
                    if name.trim().eq_ignore_ascii_case(&category_name) {
                        item.get("id")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    } else {
                        None
                    }
                })
            })
            .map(Ok)
            .unwrap_or_else(|| {
                let created = self.call_channel(
                    "subjects:categories:create",
                    json!({ "name": category_name }),
                )?;
                created
                    .pointer("/category/id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .ok_or_else(|| {
                        created
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("资产分类创建失败")
                            .to_string()
                    })
            })?;
        map.insert("categoryId".to_string(), json!(category_id));
        Ok(Value::Object(map))
    }

    pub(super) fn handle_subject_categories(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("subjects")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("subjects:categories:list", json!({})),
            "create" => self.call_channel(
                "subjects:categories:create",
                merge_payload(&args.options, payload),
            ),
            "update" => self.call_channel(
                "subjects:categories:update",
                merge_payload(&args.options, payload),
            ),
            "delete" => self.call_channel(
                "subjects:categories:delete",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "subjects categories delete requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported subjects categories action: {action}")),
        }
    }

    pub(super) fn handle_manuscripts(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("manuscripts")));
        };
        if action == "layout" {
            return self.handle_manuscript_layout(&tokens[1..], payload);
        }
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("manuscripts:list", json!({})),
            "read" => self.call_channel(
                "manuscripts:read",
                json!(args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts read requires --path".to_string())?),
            ),
            "write-current" => {
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object
                        .entry("content".to_string())
                        .or_insert(json!(args.string(&["content"]).unwrap_or_default()));
                }
                self.handle_manuscript_write_current(&merged)
            }
            "write" | "save" => {
                let path = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts write requires --path".to_string())?;
                let normalized_path = self.normalize_manuscript_target_path(&path);
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object.insert("path".to_string(), json!(normalized_path.clone()));
                    if !object.contains_key("content") {
                        object.insert(
                            "content".to_string(),
                            json!(args.string(&["content"]).unwrap_or_default()),
                        );
                    }
                }
                self.validate_authoring_save_content(
                    authoring_project_kind_from_target_path(&normalized_path),
                    &payload_string(&merged, "content").unwrap_or_default(),
                )?;
                let maybe_proposal = self.maybe_queue_writing_manuscript_proposal(
                    &normalized_path,
                    payload_string(&merged, "content").unwrap_or_default(),
                    payload_field(&merged, "metadata"),
                )?;
                if let Some(result) = maybe_proposal {
                    return Ok(result);
                }
                self.call_channel("manuscripts:save", merged)
            }
            "create" => {
                let relative = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts create requires --path".to_string())?;
                let normalized = self.normalize_manuscript_target_path(&relative);
                let (parent_path, name) = split_parent_and_name(&normalized);
                self.call_channel(
                    "manuscripts:create-file",
                    json!({
                    "parentPath": parent_path,
                    "name": name,
                    "title": args.string(&["title"]),
                    "content": payload_string(payload, "content")
                        .or_else(|| args.string(&["content"]))
                        .unwrap_or_default(),
                    }),
                )
            }
            "create-project" => self.handle_manuscript_create_project(&args, payload),
            "delete" => self.call_channel(
                "manuscripts:delete",
                json!(args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts delete requires --path".to_string())?),
            ),
            _ => Err(format!("unsupported manuscripts action: {action}")),
        }
    }

    pub(super) fn handle_manuscript_layout(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("manuscripts")));
        };
        match action {
            "get" => self.call_channel("manuscripts:get-layout", json!({})),
            "save" => self.call_channel("manuscripts:save-layout", payload.clone()),
            _ => Err(format!("unsupported manuscripts layout action: {action}")),
        }
    }

    pub(super) fn handle_media(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("media")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("media:list", json!({})),
            "jobs" | "job-list" | "generation-jobs" => {
                self.call_channel("generation:list-jobs", payload.clone())
            }
            "job" | "job-get" | "generation-job" | "progress" | "status" => {
                let job_id = args
                    .string(&["job-id", "jobId", "id"])
                    .or_else(|| payload_string_alias(payload, &["jobId", "id"]))
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "media job status requires jobId".to_string())?;
                self.call_channel("generation:get-job", json!({ "jobId": job_id }))
            }
            "get" => {
                let asset_id = args
                    .string(&["id", "asset-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "media get requires --id".to_string())?;
                let result = self.call_channel("media:list", json!({}))?;
                let asset = result
                    .get("assets")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(|value| value == asset_id)
                                .unwrap_or(false)
                        })
                    })
                    .cloned();
                Ok(json!({ "success": asset.is_some(), "asset": asset }))
            }
            "update" => self.call_channel("media:update", merge_payload(&args.options, payload)),
            "bind" => self.call_channel("media:bind", merge_payload(&args.options, payload)),
            "edit" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(path) = args
                        .string(&["source-path", "sourcePath", "path", "tool-path", "toolPath"])
                        .or_else(|| args.positionals.first().cloned())
                    {
                        object.insert("sourcePath".to_string(), json!(path));
                    }
                    if let Some(summary) = args.string(&["intent-summary", "intentSummary"]) {
                        object.insert("intentSummary".to_string(), json!(summary));
                    }
                }
                commands::media_edit::execute_media_edit(
                    self.app,
                    self.state,
                    self.session_id,
                    &request,
                )
            }
            "transcribe" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(path) = args
                        .string(&["source-path", "sourcePath", "path", "tool-path", "toolPath"])
                        .or_else(|| args.positionals.first().cloned())
                    {
                        object.insert("sourcePath".to_string(), json!(path));
                    }
                    if let Some(format) =
                        args.string(&["format", "response-format", "responseFormat"])
                    {
                        object.insert("format".to_string(), json!(format));
                    }
                    if let Some(language) = args.string(&["language", "lang"]) {
                        object.insert("language".to_string(), json!(language));
                    }
                }
                commands::media_transcribe::execute_media_transcribe(
                    self.app,
                    self.state,
                    self.session_id,
                    &request,
                )
            }
            "video-retalk" | "videoretalk" | "retalk" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    object.insert("model".to_string(), json!("videoretalk"));
                    object.insert("generationMode".to_string(), json!("video-retalk"));
                    object.entry("source".to_string()).or_insert(json!("tool"));
                    if let Some(video_url) = args.string(&["video-url", "videoUrl", "video_url"]) {
                        let input = object.entry("input".to_string()).or_insert(json!({}));
                        if let Some(input_object) = input.as_object_mut() {
                            input_object.insert("video_url".to_string(), json!(video_url));
                        }
                    }
                    if let Some(audio_url) = args.string(&["audio-url", "audioUrl", "audio_url"]) {
                        let input = object.entry("input".to_string()).or_insert(json!({}));
                        if let Some(input_object) = input.as_object_mut() {
                            input_object.insert("audio_url".to_string(), json!(audio_url));
                        }
                    }
                    if let Some(duration_seconds) =
                        args.string(&["duration-seconds", "durationSeconds", "duration_seconds"])
                    {
                        object.insert("durationSeconds".to_string(), json!(duration_seconds));
                    }
                    if let Some(resolution) = args.string(&["resolution"]) {
                        object.insert("resolution".to_string(), json!(resolution));
                    }
                    if let Some(video_extension) =
                        args.bool(&["video-extension", "videoExtension", "video_extension"])
                    {
                        object.insert("videoExtension".to_string(), json!(video_extension));
                    }
                    if let Some(session_id) = self.session_id {
                        object.insert("sessionId".to_string(), json!(session_id));
                    }
                    if let Some(tool_call_id) = self.tool_call_id {
                        object.insert("toolCallId".to_string(), json!(tool_call_id));
                        object.insert("toolName".to_string(), json!("workflow"));
                    }
                }
                let wait_for_completion = video_generation_should_wait(self.session_id, &request);
                if !wait_for_completion {
                    self.emit_tool_partial("VideoRetalk 任务已提交，后台会持续等待结果。");
                    let submitted = self.call_channel("generation:submit-video", request)?;
                    let follow_up = submitted
                        .get("jobId")
                        .and_then(Value::as_str)
                        .and_then(|job_id| {
                            self.session_id.map(|session_id| {
                                crate::media_runtime::spawn_media_job_followup_for_kind(
                                    self.app,
                                    self.runtime_mode,
                                    session_id,
                                    job_id,
                                    "video",
                                    1,
                                )
                            })
                        })
                        .transpose();
                    let mut result = submitted;
                    if let Some(object) = result.as_object_mut() {
                        match follow_up {
                            Ok(Some(follow_up)) => {
                                object.insert("followUp".to_string(), follow_up);
                            }
                            Ok(None) => {}
                            Err(error) => {
                                object.insert(
                                    "followUp".to_string(),
                                    json!({
                                        "success": false,
                                        "error": error,
                                    }),
                                );
                            }
                        }
                    }
                    return Ok(result);
                }
                self.emit_tool_partial("VideoRetalk 任务已提交，正在等待生成视频完成。");
                self.call_channel("video-gen:generate", request)
            }
            "delete" => self.call_channel(
                "media:delete",
                json!({
                    "assetId": args
                        .string(&["asset-id", "id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "media delete requires --asset-id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported media action: {action}")),
        }
    }

    pub(super) fn handle_voice(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("voice")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("voice:list", merge_payload(&args.options, payload)),
            "get" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(voice_id) = args
                    .string(&["voice-id", "voiceId", "id"])
                    .or_else(|| args.positionals.first().cloned())
                {
                    if let Some(object) = request.as_object_mut() {
                        object.insert("voiceId".to_string(), json!(voice_id));
                    }
                }
                self.call_channel("voice:get", request)
            }
            "clone" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(path) = args
                        .string(&["sample-path", "samplePath", "path", "file-path", "filePath"])
                        .or_else(|| args.positionals.first().cloned())
                    {
                        object.insert("samplePath".to_string(), json!(path));
                    }
                    if let Some(asset_id) =
                        args.string(&["owner-asset-id", "ownerAssetId", "asset-id", "assetId"])
                    {
                        object.insert("ownerAssetId".to_string(), json!(asset_id));
                    }
                    if let Some(sample_file_key) =
                        args.string(&["sample-file-key", "sampleFileKey", "sample_file_key"])
                    {
                        object.insert("sampleFileKey".to_string(), json!(sample_file_key));
                    }
                }
                self.call_channel("voice:clone", request)
            }
            "bind-asset" | "bind" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(asset_id) =
                        args.string(&["owner-asset-id", "ownerAssetId", "asset-id", "assetId"])
                    {
                        object.insert("ownerAssetId".to_string(), json!(asset_id));
                    }
                    if let Some(voice_id) = args.string(&["voice-id", "voiceId", "voice"]) {
                        object.insert("voiceId".to_string(), json!(voice_id));
                    }
                }
                self.call_channel("voice:bind-asset", request)
            }
            "speech" | "tts" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(input) = args.string(&["input", "text"]).or_else(|| {
                        if args.positionals.is_empty() {
                            None
                        } else {
                            Some(args.positionals.join(" "))
                        }
                    }) {
                        object.entry("input".to_string()).or_insert(json!(input));
                    }
                    if let Some(voice_id) = args.string(&["voice-id", "voiceId", "voice"]) {
                        object.insert("voiceId".to_string(), json!(voice_id));
                    }
                }
                self.call_channel("voice:speech", request)
            }
            "delete" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(voice_id) = args
                    .string(&["voice-id", "voiceId", "id"])
                    .or_else(|| args.positionals.first().cloned())
                {
                    if let Some(object) = request.as_object_mut() {
                        object.insert("voiceId".to_string(), json!(voice_id));
                    }
                }
                self.call_channel("voice:delete", request)
            }
            _ => Err(format!("unsupported voice action: {action}")),
        }
    }

    pub(super) fn handle_image(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("image")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "generate" => self.handle_image_generate(&args, payload),
            "history" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                match sub {
                    "list" => self.generated_media_history("image"),
                    "get" => {
                        let nested_args = parse_cli_args(&tokens[2..])?;
                        let id = nested_args
                            .string(&["id", "asset-id"])
                            .or_else(|| nested_args.positionals.first().cloned())
                            .ok_or_else(|| "image history get requires --id".to_string())?;
                        self.generated_media_history_get("image", &id)
                    }
                    _ => Err(format!("unsupported image history action: {sub}")),
                }
            }
            "providers" | "models" => {
                let summary = self.call_channel("db:get-settings", json!({}))?;
                Ok(json!({
                    "imageProvider": summary.get("image_provider").cloned().unwrap_or(Value::Null),
                    "imageProviderTemplate": summary.get("image_provider_template").cloned().unwrap_or(Value::Null),
                    "imageModel": summary.get("image_model").cloned().unwrap_or(Value::Null),
                    "imageEndpoint": summary.get("image_endpoint").cloned().unwrap_or(Value::Null),
                    "hasImageApiKey": summary
                        .get("image_api_key")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false),
                    "visualIndexEnabled": true,
                    "visualIndexProvider": summary.get("visual_index_provider").cloned().unwrap_or(Value::Null),
                    "visualIndexModel": summary.get("visual_index_model").cloned().unwrap_or(Value::Null),
                    "visualIndexEndpoint": summary.get("visual_index_endpoint").cloned().unwrap_or(Value::Null),
                    "hasVisualIndexApiKey": summary
                        .get("visual_index_api_key")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false)
                }))
            }
            _ => Err(format!("unsupported image action: {action}")),
        }
    }

    pub(super) fn handle_video(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("video")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "analyze" => {
                let mut merged = payload.clone();
                if let Some(object) = merged.as_object_mut() {
                    if let Some(path) = args.string(&["path", "tool-path", "toolPath"]) {
                        object.insert("path".to_string(), json!(path));
                    }
                    if let Some(mode) = args.string(&["mode"]) {
                        object.insert("mode".to_string(), json!(mode));
                    }
                }
                self.handle_video_analyze(&merged)
            }
            "generate" => self.handle_video_generate(&args, payload),
            "project-create" => self.handle_video_project_create(&args, payload),
            "project-list" => self.handle_video_project_list(),
            "project-get" => self.handle_video_project_get(&args),
            "project-brief" => self.handle_video_project_brief(&args, payload),
            "project-script" => self.handle_video_project_script(&args, payload),
            "project-asset-add" => self.handle_video_project_asset_add(&args, payload),
            _ => Err(format!("unsupported video action: {action}")),
        }
    }

    fn resolve_video_analysis_path(&self, raw_path: &str) -> Result<PathBuf, String> {
        let normalized = raw_path.trim().replace('\\', "/");
        if normalized.is_empty() {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "FILE_UNAVAILABLE",
                "video.analyze requires payload.path or payload.toolPath",
                false,
                None,
            ));
        }
        let candidate = PathBuf::from(&normalized);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            workspace_root(self.state)
                .map_err(|error| error.to_string())?
                .join(normalized)
        };
        if !resolved.is_file() {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "FILE_UNAVAILABLE",
                &format!("video file is not available: {}", resolved.display()),
                false,
                None,
            ));
        }
        Ok(resolved)
    }

    fn video_analysis_model_config(&self) -> Result<Value, String> {
        let settings = with_store(self.state, |store| {
            Ok(settings_store::settings_snapshot(&store))
        })?;
        let resolved = crate::ai_model_manager::AiModelManager::resolve(
            &settings,
            crate::ai_model_manager::AiModelScope::VideoAnalysis,
            None,
        );
        let base_url = resolved
            .as_ref()
            .map(|route| route.base_url.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| payload_string(&settings, "video_analysis_endpoint"))
            .or_else(|| payload_string(&settings, "api_endpoint"))
            .unwrap_or_default();
        let model_name = resolved
            .as_ref()
            .map(|route| route.model_name.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| payload_string(&settings, "video_analysis_model"))
            .unwrap_or_default();
        if base_url.trim().is_empty() || model_name.trim().is_empty() {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "MISSING_VIDEO_MODEL",
                "Video Analysis Agent 缺少 endpoint 或模型名。",
                false,
                Some(json!({
                    "agentRole": "Video Analysis Agent",
                    "requiredSettings": ["video_analysis_endpoint", "video_analysis_model"]
                })),
            ));
        }
        let api_key = resolved
            .as_ref()
            .and_then(|route| route.api_key.clone())
            .or_else(|| payload_string(&settings, "video_analysis_api_key"))
            .or_else(|| payload_string(&settings, "api_key"));
        let protocol = resolved
            .as_ref()
            .map(|route| route.protocol.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| payload_string(&settings, "video_analysis_protocol"))
            .unwrap_or_else(|| infer_protocol(&base_url, None, None));
        Ok(json!({
            "protocol": protocol,
            "baseURL": base_url,
            "apiKey": api_key,
            "modelName": model_name,
            "maxBytes": settings
                .get("video_analysis_max_direct_video_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_VIDEO_ANALYSIS_MAX_BYTES),
        }))
    }

    pub(super) fn handle_video_analyze(&self, payload: &Value) -> Result<Value, String> {
        let path = payload_string(payload, "toolPath")
            .or_else(|| payload_string(payload, "path"))
            .or_else(|| payload_string(payload, "workspaceRelativePath"))
            .ok_or_else(|| {
                app_cli_error_json(
                    Some("video.analyze"),
                    "FILE_UNAVAILABLE",
                    "video.analyze requires payload.path or payload.toolPath",
                    false,
                    None,
                )
            })?;
        let video_path = self.resolve_video_analysis_path(&path)?;
        let metadata = fs::metadata(&video_path).map_err(|error| {
            app_cli_error_json(
                Some("video.analyze"),
                "FILE_UNAVAILABLE",
                &error.to_string(),
                false,
                None,
            )
        })?;
        let model_config = self.video_analysis_model_config()?;
        let max_bytes = model_config
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_VIDEO_ANALYSIS_MAX_BYTES);
        if metadata.len() == 0 || metadata.len() > max_bytes {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "FILE_TOO_LARGE",
                &format!(
                    "视频文件大小为 {} bytes，超过 Video Analysis Agent 直传上限 {} bytes。",
                    metadata.len(),
                    max_bytes
                ),
                false,
                Some(json!({ "size": metadata.len(), "maxBytes": max_bytes })),
            ));
        }
        let (_guessed_mime, kind, _) = guess_mime_and_kind(&video_path);
        if kind != "video" {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "UNSUPPORTED_MEDIA",
                "video.analyze 只接受视频文件。",
                false,
                Some(json!({ "kind": kind, "path": video_path.display().to_string() })),
            ));
        }
        let mime_type = payload_string(payload, "mimeType")
            .unwrap_or_else(|| "video/*".to_string())
            .replace("video/*", "video/mp4");
        let bytes = fs::read(&video_path).map_err(|error| {
            app_cli_error_json(
                Some("video.analyze"),
                "FILE_UNAVAILABLE",
                &error.to_string(),
                false,
                None,
            )
        })?;
        let mode = payload_string(payload, "mode").unwrap_or_else(|| "summary".to_string());
        let instruction = payload_string(payload, "instruction").unwrap_or_default();
        let attachment_id = payload_string(payload, "attachmentId");
        let protocol = model_config
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("openai");
        let base_url = model_config
            .get("baseURL")
            .and_then(Value::as_str)
            .unwrap_or("");
        let api_key = model_config.get("apiKey").and_then(Value::as_str);
        let model_name = model_config
            .get("modelName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let file_hash = short_sha256_hex(&bytes);
        let cache_key =
            video_analysis_cache_key(&file_hash, metadata.len(), &mode, model_name, &instruction);
        let cache_path = workspace_root(self.state)
            .map_err(|error| error.to_string())?
            .join(".redbox")
            .join("video-analysis-cache")
            .join(format!("{cache_key}.json"));
        if let Some(mut cached) = read_video_analysis_cache(&cache_path) {
            if let Some(object) = cached.as_object_mut() {
                object.insert("cacheHit".to_string(), json!(true));
                object.insert(
                    "cachePath".to_string(),
                    json!(cache_path.display().to_string()),
                );
            }
            return Ok(cached);
        }
        let base64_data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let system_prompt = video_analysis_agent_system_prompt();
        let user_prompt = format!(
            "请作为 Video Analysis Agent 分析这个视频。\n\nanalysisMode: {}\nattachmentId: {}\nvideoPath: {}\ninstruction: {}\n\n只输出 JSON。",
            mode.trim(),
            attachment_id.as_deref().unwrap_or(""),
            video_path.display(),
            instruction.trim()
        );
        let raw = crate::official_support::invoke_video_analysis_by_protocol(
            protocol,
            base_url,
            api_key,
            model_name,
            system_prompt,
            &user_prompt,
            &mime_type,
            &base64_data,
        )
        .map_err(|error| {
            app_cli_error_json(
                Some("video.analyze"),
                "PROVIDER_ERROR",
                &error,
                true,
                Some(json!({
                    "agentRole": "Video Analysis Agent",
                    "modelName": model_name,
                    "protocol": protocol
                })),
            )
        })?;
        let parsed = parse_json_value_from_text(&raw).unwrap_or_else(|| {
            json!({
                "success": true,
                "summary": raw,
                "scenes": [],
                "highlights": [],
                "editingSuggestions": [],
                "warnings": ["Video Analysis Agent returned non-JSON text; wrapped as summary."]
            })
        });
        let output = json!({
            "analysisId": make_id("video-analysis"),
            "cacheHit": false,
            "cacheKey": cache_key,
            "cachePath": cache_path.display().to_string(),
            "agentRole": "Video Analysis Agent",
            "modelName": model_name,
            "source": {
                "attachmentId": attachment_id,
                "path": video_path.display().to_string(),
                "mimeType": mime_type,
                "size": metadata.len(),
                "fileHash": file_hash
            },
            "mode": mode,
            "result": parsed,
            "createdAt": now_iso(),
        });
        write_video_analysis_cache(&cache_path, &output);
        Ok(output)
    }

    pub(super) fn handle_knowledge(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("knowledge")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => Ok(json!({
                "notes": self.call_channel("knowledge:list", json!({}))?,
                "youtube": self.call_channel("knowledge:list-youtube", json!({}))?,
                "documentSources": self.call_channel("knowledge:docs:list", json!({}))?
            })),
            "search" => self.call_channel(
                "knowledge:list",
                json!({}),
            )
            .and_then(|_| {
                let query = args
                    .string(&["query", "q"])
                    .or_else(|| payload_string(payload, "query"))
                    .or_else(|| {
                        if args.positionals.is_empty() {
                            None
                        } else {
                            Some(args.positionals.join(" "))
                        }
                    })
                    .unwrap_or_default()
                    .to_lowercase();
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(8)
                    .clamp(1, 20) as usize;
                with_store(self.state, |store| {
                    let mut hits = Vec::<Value>::new();
                    for note in &store.knowledge_notes {
                        let haystack = format!(
                            "{}\n{}\n{}",
                            note.title,
                            note.content,
                            note.transcript.clone().unwrap_or_default()
                        )
                        .to_lowercase();
                        if haystack.contains(&query) {
                            hits.push(json!({
                                "kind": "note",
                                "id": note.id,
                                "title": note.title,
                                "snippet": text_snippet(&note.content, 220),
                                "sourceUrl": note.source_url,
                            }));
                        }
                    }
                    for video in &store.youtube_videos {
                        let haystack = format!(
                            "{}\n{}\n{}\n{}",
                            video.title,
                            video.description,
                            video.summary.clone().unwrap_or_default(),
                            video.subtitle_content.clone().unwrap_or_default()
                        )
                        .to_lowercase();
                        if haystack.contains(&query) {
                            hits.push(json!({
                                "kind": "youtube",
                                "id": video.id,
                                "title": video.title,
                                "snippet": text_snippet(
                                    &video.summary.clone().unwrap_or_else(|| video.description.clone()),
                                    220
                                ),
                                "videoUrl": video.video_url,
                            }));
                        }
                    }
                    Ok(json!({
                        "success": true,
                        "results": hits.into_iter().take(limit).collect::<Vec<_>>()
                    }))
                })
            }),
            _ => Err(format!("unsupported knowledge action: {action}")),
        }
    }

    pub(super) fn handle_capture(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("capture")));
        };
        match action {
            "collect" | "create" | "submit" => self.handle_capture_collect(payload),
            "status" | "get" | "list" => self.handle_capture_status(payload),
            other => Err(format!("unsupported capture action: {other}")),
        }
    }

    fn handle_capture_collect(&self, payload: &Value) -> Result<Value, String> {
        let raw_url = capture_payload_string(payload, &["url", "sourceUrl", "sourceLink"])
            .ok_or_else(|| "capture.collect requires url".to_string())?;
        let parsed_url = parse_capture_url(&raw_url)?;
        let platform = infer_capture_platform(payload, &parsed_url)?;
        let target = infer_capture_target(payload, &platform, &parsed_url)?;
        let kind = capture_kind_for(&platform, &target)?;
        let canonical_url = if kind == "youtube-video" {
            let video_id = capture_payload_string(payload, &["externalId", "videoId"])
                .or_else(|| infer_capture_external_id(kind, &parsed_url))
                .ok_or_else(|| "capture.collect could not resolve YouTube video id".to_string())?;
            format!("https://www.youtube.com/watch?v={video_id}")
        } else {
            parsed_url.to_string()
        };
        let external_id = capture_payload_string(payload, &["externalId", "external_id", "id"])
            .or_else(|| infer_capture_external_id(kind, &parsed_url));

        if kind == "youtube-video" {
            return self.handle_capture_youtube(payload, &canonical_url, external_id);
        }

        let include_comments = target == "comments"
            || capture_payload_bool(payload, &["includeComments", "comments"]).unwrap_or(false);
        let download_media = capture_payload_bool(payload, &["downloadMedia"]).unwrap_or(true);
        let ingest_to_knowledge =
            capture_payload_bool(payload, &["ingestToKnowledge", "ingest"]).unwrap_or(true);
        let wait_for_completion =
            capture_payload_bool(payload, &["waitForCompletion", "wait"]).unwrap_or(true);
        let limit = capture_payload_i64(payload, &["limit"]).map(|value| value.clamp(1, 100));
        let source = capture_payload_string(payload, &["source"])
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| matches!(value.as_str(), "manual" | "clipboard"))
            .unwrap_or_else(|| "manual".to_string());
        let client_request_key = external_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(canonical_url.as_str());

        let request = json!({
            "source": source,
            "kind": kind,
            "platform": platform,
            "target": target,
            "url": parsed_url.to_string(),
            "canonicalUrl": canonical_url,
            "externalId": external_id,
            "includeComments": include_comments,
            "clientRequestId": format!("{kind}:{client_request_key}"),
            "options": {
                "downloadMedia": download_media,
                "includeComments": include_comments,
                "limit": limit,
                "target": target,
            },
        });

        let created = self.call_channel("capture:create-server-job", request)?;
        if value_success_is_false(&created) {
            return Ok(json!({
                "success": false,
                "status": "create_failed",
                "platform": platform,
                "target": target,
                "kind": kind,
                "response": created,
            }));
        }
        let job_id = value_string_alias(&created, &["jobId"])
            .or_else(|| {
                created
                    .get("job")
                    .and_then(|job| value_string_alias(job, &["id", "jobId"]))
            })
            .ok_or_else(|| format!("capture server response missing job id: {created}"))?;

        if !wait_for_completion {
            return Ok(json!({
                "success": true,
                "status": "submitted",
                "platform": platform,
                "target": target,
                "kind": kind,
                "jobId": job_id,
                "job": created.get("job").cloned().unwrap_or(Value::Null),
                "response": created,
            }));
        }

        let job = self.poll_capture_job(payload, &job_id)?;
        let job_status =
            value_string_alias(&job, &["status"]).unwrap_or_else(|| "unknown".to_string());
        if job_status == "failed" {
            return Ok(json!({
                "success": false,
                "status": "failed",
                "platform": platform,
                "target": target,
                "kind": kind,
                "jobId": job_id,
                "job": job,
            }));
        }
        if job_status != "completed" {
            return Ok(json!({
                "success": false,
                "status": job_status,
                "platform": platform,
                "target": target,
                "kind": kind,
                "jobId": job_id,
                "job": job,
                "message": "capture job did not complete before maxWaitMs",
            }));
        }

        let ingest = if ingest_to_knowledge {
            self.ingest_capture_job_entries(&job)?
        } else {
            json!({ "success": true, "skipped": true, "count": 0 })
        };
        Ok(json!({
            "success": true,
            "status": "completed",
            "platform": platform,
            "target": target,
            "kind": kind,
            "jobId": job_id,
            "job": job,
            "ingest": ingest,
        }))
    }

    fn handle_capture_youtube(
        &self,
        payload: &Value,
        canonical_url: &str,
        external_id: Option<String>,
    ) -> Result<Value, String> {
        let video_id = external_id
            .ok_or_else(|| "capture.collect could not resolve YouTube video id".to_string())?;
        let title = capture_payload_string(payload, &["title"])
            .unwrap_or_else(|| format!("YouTube_{video_id}"));
        let description = capture_payload_string(payload, &["description"]).unwrap_or_default();
        let thumbnail_url = capture_payload_string(payload, &["thumbnailUrl", "thumbnail"]);
        let saved = self.call_channel(
            "youtube:save-note",
            json!({
                "videoId": video_id,
                "videoUrl": canonical_url,
                "title": title,
                "description": description,
                "thumbnailUrl": thumbnail_url.unwrap_or_default(),
            }),
        )?;
        Ok(json!({
            "success": saved.get("success").and_then(Value::as_bool).unwrap_or(true),
            "status": "completed",
            "platform": "youtube",
            "target": "content",
            "kind": "youtube-video",
            "jobId": Value::Null,
            "noteId": saved.get("noteId").cloned().unwrap_or(Value::Null),
            "ingest": saved,
        }))
    }

    fn handle_capture_status(&self, payload: &Value) -> Result<Value, String> {
        let job_id = capture_payload_string(payload, &["jobId", "id"]);
        if let Some(job_id) = job_id {
            return self.call_channel("capture:get-server-job", json!({ "jobId": job_id }));
        }
        let limit = capture_payload_i64(payload, &["limit"])
            .unwrap_or(20)
            .clamp(1, 50);
        self.call_channel("capture:list-server-jobs", json!({ "limit": limit }))
    }

    fn poll_capture_job(&self, payload: &Value, job_id: &str) -> Result<Value, String> {
        let max_wait_ms = capture_payload_i64(payload, &["maxWaitMs"])
            .unwrap_or(CAPTURE_DEFAULT_MAX_WAIT_MS as i64)
            .clamp(CAPTURE_MIN_WAIT_MS as i64, CAPTURE_MAX_WAIT_MS as i64)
            as u64;
        let poll_interval_ms = capture_payload_i64(payload, &["pollIntervalMs"])
            .unwrap_or(CAPTURE_DEFAULT_POLL_INTERVAL_MS as i64)
            .clamp(
                CAPTURE_MIN_POLL_INTERVAL_MS as i64,
                CAPTURE_MAX_POLL_INTERVAL_MS as i64,
            ) as u64;
        let started = std::time::Instant::now();
        let mut latest = Value::Null;
        while started.elapsed() <= Duration::from_millis(max_wait_ms) {
            let response =
                self.call_channel("capture:get-server-job", json!({ "jobId": job_id }))?;
            if value_success_is_false(&response) {
                return Err(format!("capture job status failed: {response}"));
            }
            let job = response
                .get("job")
                .cloned()
                .unwrap_or_else(|| response.clone());
            let status = value_string_alias(&job, &["status"]).unwrap_or_default();
            latest = job;
            if matches!(status.as_str(), "completed" | "failed") {
                return Ok(latest);
            }
            std::thread::sleep(Duration::from_millis(poll_interval_ms));
        }
        Ok(latest)
    }

    fn ingest_capture_job_entries(&self, job: &Value) -> Result<Value, String> {
        let entries = job
            .get("result")
            .and_then(|result| result.get("entries"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if entries.is_empty() {
            return Ok(json!({ "success": true, "count": 0 }));
        }
        self.call_channel(
            "knowledge:batch-ingest",
            json!({
                "entries": entries,
                "documentSources": [],
                "mediaAssets": [],
            }),
        )
    }

    pub(super) fn handle_work(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("work")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => {
                let result = self.call_channel("work:list", json!({}))?;
                let mut items = result.as_array().cloned().unwrap_or_default();
                let status = args
                    .string(&["status"])
                    .or_else(|| payload_string(payload, "status"));
                if let Some(status) = status.filter(|value| !value.trim().is_empty()) {
                    items.retain(|item| {
                        item.get("status")
                            .and_then(Value::as_str)
                            .map(|value| value == status)
                            .unwrap_or(false)
                    });
                }
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(20)
                    .clamp(1, 50) as usize;
                items.truncate(limit);
                Ok(json!({ "success": true, "workItems": items }))
            }
            "ready" => self.call_channel("work:ready", json!({})),
            "get" => self.call_channel(
                "work:get",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "work get requires --id".to_string())?
                }),
            ),
            "update" => self.call_channel("work:update", merge_payload(&args.options, payload)),
            _ => Err(format!("unsupported work action: {action}")),
        }
    }

    pub(super) fn handle_memory(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("memory")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        let (channel, request_payload) = memory_action_request(action, &args, payload)?;
        self.call_channel(channel, request_payload)
    }

    pub(super) fn handle_web(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let action = tokens.first().map(String::as_str).unwrap_or("fetch");
        match action {
            "fetch" | "get" | "read" => crate::tools::web_access::fetch(payload),
            "search" => crate::tools::web_search::search(self.state, payload, self.model_config),
            other => Err(format!("unsupported web action: {other}")),
        }
    }

    pub(super) fn handle_redclaw(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("redclaw")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list-projects" | "projects" => {
                Ok(json!({ "success": true, "projects": [], "deprecated": true }))
            }
            "runner-status" => self.call_channel("redclaw:runner-status", json!({})),
            "runner-run-now" => self.call_channel("redclaw:runner-run-now", json!({})),
            "runner-start" => self.call_channel(
                "redclaw:runner-start",
                merge_payload(&args.options, payload),
            ),
            "runner-stop" => self.call_channel("redclaw:runner-stop", json!({})),
            "runner-set-config" => self.call_channel(
                "redclaw:runner-set-config",
                merge_payload(&args.options, payload),
            ),
            "task-preview" => self.call_channel(
                "redclaw:task-preview",
                if payload.is_object() {
                    payload.clone()
                } else {
                    merge_payload(&args.options, payload)
                },
            ),
            "task-create" => self.call_channel(
                "redclaw:task-create",
                if payload.is_object() {
                    payload.clone()
                } else {
                    merge_payload(&args.options, payload)
                },
            ),
            "task-confirm" => self.call_channel(
                "redclaw:task-confirm",
                json!({
                    "draftId": args
                        .string(&["draft-id", "draftId"])
                        .or_else(|| payload_string(payload, "draftId"))
                        .ok_or_else(|| "redclaw task-confirm requires --draft-id".to_string())?,
                    "confirm": args
                        .string(&["confirm"])
                        .and_then(|value| value.parse::<bool>().ok())
                        .or_else(|| payload_field(payload, "confirm").and_then(Value::as_bool))
                        .unwrap_or(true),
                }),
            ),
            "task-update" => self.call_channel(
                "redclaw:task-update",
                json!({
                    "jobDefinitionId": args
                        .string(&["job-definition-id", "jobDefinitionId"])
                        .or_else(|| payload_string(payload, "jobDefinitionId"))
                        .ok_or_else(|| "redclaw task-update requires --job-definition-id".to_string())?,
                    "reason": args
                        .string(&["reason"])
                        .or_else(|| payload_string(payload, "reason"))
                        .ok_or_else(|| "redclaw task-update requires --reason".to_string())?,
                    "patch": payload_field(payload, "patch").cloned().unwrap_or_else(|| json!({})),
                }),
            ),
            "task-cancel" => self.call_channel(
                "redclaw:task-cancel",
                json!({
                    "jobDefinitionId": args
                        .string(&["job-definition-id", "jobDefinitionId"])
                        .or_else(|| args.string(&["draft-id", "draftId"]))
                        .or_else(|| payload_string(payload, "jobDefinitionId"))
                        .or_else(|| payload_string(payload, "draftId"))
                        .ok_or_else(|| "redclaw task-cancel requires --job-definition-id".to_string())?,
                    "reason": args
                        .string(&["reason"])
                        .or_else(|| payload_string(payload, "reason")),
                }),
            ),
            "task-list" => self.call_channel(
                "redclaw:task-list",
                json!({
                    "ownerScope": args
                        .string(&["owner-scope", "ownerScope"])
                        .or_else(|| payload_string(payload, "ownerScope")),
                    "includeDrafts": args
                        .string(&["include-drafts", "includeDrafts"])
                        .and_then(|value| value.parse::<bool>().ok())
                        .or_else(|| payload_field(payload, "includeDrafts").and_then(Value::as_bool))
                        .unwrap_or(true),
                }),
            ),
            "task-stats" => self.call_channel("redclaw:task-stats", json!({})),
            "profile-bundle" => self.call_channel("redclaw:profile:get-bundle", json!({})),
            "profile-read" => {
                let doc_type =
                    redclaw_profile_doc_type(&args, payload, Some("user")).unwrap_or_else(|| {
                        "user".to_string()
                    });
                let bundle = self.call_channel("redclaw:profile:get-bundle", json!({}))?;
                let content = match doc_type.as_str() {
                    "agent" => bundle
                        .pointer("/files/agent")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "soul" => bundle
                        .pointer("/files/soul")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "identity" => bundle
                        .pointer("/files/identity")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "user" => bundle
                        .pointer("/files/user")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "creator_profile" | "creator-profile" => bundle
                        .pointer("/files/creatorProfile")
                        .cloned()
                        .unwrap_or(Value::Null),
                    _ => Value::Null,
                };
                Ok(json!({
                    "success": !content.is_null(),
                    "docType": doc_type,
                    "content": content
                }))
            }
            "profile-update" => self.call_channel(
                "redclaw:profile:update-doc",
                json!({
                    "docType": redclaw_profile_doc_type(&args, payload, None)
                        .ok_or_else(|| "redclaw profile-update requires --doc-type".to_string())?,
                    "markdown": payload_string(payload, "markdown")
                        .or_else(|| args.string(&["markdown"]))
                        .unwrap_or_default(),
                    "reason": args.string(&["reason"]).or_else(|| payload_string(payload, "reason"))
                }),
            ),
            "profile-complete-style-definition" => {
                self.call_channel("redclaw:profile:complete-style-definition", payload.clone())
            }
            "profile-onboarding" => {
                let bundle = self.call_channel("redclaw:profile:get-bundle", json!({}))?;
                let onboarding = bundle
                    .get("onboardingState")
                    .cloned()
                    .unwrap_or(Value::Null);
                Ok(json!({
                    "success": !onboarding.is_null(),
                    "completed": onboarding
                        .get("completedAt")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false),
                    "state": onboarding
                }))
            }
            _ => Err(format!("unsupported redclaw action: {action}")),
        }
    }

    pub(super) fn handle_approval_request(&self, payload: &Value) -> Result<Value, String> {
        let title = payload_string(payload, "title").unwrap_or_else(|| "需要人工审批".to_string());
        let summary = payload_string(payload, "summary")
            .or_else(|| payload_string(payload, "description"))
            .unwrap_or_else(|| title.clone());
        let body = payload_string(payload, "body")
            .or_else(|| payload_string(payload, "details"))
            .unwrap_or_else(|| summary.clone());
        let wait_for_decision = payload
            .get("waitForDecision")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let timeout_ms = payload
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(30 * 60 * 1000)
            .clamp(1_000, 6 * 60 * 60 * 1000);
        let call_id = self
            .tool_call_id
            .map(ToString::to_string)
            .unwrap_or_else(|| make_id("approval-call"));
        let mut docket_payload = payload.as_object().cloned().unwrap_or_default();
        docket_payload
            .entry("sourceKind".to_string())
            .or_insert_with(|| json!("agent_approval"));
        docket_payload
            .entry("sourceId".to_string())
            .or_insert_with(|| json!(call_id.clone()));
        docket_payload
            .entry("callId".to_string())
            .or_insert_with(|| json!(call_id.clone()));
        docket_payload
            .entry("sessionId".to_string())
            .or_insert_with(|| json!(self.session_id.unwrap_or_default()));
        docket_payload.insert("title".to_string(), json!(title));
        docket_payload.insert("summary".to_string(), json!(summary));
        docket_payload.insert("body".to_string(), json!(body));
        docket_payload
            .entry("decisionType".to_string())
            .or_insert_with(|| json!("approve_reject"));
        docket_payload
            .entry("priority".to_string())
            .or_insert_with(|| json!("normal"));
        docket_payload
            .entry("riskLevel".to_string())
            .or_insert_with(|| json!("medium"));
        docket_payload
            .entry("proposedAction".to_string())
            .or_insert_with(|| json!({ "kind": "agent_approval", "callId": call_id }));

        let docket = self.call_channel(
            "team-runtime:create-review-docket",
            Value::Object(docket_payload),
        )?;
        let docket_id = docket
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "approval.request did not receive a docket id".to_string())?
            .to_string();
        if !wait_for_decision {
            return Ok(json!({
                "success": true,
                "status": "pending",
                "approvalId": docket_id,
                "docket": docket,
            }));
        }
        let receiver = register_review_docket_waiter(self.state, &docket_id)?;
        match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(outcome) => Ok(json!({
                "success": true,
                "status": "resolved",
                "approvalId": docket_id,
                "docket": docket,
                "outcome": outcome,
            })),
            Err(RecvTimeoutError::Timeout) => {
                clear_review_docket_waiters(self.state, &docket_id)?;
                Ok(json!({
                    "success": false,
                    "status": "timeout",
                    "approvalId": docket_id,
                    "docket": docket,
                    "message": "approval.request timed out before the user made a decision",
                }))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err("approval.request waiter disconnected".to_string())
            }
        }
    }

    pub(super) fn handle_settings(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("settings")));
        };
        match action {
            "summary" => self.call_channel("db:get-settings", json!({})).map(|value| {
                json!({
                    "defaultAiSourceId": value.get("default_ai_source_id").cloned().unwrap_or(Value::Null),
                    "modelName": value.get("model_name").cloned().unwrap_or(Value::Null),
                    "apiEndpoint": value.get("api_endpoint").cloned().unwrap_or(Value::Null),
                    "hasApiKey": value
                        .get("api_key")
                        .and_then(Value::as_str)
                        .map(|item| !item.trim().is_empty())
                        .unwrap_or(false),
                    "hasEmbeddingKey": value
                        .get("embedding_key")
                        .and_then(Value::as_str)
                        .map(|item| !item.trim().is_empty())
                        .unwrap_or(false),
                    "hasMcpConfig": value
                        .get("mcp_servers_json")
                        .and_then(Value::as_str)
                        .map(|item| item != "[]" && !item.trim().is_empty())
                        .unwrap_or(false)
                })
            }),
            "get" => self.call_channel("db:get-settings", json!({})),
            "set" => self.call_channel("db:save-settings", payload.clone()),
            _ => Err(format!("unsupported settings action: {action}")),
        }
    }

    pub(super) fn handle_skills(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("skills")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("skills:list", json!({ "includeBody": false })),
            "audit" => self.call_channel("skills:audit", payload.clone()),
            "read" | "get" => self.call_channel(
                "skills:read",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills read requires --name".to_string())?
                }),
            ),
            "list-resources" | "resources" => self.call_channel(
                "skills:list-resources",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload),
                    "uri": args
                        .string(&["uri", "path"])
                        .or_else(|| payload_string_alias(payload, &["uri", "path"])),
                }),
            ),
            "read-resource" | "resource-read" | "get-resource" => {
                let resource_path = args
                    .string(&["path", "uri"])
                    .or_else(|| payload_string_alias(payload, &["path", "uri"]))
                    .or_else(|| args.positionals.get(1).cloned())
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "skills read-resource requires --path".to_string())?;
                self.call_channel(
                    "skills:read-resource",
                    json!({
                        "name": skill_name_from_args_or_payload(&args, payload),
                        "path": resource_path,
                        "maxChars": args
                            .i64(&["max-chars", "maxChars", "limit"])
                            .or_else(|| payload_field(payload, "maxChars").and_then(Value::as_i64))
                            .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64)),
                    }),
                )
            }
            "invoke" => self.call_channel(
                "skills:invoke",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills invoke requires --name".to_string())?,
                    "sessionId": self.session_id,
                    "runtimeMode": self.runtime_mode,
                }),
            ),
            "enable" => self.call_channel(
                "skills:enable",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills enable requires --name".to_string())?
                }),
            ),
            "create" => self.call_channel(
                "skills:create",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills create requires --name".to_string())?
                }),
            ),
            "save" => self.call_channel(
                "skills:save",
                json!({
                    "location": args
                        .string(&["location"])
                        .or_else(|| payload_string_alias(payload, &["location"]))
                        .ok_or_else(|| "skills save requires --location".to_string())?,
                    "content": args
                        .string(&["content"])
                        .or_else(|| payload_string_alias(payload, &["content"]))
                        .unwrap_or_default(),
                }),
            ),
            "disable" => self.call_channel(
                "skills:disable",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills disable requires --name".to_string())?
                }),
            ),
            "uninstall" | "delete" => self.call_channel(
                "skills:uninstall",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills uninstall requires --name".to_string())?,
                    "scope": args
                        .string(&["scope"])
                        .or_else(|| payload_string_alias(payload, &["scope"])),
                }),
            ),
            "marketplace" | "market-list" => self.call_channel(
                "skills:marketplace:list",
                json!({
                    "marketId": args
                        .string(&["market-id", "marketId"])
                        .or_else(|| payload_string_alias(payload, &["marketId", "market-id"])),
                    "query": args
                        .string(&["query", "q"])
                        .or_else(|| payload_string_alias(payload, &["query", "q"])),
                }),
            ),
            "market-package-read" | "market-read" => self.call_channel(
                "skills:marketplace:read-package",
                json!({
                    "marketId": args
                        .string(&["market-id", "marketId"])
                        .or_else(|| payload_string_alias(payload, &["marketId", "market-id"])),
                    "packageId": args
                        .string(&["package-id", "packageId", "id", "slug"])
                        .or_else(|| args.positionals.first().cloned())
                        .or_else(|| payload_string_alias(payload, &["packageId", "package-id", "id", "slug"]))
                        .ok_or_else(|| "skills market-package-read requires --package-id".to_string())?,
                }),
            ),
            "market-install" => self.call_channel(
                "skills:marketplace:install",
                json!({
                    "marketId": args
                        .string(&["market-id", "marketId"])
                        .or_else(|| payload_string_alias(payload, &["marketId", "market-id"])),
                    "packageId": args
                        .string(&["package-id", "packageId", "id", "slug"])
                        .or_else(|| args.positionals.first().cloned())
                        .or_else(|| payload_string_alias(payload, &["packageId", "package-id", "id", "slug"])),
                    "repo": args
                        .string(&["repo", "source", "url"])
                        .or_else(|| payload_string_alias(payload, &["repo", "source", "url"])),
                    "ref": args
                        .string(&["ref"])
                        .or_else(|| payload_string_alias(payload, &["ref", "refName"])),
                    "paths": payload_field(payload, "paths").cloned().unwrap_or(Value::Null),
                    "scope": args
                        .string(&["scope"])
                        .or_else(|| payload_string_alias(payload, &["scope"])),
                }),
            ),
            "market-update" => self.call_channel(
                "skills:marketplace:update-installed",
                json!({
                    "marketId": args
                        .string(&["market-id", "marketId"])
                        .or_else(|| payload_string_alias(payload, &["marketId", "market-id"])),
                    "packageId": args
                        .string(&["package-id", "packageId", "id", "slug"])
                        .or_else(|| args.positionals.first().cloned())
                        .or_else(|| payload_string_alias(payload, &["packageId", "package-id", "id", "slug"]))
                        .ok_or_else(|| "skills market-update requires --package-id".to_string())?,
                    "scope": args
                        .string(&["scope"])
                        .or_else(|| payload_string_alias(payload, &["scope"])),
                }),
            ),
            "market-sources-list" => self.call_channel("skills:market-sources:list", json!({})),
            "market-source-add" => self.call_channel(
                "skills:market-sources:add",
                json!({
                    "name": args
                        .string(&["name"])
                        .or_else(|| payload_string_alias(payload, &["name"]))
                        .ok_or_else(|| "skills market-source-add requires --name".to_string())?,
                    "kind": args
                        .string(&["kind", "type"])
                        .or_else(|| payload_string_alias(payload, &["kind", "type"]))
                        .unwrap_or_else(|| "github".to_string()),
                    "source": args
                        .string(&["source", "path", "url"])
                        .or_else(|| payload_string_alias(payload, &["source", "path", "url"])),
                    "repo": args
                        .string(&["repo"])
                        .or_else(|| payload_string_alias(payload, &["repo"])),
                    "registryUrl": args
                        .string(&["registry-url", "registryUrl"])
                        .or_else(|| payload_string_alias(payload, &["registryUrl", "registry-url"])),
                    "ref": args
                        .string(&["ref"])
                        .or_else(|| payload_string_alias(payload, &["ref", "refName"])),
                }),
            ),
            "market-source-remove" => self.call_channel(
                "skills:market-sources:remove",
                json!({
                    "id": args
                        .string(&["id", "market-id", "marketId"])
                        .or_else(|| args.positionals.first().cloned())
                        .or_else(|| payload_string_alias(payload, &["id", "marketId", "market-id"]))
                        .ok_or_else(|| "skills market-source-remove requires --id".to_string())?,
                }),
            ),
            "install-from-repo" | "install-from-github" => self.call_channel(
                "skills:install-from-repo",
                {
                    let explicit_source = args
                        .string(&["source", "url", "repo"])
                        .or_else(|| args.positionals.first().cloned())
                        .or_else(|| payload_string_alias(payload, &["source", "url", "repo"]));
                    let path = args
                        .string(&["path"])
                        .or_else(|| payload_string_alias(payload, &["path"]));
                    let path_as_source = explicit_source.is_none()
                        && path
                            .as_deref()
                            .is_some_and(is_local_install_source_path);
                    let source = explicit_source
                        .or_else(|| path_as_source.then(|| path.clone()).flatten())
                        .ok_or_else(|| "skills install-from-repo requires --source".to_string())?;
                    json!({
                        "source": source,
                        "ref": args
                            .string(&["ref"])
                            .or_else(|| payload_string_alias(payload, &["ref", "refName"])),
                        "path": if path_as_source { None } else { path },
                        "paths": payload_field(payload, "paths").cloned().unwrap_or(Value::Null),
                        "scope": args
                            .string(&["scope"])
                            .or_else(|| payload_string_alias(payload, &["scope"])),
                    })
                },
            ),
            _ => Err(format!("unsupported skills action: {action}")),
        }
    }

    pub(super) fn handle_video_project_create(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        if !video_project_create_requested_explicitly(args, payload) {
            return Err(
                "video project-create requires explicit project workflow confirmation. \
For one-off generation, use `video generate` and keep the output in media/. \
Only create a video project folder when the user explicitly asks for a project/package/editor workflow. \
Pass `--explicit-project-workflow true` or `payload.explicitProjectWorkflow=true` after explicit confirmation."
                    .to_string(),
            );
        }
        let title = args
            .string(&["title"])
            .or_else(|| args.positionals.first().cloned())
            .unwrap_or_else(|| "Untitled Video".to_string());
        let relative = build_video_project_relative_path(args.string(&["path"]));
        let (parent_path, name) = split_parent_and_name(&relative);
        let script_content = payload_string(payload, "content")
            .or_else(|| payload_string(payload, "script"))
            .or_else(|| args.string(&["content", "script", "brief"]))
            .unwrap_or_default();
        self.call_channel(
            "manuscripts:create-file",
            json!({
                "parentPath": parent_path,
                "name": name,
                "title": title.clone(),
                "content": script_content.clone()
            }),
        )?;
        self.call_channel(
            "manuscripts:save",
            json!({
                "path": relative,
                "content": script_content,
                "metadata": {
                    "title": title,
                    "aspectRatio": args.string(&["aspect-ratio", "aspectRatio"]),
                    "duration": args.string(&["duration"]),
                    "mode": args.string(&["mode"]),
                    "draftType": "video",
                    "packageKind": "video"
                }
            }),
        )?;
        let state = self.call_channel(
            "manuscripts:get-video-project-state",
            json!({ "filePath": relative.clone() }),
        )?;
        Ok(json!({
            "success": true,
            "path": relative,
            "videoProjectId": video_project_stem_from_path(&relative),
            "project": state
        }))
    }

    pub(super) fn handle_video_project_list(&self) -> Result<Value, String> {
        let tree = self.call_channel("manuscripts:list", json!({}))?;
        let mut projects = Vec::<Value>::new();
        collect_video_projects(&tree, &mut projects);
        Ok(json!({ "success": true, "projects": projects }))
    }

    pub(super) fn handle_video_project_get(&self, args: &CliArgs) -> Result<Value, String> {
        let file_path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-get requires --path".to_string())?,
        )?;
        self.call_channel(
            "manuscripts:get-video-project-state",
            json!({
                "filePath": file_path
            }),
        )
    }

    pub(super) fn handle_video_project_brief(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| payload_string(payload, "path"))
                .or_else(|| payload_string(payload, "id"))
                .or_else(|| payload_string(payload, "videoProjectPath"))
                .or_else(|| payload_string(payload, "videoProjectId"))
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-brief requires --path".to_string())?,
        )?;
        if let Some(content) = payload_string(payload, "content")
            .or_else(|| payload_string(payload, "brief"))
            .or_else(|| args.string(&["content", "brief"]))
        {
            let video_project_id = video_project_stem_from_path(&path);
            let saved = self.call_channel(
                "manuscripts:save-video-project-brief",
                json!({
                    "filePath": path.clone(),
                    "content": content,
                    "source": "user"
                }),
            )?;
            return Ok(json!({
                "success": saved.get("success").and_then(Value::as_bool).unwrap_or(true),
                "path": path,
                "videoProjectId": video_project_id,
                "brief": saved.get("brief").cloned().unwrap_or(Value::Null),
                "project": saved.get("project").cloned().unwrap_or(Value::Null),
                "state": saved.get("state").cloned().unwrap_or(Value::Null)
            }));
        }
        let project = self.call_channel(
            "manuscripts:get-video-project-state",
            json!({ "filePath": path.clone() }),
        )?;
        let project_state = project.get("project").cloned().unwrap_or(Value::Null);
        let video_project_id = video_project_stem_from_path(&path);
        Ok(json!({
            "success": project.get("success").and_then(Value::as_bool).unwrap_or(true),
            "path": path,
            "videoProjectId": video_project_id,
            "brief": project_state.get("brief").cloned().unwrap_or(Value::Null),
            "project": project_state.clone(),
            "videoProject": project_state.clone(),
            "script": project_state.get("scriptBody").cloned().unwrap_or(Value::Null),
            "scriptApproval": project_state.get("scriptApproval").cloned().unwrap_or(Value::Null),
            "assets": project_state.get("assets").cloned().unwrap_or_else(|| json!([])),
            "renderOutput": project_state.get("renderOutput").cloned().unwrap_or(Value::Null)
        }))
    }

    pub(super) fn handle_video_project_script(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| payload_string(payload, "path"))
                .or_else(|| payload_string(payload, "id"))
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-script requires --path".to_string())?,
        )?;
        if let Some(content) =
            payload_string(payload, "content").or_else(|| args.string(&["content"]))
        {
            return self.call_channel(
                "manuscripts:save",
                json!({
                    "path": path,
                    "content": content,
                    "metadata": payload_field(payload, "metadata").cloned().unwrap_or_else(|| json!({}))
                }),
            );
        }
        self.call_channel("manuscripts:read", json!(path))
    }

    pub(super) fn handle_video_project_asset_add(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let asset_id = args
            .string(&["asset-id", "assetId"])
            .or_else(|| payload_string(payload, "assetId"))
            .or_else(|| args.positionals.get(1).cloned());
        if let Some(asset_id) = asset_id.filter(|value| !value.trim().is_empty()) {
            let file_path = self.resolve_video_project_path(
                args.string(&["path", "id", "video-project-id", "videoProjectId"])
                    .or_else(|| payload_string(payload, "path"))
                    .or_else(|| payload_string(payload, "id"))
                    .or_else(|| payload_string(payload, "videoProjectPath"))
                    .or_else(|| payload_string(payload, "videoProjectId"))
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "video project-asset-add requires --path".to_string())?,
            )?;
            return self.call_channel(
                "manuscripts:add-package-clip",
                json!({
                    "filePath": file_path,
                    "assetId": asset_id,
                    "track": args.string(&["track"]),
                    "order": args.i64(&["order"]),
                    "durationMs": args.i64(&["duration-ms", "durationMs"])
                }),
            );
        }

        let project_locator = args
            .string(&["id", "video-project-id", "videoProjectId"])
            .or_else(|| payload_string(payload, "id"))
            .or_else(|| payload_string(payload, "videoProjectId"))
            .or_else(|| payload_string(payload, "projectId"))
            .or_else(|| payload_string(payload, "videoProjectPath"))
            .or_else(|| {
                args.string(&["path"]).and_then(|value| {
                    if !std::path::Path::new(&value).is_absolute() && value.contains('/') {
                        Some(value)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| args.positionals.first().cloned())
            .ok_or_else(|| {
                "video project-asset-add requires a project locator (--id or --path)".to_string()
            })?;
        let file_path = self.resolve_video_project_path(project_locator)?;
        let source_path = args
            .string(&["source", "source-path", "sourcePath"])
            .or_else(|| payload_string(payload, "sourcePath"))
            .or_else(|| {
                args.string(&["path"]).and_then(|value| {
                    if std::path::Path::new(&value).is_absolute() {
                        Some(value)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| args.positionals.get(1).cloned())
            .ok_or_else(|| {
                "video project-asset-add requires --source-path when --asset-id is absent"
                    .to_string()
            })?;
        self.call_channel(
            "manuscripts:attach-package-file",
            json!({
                "filePath": file_path,
                "sourcePath": source_path,
                "kind": args.string(&["kind"]).or_else(|| payload_string(payload, "kind")),
                "label": args.string(&["label"]).or_else(|| payload_string(payload, "label")),
                "role": args.string(&["role"]).or_else(|| payload_string(payload, "role"))
            }),
        )
    }

    pub(super) fn handle_image_generate(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let mut merged = build_generation_payload(args, payload);
        if self.session_id.is_some() {
            apply_agent_image_generation_defaults(&mut merged);
        }
        let subject_matches = self.collect_subject_matches(args, payload, 4)?;
        let subject_reference_images = subject_matches
            .iter()
            .flat_map(|subject| value_string_list(subject.get("absoluteImagePaths"), 4))
            .take(4)
            .collect::<Vec<_>>();
        let mut reference_images = value_string_list(merged.get("referenceImages"), 4);
        if reference_images.is_empty() {
            reference_images = value_string_list(merged.get("images"), 4);
        }
        reference_images.extend(subject_reference_images);
        reference_images = self.resolve_reference_image_inputs(reference_images);
        dedupe_string_list(&mut reference_images, 4);
        let image_plan_items = extract_image_plan_items(merged.get("imagePlanItems"));
        let requested_count = requested_image_generation_count(&merged, image_plan_items.len());
        let multi_image_agent_turn = requested_count > 1 && self.session_id.is_some();
        let plan_confirmed = payload_bool(&merged, &["planConfirmed"]).unwrap_or(false);
        let auto_execution_agent = self.session_generation_agent_auto_execution_enabled();
        let shared_style_guide =
            payload_string(&merged, "sharedStyleGuide").filter(|item| !item.trim().is_empty());
        let base_prompt = payload_string(&merged, "prompt").unwrap_or_default();

        if multi_image_agent_turn {
            self.run_preflight_multi_image_skill_activation();
            if image_plan_items.is_empty() {
                let required = if auto_execution_agent {
                    vec!["sharedStyleGuide", "imagePlanItems"]
                } else {
                    vec!["planConfirmed", "sharedStyleGuide", "imagePlanItems"]
                };
                let hint = if auto_execution_agent {
                    "Agent 模式可自动执行；请先补齐多图顺序表、统一风格锚点和 imagePlanItems，然后直接再次调用 image.generate。"
                } else {
                    "先输出多图顺序表、统一风格锚点，并等待用户确认；确认后再调用 image.generate。"
                };
                return Err(app_cli_error_json(
                    Some("image.generate"),
                    "IMAGE_PLAN_REQUIRED",
                    "multi-image generation requires an approved image plan before execution",
                    false,
                    Some(json!({
                        "required": required,
                        "count": requested_count,
                        "hint": hint
                    })),
                ));
            }
            if shared_style_guide.is_none() {
                let hint = if auto_execution_agent {
                    "Agent 模式可自动执行；为整组图片补一份统一风格锚点，再直接继续生成。"
                } else {
                    "为整组图片补一份统一风格锚点，再继续生成。"
                };
                return Err(app_cli_error_json(
                    Some("image.generate"),
                    "IMAGE_STYLE_GUIDE_REQUIRED",
                    "multi-image generation requires a sharedStyleGuide",
                    false,
                    Some(json!({
                        "count": image_plan_items.len(),
                        "hint": hint
                    })),
                ));
            }
            if !plan_confirmed && !auto_execution_agent {
                return Err(app_cli_error_json(
                    Some("image.generate"),
                    "IMAGE_PLAN_CONFIRMATION_REQUIRED",
                    "multi-image generation requires explicit user confirmation",
                    false,
                    Some(json!({
                        "count": image_plan_items.len(),
                        "hint": "先向用户展示多图方案并等待确认；确认后传入 planConfirmed=true。"
                    })),
                ));
            }
        }

        if let Some(object) = merged.as_object_mut() {
            object.remove("model");
            if !reference_images.is_empty() {
                object.insert("referenceImages".to_string(), json!(reference_images));
                let generation_mode = object
                    .get("generationMode")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if generation_mode.is_empty() {
                    object.insert("generationMode".to_string(), json!("reference-guided"));
                }
            }
            if requested_count > 1 {
                object.insert("count".to_string(), json!(requested_count));
            }
            if !image_plan_items.is_empty() {
                let compiled_items = image_plan_items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        if item.prompt.trim().is_empty() {
                            return Err(app_cli_error_json(
                                Some("image.generate"),
                                "IMAGE_PLAN_ITEM_PROMPT_REQUIRED",
                                "each imagePlanItems entry must include a prompt",
                                false,
                                Some(json!({
                                    "index": index,
                                    "title": item.title,
                                })),
                            ));
                        }
                        Ok(json!({
                            "title": item.title,
                            "prompt": item.prompt,
                            "copy": item.copy,
                            "compiledPrompt": compile_image_batch_prompt(
                                &base_prompt,
                                shared_style_guide.as_deref(),
                                item,
                                index,
                                image_plan_items.len(),
                            ),
                        }))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                object.insert("count".to_string(), json!(compiled_items.len()));
                object.insert("imagePlanItems".to_string(), json!(compiled_items));
            }
            object
                .entry("source".to_string())
                .or_insert_with(|| json!("tool"));
            if let Some(session_id) = self.session_id {
                object.insert("sessionId".to_string(), json!(session_id));
            }
            if let Some(tool_call_id) = self.tool_call_id {
                object.insert("toolCallId".to_string(), json!(tool_call_id));
                object.insert("toolName".to_string(), json!("workflow"));
            }
        }
        match image_generation_delivery_mode(self.session_id, &merged, requested_count) {
            ImageGenerationDeliveryMode::InlineWait => {
                self.emit_tool_partial("图片生成任务已提交，正在等待生成完成。");
                return self.call_channel("image-gen:generate", merged);
            }
            ImageGenerationDeliveryMode::BackgroundFollowup => {
                self.emit_tool_partial(
                    "多图生成任务已提交到媒体 runtime，后台任务将持续跟进结果。",
                );
                let submitted = self.call_channel("generation:submit-image", merged)?;
                let Some(job_id) = submitted.get("jobId").and_then(Value::as_str) else {
                    return Ok(submitted);
                };
                let follow_up = self
                    .session_id
                    .map(|session_id| {
                        crate::media_runtime::spawn_media_job_followup(
                            self.app,
                            self.runtime_mode,
                            session_id,
                            job_id,
                            requested_count,
                        )
                    })
                    .transpose();
                return Ok(match follow_up {
                    Ok(Some(follow_up)) => json!({
                        "success": true,
                        "submitted": submitted,
                        "followUp": follow_up,
                    }),
                    Ok(None) => submitted,
                    Err(error) => json!({
                        "success": true,
                        "submitted": submitted,
                        "followUp": {
                            "success": false,
                            "error": error,
                        },
                    }),
                });
            }
            ImageGenerationDeliveryMode::AsyncSubmit => {}
        }
        self.emit_tool_partial("图片生成任务已提交到媒体 runtime，正在排队执行。");
        self.call_channel("generation:submit-image", merged)
    }

    fn run_preflight_multi_image_skill_activation(&self) {
        let Some(session_id) = self.session_id else {
            return;
        };
        let item = with_store(self.state, |store| {
            Ok(preflight_skill_activation_item(
                &store.skills,
                self.runtime_mode,
                IMAGE_DIRECTOR_SKILL_NAME,
            ))
        })
        .ok()
        .flatten();
        let Some((name, description)) = item else {
            return;
        };
        let call_id = make_id("tool-call");
        emit_runtime_tool_request(
            self.app,
            Some(session_id),
            &call_id,
            "workflow",
            json!({
                "action": "skills.invoke",
                "payload": { "name": name },
            }),
            Some("Preflight skill activation before multi-image generation"),
        );
        let invoke_result = self.call_channel(
            "skills:invoke",
            json!({
                "name": name,
                "sessionId": session_id,
                "runtimeMode": self.runtime_mode,
            }),
        );
        match invoke_result {
            Ok(result) => {
                let envelope = json!({
                    "ok": true,
                    "action": "skills.invoke",
                    "data": result,
                });
                let output = serde_json::to_string_pretty(&envelope)
                    .unwrap_or_else(|_| envelope.to_string());
                emit_runtime_tool_result(
                    self.app,
                    Some(session_id),
                    &call_id,
                    "workflow",
                    true,
                    &output,
                );
            }
            Err(error) => {
                let failure = app_cli_error_json(
                    Some("skills.invoke"),
                    "ACTION_FAILED",
                    &error,
                    false,
                    Some(json!({ "activationSource": "host.multi-image-preflight" })),
                );
                emit_runtime_tool_result(
                    self.app,
                    Some(session_id),
                    &call_id,
                    "workflow",
                    false,
                    &failure,
                );
                return;
            }
        }
        emit_runtime_task_checkpoint_saved(
            self.app,
            None,
            Some(session_id),
            "chat.skill_activated",
            "skill activated",
            Some(json!({
                "name": name,
                "description": description,
                "runtimeMode": self.runtime_mode,
                "activationSource": "host.multi-image-preflight",
            })),
        );
    }

    fn emit_tool_partial(&self, content: &str) {
        let Some(tool_call_id) = self.tool_call_id else {
            return;
        };
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return;
        }
        emit_runtime_tool_partial(self.app, self.session_id, tool_call_id, "workflow", trimmed);
    }

    fn resolve_reference_image_inputs(&self, inputs: Vec<String>) -> Vec<String> {
        let Some(session_id) = self.session_id else {
            return inputs;
        };
        resolve_session_file_reference_inputs(self.state, session_id, inputs)
    }

    pub(super) fn handle_video_generate(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let mut merged = build_generation_payload(args, payload);
        let wait_for_completion = video_generation_should_wait(self.session_id, &merged);
        let video_project_path = self
            .video_project_locator_from_generate(args, payload)
            .map(|locator| self.resolve_video_project_path(locator))
            .transpose()?;
        let video_project_state = video_project_path
            .as_ref()
            .map(|project_path| {
                self.call_channel(
                    "manuscripts:get-video-project-state",
                    json!({ "filePath": project_path }),
                )
            })
            .transpose()?;
        let subject_matches = self.collect_subject_matches(args, payload, 5)?;
        let subject_reference_images = subject_matches
            .iter()
            .flat_map(|subject| value_string_list(subject.get("absoluteImagePaths"), 1))
            .take(5)
            .collect::<Vec<_>>();
        let mut reference_images = value_string_list(merged.get("referenceImages"), 5);
        let project_reference_images = video_project_state
            .as_ref()
            .map(|state| extract_video_project_reference_images(state, 5))
            .unwrap_or_default();
        if reference_images.is_empty() && !project_reference_images.is_empty() {
            reference_images.extend(project_reference_images);
        }
        reference_images.extend(subject_reference_images);
        reference_images = self.resolve_reference_image_inputs(reference_images);
        dedupe_string_list(&mut reference_images, 5);
        let explicit_driving_audio = args
            .string(&["driving-audio", "audio-url"])
            .or_else(|| payload_string(payload, "drivingAudio"))
            .filter(|item| !item.trim().is_empty());
        let mut inferred_driving_audio = explicit_driving_audio.clone().or_else(|| {
            subject_matches.iter().find_map(|subject| {
                subject
                    .get("absoluteVoicePath")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(ToString::to_string)
            })
        });
        if let Some(driving_audio) = inferred_driving_audio.take() {
            inferred_driving_audio = self
                .resolve_reference_image_inputs(vec![driving_audio])
                .into_iter()
                .next();
        }
        let resolved_first_clip = payload_string(&merged, "firstClip")
            .map(|first_clip| self.resolve_reference_image_inputs(vec![first_clip]))
            .and_then(|items| items.into_iter().next());
        if let Some(object) = merged.as_object_mut() {
            if !reference_images.is_empty() {
                object.insert("referenceImages".to_string(), json!(reference_images));
                if object
                    .get("generationMode")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    object.insert("generationMode".to_string(), json!("reference-guided"));
                }
            }
            if let Some(driving_audio) = inferred_driving_audio {
                object.insert("drivingAudio".to_string(), json!(driving_audio));
            }
            if let Some(first_clip) = resolved_first_clip {
                object.insert("firstClip".to_string(), json!(first_clip));
            }
            if let Some(project_path) = video_project_path.clone() {
                object.insert("videoProjectPath".to_string(), json!(project_path));
            }
            if let Some(session_id) = self.session_id {
                object.insert("sessionId".to_string(), json!(session_id));
            }
            if let Some(tool_call_id) = self.tool_call_id {
                object.insert("toolCallId".to_string(), json!(tool_call_id));
                object.insert("toolName".to_string(), json!("workflow"));
            }
        }
        apply_video_storyboard_payload_defaults(&mut merged, video_project_state.as_ref());
        if let Some(compiled_prompt) =
            compile_video_generation_prompt(&merged, video_project_state.as_ref())
        {
            if let Some(object) = merged.as_object_mut() {
                object.insert("prompt".to_string(), json!(compiled_prompt));
            }
        }
        if !wait_for_completion {
            self.emit_tool_partial("视频生成任务已提交，后台会持续等待结果。");
            let submitted = self.call_channel("generation:submit-video", merged)?;
            let follow_up = submitted
                .get("jobId")
                .and_then(Value::as_str)
                .and_then(|job_id| {
                    self.session_id.map(|session_id| {
                        crate::media_runtime::spawn_media_job_followup_for_kind(
                            self.app,
                            self.runtime_mode,
                            session_id,
                            job_id,
                            "video",
                            1,
                        )
                    })
                })
                .transpose();
            let mut result =
                merge_video_generation_result(submitted, video_project_path, video_project_state);
            if let Some(object) = result.as_object_mut() {
                match follow_up {
                    Ok(Some(follow_up)) => {
                        object.insert("followUp".to_string(), follow_up);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        object.insert(
                            "followUp".to_string(),
                            json!({
                                "success": false,
                                "error": error,
                            }),
                        );
                    }
                }
            }
            return Ok(result);
        }
        self.emit_tool_partial("视频生成任务已提交，正在等待视频完成。");
        let result = self.call_channel("video-gen:generate", merged)?;
        if let Some(project_path) = video_project_path {
            if let Some(assets) = result.get("assets").and_then(Value::as_array) {
                for asset in assets {
                    let Some(asset_id) = asset.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    self.call_channel(
                        "manuscripts:add-package-clip",
                        json!({
                            "filePath": project_path,
                            "assetId": asset_id
                        }),
                    )?;
                }
            }
            let project_state = self.call_channel(
                "manuscripts:get-video-project-state",
                json!({ "filePath": project_path.clone() }),
            )?;
            return Ok(merge_video_generation_result(
                result,
                Some(project_path),
                Some(project_state),
            ));
        }
        Ok(merge_video_generation_result(result, None, None))
    }

    fn video_project_locator_from_generate(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Option<String> {
        args.string(&["path", "video-project-path", "videoProjectPath"])
            .or_else(|| payload_string(payload, "videoProjectPath"))
            .or_else(|| payload_string(payload, "path"))
            .or_else(|| {
                args.string(&[
                    "video-project-id",
                    "videoProjectId",
                    "project-id",
                    "projectId",
                ])
            })
            .or_else(|| payload_string(payload, "videoProjectId"))
            .or_else(|| payload_string(payload, "projectId"))
            .filter(|value| !value.trim().is_empty())
    }

    fn resolve_video_project_path(&self, locator: String) -> Result<String, String> {
        let trimmed = locator.trim();
        if trimmed.is_empty() {
            return Err("video project locator is empty".to_string());
        }
        let normalized = normalize_relative_path(trimmed);
        if normalized.contains('/') {
            return Ok(normalized.trim_end_matches(".md").to_string());
        }
        let default_path = normalize_relative_path(&format!("video/{normalized}"));
        let tree = self.call_channel("manuscripts:list", json!({}))?;
        let mut projects = Vec::<Value>::new();
        collect_video_projects(&tree, &mut projects);
        let target_file_name = normalized.clone();
        let matches = projects
            .iter()
            .filter_map(|item| item.get("path").and_then(Value::as_str))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .filter(|path| {
                *path == default_path
                    || *path == target_file_name
                    || path.ends_with(&format!("/{target_file_name}"))
            })
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            Ok(matches[0].clone())
        } else {
            Ok(default_path)
        }
    }

    fn collect_subject_matches(
        &self,
        args: &CliArgs,
        payload: &Value,
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        let subject_ids = comma_list_strings(
            args.value(&["subject-ids", "subjectIds"])
                .or_else(|| payload_field(payload, "subjectIds").cloned()),
        );
        if !subject_ids.is_empty() {
            let mut matches = Vec::<Value>::new();
            for id in subject_ids.into_iter().take(limit) {
                let result = self.call_channel("subjects:get", json!({ "id": id }))?;
                if let Some(subject) = result
                    .get("subject")
                    .cloned()
                    .filter(|item| !item.is_null())
                {
                    matches.push(subject);
                }
            }
            return Ok(matches);
        }
        let subject_query = args
            .string(&["subject-query", "query-subjects"])
            .or_else(|| payload_string(payload, "subjectQuery"));
        if let Some(subject_query) = subject_query.filter(|item| !item.trim().is_empty()) {
            let result = self.call_channel("subjects:search", json!({ "query": subject_query }))?;
            return Ok(result
                .get("subjects")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(limit)
                .collect());
        }
        Ok(Vec::new())
    }

    fn generated_media_history(&self, kind: &str) -> Result<Value, String> {
        let result = self.call_channel("media:list", json!({}))?;
        let assets = result
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| media_matches_kind(item, kind))
            .collect::<Vec<_>>();
        Ok(json!({ "success": true, "assets": assets }))
    }

    fn generated_media_history_get(&self, kind: &str, id: &str) -> Result<Value, String> {
        let result = self.generated_media_history(kind)?;
        let asset = result
            .get("assets")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("id")
                        .and_then(Value::as_str)
                        .map(|value| value == id)
                        .unwrap_or(false)
                })
            })
            .cloned();
        Ok(json!({ "success": asset.is_some(), "asset": asset }))
    }

    fn bound_writing_session_target(&self) -> Option<BoundWritingSessionTarget> {
        let session_id = self.session_id?;
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let file_path = payload_string(metadata, "associatedPackageFilePath")
                .or_else(|| payload_string(metadata, "associatedFilePath"))
                .unwrap_or_default();
            let draft_type = payload_string(metadata, "associatedPackageKind")
                .or_else(|| payload_string(metadata, "draftType"))
                .map(|value| {
                    if value == "article" {
                        "longform".to_string()
                    } else {
                        value
                    }
                })
                .unwrap_or_else(|| "unknown".to_string());
            if file_path.trim().is_empty() || !matches!(draft_type.as_str(), "longform") {
                return Ok(None);
            }
            Ok(Some(BoundWritingSessionTarget {
                file_path,
                draft_type,
                title: payload_string(metadata, "associatedPackageTitle"),
            }))
        })
        .ok()
        .flatten()
    }

    fn current_authoring_target_preference(&self) -> Option<AuthoringTargetPreference> {
        if let Some(target) = self.current_authoring_session_target() {
            return Some(AuthoringTargetPreference {
                preferred_kind: target.project_kind,
                preferred_subdir: Some(split_parent_and_name(&target.project_path).0),
            });
        }
        if let Some(target) = self.bound_writing_session_target() {
            let draft_type = target.draft_type.to_ascii_lowercase();
            let preferred_kind = match draft_type.as_str() {
                "longform" => AuthoringProjectKind::Redarticle,
                _ => return None,
            };
            return Some(AuthoringTargetPreference {
                preferred_kind,
                preferred_subdir: None,
            });
        }

        let session_id = self.session_id?;
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let intent = payload_string(metadata, "intent")
                .or_else(|| {
                    metadata
                        .get("taskHints")
                        .and_then(|value| payload_string(value, "intent"))
                })
                .unwrap_or_default();
            if intent != "manuscript_creation" {
                return Ok(None);
            }
            let platform = payload_string(metadata, "platform").or_else(|| {
                metadata
                    .get("taskHints")
                    .and_then(|value| payload_string(value, "platform"))
            });
            let preferred_subdir = payload_string(metadata, "saveSubdir")
                .or_else(|| {
                    metadata
                        .get("taskHints")
                        .and_then(|value| payload_string(value, "saveSubdir"))
                })
                .or_else(|| {
                    let context_type = payload_string(metadata, "contextType").unwrap_or_default();
                    if context_type == "wander" {
                        Some("wander".to_string())
                    } else {
                        None
                    }
                });
            let preference = match platform.as_deref() {
                Some("wechat_official_account") => AuthoringTargetPreference {
                    preferred_kind: AuthoringProjectKind::Redarticle,
                    preferred_subdir,
                },
                Some("xiaohongshu") => AuthoringTargetPreference {
                    preferred_kind: AuthoringProjectKind::Redpost,
                    preferred_subdir,
                },
                _ => AuthoringTargetPreference {
                    preferred_kind: AuthoringProjectKind::Redpost,
                    preferred_subdir,
                },
            };
            Ok(Some(preference))
        })
        .ok()
        .flatten()
    }

    pub(super) fn current_authoring_session_target(&self) -> Option<CurrentAuthoringSessionTarget> {
        let session_id = self.session_id?;
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let project_path =
                payload_string(metadata, "currentAuthoringProjectPath").unwrap_or_default();
            let content_path =
                payload_string(metadata, "currentAuthoringContentPath").unwrap_or_default();
            if project_path.trim().is_empty() || content_path.trim().is_empty() {
                return Ok(None);
            }
            let project_kind = authoring_project_kind_from_value(
                payload_string(metadata, "currentAuthoringProjectKind").as_deref(),
            )
            .unwrap_or(AuthoringProjectKind::Redpost);
            Ok(Some(CurrentAuthoringSessionTarget {
                project_path,
                project_kind,
            }))
        })
        .ok()
        .flatten()
    }

    fn active_session_skills(&self) -> Vec<LoadedSkillRecord> {
        let Some(session_id) = self.session_id else {
            return Vec::new();
        };
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(Vec::new());
            };
            Ok(
                resolve_skill_set(&store.skills, self.runtime_mode, Some(metadata), &[])
                    .active_skills,
            )
        })
        .unwrap_or_default()
    }

    fn load_skill_host_save_validators(
        &self,
        skill: &LoadedSkillRecord,
    ) -> Result<Option<SkillHostSaveValidatorSet>, String> {
        let workspace = workspace_root(self.state).ok();
        let bundle = load_skill_bundle_sections_from_sources(&skill.name, workspace.as_deref());
        let Some(raw_rules) = bundle.rules.get("host-save-validators.json") else {
            return Ok(None);
        };
        let parsed =
            serde_json::from_str::<SkillHostSaveValidatorSet>(raw_rules).map_err(|error| {
                format!(
                    "技能 {} 的 host-save-validators.json 无法解析：{error}",
                    skill.name
                )
            })?;
        Ok(Some(parsed))
    }

    fn validate_authoring_save_content(
        &self,
        project_kind: Option<AuthoringProjectKind>,
        content: &str,
    ) -> Result<(), String> {
        if content.trim().is_empty() {
            return Ok(());
        }
        if !matches!(
            project_kind,
            Some(AuthoringProjectKind::Redpost | AuthoringProjectKind::Redarticle)
        ) {
            return Ok(());
        }
        let project_kind = project_kind.expect("project kind should exist after match");
        let project_kind_label = authoring_project_kind_label(project_kind);
        let mut violations = Vec::<String>::new();
        for skill in self.active_session_skills() {
            let Some(validators) = self.load_skill_host_save_validators(&skill)? else {
                continue;
            };
            if !validators.applies_to.is_empty()
                && !validators
                    .applies_to
                    .iter()
                    .any(|value| value.eq_ignore_ascii_case(project_kind_label))
            {
                continue;
            }
            for rule in validators
                .rules
                .iter()
                .filter(|rule| !rule.message.trim().is_empty())
            {
                if evaluate_skill_host_save_rule(rule, content) {
                    violations.push(format!("{}: {}", skill.name, rule.message.trim()));
                }
            }
        }
        if violations.is_empty() {
            return Ok(());
        }
        Err(format!(
            "保存前校验未通过：{}。请先修正文案后再保存。",
            violations.join("；")
        ))
    }

    fn persist_current_authoring_session_target(
        &self,
        project_path: &str,
        content_path: &str,
        entry_path: &str,
        project_kind: AuthoringProjectKind,
        title: &str,
    ) -> Result<(), String> {
        let Some(session_id) = self.session_id else {
            return Ok(());
        };
        with_store_mut(self.state, |store| {
            let Some(session) = store
                .chat_sessions
                .iter_mut()
                .find(|item| item.id == session_id)
            else {
                return Ok(());
            };
            let mut metadata = session
                .metadata
                .clone()
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            metadata.insert(
                "currentAuthoringProjectPath".to_string(),
                json!(project_path),
            );
            metadata.insert(
                "currentAuthoringContentPath".to_string(),
                json!(content_path),
            );
            metadata.insert("currentAuthoringEntryPath".to_string(), json!(entry_path));
            metadata.insert(
                "currentAuthoringProjectKind".to_string(),
                json!(authoring_project_kind_label(project_kind)),
            );
            metadata.insert("currentAuthoringTitle".to_string(), json!(title));
            session.metadata = Some(Value::Object(metadata));
            session.updated_at = now_iso();
            Ok(())
        })?;
        emit_runtime_task_checkpoint_saved(
            self.app,
            None,
            Some(session_id),
            "chat.authoring_target_bound",
            "authoring target bound",
            Some(json!({
                "projectPath": project_path,
                "contentPath": content_path,
                "entryPath": entry_path,
                "kind": authoring_project_kind_label(project_kind),
                "title": title,
            })),
        );
        Ok(())
    }

    fn default_authoring_project_kind(&self) -> AuthoringProjectKind {
        let Some(preference) = self.current_authoring_target_preference() else {
            return AuthoringProjectKind::Redpost;
        };
        preference.preferred_kind
    }

    pub(super) fn handle_manuscript_create_project(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let title = payload_string(payload, "title")
            .or_else(|| args.string(&["title"]))
            .or_else(|| args.positionals.first().cloned())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "manuscripts create-project requires --title".to_string())?;
        let requested_parent = payload_string(payload, "parent")
            .or_else(|| payload_string(payload, "parentPath"))
            .or_else(|| args.string(&["parent", "parent-path", "parentPath"]));
        let project_kind = authoring_project_kind_from_value(
            payload_string(payload, "kind")
                .or_else(|| args.string(&["kind"]))
                .as_deref(),
        )
        .unwrap_or_else(|| self.default_authoring_project_kind());
        let project_id = build_authoring_project_id(&title, project_kind);
        let preferred_subdir = self
            .current_authoring_target_preference()
            .and_then(|preference| preference.preferred_subdir);
        let normalized_parent = requested_parent
            .map(|value| normalize_relative_path(&value))
            .filter(|value| !value.trim().is_empty())
            .or(preferred_subdir)
            .unwrap_or_default();
        let relative = build_authoring_project_relative_path(
            Some(&normalized_parent),
            &project_id,
            project_kind,
        );
        let (parent_path, name) = split_parent_and_name(&relative);
        let created = self.call_channel(
            "manuscripts:create-file",
            json!({
                "parentPath": parent_path,
                "name": name,
                "kind": authoring_project_kind_label(project_kind),
                "title": title,
                "content": ""
            }),
        )?;
        let entry_name = match project_kind {
            AuthoringProjectKind::Redpost | AuthoringProjectKind::Redarticle => "content.md",
        };
        let content_path = join_relative(&relative, entry_name);
        self.persist_current_authoring_session_target(
            &relative,
            &content_path,
            &content_path,
            project_kind,
            &title,
        )?;
        Ok(json!({
            "success": created.get("success").and_then(Value::as_bool).unwrap_or(true),
            "path": created.get("path").cloned().unwrap_or_else(|| json!(relative.clone())),
            "projectPath": created.get("path").cloned().unwrap_or_else(|| json!(relative.clone())),
            "contentPath": content_path.clone(),
            "entryPath": content_path,
            "projectId": project_id,
            "title": title,
            "kind": authoring_project_kind_label(project_kind),
        }))
    }

    pub(super) fn handle_manuscript_write_current(&self, payload: &Value) -> Result<Value, String> {
        let target = self.current_authoring_session_target().ok_or_else(|| {
            "manuscripts write-current requires an active authoring project".to_string()
        })?;
        let mut merged = payload.clone();
        let content = payload_string(&merged, "content").unwrap_or_default();
        if content.trim().is_empty() {
            return Err(json!({
                "ok": false,
                "tool": "workflow",
                "action": "manuscripts.writeCurrent",
                "error": {
                    "code": "EMPTY_CONTENT_REJECTED",
                    "message": "manuscripts.writeCurrent requires non-empty content; use Write(path=\"manuscripts://current\", content=\"完整正文\")",
                    "retryable": false
                }
            })
            .to_string());
        }
        let object = merged
            .as_object_mut()
            .ok_or_else(|| "manuscripts write-current payload must be an object".to_string())?;
        object.insert("path".to_string(), json!(target.project_path.clone()));
        object
            .entry("content".to_string())
            .or_insert(json!(content));
        self.validate_authoring_save_content(
            Some(target.project_kind),
            &payload_string(&merged, "content").unwrap_or_default(),
        )?;
        let content = payload_string(&merged, "content").unwrap_or_default();
        if let Some(result) = self.maybe_queue_writing_manuscript_proposal(
            &target.project_path,
            content,
            payload_field(&merged, "metadata"),
        )? {
            return Ok(result);
        }
        let saved = self.call_channel("manuscripts:save", merged.clone())?;
        let saved_bytes = payload_string(&merged, "content")
            .map(|value| value.as_bytes().len() as i64)
            .unwrap_or(0);
        let project_path = target.project_path.clone();
        let content_path = join_relative(&project_path, "content.md");
        Ok(json!({
            "projectPath": project_path,
            "contentPath": content_path,
            "savedBytes": saved_bytes,
            "result": saved,
        }))
    }

    pub(super) fn handle_manuscript_read_current(&self) -> Result<Value, String> {
        let target = self.current_authoring_session_target().ok_or_else(|| {
            "manuscripts read-current requires an active authoring project".to_string()
        })?;
        self.call_channel("manuscripts:read", json!(target.project_path))
    }

    fn normalize_manuscript_target_path(&self, requested_path: &str) -> String {
        let normalized = normalize_relative_path(requested_path);
        if normalized.trim().is_empty() {
            return normalized;
        }
        let Some(preference) = self.current_authoring_target_preference() else {
            return if normalized.ends_with(".md") {
                normalized
            } else {
                format!("{normalized}.md")
            };
        };
        let normalized =
            normalize_authoring_target_subdir(&normalized, preference.preferred_subdir.as_deref());
        let resolved = resolve_manuscript_path(self.state, &normalized).ok();
        let target_exists = resolved.as_ref().map(|path| path.exists()).unwrap_or(false);
        if normalized.ends_with(".md") {
            if target_exists {
                return normalized;
            }
            let stem = normalized.trim_end_matches(".md");
            return stem.to_string();
        }
        if target_exists {
            return normalized;
        }
        normalized
    }

    fn maybe_queue_writing_manuscript_proposal(
        &self,
        target_path: &str,
        content: String,
        metadata: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        let Some(target) = self.bound_writing_session_target() else {
            return Ok(None);
        };
        let normalized_target_path = normalize_relative_path(target_path);
        if normalize_relative_path(&target.file_path) != normalized_target_path {
            return Ok(None);
        }
        let current =
            self.call_channel("manuscripts:read", json!(normalized_target_path.clone()))?;
        let current_content = payload_string(&current, "content").unwrap_or_default();
        let frontmatter_block = extract_markdown_frontmatter_block(&current_content);
        let proposed_body = strip_markdown_frontmatter(&content);
        let proposed_content =
            compose_markdown_with_frontmatter(&proposed_body, frontmatter_block.as_deref());
        if proposed_content == current_content {
            return Ok(Some(json!({
                "success": true,
                "proposalCreated": false,
                "unchanged": true,
                "filePath": normalized_target_path,
                "message": "AI 返回的稿件与当前内容一致，没有生成新的改稿提案。"
            })));
        }
        let timestamp = now_iso();
        let proposal = crate::ManuscriptWriteProposalRecord {
            id: make_id("manuscript-proposal"),
            file_path: normalized_target_path.clone(),
            session_id: self.session_id.map(ToString::to_string),
            tool_call_id: self.tool_call_id.map(ToString::to_string),
            draft_type: Some(target.draft_type),
            title: target.title,
            metadata: metadata.cloned(),
            base_content: current_content,
            proposed_content,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        let saved = commands::manuscripts::upsert_manuscript_write_proposal(
            self.app, self.state, proposal,
        )?;
        Ok(Some(json!({
            "success": true,
            "proposalCreated": true,
            "requiresReview": true,
            "filePath": saved.file_path,
            "proposal": saved,
            "message": "已生成待审改稿提案。请在稿件编辑器里查看 diff，并手动接受或拒绝。"
        })))
    }
}

fn build_task_brief_patch(payload: &Value, now: &str) -> Value {
    let mut patch = match payload.get("brief").and_then(Value::as_object) {
        Some(brief) => brief.clone(),
        None => payload.as_object().cloned().unwrap_or_default(),
    };
    for key in ["sessionId", "merge"] {
        patch.remove(key);
    }
    if let Some(stage) = payload_string(payload, "stage") {
        patch.insert("currentStage".to_string(), json!(stage));
    }
    if let Some(status) = payload_string(payload, "status") {
        patch.insert("status".to_string(), json!(status));
    }
    patch.insert("lastUpdatedAt".to_string(), json!(now));
    sanitize_task_brief_value(&Value::Object(patch), 0)
}

fn task_brief_context_usage_response(store: &AppStore, session_id: &str) -> Value {
    let usage = crate::runtime::session_context_usage_value(store, session_id);
    let compact_threshold = usage
        .get("compactThreshold")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let estimated_effective_tokens = usage
        .get("estimatedEffectiveTokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let estimated_remaining_tokens = if compact_threshold > 0 {
        Some(compact_threshold.saturating_sub(estimated_effective_tokens))
    } else {
        None
    };
    json!({
        "success": true,
        "sessionId": session_id,
        "operation": "get",
        "context": usage,
        "estimatedRemainingTokens": estimated_remaining_tokens,
        "remainingRatio": if compact_threshold <= 0 {
            Value::Null
        } else {
            json!(estimated_remaining_tokens.unwrap_or(0) as f64 / compact_threshold as f64)
        },
        "isEstimate": true,
        "basis": "session message character estimate and configured compact threshold"
    })
}

fn goal_is_finished(goal: &Map<String, Value>) -> bool {
    matches!(
        goal.get("status").and_then(Value::as_str),
        Some("complete" | "blocked" | "cancelled")
    )
}

fn merge_task_brief_object(target: &mut Map<String, Value>, patch: &Map<String, Value>) {
    for (key, value) in patch {
        let sanitized = sanitize_task_brief_value(value, 0);
        match (target.get_mut(key), sanitized) {
            (Some(Value::Object(existing)), Value::Object(next)) => {
                merge_task_brief_object(existing, &next);
            }
            (_, next) => {
                target.insert(key.clone(), next);
            }
        }
    }
}

fn sanitize_task_brief_value(value: &Value, depth: usize) -> Value {
    if depth >= TASK_BRIEF_MAX_DEPTH {
        return match value {
            Value::String(text) => Value::String(truncate_task_brief_string(text)),
            Value::Number(_) | Value::Bool(_) | Value::Null => value.clone(),
            Value::Array(items) => json!({ "truncated": true, "itemCount": items.len() }),
            Value::Object(object) => json!({ "truncated": true, "fieldCount": object.len() }),
        };
    }
    match value {
        Value::String(text) => Value::String(truncate_task_brief_string(text)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(TASK_BRIEF_MAX_ARRAY_ITEMS)
                .map(|item| sanitize_task_brief_value(item, depth + 1))
                .collect(),
        ),
        Value::Object(object) => {
            let mut next = Map::new();
            for (key, item) in object.iter().take(TASK_BRIEF_MAX_OBJECT_FIELDS) {
                next.insert(key.clone(), sanitize_task_brief_value(item, depth + 1));
            }
            Value::Object(next)
        }
        _ => value.clone(),
    }
}

fn truncate_task_brief_string(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars().take(TASK_BRIEF_MAX_STRING_CHARS) {
        out.push(ch);
    }
    if text.chars().count() > TASK_BRIEF_MAX_STRING_CHARS {
        out.push_str("...[truncated]");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cli_args(positionals: &[&str], options: Value) -> CliArgs {
        CliArgs {
            positionals: positionals.iter().map(|item| item.to_string()).collect(),
            options: options.as_object().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn redclaw_profile_doc_type_reads_json_payload_doc_type() {
        let args = test_cli_args(&[], json!({}));
        let payload = json!({ "docType": "creator_profile" });

        assert_eq!(
            redclaw_profile_doc_type(&args, &payload, None).as_deref(),
            Some("creator_profile")
        );
    }

    #[test]
    fn redclaw_profile_doc_type_accepts_payload_id_alias() {
        let args = test_cli_args(&[], json!({}));
        let payload = json!({ "id": "soul" });

        assert_eq!(
            redclaw_profile_doc_type(&args, &payload, None).as_deref(),
            Some("soul")
        );
    }

    #[test]
    fn redclaw_profile_doc_type_prefers_cli_option_over_payload() {
        let args = test_cli_args(&[], json!({ "doc-type": "agent" }));
        let payload = json!({ "docType": "creator_profile" });

        assert_eq!(
            redclaw_profile_doc_type(&args, &payload, None).as_deref(),
            Some("agent")
        );
    }

    #[test]
    fn redclaw_profile_doc_type_uses_read_default_only_when_provided() {
        let args = test_cli_args(&[], json!({}));
        let payload = json!({});

        assert_eq!(
            redclaw_profile_doc_type(&args, &payload, Some("user")).as_deref(),
            Some("user")
        );
        assert_eq!(redclaw_profile_doc_type(&args, &payload, None), None);
    }

    #[test]
    fn capture_infers_xhs_profile_from_profile_url() {
        let payload = json!({ "url": "https://www.xiaohongshu.com/user/profile/abc_123" });
        let parsed = parse_capture_url(payload.get("url").and_then(Value::as_str).unwrap())
            .expect("valid xhs url");
        let platform = infer_capture_platform(&payload, &parsed).expect("platform");
        let target = infer_capture_target(&payload, &platform, &parsed).expect("target");

        assert_eq!(platform, "xiaohongshu");
        assert_eq!(target, "profile");
        assert_eq!(capture_kind_for(&platform, &target).unwrap(), "xhs-profile");
        assert_eq!(
            infer_capture_external_id("xhs-profile", &parsed).as_deref(),
            Some("abc_123")
        );
    }

    #[test]
    fn capture_accepts_nested_options_for_target() {
        let payload = json!({
            "url": "https://www.xiaohongshu.com/explore/note-1",
            "options": { "target": "comments", "includeComments": true }
        });
        let parsed = parse_capture_url(payload.get("url").and_then(Value::as_str).unwrap())
            .expect("valid xhs url");
        let platform = infer_capture_platform(&payload, &parsed).expect("platform");
        let target = infer_capture_target(&payload, &platform, &parsed).expect("target");

        assert_eq!(target, "comments");
        assert_eq!(capture_kind_for(&platform, &target).unwrap(), "xhs-note");
        assert_eq!(
            capture_payload_bool(&payload, &["includeComments"]),
            Some(true)
        );
    }

    #[test]
    fn capture_rejects_comments_for_douyin() {
        let payload = json!({
            "url": "https://www.douyin.com/video/1234567890",
            "target": "comments"
        });
        let parsed = parse_capture_url(payload.get("url").and_then(Value::as_str).unwrap())
            .expect("valid douyin url");
        let platform = infer_capture_platform(&payload, &parsed).expect("platform");

        assert!(infer_capture_target(&payload, &platform, &parsed).is_err());
    }

    #[test]
    fn capture_extracts_youtube_video_id() {
        let parsed = parse_capture_url("https://youtu.be/abc_DEF-123?t=10").expect("valid url");

        assert_eq!(
            infer_capture_external_id("youtube-video", &parsed).as_deref(),
            Some("abc_DEF-123")
        );
    }
}
