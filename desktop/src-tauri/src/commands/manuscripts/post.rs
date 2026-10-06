use super::*;

fn default_post_bindings() -> Value {
    json!({
        "media": [],
        "targets": [],
        "publishedPosts": [],
        "sources": [],
        "inspirations": []
    })
}

fn require_post_package(path: &std::path::Path) -> Result<(), String> {
    if !is_manuscript_package_path(path) {
        return Err("Not a manuscript package".to_string());
    }
    let manifest = read_json_value_or(&package_manifest_path(path), json!({}));
    let kind = manifest
        .get("kind")
        .or_else(|| manifest.get("packageKind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if kind != "post" {
        return Err("Only post packages are supported".to_string());
    }
    Ok(())
}

fn normalize_post_platform(value: &str) -> Result<String, String> {
    let mut output = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            output.push(ch);
            last_dash = false;
        } else if ch == '-' && !last_dash {
            output.push(ch);
            last_dash = true;
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }
    let normalized = output.trim_matches('-').to_string();
    if normalized.is_empty() {
        Err("platform is required".to_string())
    } else {
        Ok(normalized)
    }
}

fn post_variant_path(platform: &str) -> String {
    format!("variants/{platform}.md")
}

fn read_post_bindings(package_path: &std::path::Path) -> Value {
    read_package_json_entry_or(package_path, "bindings.json", default_post_bindings())
}

fn write_post_bindings(package_path: &std::path::Path, bindings: &Value) -> Result<Value, String> {
    write_package_json_entry(package_path, "bindings.json", bindings)?;
    let mut manifest = read_package_json_entry_or(package_path, "manifest.json", json!({}));
    if let Some(object) = manifest.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_i64()));
        write_package_json_entry(package_path, "manifest.json", &manifest)?;
    }
    Ok(bindings.clone())
}

fn upsert_post_target(bindings: &mut Value, platform: &str, variant_path: &str) {
    if !bindings.is_object() {
        *bindings = default_post_bindings();
    }
    let object = bindings.as_object_mut().expect("bindings should be object");
    let targets_value = object
        .entry("targets".to_string())
        .or_insert_with(|| json!([]));
    if !targets_value.is_array() {
        *targets_value = json!([]);
    }
    let targets = targets_value
        .as_array_mut()
        .expect("targets should be array");
    if let Some(target) = targets.iter_mut().find(|target| {
        target
            .get("platform")
            .and_then(Value::as_str)
            .map(|value| value == platform)
            .unwrap_or(false)
    }) {
        if let Some(target_object) = target.as_object_mut() {
            target_object.insert("variantPath".to_string(), json!(variant_path));
            target_object
                .entry("status".to_string())
                .or_insert(json!("draft"));
        }
        return;
    }
    targets.push(json!({
        "platform": platform,
        "variantPath": variant_path,
        "status": "draft"
    }));
}

pub(super) fn handle_post_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:get-post-bindings" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .or_else(|| payload_value_as_string(&payload))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            require_post_package(&full_path)?;
            Ok(json!({
                "success": true,
                "bindings": read_post_bindings(&full_path)
            }))
        })()),
        "manuscripts:update-post-bindings" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let bindings = payload_field(&payload, "bindings")
                .cloned()
                .unwrap_or_else(default_post_bindings);
            if !bindings.is_object() {
                return Ok(json!({ "success": false, "error": "bindings must be an object" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            require_post_package(&full_path)?;
            let bindings = write_post_bindings(&full_path, &bindings)?;
            Ok(json!({
                "success": true,
                "bindings": bindings,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:read-post-variant" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            let platform =
                normalize_post_platform(&payload_string(&payload, "platform").unwrap_or_default())?;
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            require_post_package(&full_path)?;
            let variant_path = post_variant_path(&platform);
            Ok(json!({
                "success": true,
                "platform": platform,
                "variantPath": variant_path,
                "content": read_package_text_entry(&full_path, &variant_path).unwrap_or_default()
            }))
        })()),
        "manuscripts:save-post-variant" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            let platform =
                normalize_post_platform(&payload_string(&payload, "platform").unwrap_or_default())?;
            let content = payload_string(&payload, "content").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            require_post_package(&full_path)?;
            let variant_path = post_variant_path(&platform);
            write_package_text_entry(&full_path, &variant_path, &content)?;
            let mut bindings = read_post_bindings(&full_path);
            upsert_post_target(&mut bindings, &platform, &variant_path);
            let bindings = write_post_bindings(&full_path, &bindings)?;
            Ok(json!({
                "success": true,
                "platform": platform,
                "variantPath": variant_path,
                "bindings": bindings,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_post_platform_for_variant_paths() {
        assert_eq!(
            normalize_post_platform(" XiaoHongShu / Main ").unwrap(),
            "xiaohongshu-main"
        );
        assert_eq!(
            normalize_post_platform("tiktok_shop").unwrap(),
            "tiktok_shop"
        );
        assert!(normalize_post_platform("   ").is_err());
    }

    #[test]
    fn upserts_post_target_without_dropping_existing_status() {
        let mut bindings = json!({
            "targets": [{
                "platform": "xhs",
                "variantPath": "variants/old.md",
                "status": "published"
            }]
        });

        upsert_post_target(&mut bindings, "xhs", "variants/xhs.md");
        upsert_post_target(&mut bindings, "douyin", "variants/douyin.md");

        let targets = bindings
            .get("targets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[0].get("variantPath").and_then(Value::as_str),
            Some("variants/xhs.md")
        );
        assert_eq!(
            targets[0].get("status").and_then(Value::as_str),
            Some("published")
        );
        assert_eq!(
            targets[1].get("status").and_then(Value::as_str),
            Some("draft")
        );
    }
}
