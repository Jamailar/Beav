use super::*;

pub(super) fn ensure_editor_project_ai_state(
    project: &mut Value,
) -> Result<&mut serde_json::Map<String, Value>, String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let ai = project_object
        .entry("ai".to_string())
        .or_insert_with(|| json!({}));
    if !ai.is_object() {
        *ai = json!({});
    }
    let ai_object = ai
        .as_object_mut()
        .ok_or_else(|| "Editor project ai must be an object".to_string())?;
    ai_object
        .entry("motionPrompt".to_string())
        .or_insert(json!(DEFAULT_EDITOR_MOTION_PROMPT));
    ai_object
        .entry("lastEditBrief".to_string())
        .or_insert(Value::Null);
    ai_object
        .entry("lastMotionBrief".to_string())
        .or_insert(Value::Null);
    let approval = ai_object
        .entry("scriptApproval".to_string())
        .or_insert_with(|| json!({}));
    if !approval.is_object() {
        *approval = json!({});
    }
    let approval_object = approval
        .as_object_mut()
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    approval_object
        .entry("status".to_string())
        .or_insert(json!("pending"));
    approval_object
        .entry("lastScriptUpdateAt".to_string())
        .or_insert(Value::Null);
    approval_object
        .entry("lastScriptUpdateSource".to_string())
        .or_insert(Value::Null);
    approval_object
        .entry("confirmedAt".to_string())
        .or_insert(Value::Null);
    Ok(ai_object)
}

pub(super) fn package_script_state_value(project: &Value) -> Value {
    let approval = project
        .pointer("/ai/scriptApproval")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "status": "pending",
                "lastScriptUpdateAt": Value::Null,
                "lastScriptUpdateSource": Value::Null,
                "confirmedAt": Value::Null
            })
        });
    json!({
        "body": project
            .pointer("/script/body")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
        "approval": approval
    })
}

pub(super) fn package_video_script_state_value(
    package_path: &std::path::Path,
    file_name: &str,
    manifest: &Value,
) -> Value {
    let script_body =
        fs::read_to_string(package_entry_path(package_path, file_name, Some(manifest)))
            .unwrap_or_default();
    video_script_state_from_manifest(manifest, &script_body)
}

pub(super) fn mark_manifest_video_script_pending(
    manifest: &mut Value,
    source: &str,
) -> Result<(), String> {
    let video_ai = ensure_manifest_video_ai_state(manifest)?;
    let approval = video_ai
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Manifest videoAi.scriptApproval must be an object".to_string())?;
    approval.insert("status".to_string(), json!("pending"));
    approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    approval.insert(
        "lastScriptUpdateSource".to_string(),
        if source.trim().is_empty() {
            Value::Null
        } else {
            json!(source)
        },
    );
    approval.insert("confirmedAt".to_string(), Value::Null);
    Ok(())
}

pub(super) fn confirm_manifest_video_script(manifest: &mut Value) -> Result<Value, String> {
    let video_ai = ensure_manifest_video_ai_state(manifest)?;
    let approval = video_ai
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Manifest videoAi.scriptApproval must be an object".to_string())?;
    if approval
        .get("lastScriptUpdateAt")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    }
    approval.insert("status".to_string(), json!("confirmed"));
    approval.insert("confirmedAt".to_string(), json!(now_i64()));
    Ok(manifest
        .pointer("/videoAi/scriptApproval")
        .cloned()
        .unwrap_or_else(|| default_video_script_approval("system")))
}

pub(super) fn persist_video_project_brief(
    package_path: &std::path::Path,
    brief: &str,
    source: &str,
) -> Result<(Value, Value), String> {
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_i64()));
    }
    let video_ai = ensure_manifest_video_ai_state(&mut manifest)?;
    let normalized_brief = brief.trim();
    video_ai.insert(
        "brief".to_string(),
        if normalized_brief.is_empty() {
            Value::Null
        } else {
            json!(normalized_brief)
        },
    );
    video_ai.insert("lastBriefUpdateAt".to_string(), json!(now_i64()));
    video_ai.insert(
        "lastBriefUpdateSource".to_string(),
        if source.trim().is_empty() {
            Value::Null
        } else {
            json!(source)
        },
    );
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    Ok((
        get_manuscript_package_state(package_path)?,
        video_project_brief_from_manifest(&manifest),
    ))
}

pub(super) fn normalize_video_project_asset_kind(
    input: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(raw) = input.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let normalized = raw.to_ascii_lowercase();
    match normalized.as_str() {
        "reference-image" | "voice-reference" | "keyframe" | "clip" | "output" | "other" => {
            Ok(Some(normalized))
        }
        _ => Err(
            "kind must be one of reference-image, voice-reference, keyframe, clip, output, other"
                .to_string(),
        ),
    }
}

pub(super) fn mark_editor_project_script_pending(
    project: &mut Value,
    content: &str,
    source: &str,
) -> Result<(), String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let script = project_object
        .entry("script".to_string())
        .or_insert_with(|| json!({}));
    if !script.is_object() {
        *script = json!({});
    }
    if let Some(script_object) = script.as_object_mut() {
        script_object.insert("body".to_string(), json!(content));
    }
    let ai_object = ensure_editor_project_ai_state(project)?;
    ai_object.insert("lastEditBrief".to_string(), Value::Null);
    ai_object.insert("lastMotionBrief".to_string(), Value::Null);
    let approval = ai_object
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    approval.insert("status".to_string(), json!("pending"));
    approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    approval.insert("lastScriptUpdateSource".to_string(), json!(source));
    approval.insert("confirmedAt".to_string(), Value::Null);
    Ok(())
}

pub(super) fn confirm_editor_project_script(project: &mut Value) -> Result<Value, String> {
    let ai_object = ensure_editor_project_ai_state(project)?;
    let approval = ai_object
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    if approval
        .get("lastScriptUpdateAt")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    }
    approval.insert("status".to_string(), json!("confirmed"));
    approval.insert("confirmedAt".to_string(), json!(now_i64()));
    Ok(project
        .pointer("/ai/scriptApproval")
        .cloned()
        .unwrap_or(Value::Null))
}

pub(super) fn run_animation_director_subagent(
    _app: &AppHandle,
    _state: &State<'_, AppState>,
    _session_id: Option<&str>,
    _model_config: Option<&Value>,
    _user_input: &str,
) -> Result<(Value, String), String> {
    Err("该生成功能已关闭".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_project_asset_kind_normalizes_known_values() {
        assert_eq!(
            normalize_video_project_asset_kind(Some(" KeyFrame ")).unwrap(),
            Some("keyframe".to_string())
        );
        assert_eq!(normalize_video_project_asset_kind(None).unwrap(), None);
    }
}
