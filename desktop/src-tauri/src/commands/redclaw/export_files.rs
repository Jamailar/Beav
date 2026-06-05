use serde_json::{json, Value};
use tauri::State;

use super::redclaw_export_content::{
    publish_package_from_project, review_report_from_project, xhs_package_from_project,
};
use super::redclaw_export_markdown::{
    build_cover_brief_markdown, build_publish_package_markdown, build_review_report_markdown,
    build_xhs_package_markdown,
};
use crate::persistence::{with_store, with_store_mut};
use crate::store::redclaw as redclaw_store;
use crate::{now_iso, payload_string, workspace_root, write_text_file, AppState};

pub(super) fn export_redclaw_publish_package(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let root = workspace_root(state)?;
    let export_dir = root
        .join("redclaw")
        .join("publish-packages")
        .join(safe_export_slug(&project_id));
    std::fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let project_snapshot = with_store(state, |store| {
        redclaw_store::project_by_id(&store, &project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())
    })?;
    let package = publish_package_from_project(&project_snapshot);
    let package_path = export_dir.join("publish-package.json");
    let markdown_path = export_dir.join("publish-package.md");
    let cover_brief_path = export_dir.join("cover-brief.md");
    write_text_file(
        &package_path,
        &serde_json::to_string_pretty(&package).map_err(|error| error.to_string())?,
    )?;
    write_text_file(&markdown_path, &build_publish_package_markdown(&package))?;
    write_text_file(&cover_brief_path, &build_cover_brief_markdown(&package))?;

    let now = now_iso();
    let export_record = json!({
        "packagePath": export_dir.display().to_string(),
        "jsonPath": package_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "coverBriefPath": cover_brief_path.display().to_string(),
        "schema": "redclaw.publishPackage.v1",
        "createdAt": now,
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_array_record(
            store,
            &project_id,
            "publishPackageExports",
            export_record,
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "packagePath": export_dir.display().to_string(),
        "jsonPath": package_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "coverBriefPath": cover_brief_path.display().to_string(),
        "package": package,
    }))
}

pub(super) fn export_redclaw_review_report(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let root = workspace_root(state)?;
    let export_dir = root
        .join("redclaw")
        .join("review-reports")
        .join(safe_export_slug(&project_id));
    std::fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let project_snapshot = with_store(state, |store| {
        redclaw_store::project_by_id(&store, &project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())
    })?;
    let report = review_report_from_project(&project_snapshot);
    let report_path = export_dir.join("review-report.json");
    let markdown_path = export_dir.join("review-report.md");
    write_text_file(
        &report_path,
        &serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?,
    )?;
    write_text_file(&markdown_path, &build_review_report_markdown(&report))?;

    let now = now_iso();
    let export_record = json!({
        "packagePath": export_dir.display().to_string(),
        "jsonPath": report_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "schema": "redclaw.reviewReport.v1",
        "createdAt": now,
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_array_record(
            store,
            &project_id,
            "reviewReportExports",
            export_record,
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "packagePath": export_dir.display().to_string(),
        "jsonPath": report_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "report": report,
    }))
}

pub(super) fn export_redclaw_xhs_package(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let root = workspace_root(state)?;
    let export_dir = root
        .join("redclaw")
        .join("xhs-packages")
        .join(safe_export_slug(&project_id));
    std::fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let project_snapshot = with_store(state, |store| {
        redclaw_store::project_by_id(&store, &project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())
    })?;
    let package = xhs_package_from_project(&project_snapshot);
    let package_path = export_dir.join("xhs-package.json");
    let markdown_path = export_dir.join("xhs-package.md");
    let layout_path = export_dir.join("carousel-layout.json");
    let image_manifest_path = export_dir.join("image-manifest.json");
    write_text_file(
        &package_path,
        &serde_json::to_string_pretty(&package).map_err(|error| error.to_string())?,
    )?;
    write_text_file(&markdown_path, &build_xhs_package_markdown(&package))?;
    write_text_file(
        &layout_path,
        &serde_json::to_string_pretty(package.get("carouselLayout").unwrap_or(&Value::Null))
            .map_err(|error| error.to_string())?,
    )?;
    write_text_file(
        &image_manifest_path,
        &serde_json::to_string_pretty(package.get("imageAssets").unwrap_or(&Value::Null))
            .map_err(|error| error.to_string())?,
    )?;

    let now = now_iso();
    let export_record = json!({
        "packagePath": export_dir.display().to_string(),
        "jsonPath": package_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "layoutPath": layout_path.display().to_string(),
        "imageManifestPath": image_manifest_path.display().to_string(),
        "schema": "redclaw.xhsPackage.v1",
        "createdAt": now,
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_array_record(
            store,
            &project_id,
            "xhsPackageExports",
            export_record,
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "packagePath": export_dir.display().to_string(),
        "jsonPath": package_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "layoutPath": layout_path.display().to_string(),
        "imageManifestPath": image_manifest_path.display().to_string(),
        "package": package,
    }))
}

pub(super) fn safe_export_slug(value: &str) -> String {
    let mut slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "redclaw-project".to_string()
    } else {
        slug
    }
}
