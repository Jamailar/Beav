use super::*;

pub(in crate::commands::manuscripts) fn ffmpeg_asset_items(package_state: &Value) -> Vec<Value> {
    package_state
        .pointer("/assets/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn ffmpeg_asset_id(asset: &Value) -> Option<String> {
    asset
        .get("assetId")
        .or_else(|| asset.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn ffmpeg_asset_path(asset: &Value) -> Option<String> {
    for key in [
        "absolutePath",
        "mediaPath",
        "previewUrl",
        "relativePath",
        "src",
    ] {
        if let Some(value) = asset.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

pub(super) fn resolve_ffmpeg_asset_path(
    assets: &[Value],
    asset_id: &str,
) -> Result<String, String> {
    assets
        .iter()
        .find(|asset| {
            ffmpeg_asset_id(asset)
                .map(|candidate| candidate == asset_id)
                .unwrap_or(false)
        })
        .and_then(ffmpeg_asset_path)
        .ok_or_else(|| format!("未找到素材 `{asset_id}` 的可用路径"))
}

pub(super) fn ffmpeg_operation_input_path(
    operation: &Value,
    current_path: Option<&std::path::PathBuf>,
    assets: &[Value],
) -> Result<String, String> {
    if let Some(input_path) = operation.get("inputPath").and_then(Value::as_str) {
        let trimmed = input_path.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    if let Some(asset_id) = operation.get("assetId").and_then(Value::as_str) {
        let trimmed = asset_id.trim();
        if !trimmed.is_empty() {
            return resolve_ffmpeg_asset_path(assets, trimmed);
        }
    }
    current_path
        .map(|path| path.display().to_string())
        .ok_or_else(|| "当前操作缺少输入视频，请提供 assetId 或 inputPath".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_asset_items_and_paths_from_package_state() {
        let package_state = json!({
            "assets": {
                "items": [
                    { "assetId": "video-1", "absolutePath": "/tmp/video-1.mp4" },
                    { "id": "video-2", "relativePath": "imports/video-2.mp4" }
                ]
            }
        });
        let assets = ffmpeg_asset_items(&package_state);

        assert_eq!(assets.len(), 2);
        assert_eq!(
            resolve_ffmpeg_asset_path(&assets, "video-1").unwrap(),
            "/tmp/video-1.mp4"
        );
        assert_eq!(
            resolve_ffmpeg_asset_path(&assets, "video-2").unwrap(),
            "imports/video-2.mp4"
        );
    }

    #[test]
    fn operation_input_prefers_explicit_path_then_asset_then_current_path() {
        let assets = vec![json!({ "assetId": "asset-1", "src": "/tmp/asset-1.mp4" })];
        let current = std::path::PathBuf::from("/tmp/current.mp4");

        assert_eq!(
            ffmpeg_operation_input_path(&json!({ "inputPath": " /tmp/raw.mp4 " }), None, &assets)
                .unwrap(),
            "/tmp/raw.mp4"
        );
        assert_eq!(
            ffmpeg_operation_input_path(&json!({ "assetId": "asset-1" }), None, &assets).unwrap(),
            "/tmp/asset-1.mp4"
        );
        assert_eq!(
            ffmpeg_operation_input_path(&json!({}), Some(&current), &assets).unwrap(),
            "/tmp/current.mp4"
        );
    }
}
