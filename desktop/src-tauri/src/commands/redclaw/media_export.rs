use super::redclaw_export_content::{
    orchestration_outputs_for_project, output_for_role, parsed_output_artifact,
    redclaw_output_summary,
};
use super::redclaw_export_files::safe_export_slug;
use super::*;
use crate::{workspace_root, write_text_file};
use std::path::{Path, PathBuf};

fn build_redclaw_media_plan_export(project: &crate::runtime::RedclawProjectRecord) -> Value {
    let outputs = orchestration_outputs_for_project(project);
    let script = output_for_role(&outputs, "script_agent");
    let storyboard = output_for_role(&outputs, "storyboard_agent");
    let media = output_for_role(&outputs, "media_agent");
    let publish = output_for_role(&outputs, "publish_agent");
    let media_artifact = parsed_output_artifact(media.as_ref());
    json!({
        "schema": "redclaw.mediaPlan.v1",
        "project": {
            "id": project.id,
            "goal": project.goal,
            "platform": project.platform,
            "contentFormat": project.content_format,
            "runtimeTaskId": project.runtime_task_id,
            "artifactPath": project.artifact_path,
        },
        "generatedAt": now_iso(),
        "mediaPlan": media_artifact,
        "timelinePlan": media_artifact.get("timelinePlan").cloned()
            .or_else(|| media_artifact.get("timeline").cloned())
            .unwrap_or_else(|| json!([])),
        "matchedAssets": media_artifact.get("matchedAssets").cloned().unwrap_or_else(|| json!([])),
        "missingAssets": media_artifact.get("missingAssets").cloned().unwrap_or_else(|| json!([])),
        "productionRisks": media_artifact.get("productionRisks").cloned().unwrap_or_else(|| json!([])),
        "sections": {
            "script": redclaw_output_summary(script.as_ref()),
            "storyboard": redclaw_output_summary(storyboard.as_ref()),
            "media": redclaw_output_summary(media.as_ref()),
            "publish": redclaw_output_summary(publish.as_ref()),
        }
    })
}

fn media_plan_asset_path(item: &Value) -> Option<String> {
    for key in [
        "path",
        "absolutePath",
        "absolute_path",
        "filePath",
        "file",
        "source",
        "src",
        "url",
    ] {
        if let Some(value) = item
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }
    None
}

fn media_plan_duration_seconds(item: &Value) -> Option<f64> {
    for key in ["duration", "durationSeconds", "seconds"] {
        if let Some(value) = item.get(key).and_then(Value::as_f64) {
            return Some(value.max(0.0));
        }
        if let Some(value) = item.get(key).and_then(Value::as_i64) {
            return Some((value as f64).max(0.0));
        }
    }
    let start = item
        .get("startAt")
        .or_else(|| item.get("start"))
        .and_then(Value::as_f64);
    let end = item
        .get("endAt")
        .or_else(|| item.get("end"))
        .and_then(Value::as_f64);
    match (start, end) {
        (Some(start), Some(end)) if end > start => Some(end - start),
        _ => None,
    }
}

fn media_plan_concat_items(plan: &Value) -> Vec<(String, Option<f64>)> {
    let mut items = Vec::new();
    for key in ["timelinePlan", "matchedAssets"] {
        for item in plan
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(path) = media_plan_asset_path(item) {
                items.push((path, media_plan_duration_seconds(item)));
            }
        }
    }
    items
}

fn ffconcat_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "'\\''")
}

fn build_ffconcat(items: &[(String, Option<f64>)]) -> String {
    let mut body = String::from("ffconcat version 1.0\n");
    for (path, duration) in items {
        body.push_str(&format!("file '{}'\n", ffconcat_escape(path)));
        if let Some(duration) = duration.filter(|value| *value > 0.0) {
            body.push_str(&format!("duration {:.3}\n", duration));
        }
    }
    body
}

fn build_media_plan_readme(project_id: &str, items: &[(String, Option<f64>)]) -> String {
    let mut body = String::new();
    body.push_str(&format!(
        "# RedClaw Media Plan\n\nProject: `{project_id}`\n\n"
    ));
    body.push_str("- `media-plan.json`: structured RedClaw media plan export.\n");
    body.push_str("- `rough-cut.ffconcat`: ffmpeg concat input generated from matched timeline assets when paths are available.\n\n");
    if items.is_empty() {
        body.push_str("No concrete media file paths were found in the current MediaPlan. Ask Media Agent to match local assets before rendering a rough cut.\n");
    } else {
        body.push_str("Preview command:\n\n```bash\nffmpeg -safe 0 -f concat -i rough-cut.ffconcat -c copy rough-cut.mp4\n```\n");
    }
    body
}

fn ffconcat_file_entries(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let raw = trimmed.strip_prefix("file ")?;
            let value = raw
                .trim()
                .trim_matches('\'')
                .replace("'\\''", "'")
                .replace("\\\\", "\\");
            if value.trim().is_empty() {
                None
            } else {
                Some(value)
            }
        })
        .collect()
}

fn validate_ffconcat_inputs(package_dir: &Path, concat_path: &Path) -> Result<Vec<String>, String> {
    let body = std::fs::read_to_string(concat_path).map_err(|error| error.to_string())?;
    let entries = ffconcat_file_entries(&body);
    if entries.is_empty() {
        return Err("rough-cut.ffconcat has no media file entries".to_string());
    }
    let missing = entries
        .iter()
        .filter(|entry| !entry.starts_with("http://") && !entry.starts_with("https://"))
        .filter(|entry| {
            let path = Path::new(entry);
            let resolved = if path.is_absolute() {
                path.to_path_buf()
            } else {
                package_dir.join(path)
            };
            !resolved.exists()
        })
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "rough-cut.ffconcat references missing files: {}",
            missing.join(", ")
        ));
    }
    Ok(entries)
}

fn run_ffmpeg_concat(
    ffmpeg_path: &Path,
    package_dir: &Path,
    concat_path: &Path,
    output_path: &Path,
) -> Result<Value, String> {
    let output = crate::background_command(ffmpeg_path)
        .current_dir(package_dir)
        .arg("-y")
        .arg("-safe")
        .arg("0")
        .arg("-f")
        .arg("concat")
        .arg("-i")
        .arg(concat_path)
        .arg("-c")
        .arg("copy")
        .arg(output_path)
        .output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "ffmpeg rough cut render failed: {}",
            stderr.trim().chars().take(1200).collect::<String>()
        ));
    }
    Ok(json!({
        "status": output.status.code(),
        "stdout": stdout,
        "stderr": stderr,
    }))
}

pub(super) fn export_redclaw_media_plan(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let root = workspace_root(state)?;
    let export_dir = root.join("redclaw").join("media-plans");
    std::fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let project_snapshot = with_store(state, |store| {
        redclaw_store::project_by_id(&store, &project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())
    })?;

    let export_value = build_redclaw_media_plan_export(&project_snapshot);
    let package_dir = export_dir.join(safe_export_slug(&project_snapshot.id));
    std::fs::create_dir_all(&package_dir).map_err(|error| error.to_string())?;
    let path = package_dir.join("media-plan.json");
    let concat_path = package_dir.join("rough-cut.ffconcat");
    let readme_path = package_dir.join("README.md");
    let body = serde_json::to_string_pretty(&export_value).map_err(|error| error.to_string())?;
    write_text_file(&path, &body)?;
    let concat_items = media_plan_concat_items(&export_value);
    write_text_file(&concat_path, &build_ffconcat(&concat_items))?;
    write_text_file(
        &readme_path,
        &build_media_plan_readme(&project_snapshot.id, &concat_items),
    )?;

    let now = now_iso();
    let export_record = json!({
        "path": path.display().to_string(),
        "packagePath": package_dir.display().to_string(),
        "concatPath": concat_path.display().to_string(),
        "readmePath": readme_path.display().to_string(),
        "schema": "redclaw.mediaPlan.v1",
        "createdAt": now,
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_array_record(
            store,
            &project_id,
            "mediaPlanExports",
            export_record,
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "path": path.display().to_string(),
        "packagePath": package_dir.display().to_string(),
        "concatPath": concat_path.display().to_string(),
        "readmePath": readme_path.display().to_string(),
        "plan": export_value
    }))
}

pub(super) fn render_redclaw_rough_cut(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let export_result = export_redclaw_media_plan(state, payload)?;
    let package_path = payload_string(&export_result, "packagePath")
        .ok_or_else(|| "media plan packagePath missing".to_string())?;
    let concat_path = payload_string(&export_result, "concatPath")
        .ok_or_else(|| "media plan concatPath missing".to_string())?;
    let package_dir = PathBuf::from(package_path);
    let concat_path = PathBuf::from(concat_path);
    let output_path = package_dir.join("rough-cut.mp4");
    let ffmpeg_path = ffmpeg_executable(Some(app))?;
    let inputs = validate_ffconcat_inputs(&package_dir, &concat_path)?;
    let ffmpeg = run_ffmpeg_concat(&ffmpeg_path, &package_dir, &concat_path, &output_path)?;
    let output_size = std::fs::metadata(&output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let now = now_iso();
    let render_record = json!({
        "path": output_path.display().to_string(),
        "packagePath": package_dir.display().to_string(),
        "concatPath": concat_path.display().to_string(),
        "inputCount": inputs.len(),
        "sizeBytes": output_size,
        "createdAt": now,
        "renderer": "ffmpeg.concat.copy",
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_record_and_artifact(
            store,
            &project_id,
            "mediaPlanRenders",
            render_record.clone(),
            json!({
                "artifactType": "redclaw-rough-cut",
                "title": "RedClaw Rough Cut",
                "path": output_path.display().to_string(),
                "payload": render_record,
                "createdAt": now,
            }),
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "path": output_path.display().to_string(),
        "packagePath": package_dir.display().to_string(),
        "inputCount": inputs.len(),
        "sizeBytes": output_size,
        "ffmpeg": ffmpeg,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffconcat_includes_asset_paths_and_durations() {
        let plan = json!({
            "timelinePlan": [
                { "path": "/tmp/a.mp4", "durationSeconds": 2.5 },
                { "filePath": "/tmp/b.mp4", "start": 1.0, "end": 4.0 }
            ]
        });
        let items = media_plan_concat_items(&plan);
        let body = build_ffconcat(&items);

        assert!(body.contains("ffconcat version 1.0"));
        assert!(body.contains("file '/tmp/a.mp4'"));
        assert!(body.contains("duration 2.500"));
        assert!(body.contains("file '/tmp/b.mp4'"));
        assert!(body.contains("duration 3.000"));
    }

    #[test]
    fn ffconcat_file_entries_parses_exported_paths() {
        let entries = ffconcat_file_entries(
            "ffconcat version 1.0\nfile '/tmp/a.mp4'\nduration 1.000\nfile 'relative/b.mp4'\n",
        );

        assert_eq!(entries, vec!["/tmp/a.mp4", "relative/b.mp4"]);
    }
}
