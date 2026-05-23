use super::*;

pub(super) fn handle_layout_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:get-layout" => Some((|| -> Result<Value, String> {
            let path = manuscript_layouts_path(state)?;
            if path.exists() {
                let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                let layout: Value =
                    serde_json::from_str(&content).map_err(|error| error.to_string())?;
                Ok(layout)
            } else {
                Ok(json!({}))
            }
        })()),
        "manuscripts:save-layout" => Some((|| -> Result<Value, String> {
            let path = manuscript_layouts_path(state)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(
                &path,
                serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            Ok(json!({ "success": true }))
        })()),
        _ => None,
    }
}
