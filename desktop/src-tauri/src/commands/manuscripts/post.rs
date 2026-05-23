use super::*;

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
