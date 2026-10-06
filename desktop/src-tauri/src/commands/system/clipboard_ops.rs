use crate::payload_string;
use arboard::Clipboard;
use serde_json::{json, Value};

pub(super) fn read_text() -> Result<Value, String> {
    Ok(json!(Clipboard::new()
        .and_then(|mut clipboard| clipboard.get_text())
        .unwrap_or_default()))
}

pub(super) fn write_html(payload: &Value) -> Result<Value, String> {
    let text = payload_string(payload, "text")
        .or_else(|| payload_string(payload, "html"))
        .unwrap_or_default();
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text.clone()))
        .map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "text": text }))
}
