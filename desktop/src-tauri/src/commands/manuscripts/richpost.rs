use super::*;

pub(super) fn handle_richpost_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:generate-richpost-page-plan" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let file_name = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled");
            if get_package_kind_from_manifest(&full_path).as_deref() != Some("post") {
                return Ok(
                    json!({ "success": false, "error": "Only richpost packages support page plans" }),
                );
            }
            let manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
            let title = manifest
                .get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| title_from_relative_path(file_name));
            let content =
                fs::read_to_string(package_entry_path(&full_path, file_name, Some(&manifest)))
                    .unwrap_or_default();
            let blocks =
                build_package_content_blocks(&package_content_map_path(&full_path), &content);
            let (cover_asset, image_assets) =
                collect_package_bound_assets(Some(state), &full_path)?;
            let plan = generate_richpost_page_plan(
                state,
                &full_path,
                file_name,
                &title,
                &content,
                payload_field(&payload, "modelConfig"),
            )?;
            Ok(json!({
                "success": true,
                "plan": plan,
                "state": persist_richpost_page_plan(
                    &full_path,
                    &title,
                    &blocks,
                    cover_asset.as_ref(),
                    &image_assets,
                    &plan,
                    "ai",
                )?,
            }))
        })()),
        "manuscripts:apply-richpost-page-plan" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let raw_plan = payload_field(&payload, "plan")
                .cloned()
                .unwrap_or(Value::Null);
            if !raw_plan.is_object() {
                return Ok(json!({ "success": false, "error": "plan is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let file_name = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled");
            if get_package_kind_from_manifest(&full_path).as_deref() != Some("post") {
                return Ok(
                    json!({ "success": false, "error": "Only richpost packages support page plans" }),
                );
            }
            let manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
            let title = manifest
                .get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| title_from_relative_path(file_name));
            let content =
                fs::read_to_string(package_entry_path(&full_path, file_name, Some(&manifest)))
                    .unwrap_or_default();
            let blocks =
                build_package_content_blocks(&package_content_map_path(&full_path), &content);
            let (cover_asset, image_assets) =
                collect_package_bound_assets(Some(state), &full_path)?;
            let next_state = persist_richpost_page_plan(
                &full_path,
                &title,
                &blocks,
                cover_asset.as_ref(),
                &image_assets,
                &raw_plan,
                "ui-corrected",
            )?;
            let normalized_plan =
                read_json_value_or(&package_richpost_page_plan_path(&full_path), json!({}));
            Ok(json!({
                "success": true,
                "plan": normalized_plan,
                "state": next_state,
            }))
        })()),
        "manuscripts:render-richpost-pages" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let file_name = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled");
            if get_package_kind_from_manifest(&full_path).as_deref() != Some("post") {
                return Ok(
                    json!({ "success": false, "error": "Only richpost packages support page plans" }),
                );
            }
            let mut manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
            let current_typography = richpost_typography_settings_from_manifest(&manifest);
            let requested_font_scale = payload_field(&payload, "fontScale").and_then(Value::as_f64);
            let requested_line_height_scale =
                payload_field(&payload, "lineHeightScale").and_then(Value::as_f64);
            if requested_font_scale.is_some() || requested_line_height_scale.is_some() {
                let next_typography = richpost_typography_settings(
                    requested_font_scale.or(Some(current_typography.font_scale)),
                    requested_line_height_scale.or(Some(current_typography.line_height_scale)),
                );
                write_richpost_typography_settings_to_manifest(&mut manifest, next_typography);
                if let Some(object) = manifest.as_object_mut() {
                    object.insert("updatedAt".to_string(), json!(now_i64()));
                }
                write_json_value(&package_manifest_path(&full_path), &manifest)?;
            }
            Ok(json!({
                "success": true,
                "state": sync_manuscript_package_html_assets(Some(state), &full_path, file_name, None, None)?,
            }))
        })()),
        "manuscripts:pick-richpost-export-path" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            if get_package_kind_from_manifest(&full_path).as_deref() != Some("post") {
                return Ok(
                    json!({ "success": false, "error": "Only richpost packages support image export" }),
                );
            }
            let fallback_export_dir = full_path.join("exports").join("xiaohongshu");
            let export_dir = dirs::download_dir().unwrap_or(fallback_export_dir);
            let _ = fs::create_dir_all(&export_dir);
            let file_stem = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(slug_from_relative_path)
                .unwrap_or_else(|| "redbox-richpost".to_string());
            let archive_name = format!("{file_stem}-{}.zip", now_ms());
            let picked =
                pick_save_file_native("选择导出压缩包位置", &archive_name, Some(&export_dir))?;
            let Some(path) = picked else {
                return Ok(json!({ "success": true, "canceled": true }));
            };
            let normalized_path = ensure_export_extension(path, "zip");
            Ok(json!({
                "success": true,
                "canceled": false,
                "path": normalized_path.display().to_string(),
            }))
        })()),
        "manuscripts:save-richpost-export-archive" => Some((|| -> Result<Value, String> {
            let output_path = payload_string(&payload, "outputPath").unwrap_or_default();
            let entries = payload
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if output_path.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "outputPath is required" }));
            }
            if entries.is_empty() {
                return Ok(json!({ "success": false, "error": "entries is required" }));
            }
            let path = ensure_export_extension(std::path::PathBuf::from(output_path), "zip");
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let file = fs::File::create(&path).map_err(|error| error.to_string())?;
            let mut archive = zip::ZipWriter::new(file);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            for (index, entry) in entries.iter().enumerate() {
                let name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| format!("第 {} 个导出文件缺少 name", index + 1))?;
                let data_base64 = entry
                    .get("dataBase64")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| format!("第 {} 个导出文件缺少 dataBase64", index + 1))?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_base64.as_bytes())
                    .or_else(|_| {
                        base64::engine::general_purpose::STANDARD_NO_PAD
                            .decode(data_base64.as_bytes())
                    })
                    .map_err(|error| error.to_string())?;
                archive
                    .start_file(name, options)
                    .map_err(|error| error.to_string())?;
                archive
                    .write_all(&bytes)
                    .map_err(|error| error.to_string())?;
            }

            archive.finish().map_err(|error| error.to_string())?;
            Ok(json!({
                "success": true,
                "path": path.display().to_string(),
                "entryCount": entries.len(),
            }))
        })()),
        "manuscripts:save-richpost-export-image" => Some((|| -> Result<Value, String> {
            let output_path = payload_string(&payload, "outputPath").unwrap_or_default();
            let data_base64 = payload_string(&payload, "dataBase64").unwrap_or_default();
            if output_path.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "outputPath is required" }));
            }
            if data_base64.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "dataBase64 is required" }));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_base64.as_bytes())
                .or_else(|_| {
                    base64::engine::general_purpose::STANDARD_NO_PAD.decode(data_base64.as_bytes())
                })
                .map_err(|error| error.to_string())?;
            let path = std::path::PathBuf::from(output_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&path, bytes).map_err(|error| error.to_string())?;
            Ok(json!({
                "success": true,
                "path": path.display().to_string(),
            }))
        })()),
        "manuscripts:save-richpost-card-preview" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let data_base64 = payload_string(&payload, "dataBase64").unwrap_or_default();
            if file_path.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            if data_base64.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "dataBase64 is required" }));
            }
            let package_path = resolve_manuscript_path(state, &file_path)?;
            if !package_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_base64.as_bytes())
                .or_else(|_| {
                    base64::engine::general_purpose::STANDARD_NO_PAD.decode(data_base64.as_bytes())
                })
                .map_err(|error| error.to_string())?;
            let preview_path = package_richpost_card_preview_image_path(&package_path);
            if let Some(parent) = preview_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&preview_path, bytes).map_err(|error| error.to_string())?;
            let updated_at = fs::metadata(&preview_path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64);
            Ok(json!({
                "success": true,
                "path": preview_path.display().to_string(),
                "fileUrl": file_url_for_path(&preview_path),
                "updatedAt": updated_at,
            }))
        })()),
        _ => None,
    }
}
