use crate::commands::library::persist_media_workspace_catalog;
use crate::manuscript_package::{
    animation_layers_from_remotion_scene, build_default_remotion_scene,
    default_video_script_approval, ensure_manifest_video_ai_state, get_video_project_state,
    hydrate_editor_project_motion_from_remotion, normalized_remotion_render_config,
    persist_remotion_composition_artifacts, video_project_brief_from_manifest,
    video_script_state_from_manifest,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    request_runtime_approval, resolve_runtime_approval_by_source_key,
    ManuscriptScriptConfirmPayload, RuntimeApprovalDetails, RuntimeApprovalRecord,
};
use crate::store::{media as media_store, settings as settings_store};
use crate::*;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use tauri::{AppHandle, State};

mod assets;
mod auto_naming;
mod content_blocks;
mod editor_commands;
mod editor_project;
mod editor_project_model;
mod editor_runtime_state;
mod export_helpers;
mod ffmpeg_edit;
mod layout;
mod package;
mod post;
mod remotion;
mod remotion_context;
mod richpost;
mod richpost_artifacts;
mod richpost_model;
mod richpost_pagination;
mod richpost_plan;
mod richpost_render_model;
mod script_state;
mod subtitles;
mod timeline;
mod timeline_model;
mod tree;
mod write_proposals;

#[path = "manuscripts/theme/mod.rs"]
mod theme;

const DEFAULT_EDITOR_MOTION_PROMPT: &str =
    "请根据当前时间线和脚本，生成适合短视频的对象动画与节奏设计。默认不要额外标题、说明或字幕。";

use assets::*;
use auto_naming::{
    choose_auto_named_manuscript_relative, first_markdown_heading_text,
    is_auto_generated_manuscript_stem, is_untitled_manuscript_label,
};
use content_blocks::{
    build_package_content_blocks, package_content_map_value, render_package_block_fragment,
    render_package_block_fragment_parts, PackageBoundAsset, PackageContentBlock,
};
use editor_commands::*;
use editor_project_model::{
    default_motion_item_from_media, editor_default_subtitle_style,
    editor_project_animation_layers_mut, editor_project_items_mut, editor_project_tracks_mut,
    ensure_editor_track, ensure_motion_track, normalize_editor_project_timeline,
    normalize_motion_item, upsert_editor_project_last_subtitle_transcription,
};
use editor_runtime_state::{
    editor_runtime_state_record, editor_runtime_state_value, push_editor_project_undo_snapshot,
    restore_editor_project_from_history,
};
use export_helpers::{
    ensure_export_extension, instructions_request_visual_text_layers, remotion_export_scale,
    strip_incidental_remotion_text_layers,
};
use remotion_context::{merge_remotion_scene_patch, remotion_context_value};
use richpost_artifacts::persist_richpost_pages_from_plan;
use richpost_model::*;
use richpost_pagination::*;
use richpost_plan::*;
use richpost_render_model::*;
use script_state::*;
pub(crate) use timeline_model::timeline_clip_duration_ms;
use timeline_model::{
    build_timeline_clip_from_asset, build_timeline_subtitle_clip, build_timeline_text_clip,
    default_track_name_for_asset, min_clip_duration_ms_for_asset_kind, split_timeline_clip_value,
    timeline_clip_asset_kind, timeline_track_kind, DEFAULT_TIMELINE_CLIP_MS,
};
pub(crate) use write_proposals::{
    accept_manuscript_write_proposal, get_manuscript_write_proposal,
    reject_manuscript_write_proposal, upsert_manuscript_write_proposal,
};

fn richpost_theme_spec_storage_value(theme: &RichpostThemeSpec) -> Value {
    theme::store::richpost_theme_spec_storage_value(theme)
}

fn richpost_theme_root_master_path_for_theme(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    master_name: &str,
) -> Option<std::path::PathBuf> {
    theme::store::richpost_theme_root_master_path_for_theme(package_path, theme, master_name)
}

fn richpost_theme_spec_from_manifest(
    package_path: Option<&std::path::Path>,
    manifest: &Value,
) -> RichpostThemeSpec {
    theme::store::richpost_theme_spec_from_manifest(package_path, manifest)
}

fn default_richpost_master_fragment(master_name: &str) -> &'static str {
    let _ = master_name;
    r#"<!--
RedBox richpost master scaffold.
- 保留 zone 占位符，不要把正文直接写进母版
- 背景层使用 rb-zone-background，默认位于文字下方
- 真实文字区域由 --rb-frame-left / top / width / height 控制
- 可以自由增加容器、遮罩、装饰，但不要删掉 title/body/media/footer 区
-->
<style>
.rb-page-host .rb-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100%;
}
.rb-page-host .rb-zone-background,
.rb-page-host .rb-zone-overlay,
.rb-page-host .rb-zone-decoration {
  position: absolute;
  inset: 0;
}
.rb-page-host .rb-zone-background {
  background-image: var(--rb-background-image, none);
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
}
.rb-page-host .rb-zone-background .page-asset,
.rb-page-host .rb-zone-background img {
  width: 100%;
  height: 100%;
}
.rb-page-host .rb-zone-background img {
  object-fit: cover;
}
.rb-page-host .rb-stage-frame {
  position: absolute;
  left: var(--rb-frame-left, 8%);
  top: var(--rb-frame-top, 10%);
  width: var(--rb-frame-width, 84%);
  height: var(--rb-frame-height, 78%);
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: var(--rb-zone-gap);
  align-items: flex-start;
  justify-content: flex-start;
  overflow: hidden;
}
.rb-page-host .rb-zone-title,
.rb-page-host .rb-zone-body,
.rb-page-host .rb-zone-media,
.rb-page-host .rb-zone-footer {
  width: 100%;
  max-width: 100%;
}
.rb-page-host .rb-zone-media .page-asset img {
  object-fit: cover;
}
</style>
<div class="rb-stage">
  <div class="rb-zone rb-zone-background">{{zone:background}}</div>
  <div class="rb-zone rb-zone-overlay">{{zone:overlay}}</div>
  <div class="rb-zone rb-zone-decoration">{{zone:decoration}}</div>
  <div class="rb-stage-frame" data-zone-frame="content">
    <header class="rb-zone rb-zone-title">{{zone:title}}</header>
    <main class="rb-zone rb-zone-body">{{zone:body}}</main>
    <div class="rb-zone rb-zone-media">{{zone:media}}</div>
    <footer class="rb-zone rb-zone-footer">{{zone:footer}}</footer>
  </div>
</div>"#
}

fn richpost_master_file_needs_upgrade(path: &std::path::Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return true;
    };
    !content.contains("data-zone-frame=\"content\"")
        || !content.contains("--rb-frame-left")
        || content.contains("min-height: var(--rb-frame-height")
        || !content.contains(
            ".rb-page-host .rb-stage {\n  position: relative;\n  width: 100%;\n  height: 100%;",
        )
        || content.contains("rb-stage-stack")
}

fn ensure_richpost_layout_scaffold(
    package_path: &std::path::Path,
    manifest: &Value,
) -> Result<Value, String> {
    theme::scaffold::ensure_richpost_layout_scaffold(package_path, manifest)
}

#[allow(dead_code)]
pub(crate) fn richpost_theme_catalog_value(package_path: Option<&std::path::Path>) -> Value {
    theme::scaffold::richpost_theme_catalog_value(package_path)
}

pub(crate) fn richpost_theme_catalog_value_for_manifest(
    package_path: Option<&std::path::Path>,
    manifest: &Value,
) -> Value {
    theme::scaffold::richpost_theme_catalog_value_for_manifest(package_path, manifest)
}

pub(crate) fn richpost_theme_state_value(
    package_path: &std::path::Path,
    manifest: &Value,
) -> Value {
    theme::scaffold::richpost_theme_state_value(package_path, manifest)
}

fn package_block_is_page_break(kind: &str) -> bool {
    kind == "page-break"
}

fn persist_richpost_page_plan(
    package_path: &std::path::Path,
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    raw_plan: &Value,
    source: &str,
) -> Result<Value, String> {
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let normalized = normalize_richpost_page_plan(
        raw_plan,
        title,
        blocks,
        cover_asset,
        image_assets,
        source,
        typography,
        &theme,
    );
    write_json_value(&package_richpost_page_plan_path(package_path), &normalized)?;
    persist_richpost_pages_from_plan(
        package_path,
        title,
        blocks,
        cover_asset,
        image_assets,
        &normalized,
    )?;
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_i64()));
    }
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    get_manuscript_package_state(package_path)
}

pub(crate) fn sync_manuscript_package_html_assets(
    state: Option<&State<'_, AppState>>,
    package_path: &std::path::Path,
    file_name: &str,
    content_override: Option<&str>,
    target_override: Option<&str>,
) -> Result<Value, String> {
    let package_kind = get_package_kind_from_manifest(package_path)
        .ok_or_else(|| "未识别的工程类型".to_string())?;
    if package_kind != "post" {
        return get_manuscript_package_state(package_path);
    }
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let entry = manifest
        .get("entry")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_package_entry_for_kind(Some(&package_kind)));
    let title = manifest
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| title_from_relative_path(file_name));
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let _ = ensure_richpost_layout_scaffold(package_path, &manifest)?;
    let content = content_override
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            fs::read_to_string(package_entry_path(package_path, file_name, Some(&manifest)))
                .unwrap_or_default()
        });
    let content_map_path = package_content_map_path(package_path);
    let blocks = build_package_content_blocks(&content_map_path, &content);
    write_json_value(
        &content_map_path,
        &package_content_map_value(&package_kind, &title, entry, &blocks),
    )?;
    let (cover_asset, image_assets) = collect_package_bound_assets(state, package_path)?;
    let has_manual_page_breaks = blocks
        .iter()
        .any(|block| package_block_is_page_break(&block.kind));
    let raw_plan = default_richpost_page_plan(
        &title,
        &blocks,
        cover_asset.as_ref(),
        &image_assets,
        if has_manual_page_breaks {
            "markdown-page-break"
        } else {
            "markdown-auto-reflow"
        },
        typography,
        &theme,
    );
    let _ = target_override;
    persist_richpost_page_plan(
        package_path,
        &title,
        &blocks,
        cover_asset.as_ref(),
        &image_assets,
        &raw_plan,
        raw_plan
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("system-sync"),
    )
}

fn persist_package_script_body(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    content: &str,
    metadata: Option<&serde_json::Map<String, Value>>,
    source: &str,
) -> Result<(Value, Value), String> {
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let package_kind = payload_string(&manifest, "packageKind")
        .or_else(|| payload_string(&manifest, "kind"))
        .or_else(|| get_package_kind_from_manifest(package_path))
        .unwrap_or_else(|| "article".to_string());
    let draft_type =
        payload_string(&manifest, "draftType").unwrap_or_else(|| match package_kind.as_str() {
            "post" => "richpost".to_string(),
            "video" => "video".to_string(),
            "audio" => "audio".to_string(),
            _ => "longform".to_string(),
        });
    if let Some(object) = manifest.as_object_mut() {
        if let Some(metadata_object) = metadata {
            for (key, value) in metadata_object {
                object.insert(key.clone(), value.clone());
            }
        }
        object.insert("updatedAt".to_string(), json!(now_i64()));
        object
            .entry("title".to_string())
            .or_insert(json!(title_from_relative_path(file_name)));
        object
            .entry("entry".to_string())
            .or_insert(json!(
                if matches!(package_kind.as_str(), "video" | "audio") {
                    "script.md"
                } else {
                    "content.md"
                }
            ));
        object
            .entry("draftType".to_string())
            .or_insert(json!(draft_type));
        object
            .entry("packageKind".to_string())
            .or_insert(json!(package_kind.clone()));
        if package_kind == "post" {
            let default_theme = default_richpost_theme_spec();
            object
                .entry("richpostThemeId".to_string())
                .or_insert(json!(default_theme.id.clone()));
            object
                .entry("richpostThemeSnapshot".to_string())
                .or_insert_with(|| richpost_theme_spec_storage_value(&default_theme));
        }
    }
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    write_text_file(
        &package_entry_path(package_path, file_name, Some(&manifest)),
        content,
    )?;

    if package_kind == "video" {
        mark_manifest_video_script_pending(&mut manifest, source)?;
        write_json_value(&package_manifest_path(package_path), &manifest)?;
        return Ok((
            get_manuscript_package_state(package_path)?,
            package_video_script_state_value(package_path, file_name, &manifest),
        ));
    }

    if package_kind == "audio" {
        let mut project = ensure_editor_project(package_path)?;
        mark_editor_project_script_pending(&mut project, content, source)?;
        write_json_value(&package_editor_project_path(package_path), &project)?;
        return Ok((
            get_manuscript_package_state(package_path)?,
            package_script_state_value(&project),
        ));
    }

    Ok((
        sync_manuscript_package_html_assets(
            Some(state),
            package_path,
            file_name,
            Some(content),
            None,
        )?,
        json!({
            "body": content,
            "approval": {
                "status": "pending",
                "lastScriptUpdateAt": Value::Null,
                "lastScriptUpdateSource": source,
                "confirmedAt": Value::Null
            }
        }),
    ))
}

pub(crate) fn save_manuscript_content(
    state: &State<'_, AppState>,
    target: &str,
    content: &str,
    metadata: Option<&serde_json::Map<String, Value>>,
    source: &str,
) -> Result<Value, String> {
    let current_relative = normalize_relative_path(target);
    let mut path = resolve_manuscript_path(state, target)?;
    let mut active_relative = current_relative.clone();
    let mut active_title = metadata
        .and_then(|items| items.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let current_file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string();
    let current_stem = title_from_relative_path(&current_relative);
    let should_auto_name = !is_manuscript_package_path(&path)
        && (active_title
            .as_deref()
            .map(is_untitled_manuscript_label)
            .unwrap_or(false)
            || is_auto_generated_manuscript_stem(&current_stem));
    if should_auto_name {
        if let Some(next_title) = first_markdown_heading_text(content) {
            let next_relative = choose_auto_named_manuscript_relative(
                state,
                &current_relative,
                &current_file_name,
                &next_title,
            )?;
            if next_relative != current_relative {
                let next_path = resolve_manuscript_path(state, &next_relative)?;
                if let Some(parent) = next_path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                if path.exists() {
                    fs::rename(&path, &next_path).map_err(|error| error.to_string())?;
                }
                path = next_path;
                active_relative = next_relative;
            }
            active_title = Some(next_title);
        }
    }

    let merged_metadata = {
        let mut items = metadata.cloned().unwrap_or_default();
        if let Some(title) = active_title.as_ref() {
            items.insert("title".to_string(), json!(title));
        }
        items
    };
    if !path.exists()
        && merged_metadata
            .get("packageKind")
            .or_else(|| merged_metadata.get("kind"))
            .is_some()
    {
        let package_title = active_title
            .clone()
            .unwrap_or_else(|| title_from_relative_path(&active_relative));
        let kind = payload_string(&Value::Object(merged_metadata.clone()), "packageKind")
            .or_else(|| payload_string(&Value::Object(merged_metadata.clone()), "kind"))
            .unwrap_or_else(|| "post".to_string());
        create_manuscript_package(&path, content, &kind, &package_title)?;
    }
    if is_manuscript_package_path(&path) {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let (next_state, script_state) = persist_package_script_body(
            state,
            &path,
            file_name,
            content,
            Some(&merged_metadata),
            source,
        )?;
        return Ok(json!({
            "success": true,
            "newPath": active_relative,
            "title": active_title,
            "state": next_state,
            "script": script_state,
            "content": content,
        }));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(json!({
        "success": true,
        "newPath": active_relative,
        "title": active_title,
        "content": content,
    }))
}

fn generate_richpost_page_plan(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    title: &str,
    body: &str,
    model_config: Option<&Value>,
) -> Result<Value, String> {
    let _ = (state, package_path, file_name, title, body, model_config);
    Err("图文分页方案功能已下线".to_string())
}

pub fn handle_manuscripts_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !channel.starts_with("manuscripts:") {
        return None;
    }

    tree::handle_tree_channel(app, state, channel, payload)
        .or_else(|| package::handle_package_channel(app, state, channel, payload))
        .or_else(|| post::handle_post_channel(app, state, channel, payload))
        .or_else(|| richpost::handle_richpost_channel(app, state, channel, payload))
        .or_else(|| editor_project::handle_editor_project_channel(app, state, channel, payload))
        .or_else(|| timeline::handle_timeline_channel(app, state, channel, payload))
        .or_else(|| remotion::handle_remotion_channel(app, state, channel, payload))
        .or_else(|| layout::handle_layout_channel(app, state, channel, payload))
        .or_else(|| {
            Some(Err(format!(
                "{} host does not recognize channel `{channel}`.",
                app_brand_display_name()
            )))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_project_motion_items_from_remotion_scene_updates_animation_layers_and_items() {
        let mut project = json!({
            "tracks": [{
                "id": "M1",
                "kind": "motion",
                "name": "M1",
                "order": 0,
                "ui": {
                    "hidden": false,
                    "locked": false,
                    "muted": false,
                    "solo": false,
                    "collapsed": false,
                    "volume": 1.0
                }
            }],
            "items": [{
                "id": "old-motion",
                "type": "motion",
                "trackId": "M1",
                "fromMs": 0,
                "durationMs": 1000,
                "templateId": "static",
                "props": {},
                "enabled": true
            }, {
                "id": "clip-1",
                "type": "media",
                "trackId": "V1",
                "assetId": "asset-1",
                "fromMs": 0,
                "durationMs": 1000,
                "trimInMs": 0,
                "trimOutMs": 0,
                "enabled": true
            }],
            "animationLayers": [{
                "id": "old-motion",
                "name": "旧动画",
                "trackId": "M1",
                "enabled": true,
                "fromMs": 0,
                "durationMs": 1000,
                "zIndex": 0,
                "renderMode": "motion-layer",
                "componentType": "scene-sequence",
                "props": { "templateId": "static" },
                "entities": [],
                "bindings": []
            }]
        });
        let composition = json!({
            "fps": 30,
            "renderMode": "motion-layer",
            "scenes": [{
                "id": "scene-1",
                "clipId": Value::Null,
                "assetId": Value::Null,
                "startFrame": 0,
                "durationInFrames": 30,
                "motionPreset": "static",
                "overlayTitle": "苹果下落",
                "overlayBody": Value::Null,
                "overlays": [],
                "entities": [{
                    "id": "apple-1",
                    "type": "shape",
                    "shape": "apple",
                    "color": "#FF0000",
                    "x": 100,
                    "y": 0,
                    "width": 120,
                    "height": 120,
                    "animations": [{
                        "id": "anim-1",
                        "kind": "fall-bounce",
                        "fromFrame": 0,
                        "durationInFrames": 30
                    }]
                }]
            }]
        });

        editor_project_model::sync_project_motion_items_from_remotion_scene(
            &mut project,
            &composition,
        )
        .unwrap();

        let layers = project
            .get("animationLayers")
            .and_then(Value::as_array)
            .expect("animation layers should exist");
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].get("id").and_then(Value::as_str), Some("scene-1"));
        assert_eq!(
            layers[0]
                .pointer("/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
        assert_eq!(
            layers[0]
                .pointer("/entities/0/color")
                .and_then(Value::as_str),
            Some("#FF0000")
        );

        let motion_items = project
            .get("items")
            .and_then(Value::as_array)
            .expect("items should exist")
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("motion"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(motion_items.len(), 1);
        assert_eq!(
            motion_items[0].get("id").and_then(Value::as_str),
            Some("scene-1")
        );
        assert_eq!(
            motion_items[0]
                .pointer("/props/entities/0/animations/0/kind")
                .and_then(Value::as_str),
            Some("fall-bounce")
        );
        assert_eq!(
            motion_items[0]
                .pointer("/props/entities/0/color")
                .and_then(Value::as_str),
            Some("#FF0000")
        );
    }

    #[test]
    fn merge_remotion_scene_patch_preserves_unmodified_existing_scene_data() {
        let existing = json!({
            "title": "Demo",
            "fps": 30,
            "scenes": [{
                "id": "scene-1",
                "startFrame": 0,
                "durationInFrames": 90,
                "overlayTitle": "旧标题",
                "entities": [{
                    "id": "apple-1",
                    "type": "shape",
                    "shape": "apple"
                }]
            }]
        });
        let patch = json!({
            "scenes": [{
                "id": "scene-1",
                "overlayTitle": "新标题"
            }]
        });

        let merged = merge_remotion_scene_patch(&existing, &patch);
        assert_eq!(
            merged
                .pointer("/scenes/0/overlayTitle")
                .and_then(Value::as_str),
            Some("新标题")
        );
        assert_eq!(
            merged
                .pointer("/scenes/0/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
    }

    #[test]
    fn mark_editor_project_script_pending_sets_body_and_approval_fields() {
        let mut project = json!({});

        mark_editor_project_script_pending(&mut project, "新脚本内容", "ai").unwrap();

        assert_eq!(
            project.pointer("/script/body").and_then(Value::as_str),
            Some("新脚本内容")
        );
        assert_eq!(
            project
                .pointer("/ai/scriptApproval/status")
                .and_then(Value::as_str),
            Some("pending")
        );
        assert_eq!(
            project
                .pointer("/ai/scriptApproval/lastScriptUpdateSource")
                .and_then(Value::as_str),
            Some("ai")
        );
        assert!(project
            .pointer("/ai/scriptApproval/confirmedAt")
            .map(Value::is_null)
            .unwrap_or(false));
    }

    #[test]
    fn confirm_editor_project_script_sets_confirmed_without_losing_script_body() {
        let mut project = json!({});
        mark_editor_project_script_pending(&mut project, "可执行脚本", "user").unwrap();

        let approval = confirm_editor_project_script(&mut project).unwrap();

        assert_eq!(
            approval.get("status").and_then(Value::as_str),
            Some("confirmed")
        );
        assert_eq!(
            project.pointer("/script/body").and_then(Value::as_str),
            Some("可执行脚本")
        );
        assert!(approval
            .get("confirmedAt")
            .and_then(Value::as_i64)
            .map(|value| value > 0)
            .unwrap_or(false));
    }
}
