use crate::{
    advisor_avatar_dir, copy_file_into_dir, file_url_for_path, pick_files_native, AppState,
};
use serde_json::{json, Value};
use tauri::State;

pub(super) fn handle_avatar_channel(
    state: &State<'_, AppState>,
    channel: &str,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "advisors:select-avatar" => select_avatar_value(state),
        _ => return None,
    })
}

fn select_avatar_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let selected = pick_files_native("选择成员头像图片", false, false)?;
    let Some(path) = selected.into_iter().next() else {
        return Ok(Value::Null);
    };
    let target_dir = advisor_avatar_dir(state)?;
    let (_, copied) = copy_file_into_dir(&path, &target_dir)?;
    Ok(json!(file_url_for_path(&copied)))
}
