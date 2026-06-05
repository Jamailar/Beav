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

mod auto_naming;
mod content_blocks;
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
mod richpost_model;
mod richpost_pagination;
mod richpost_render_model;
mod subtitles;
mod timeline;
mod timeline_model;
mod tree;

#[path = "manuscripts/theme/mod.rs"]
mod theme;

const DEFAULT_EDITOR_MOTION_PROMPT: &str =
    "请根据当前时间线和脚本，生成适合短视频的对象动画与节奏设计。默认不要额外标题、说明或字幕。";

use auto_naming::{
    choose_auto_named_manuscript_relative, first_markdown_heading_text,
    is_auto_generated_manuscript_stem, is_untitled_manuscript_label,
};
use content_blocks::{
    build_package_content_blocks, package_content_map_value, render_package_block_fragment,
    render_package_block_fragment_parts, PackageBoundAsset, PackageContentBlock,
};
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
use richpost_model::*;
use richpost_pagination::*;
use richpost_render_model::*;
pub(crate) use timeline_model::timeline_clip_duration_ms;
use timeline_model::{
    build_timeline_clip_from_asset, build_timeline_subtitle_clip, build_timeline_text_clip,
    default_track_name_for_asset, min_clip_duration_ms_for_asset_kind, split_timeline_clip_value,
    timeline_clip_asset_kind, timeline_track_kind, DEFAULT_TIMELINE_CLIP_MS,
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

fn ensure_editor_project_ai_state(
    project: &mut Value,
) -> Result<&mut serde_json::Map<String, Value>, String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let ai = project_object
        .entry("ai".to_string())
        .or_insert_with(|| json!({}));
    if !ai.is_object() {
        *ai = json!({});
    }
    let ai_object = ai
        .as_object_mut()
        .ok_or_else(|| "Editor project ai must be an object".to_string())?;
    ai_object
        .entry("motionPrompt".to_string())
        .or_insert(json!(DEFAULT_EDITOR_MOTION_PROMPT));
    ai_object
        .entry("lastEditBrief".to_string())
        .or_insert(Value::Null);
    ai_object
        .entry("lastMotionBrief".to_string())
        .or_insert(Value::Null);
    let approval = ai_object
        .entry("scriptApproval".to_string())
        .or_insert_with(|| json!({}));
    if !approval.is_object() {
        *approval = json!({});
    }
    let approval_object = approval
        .as_object_mut()
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    approval_object
        .entry("status".to_string())
        .or_insert(json!("pending"));
    approval_object
        .entry("lastScriptUpdateAt".to_string())
        .or_insert(Value::Null);
    approval_object
        .entry("lastScriptUpdateSource".to_string())
        .or_insert(Value::Null);
    approval_object
        .entry("confirmedAt".to_string())
        .or_insert(Value::Null);
    Ok(ai_object)
}

fn package_script_state_value(project: &Value) -> Value {
    let approval = project
        .pointer("/ai/scriptApproval")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "status": "pending",
                "lastScriptUpdateAt": Value::Null,
                "lastScriptUpdateSource": Value::Null,
                "confirmedAt": Value::Null
            })
        });
    json!({
        "body": project
            .pointer("/script/body")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
        "approval": approval
    })
}

fn package_video_script_state_value(
    package_path: &std::path::Path,
    file_name: &str,
    manifest: &Value,
) -> Value {
    let script_body =
        fs::read_to_string(package_entry_path(package_path, file_name, Some(manifest)))
            .unwrap_or_default();
    video_script_state_from_manifest(manifest, &script_body)
}

fn mark_manifest_video_script_pending(manifest: &mut Value, source: &str) -> Result<(), String> {
    let video_ai = ensure_manifest_video_ai_state(manifest)?;
    let approval = video_ai
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Manifest videoAi.scriptApproval must be an object".to_string())?;
    approval.insert("status".to_string(), json!("pending"));
    approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    approval.insert(
        "lastScriptUpdateSource".to_string(),
        if source.trim().is_empty() {
            Value::Null
        } else {
            json!(source)
        },
    );
    approval.insert("confirmedAt".to_string(), Value::Null);
    Ok(())
}

fn confirm_manifest_video_script(manifest: &mut Value) -> Result<Value, String> {
    let video_ai = ensure_manifest_video_ai_state(manifest)?;
    let approval = video_ai
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Manifest videoAi.scriptApproval must be an object".to_string())?;
    if approval
        .get("lastScriptUpdateAt")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    }
    approval.insert("status".to_string(), json!("confirmed"));
    approval.insert("confirmedAt".to_string(), json!(now_i64()));
    Ok(manifest
        .pointer("/videoAi/scriptApproval")
        .cloned()
        .unwrap_or_else(|| default_video_script_approval("system")))
}

fn persist_video_project_brief(
    package_path: &std::path::Path,
    brief: &str,
    source: &str,
) -> Result<(Value, Value), String> {
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_i64()));
    }
    let video_ai = ensure_manifest_video_ai_state(&mut manifest)?;
    let normalized_brief = brief.trim();
    video_ai.insert(
        "brief".to_string(),
        if normalized_brief.is_empty() {
            Value::Null
        } else {
            json!(normalized_brief)
        },
    );
    video_ai.insert("lastBriefUpdateAt".to_string(), json!(now_i64()));
    video_ai.insert(
        "lastBriefUpdateSource".to_string(),
        if source.trim().is_empty() {
            Value::Null
        } else {
            json!(source)
        },
    );
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    Ok((
        get_manuscript_package_state(package_path)?,
        video_project_brief_from_manifest(&manifest),
    ))
}

fn normalize_video_project_asset_kind(input: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = input.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let normalized = raw.to_ascii_lowercase();
    match normalized.as_str() {
        "reference-image" | "voice-reference" | "keyframe" | "clip" | "output" | "other" => {
            Ok(Some(normalized))
        }
        _ => Err(
            "kind must be one of reference-image, voice-reference, keyframe, clip, output, other"
                .to_string(),
        ),
    }
}

fn mark_editor_project_script_pending(
    project: &mut Value,
    content: &str,
    source: &str,
) -> Result<(), String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let script = project_object
        .entry("script".to_string())
        .or_insert_with(|| json!({}));
    if !script.is_object() {
        *script = json!({});
    }
    if let Some(script_object) = script.as_object_mut() {
        script_object.insert("body".to_string(), json!(content));
    }
    let ai_object = ensure_editor_project_ai_state(project)?;
    ai_object.insert("lastEditBrief".to_string(), Value::Null);
    ai_object.insert("lastMotionBrief".to_string(), Value::Null);
    let approval = ai_object
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    approval.insert("status".to_string(), json!("pending"));
    approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    approval.insert("lastScriptUpdateSource".to_string(), json!(source));
    approval.insert("confirmedAt".to_string(), Value::Null);
    Ok(())
}

fn confirm_editor_project_script(project: &mut Value) -> Result<Value, String> {
    let ai_object = ensure_editor_project_ai_state(project)?;
    let approval = ai_object
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    if approval
        .get("lastScriptUpdateAt")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    }
    approval.insert("status".to_string(), json!("confirmed"));
    approval.insert("confirmedAt".to_string(), json!(now_i64()));
    Ok(project
        .pointer("/ai/scriptApproval")
        .cloned()
        .unwrap_or(Value::Null))
}

fn run_animation_director_subagent(
    _app: &AppHandle,
    _state: &State<'_, AppState>,
    _session_id: Option<&str>,
    _model_config: Option<&Value>,
    _user_input: &str,
) -> Result<(Value, String), String> {
    Err("该生成功能已关闭".to_string())
}

fn collect_package_bound_assets(
    state: Option<&State<'_, AppState>>,
    package_path: &std::path::Path,
) -> Result<(Option<PackageBoundAsset>, Vec<PackageBoundAsset>), String> {
    let Some(state) = state else {
        return Ok((None, Vec::new()));
    };
    let cover_asset_id = read_json_value_or(&package_cover_path(package_path), json!({}))
        .get("assetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let image_asset_ids =
        read_json_value_or(&package_images_path(package_path), json!({ "items": [] }))
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("assetId")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(ToString::to_string)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
    with_store(state, |store| {
        let resolve_asset = |asset_id: &str| -> Option<PackageBoundAsset> {
            let asset = media_store::get_asset(&store, asset_id)?;
            let url = asset_prompt_url(&asset)?;
            Some(PackageBoundAsset {
                id: asset.id.clone(),
                title: asset
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(asset.id.as_str())
                    .to_string(),
                url,
                role: "image".to_string(),
            })
        };
        let cover = cover_asset_id
            .as_deref()
            .and_then(resolve_asset)
            .map(|mut asset| {
                asset.role = "cover".to_string();
                asset
            });
        let images = image_asset_ids
            .iter()
            .filter_map(|asset_id| resolve_asset(asset_id))
            .collect::<Vec<_>>();
        Ok((cover, images))
    })
}

fn normalize_richpost_template(value: &str) -> &'static str {
    match value.trim() {
        "cover" => "cover",
        "text-image" => "text-image",
        "image-focus" => "image-focus",
        "quote" => "quote",
        "ending" => "ending",
        _ => "text-stack",
    }
}

fn richpost_master_name_from_template(template: &str) -> String {
    match normalize_richpost_template(template) {
        "cover" => RICHPOST_MASTER_COVER.to_string(),
        "ending" => RICHPOST_MASTER_ENDING.to_string(),
        _ => RICHPOST_MASTER_BODY.to_string(),
    }
}

fn richpost_master_role(master_name: &str, template: &str) -> &'static str {
    match sanitize_richpost_master_name(master_name).as_deref() {
        Some(RICHPOST_MASTER_COVER) => RICHPOST_MASTER_COVER,
        Some(RICHPOST_MASTER_ENDING) => RICHPOST_MASTER_ENDING,
        Some(RICHPOST_MASTER_BODY) => RICHPOST_MASTER_BODY,
        _ => match normalize_richpost_template(template) {
            "cover" => RICHPOST_MASTER_COVER,
            "ending" => RICHPOST_MASTER_ENDING,
            _ => RICHPOST_MASTER_BODY,
        },
    }
}

fn sanitize_richpost_zone_name(raw: &str) -> Option<String> {
    sanitize_richpost_master_name(raw)
}

fn richpost_page_style_overrides_for_template(template: &str) -> Value {
    let _ = template;
    Value::Object(serde_json::Map::new())
}

fn richpost_zone_assignment_value(block_ids: Vec<String>, asset_ids: Vec<String>) -> Value {
    richpost_zone_assignment_with_fragments(block_ids, asset_ids, Vec::new())
}

fn richpost_zone_assignment_with_fragments(
    block_ids: Vec<String>,
    asset_ids: Vec<String>,
    fragments: Vec<Value>,
) -> Value {
    let mut object = serde_json::Map::new();
    if !block_ids.is_empty() {
        object.insert("blockIds".to_string(), json!(block_ids));
    }
    if !asset_ids.is_empty() {
        object.insert("assetIds".to_string(), json!(asset_ids));
    }
    if !fragments.is_empty() {
        object.insert("fragments".to_string(), Value::Array(fragments));
    }
    Value::Object(object)
}

fn richpost_zone_block_ids(zones: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut items = Vec::<String>::new();
    for zone_name in [
        "title",
        "body",
        "media",
        "footer",
        "background",
        "overlay",
        "decoration",
    ] {
        if let Some(blocks) = zones
            .get(zone_name)
            .and_then(|value| value.get("blockIds"))
            .and_then(Value::as_array)
        {
            for block_id in blocks.iter().filter_map(Value::as_str) {
                if !items.iter().any(|item| item == block_id) {
                    items.push(block_id.to_string());
                }
            }
        }
        if let Some(fragments) = zones
            .get(zone_name)
            .and_then(|value| value.get("fragments"))
            .and_then(Value::as_array)
        {
            for source_block_id in fragments
                .iter()
                .filter_map(|fragment| fragment.get("sourceBlockId"))
                .filter_map(Value::as_str)
            {
                if !items.iter().any(|item| item == source_block_id) {
                    items.push(source_block_id.to_string());
                }
            }
        }
    }
    items
}

fn richpost_zone_asset_ids(zones: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut items = Vec::<String>::new();
    for zone_name in [
        "background",
        "media",
        "footer",
        "overlay",
        "decoration",
        "title",
        "body",
    ] {
        if let Some(assets) = zones
            .get(zone_name)
            .and_then(|value| value.get("assetIds"))
            .and_then(Value::as_array)
        {
            items.extend(
                assets
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string),
            );
        }
    }
    items
}

fn richpost_block_ids(blocks: &[PackageContentBlock]) -> Vec<String> {
    blocks
        .iter()
        .filter(|block| !package_block_is_page_break(&block.kind))
        .map(|block| block.id.clone())
        .collect::<Vec<_>>()
}

fn richpost_block_segments(blocks: &[PackageContentBlock]) -> Vec<Vec<PackageContentBlock>> {
    let mut segments = Vec::<Vec<PackageContentBlock>>::new();
    let mut current = Vec::<PackageContentBlock>::new();
    for block in blocks {
        if package_block_is_page_break(&block.kind) {
            if !current.is_empty() {
                segments.push(current);
                current = Vec::new();
            }
            continue;
        }
        current.push(block.clone());
    }
    if !current.is_empty() {
        segments.push(current);
    }
    segments
}

fn richpost_asset_records(
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
) -> Vec<PackageBoundAsset> {
    let mut items = Vec::<PackageBoundAsset>::new();
    if let Some(asset) = cover_asset {
        items.push(asset.clone());
    }
    items.extend(image_assets.iter().cloned());
    items
}

fn split_richpost_zone_blocks(
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    master_name: &str,
    block_ids: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut title_ids = Vec::<String>::new();
    let mut body_ids = Vec::<String>::new();
    let mut in_title = true;
    for block_id in block_ids {
        let is_heading = blocks_by_id
            .get(block_id)
            .map(|block| block.kind == "heading")
            .unwrap_or(false);
        if in_title && is_heading {
            title_ids.push(block_id.clone());
            continue;
        }
        in_title = false;
        body_ids.push(block_id.clone());
    }
    if title_ids.is_empty() && master_name == RICHPOST_MASTER_COVER {
        if let Some(first) = body_ids.first().cloned() {
            title_ids.push(first);
            body_ids.remove(0);
        }
    }
    (title_ids, body_ids)
}

fn build_default_richpost_zones(
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    master_name: &str,
    template: &str,
    block_ids: &[String],
    asset_ids: &[String],
) -> Value {
    let (title_ids, body_ids) = split_richpost_zone_blocks(blocks_by_id, master_name, block_ids);
    let mut zones = serde_json::Map::<String, Value>::new();
    if !title_ids.is_empty() {
        zones.insert(
            "title".to_string(),
            richpost_zone_assignment_value(title_ids, Vec::new()),
        );
    }
    if !body_ids.is_empty() {
        zones.insert(
            "body".to_string(),
            richpost_zone_assignment_value(body_ids, Vec::new()),
        );
    }
    if !asset_ids.is_empty() {
        let normalized_template = normalize_richpost_template(template);
        if master_name == RICHPOST_MASTER_COVER || master_name == RICHPOST_MASTER_ENDING {
            zones.insert(
                "background".to_string(),
                richpost_zone_assignment_value(Vec::new(), asset_ids.to_vec()),
            );
        } else if normalized_template == "image-focus" {
            let background_assets = vec![asset_ids[0].clone()];
            zones.insert(
                "background".to_string(),
                richpost_zone_assignment_value(Vec::new(), background_assets),
            );
            if asset_ids.len() > 1 {
                zones.insert(
                    "media".to_string(),
                    richpost_zone_assignment_value(Vec::new(), asset_ids[1..].to_vec()),
                );
            }
        } else {
            zones.insert(
                "media".to_string(),
                richpost_zone_assignment_value(Vec::new(), asset_ids.to_vec()),
            );
        }
    }
    Value::Object(zones)
}

fn normalize_richpost_style_overrides(raw: Option<&Value>, template: &str) -> Value {
    let mut normalized = richpost_page_style_overrides_for_template(template)
        .as_object()
        .cloned()
        .unwrap_or_default();
    merge_richpost_css_var_object(&mut normalized, raw);
    Value::Object(normalized)
}

fn normalize_richpost_zones(
    raw: Option<&Value>,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    master_name: &str,
    template: &str,
    legacy_block_ids: &[String],
    legacy_asset_ids: &[String],
    assigned_block_ids: &mut BTreeSet<String>,
    valid_asset_ids: &BTreeSet<String>,
) -> Value {
    let mut normalized_zones = serde_json::Map::<String, Value>::new();
    if let Some(object) = raw.and_then(Value::as_object) {
        for (zone_name, zone_value) in object {
            let Some(zone_key) = sanitize_richpost_zone_name(zone_name) else {
                continue;
            };
            let block_ids = zone_value
                .get("blockIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| blocks_by_id.contains_key(*value))
                        .filter(|value| assigned_block_ids.insert((*value).to_string()))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let asset_ids = zone_value
                .get("assetIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| valid_asset_ids.contains(*value))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let fragments = zone_value
                .get("fragments")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_object)
                        .filter_map(|fragment| {
                            let source_block_id = fragment
                                .get("sourceBlockId")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|value| blocks_by_id.contains_key(*value))?;
                            assigned_block_ids.insert(source_block_id.to_string());
                            let source_block = blocks_by_id.get(source_block_id)?;
                            let text = fragment
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|value| !value.is_empty())?;
                            Some(richpost_zone_fragment_value(
                                source_block_id,
                                fragment
                                    .get("kind")
                                    .and_then(Value::as_str)
                                    .unwrap_or(&source_block.kind),
                                fragment
                                    .get("level")
                                    .and_then(Value::as_u64)
                                    .and_then(|value| u8::try_from(value).ok())
                                    .or(source_block.level),
                                text,
                                fragment
                                    .get("continuedFromPrevious")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                fragment
                                    .get("continuesToNext")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            ))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if block_ids.is_empty() && asset_ids.is_empty() {
                if fragments.is_empty() {
                    continue;
                }
            }
            normalized_zones.insert(
                zone_key,
                richpost_zone_assignment_with_fragments(block_ids, asset_ids, fragments),
            );
        }
    }

    if normalized_zones.is_empty() {
        let fallback_block_ids = legacy_block_ids
            .iter()
            .filter(|block_id| assigned_block_ids.insert((*block_id).to_string()))
            .cloned()
            .collect::<Vec<_>>();
        return build_default_richpost_zones(
            blocks_by_id,
            master_name,
            template,
            &fallback_block_ids,
            legacy_asset_ids,
        );
    }

    Value::Object(normalized_zones)
}

fn default_richpost_page_plan(
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    source: &str,
    typography: RichpostTypographySettings,
    theme: &RichpostThemeSpec,
) -> Value {
    let segments = richpost_block_segments(blocks);
    let mut pages = Vec::<Value>::new();
    let blocks_by_id = blocks
        .iter()
        .map(|block| (block.id.clone(), block.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut available_asset_ids = Vec::<String>::new();
    if let Some(asset) = cover_asset {
        available_asset_ids.push(asset.id.clone());
    }
    available_asset_ids.extend(image_assets.iter().map(|asset| asset.id.clone()));
    let mut next_asset_index = 0usize;

    let mut total_pages_hint = segments
        .iter()
        .map(|segment| {
            richpost_default_segment_pages(segment, typography, theme, 0, 1)
                .into_iter()
                .filter(|page| !(page.title_block_ids.is_empty() && page.body_fragments.is_empty()))
                .count()
        })
        .sum::<usize>()
        .max(1);
    let mut segment_pages = Vec::<RichpostAutoPageDraft>::new();
    for _ in 0..4 {
        let mut next_pages = Vec::<RichpostAutoPageDraft>::new();
        let mut start_page_index = 0usize;
        for segment in &segments {
            let mut generated = richpost_default_segment_pages(
                segment,
                typography,
                theme,
                start_page_index,
                total_pages_hint,
            )
            .into_iter()
            .filter(|page| !(page.title_block_ids.is_empty() && page.body_fragments.is_empty()))
            .collect::<Vec<_>>();
            start_page_index += generated.len();
            next_pages.append(&mut generated);
        }
        let next_total = next_pages.len().max(1);
        segment_pages = next_pages;
        if next_total == total_pages_hint {
            break;
        }
        total_pages_hint = next_total;
    }
    let segment_page_count = segment_pages.len();
    for (page_index, page_draft) in segment_pages.into_iter().enumerate() {
        let template = "text-stack";
        let asset_ids = if next_asset_index < available_asset_ids.len() {
            let asset_id = available_asset_ids[next_asset_index].clone();
            next_asset_index += 1;
            vec![asset_id]
        } else {
            Vec::new()
        };
        let master =
            richpost_master_for_page_position(theme, page_index, segment_page_count).to_string();
        let mut page_block_ids = page_draft.title_block_ids.clone();
        for body_block_id in &page_draft.body_block_ids {
            if !page_block_ids.iter().any(|item| item == body_block_id) {
                page_block_ids.push(body_block_id.clone());
            }
        }
        for source_block_id in page_draft
            .body_fragments
            .iter()
            .filter_map(|fragment| fragment.get("sourceBlockId"))
            .filter_map(Value::as_str)
        {
            if !page_block_ids.iter().any(|item| item == source_block_id) {
                page_block_ids.push(source_block_id.to_string());
            }
        }
        let mut zones = serde_json::Map::<String, Value>::new();
        if !page_draft.title_block_ids.is_empty() {
            zones.insert(
                "title".to_string(),
                richpost_zone_assignment_value(page_draft.title_block_ids.clone(), Vec::new()),
            );
        }
        if !page_draft.body_fragments.is_empty() {
            zones.insert(
                "body".to_string(),
                richpost_zone_assignment_with_fragments(
                    Vec::new(),
                    Vec::new(),
                    page_draft.body_fragments.clone(),
                ),
            );
        } else if !page_draft.body_block_ids.is_empty() {
            zones.insert(
                "body".to_string(),
                richpost_zone_assignment_value(page_draft.body_block_ids.clone(), Vec::new()),
            );
        }
        if !asset_ids.is_empty() {
            zones.insert(
                "media".to_string(),
                richpost_zone_assignment_value(Vec::new(), asset_ids.clone()),
            );
        }
        pages.push(json!({
            "master": master,
            "template": template,
            "blockIds": page_block_ids,
            "assetIds": asset_ids.clone(),
            "zones": Value::Object(zones),
            "styleOverrides": richpost_page_style_overrides_for_template(template)
        }));
    }

    if pages.is_empty() {
        let fallback_assets = available_asset_ids
            .first()
            .cloned()
            .map(|asset_id| vec![asset_id])
            .unwrap_or_default();
        pages.push(json!({
            "master": RICHPOST_MASTER_BODY,
            "template": "text-stack",
            "blockIds": [],
            "assetIds": fallback_assets.clone(),
            "zones": build_default_richpost_zones(
                &blocks_by_id,
                RICHPOST_MASTER_BODY,
                "text-stack",
                &[],
                &fallback_assets
            ),
            "styleOverrides": richpost_page_style_overrides_for_template("text-stack")
        }));
    }

    let normalized_pages = pages
        .into_iter()
        .enumerate()
        .map(|(index, mut page)| {
            if let Some(object) = page.as_object_mut() {
                object.insert("id".to_string(), json!(format!("page-{:03}", index + 1)));
            }
            page
        })
        .collect::<Vec<_>>();

    json!({
        "version": 1,
        "title": title,
        "generatedAt": now_i64(),
        "source": source,
        "pageCount": normalized_pages.len(),
        "pages": normalized_pages
    })
}

fn normalize_richpost_page_plan(
    raw: &Value,
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    source: &str,
    typography: RichpostTypographySettings,
    theme: &RichpostThemeSpec,
) -> Value {
    let all_block_ids = richpost_block_ids(blocks);
    let blocks_by_id = blocks
        .iter()
        .filter(|block| !package_block_is_page_break(&block.kind))
        .map(|block| (block.id.clone(), block.clone()))
        .collect::<BTreeMap<_, _>>();
    let valid_asset_ids = richpost_asset_records(cover_asset, image_assets)
        .iter()
        .map(|asset| asset.id.clone())
        .collect::<BTreeSet<_>>();
    let mut assigned_block_ids = BTreeSet::<String>::new();
    let mut normalized_pages = Vec::<Value>::new();

    if let Some(pages) = raw.get("pages").and_then(Value::as_array) {
        for page in pages {
            let Some(object) = page.as_object() else {
                continue;
            };
            let template = normalize_richpost_template(
                object
                    .get("template")
                    .and_then(Value::as_str)
                    .unwrap_or("text-stack"),
            );
            let master = object
                .get("master")
                .and_then(Value::as_str)
                .and_then(sanitize_richpost_master_name)
                .unwrap_or_else(|| richpost_master_name_from_template(template));
            let legacy_block_ids = object
                .get("blockIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| blocks_by_id.contains_key(*value))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let legacy_asset_ids = object
                .get("assetIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| valid_asset_ids.contains(*value))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let zones = normalize_richpost_zones(
                object.get("zones"),
                &blocks_by_id,
                richpost_master_role(&master, template),
                template,
                &legacy_block_ids,
                &legacy_asset_ids,
                &mut assigned_block_ids,
                &valid_asset_ids,
            );
            let Some(zone_object) = zones.as_object() else {
                continue;
            };
            let block_ids = richpost_zone_block_ids(zone_object);
            let asset_ids = richpost_zone_asset_ids(zone_object);
            if block_ids.is_empty() && asset_ids.is_empty() {
                continue;
            }
            normalized_pages.push(json!({
                "master": master,
                "template": template,
                "blockIds": block_ids,
                "assetIds": asset_ids,
                "zones": zones,
                "styleOverrides": normalize_richpost_style_overrides(object.get("styleOverrides"), template)
            }));
        }
    }

    let remaining_block_ids = all_block_ids
        .into_iter()
        .filter(|block_id| !assigned_block_ids.contains(block_id))
        .collect::<Vec<_>>();
    let already_used_assets = normalized_pages
        .iter()
        .filter_map(|page| page.get("zones").and_then(Value::as_object))
        .flat_map(richpost_zone_asset_ids)
        .collect::<BTreeSet<_>>();
    let remaining_image_assets = image_assets
        .iter()
        .filter(|asset| !already_used_assets.contains(&asset.id))
        .cloned()
        .collect::<Vec<_>>();
    if !remaining_block_ids.is_empty() {
        let fallback = default_richpost_page_plan(
            title,
            &blocks
                .iter()
                .filter(|block| remaining_block_ids.contains(&block.id))
                .cloned()
                .collect::<Vec<_>>(),
            None,
            &remaining_image_assets,
            "system-overflow",
            typography,
            theme,
        );
        if let Some(pages) = fallback.get("pages").and_then(Value::as_array) {
            normalized_pages.extend(pages.iter().cloned().map(|page| {
                json!({
                    "master": page.get("master").cloned().unwrap_or_else(|| json!(RICHPOST_MASTER_BODY)),
                    "template": page.get("template").cloned().unwrap_or_else(|| json!("text-stack")),
                    "blockIds": page.get("blockIds").cloned().unwrap_or_else(|| json!([])),
                    "assetIds": page.get("assetIds").cloned().unwrap_or_else(|| json!([])),
                    "zones": page.get("zones").cloned().unwrap_or_else(|| json!({})),
                    "styleOverrides": page.get("styleOverrides").cloned().unwrap_or_else(|| json!({}))
                })
            }));
        }
    }

    if normalized_pages.is_empty() {
        return default_richpost_page_plan(
            title,
            blocks,
            cover_asset,
            image_assets,
            source,
            typography,
            theme,
        );
    }

    let pages = normalized_pages
        .into_iter()
        .enumerate()
        .map(|(index, mut page)| {
            if let Some(object) = page.as_object_mut() {
                object.insert("id".to_string(), json!(format!("page-{:03}", index + 1)));
            }
            page
        })
        .collect::<Vec<_>>();

    json!({
        "version": 1,
        "title": title,
        "generatedAt": now_i64(),
        "source": source,
        "pageCount": pages.len(),
        "pages": pages
    })
}

fn render_richpost_preview_shell(
    title: &str,
    plan: &Value,
    _package_path: &std::path::Path,
    tokens: &Value,
    typography: RichpostTypographySettings,
) -> String {
    let pages = plan
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let cards = pages
        .iter()
        .filter_map(|page| {
            let page_id = page.get("id").and_then(Value::as_str)?;
            let label = page.get("label").and_then(Value::as_str).unwrap_or(page_id);
            Some(format!(
                "<section class=\"preview-card\"><iframe title=\"{}\" src=\"./pages/{}.html?v={}\" loading=\"lazy\"></iframe></section>",
                escape_html(label),
                escape_html(page_id),
                now_i64()
            ))
        })
        .collect::<Vec<_>>()
        .join("");
    let shell_bg = richpost_token_value(tokens, "--rb-shell-bg");
    let preview_card_bg = richpost_token_value(tokens, "--rb-preview-card-bg");
    let preview_card_border = richpost_token_value(tokens, "--rb-preview-card-border");
    let preview_card_shadow = richpost_token_value(tokens, "--rb-preview-card-shadow");
    let text_color = richpost_token_value(tokens, "--rb-text");
    let muted_color = richpost_token_value(tokens, "--rb-muted");
    let heading_font = richpost_token_value(tokens, "--rb-heading-font");
    let body_font = richpost_token_value(tokens, "--rb-body-font");
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg:{};
      --card:{};
      --text:{};
      --muted:{};
      --line:{};
      --shadow:{};
      --heading-font:{};
      --body-font:{};
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font-family:var(--body-font); }}
    .shell {{ max-width: 780px; margin: 0 auto; padding: 28px 18px 48px; }}
    .pages {{ display:flex; flex-direction:column; gap:20px; }}
    .preview-card {{ padding:16px; background:var(--card); border:1px solid var(--line); box-shadow:var(--shadow); backdrop-filter: blur(10px); border-radius:0; }}
    iframe {{ display:block; width:100%; aspect-ratio:3/4; border:0; background:#fff; }}
  </style>
  <script>
    (() => {{
      const params = new URLSearchParams(window.location.search);
      const defaultFontScale = String({});
      const defaultLineHeightScale = String({});
      const rawFontScale = params.get('fontScale') || defaultFontScale;
      const rawLineHeightScale = params.get('lineHeightScale') || defaultLineHeightScale;
      document.addEventListener('DOMContentLoaded', () => {{
        document.querySelectorAll('iframe').forEach((frame) => {{
          const src = frame.getAttribute('src');
          if (!src) return;
          const nextUrl = new URL(src, window.location.href);
          nextUrl.searchParams.set('fontScale', rawFontScale);
          nextUrl.searchParams.set('lineHeightScale', rawLineHeightScale);
          frame.setAttribute('src', nextUrl.toString());
        }});
      }});
    }})();
  </script>
</head>
<body>
  <div class="shell">
    <main class="pages">{}</main>
  </div>
</body>
</html>"#,
        escape_html(title),
        shell_bg,
        preview_card_bg,
        text_color,
        muted_color,
        preview_card_border,
        preview_card_shadow,
        heading_font,
        body_font,
        typography.font_scale,
        typography.line_height_scale,
        cards
    )
}

fn persist_richpost_pages_from_plan(
    package_path: &std::path::Path,
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    plan: &Value,
) -> Result<(), String> {
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let tokens = ensure_richpost_layout_scaffold(package_path, &manifest)?;
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let pages_dir = package_richpost_pages_dir(package_path);
    fs::create_dir_all(&pages_dir).map_err(|error| error.to_string())?;
    let blocks_by_id = blocks
        .iter()
        .map(|block| (block.id.clone(), block.clone()))
        .collect::<BTreeMap<_, _>>();
    let assets_by_id = richpost_asset_records(cover_asset, image_assets)
        .into_iter()
        .map(|asset| (asset.id.clone(), asset))
        .collect::<BTreeMap<_, _>>();
    let pages = plan
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut keep_file_names = BTreeSet::<String>::new();
    for (index, page) in pages.iter().enumerate() {
        let Some(page_id) = page.get("id").and_then(Value::as_str) else {
            continue;
        };
        let html = render_richpost_page_html(
            package_path,
            &theme,
            title,
            page,
            index,
            pages.len(),
            &blocks_by_id,
            &assets_by_id,
            &tokens,
            typography,
        );
        let path = package_richpost_page_html_path(package_path, page_id);
        write_text_file(&path, &html)?;
        keep_file_names.insert(format!("{page_id}.html"));
    }
    if let Ok(entries) = fs::read_dir(&pages_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !keep_file_names.contains(&file_name) {
                let _ = fs::remove_file(path);
            }
        }
    }
    write_text_file(
        &package_layout_html_path(package_path),
        &render_richpost_preview_shell(title, plan, package_path, &tokens, typography),
    )?;
    Ok(())
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

fn asset_prompt_url(asset: &MediaAssetRecord) -> Option<String> {
    asset
        .preview_url
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            asset
                .absolute_path
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(|value| file_url_for_path(std::path::Path::new(value)))
        })
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

fn manuscript_write_proposal_by_file_path(
    store: &AppStore,
    file_path: &str,
) -> Option<ManuscriptWriteProposalRecord> {
    let normalized = normalize_relative_path(file_path);
    store
        .manuscript_write_proposals
        .iter()
        .find(|item| normalize_relative_path(&item.file_path) == normalized)
        .cloned()
}

pub(crate) fn get_manuscript_write_proposal(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Option<ManuscriptWriteProposalRecord>, String> {
    with_store(state, |store| {
        Ok(manuscript_write_proposal_by_file_path(&store, file_path))
    })
}

pub(crate) fn upsert_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    proposal: ManuscriptWriteProposalRecord,
) -> Result<ManuscriptWriteProposalRecord, String> {
    let saved = with_store_mut(state, |store| {
        let normalized = normalize_relative_path(&proposal.file_path);
        store
            .manuscript_write_proposals
            .retain(|item| normalize_relative_path(&item.file_path) != normalized);
        store.manuscript_write_proposals.push(proposal.clone());
        Ok(proposal.clone())
    })?;
    crate::events::emit_manuscript_write_proposal_changed(
        app,
        &saved.file_path,
        Some(json!(saved.clone())),
    );
    Ok(saved)
}

pub(crate) fn reject_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<bool, String> {
    let normalized = normalize_relative_path(file_path);
    let removed = with_store_mut(state, |store| {
        let before = store.manuscript_write_proposals.len();
        store
            .manuscript_write_proposals
            .retain(|item| normalize_relative_path(&item.file_path) != normalized);
        Ok(before != store.manuscript_write_proposals.len())
    })?;
    if removed {
        crate::events::emit_manuscript_write_proposal_changed(app, file_path, None);
    }
    Ok(removed)
}

pub(crate) fn accept_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    file_path: &str,
    proposed_content_override: Option<String>,
) -> Result<Value, String> {
    let proposal = get_manuscript_write_proposal(state, file_path)?
        .ok_or_else(|| "未找到待审改稿提案".to_string())?;
    let accepted_content =
        proposed_content_override.unwrap_or_else(|| proposal.proposed_content.clone());
    let saved = save_manuscript_content(
        state,
        &proposal.file_path,
        &accepted_content,
        proposal.metadata.as_ref().and_then(Value::as_object),
        "ai-proposal-accepted",
    )?;
    let _ = reject_manuscript_write_proposal(app, state, &proposal.file_path)?;
    let mut object = saved.as_object().cloned().unwrap_or_default();
    object.insert("proposalId".to_string(), json!(proposal.id));
    object.insert("filePath".to_string(), json!(proposal.file_path));
    object.insert("content".to_string(), json!(accepted_content));
    Ok(Value::Object(object))
}

fn resolve_project_media_source_path(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    source: &str,
) -> Result<(std::path::PathBuf, bool), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("当前片段缺少素材路径".to_string());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let bytes = run_curl_bytes("GET", trimmed, None, &[], None)?;
        let temp_root = store_root(state)?.join("tmp");
        fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;
        let extension = std::path::Path::new(trimmed)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("media");
        let target = temp_root.join(format!("subtitle-source-{}.{}", now_ms(), extension));
        fs::write(&target, bytes).map_err(|error| error.to_string())?;
        return Ok((target, true));
    }

    let Some(raw_path) = resolve_local_path(trimmed) else {
        return Err("当前片段的素材路径不可解析".to_string());
    };
    let mut candidates = Vec::new();
    if raw_path.is_absolute() {
        candidates.push(raw_path);
    } else {
        candidates.push(raw_path.clone());
        candidates.push(package_path.join(&raw_path));
        if let Ok(media_root_path) = media_root(state) {
            candidates.push(media_root_path.join(&raw_path));
        }
        if let Ok(workspace_root_path) = workspace_root(state) {
            candidates.push(workspace_root_path.join(&raw_path));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|path| (path, false))
        .ok_or_else(|| format!("找不到素材文件: {trimmed}"))
}

fn generate_motion_items_for_project(
    state: &State<'_, AppState>,
    project: &Value,
    instructions: &str,
    selected_item_ids: &[String],
    model_config: Option<&Value>,
) -> Result<(Vec<Value>, String), String> {
    let media_items = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.get("type").and_then(|value| value.as_str()) == Some("media"))
        .filter(|item| {
            if selected_item_ids.is_empty() {
                return true;
            }
            item.get("id")
                .and_then(|value| value.as_str())
                .map(|value| selected_item_ids.iter().any(|selected| selected == value))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    if media_items.is_empty() {
        return Err("当前工程没有可生成动画的媒体片段".to_string());
    }

    let fallback_items = media_items
        .iter()
        .enumerate()
        .map(|(index, item)| default_motion_item_from_media(item, project, index))
        .collect::<Vec<_>>();
    let user_prompt = format!(
        "请基于当前脚本和媒体片段，生成 motion item 列表。\n\
只输出 JSON，不要输出解释。\n\
结构：{{\"brief\":string,\"items\":[{{\"bindItemId\":string,\"fromMs\":number,\"durationMs\":number,\"templateId\":\"static|slow-zoom-in|slow-zoom-out|pan-left|pan-right|slide-up|slide-down\",\"props\":{{\"overlayTitle\":string|null,\"overlayBody\":string|null,\"overlays\":[{{\"id\":string,\"text\":string,\"startFrame\":number,\"durationInFrames\":number,\"position\":\"top|center|bottom\",\"animation\":\"fade-up|fade-in|slide-left|pop\",\"fontSize\":number}}]}}}}]}}\n\
要求：\n\
1. 每个 item 必须绑定现有 bindItemId。\n\
2. fromMs / durationMs 要落在绑定片段范围内或与其基本一致。\n\
3. 模板只允许 static, slow-zoom-in, slow-zoom-out, pan-left, pan-right, slide-up, slide-down。\n\
4. 适合短视频节奏，前段更强，后段更稳。\n\
5. 默认不要生成 overlayTitle、overlayBody 或 overlays；除非脚本明确要求屏幕文字、标题或字幕。\n\
\n\
脚本：{}\n\
目标片段：{}",
        instructions,
        serde_json::to_string(&media_items).map_err(|error| error.to_string())?
    );
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是当前品牌 AI 的短视频动画导演。只输出严格 JSON。",
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let normalized_items = parsed
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    normalize_motion_item(
                        item,
                        fallback_items.get(index).unwrap_or(&fallback_items[0]),
                    )
                })
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .unwrap_or(fallback_items);
    let brief = parsed
        .get("brief")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw);
    Ok((normalized_items, brief))
}

fn normalize_editor_ai_command(raw: &Value) -> Option<Value> {
    let command_type = raw.get("type").and_then(|value| value.as_str())?;
    match command_type {
        "upsert_assets" => Some(json!({
            "type": "upsert_assets",
            "assets": raw.get("assets").cloned().unwrap_or_else(|| json!([]))
        })),
        "add_track" => Some(json!({
            "type": "add_track",
            "kind": raw.get("kind").cloned().unwrap_or(json!("video")),
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null)
        })),
        "delete_tracks" => Some(json!({
            "type": "delete_tracks",
            "trackIds": raw.get("trackIds").cloned().unwrap_or_else(|| json!([]))
        })),
        "update_item" => Some(json!({
            "type": "update_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "delete_item" => Some(json!({
            "type": "delete_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null)
        })),
        "split_item" => Some(json!({
            "type": "split_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "splitMs": raw.get("splitMs").cloned().unwrap_or(json!(0))
        })),
        "move_items" => Some(json!({
            "type": "move_items",
            "itemIds": raw.get("itemIds").cloned().unwrap_or_else(|| json!([])),
            "deltaMs": raw.get("deltaMs").cloned().unwrap_or(json!(0)),
            "targetTrackId": raw.get("targetTrackId").cloned().unwrap_or(Value::Null)
        })),
        "retime_item" => Some(json!({
            "type": "retime_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "fromMs": raw.get("fromMs").cloned().unwrap_or(Value::Null),
            "durationMs": raw.get("durationMs").cloned().unwrap_or(Value::Null)
        })),
        "set_track_ui" => Some(json!({
            "type": "set_track_ui",
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "reorder_tracks" => Some(json!({
            "type": "reorder_tracks",
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null),
            "direction": raw.get("direction").cloned().unwrap_or(json!("up"))
        })),
        "update_stage_item" => Some(json!({
            "type": "update_stage_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or(Value::Null),
            "visible": raw.get("visible").cloned().unwrap_or(Value::Null),
            "locked": raw.get("locked").cloned().unwrap_or(Value::Null),
            "groupId": raw.get("groupId").cloned().unwrap_or(Value::Null)
        })),
        "animation_layer_create" => Some(json!({
            "type": "animation_layer_create",
            "layer": raw.get("layer").cloned().unwrap_or_else(|| json!({}))
        })),
        "animation_layer_update" => Some(json!({
            "type": "animation_layer_update",
            "layerId": raw.get("layerId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "animation_layer_delete" => Some(json!({
            "type": "animation_layer_delete",
            "layerId": raw.get("layerId").cloned().unwrap_or(Value::Null)
        })),
        _ => None,
    }
}

fn generate_editor_commands_for_project(
    state: &State<'_, AppState>,
    project: &Value,
    instructions: &str,
    model_config: Option<&Value>,
) -> Result<(Vec<Value>, String), String> {
    let user_prompt = format!(
        "把用户的编辑要求转换成结构化命令 JSON。\n\
只输出 JSON，不要输出解释。\n\
允许命令：add_track, delete_tracks, update_item, delete_item, split_item, move_items, retime_item, set_track_ui, reorder_tracks, update_stage_item。\n\
输出结构：{{\"brief\":string,\"commands\":[...]}}\n\
规则：\n\
1. 只能引用现有 itemId / trackId。\n\
2. 不要生成 motion item；motion 相关生成单独走 generate-motion-items。\n\
3. patch 只包含必要字段。\n\
4. 如果用户指令模糊，给出最保守的命令。\n\
\n\
当前工程 JSON：{}\n\
用户要求：{}",
        serde_json::to_string(project).map_err(|error| error.to_string())?,
        instructions
    );
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是当前品牌 AI 的视频编辑命令规划器。只输出严格 JSON。",
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let commands = parsed
        .get("commands")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_editor_ai_command)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let brief = parsed
        .get("brief")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw);
    Ok((commands, brief))
}

fn apply_editor_commands(project: &mut Value, commands: &[Value]) -> Result<(), String> {
    ensure_motion_track(project)?;
    for command in commands {
        let command_type = command
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match command_type {
            "upsert_assets" => {
                let assets = command
                    .get("assets")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let current_assets = project
                    .get_mut("assets")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project assets missing".to_string())?;
                for asset in assets {
                    let asset_id = asset
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if asset_id.is_empty() {
                        continue;
                    }
                    if let Some(existing) = current_assets.iter_mut().find(|item| {
                        item.get("id").and_then(|value| value.as_str()) == Some(asset_id)
                    }) {
                        *existing = asset.clone();
                    } else {
                        current_assets.push(asset.clone());
                    }
                }
            }
            "add_track" => {
                let kind = command
                    .get("kind")
                    .and_then(|value| value.as_str())
                    .unwrap_or("video");
                let prefix = match kind {
                    "audio" => "A",
                    "subtitle" => "S",
                    "text" => "T",
                    "motion" => "M",
                    _ => "V",
                };
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        let tracks = project
                            .get("tracks")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let max_index = tracks
                            .iter()
                            .filter_map(|track| {
                                let id = track
                                    .get("id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                if !id.starts_with(prefix) {
                                    return None;
                                }
                                id[1..].parse::<i64>().ok()
                            })
                            .max()
                            .unwrap_or(0);
                        format!("{prefix}{}", max_index + 1)
                    });
                let order = editor_project_tracks_mut(project)?.len();
                editor_project_tracks_mut(project)?.push(json!({
                    "id": track_id,
                    "kind": kind,
                    "name": track_id,
                    "order": order,
                    "ui": {
                        "hidden": false,
                        "locked": false,
                        "muted": false,
                        "solo": false,
                        "collapsed": false,
                        "volume": 1.0
                    }
                }));
            }
            "delete_tracks" => {
                let track_ids = command
                    .get("trackIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_tracks_mut(project)?.retain(|track| {
                    let track_id = track
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !track_ids.iter().any(|value| value == track_id)
                });
                editor_project_items_mut(project)?.retain(|item| {
                    let track_id = item
                        .get("trackId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !track_ids.iter().any(|value| value == track_id)
                });
                for (order, track) in editor_project_tracks_mut(project)?.iter_mut().enumerate() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("order".to_string(), json!(order));
                    }
                }
            }
            "add_item" => {
                if let Some(item) = command.get("item") {
                    editor_project_items_mut(project)?.push(item.clone());
                }
            }
            "update_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(item) = editor_project_items_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(item_id))
                {
                    if let (Some(target), Some(source)) = (item.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            "delete_item" => {
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![command.get("itemId").cloned().unwrap_or(Value::Null)]);
                let normalized = item_ids
                    .iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !normalized.iter().any(|value| value == item_id)
                });
            }
            "delete_items" => {
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !item_ids.iter().any(|value| value == item_id)
                });
            }
            "split_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let split_ms = command
                    .get("splitMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let items = editor_project_items_mut(project)?;
                let Some(index) = items.iter().position(|item| {
                    item.get("id").and_then(|value| value.as_str()) == Some(item_id)
                }) else {
                    continue;
                };
                let mut original = items[index].clone();
                let from_ms = original
                    .get("fromMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let duration_ms = original
                    .get("durationMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                if split_ms <= from_ms || split_ms >= from_ms + duration_ms {
                    continue;
                }
                let first_duration = split_ms - from_ms;
                let second_duration = duration_ms - first_duration;
                if let Some(object) = original.as_object_mut() {
                    object.insert("durationMs".to_string(), json!(first_duration));
                }
                items[index] = original;
                let mut second = items[index].clone();
                if let Some(object) = second.as_object_mut() {
                    object.insert("id".to_string(), json!(make_id("item")));
                    object.insert("fromMs".to_string(), json!(split_ms));
                    object.insert("durationMs".to_string(), json!(second_duration));
                    if let Some(trim_in_ms) =
                        object.get("trimInMs").and_then(|value| value.as_i64())
                    {
                        object.insert("trimInMs".to_string(), json!(trim_in_ms + first_duration));
                    }
                }
                items.insert(index + 1, second);
            }
            "move_items" => {
                let delta_ms = command
                    .get("deltaMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let target_track_id = command
                    .get("targetTrackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string);
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                for item in editor_project_items_mut(project)?.iter_mut() {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if !item_ids.iter().any(|value| value == item_id) {
                        continue;
                    }
                    if let Some(object) = item.as_object_mut() {
                        let from_ms = object
                            .get("fromMs")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(0);
                        object.insert("fromMs".to_string(), json!((from_ms + delta_ms).max(0)));
                        if let Some(track_id) = target_track_id.as_ref() {
                            object.insert("trackId".to_string(), json!(track_id));
                        }
                    }
                }
            }
            "retime_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if let Some(item) = editor_project_items_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(item_id))
                {
                    if let Some(object) = item.as_object_mut() {
                        if let Some(from_ms) = command.get("fromMs") {
                            object.insert("fromMs".to_string(), from_ms.clone());
                        }
                        if let Some(duration_ms) = command.get("durationMs") {
                            object.insert("durationMs".to_string(), duration_ms.clone());
                        }
                    }
                }
            }
            "set_track_ui" => {
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(track) = editor_project_tracks_mut(project)?
                    .iter_mut()
                    .find(|track| {
                        track.get("id").and_then(|value| value.as_str()) == Some(track_id)
                    })
                {
                    let current_ui = track.get("ui").cloned().unwrap_or_else(|| json!({}));
                    let mut next_ui = current_ui;
                    if let (Some(target), Some(source)) =
                        (next_ui.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                    if let Some(object) = track.as_object_mut() {
                        object.insert("ui".to_string(), next_ui);
                    }
                }
            }
            "reorder_tracks" => {
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let direction = command
                    .get("direction")
                    .and_then(|value| value.as_str())
                    .unwrap_or("up");
                let tracks = editor_project_tracks_mut(project)?;
                let Some(index) = tracks.iter().position(|track| {
                    track.get("id").and_then(|value| value.as_str()) == Some(track_id)
                }) else {
                    continue;
                };
                let target_index = if direction == "down" {
                    (index + 1).min(tracks.len().saturating_sub(1))
                } else {
                    index.saturating_sub(1)
                };
                let track = tracks.remove(index);
                tracks.insert(target_index, track);
                for (order, track) in tracks.iter_mut().enumerate() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("order".to_string(), json!(order));
                    }
                }
            }
            "update_stage_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let stage = project
                    .get_mut("stage")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| "Editor project stage missing".to_string())?;
                if let Some(transform_patch) = command.get("patch").and_then(Value::as_object) {
                    let transforms = stage
                        .entry("itemTransforms".to_string())
                        .or_insert_with(|| json!({}));
                    let entry = transforms
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemTransforms missing".to_string())?
                        .entry(item_id.to_string())
                        .or_insert_with(|| json!({}));
                    if let (Some(target), Some(source)) =
                        (entry.as_object_mut(), Some(transform_patch))
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
                if let Some(visible) = command.get("visible") {
                    stage
                        .entry("itemVisibility".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemVisibility missing".to_string())?
                        .insert(item_id.to_string(), visible.clone());
                }
                if let Some(locked) = command.get("locked") {
                    stage
                        .entry("itemLocks".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemLocks missing".to_string())?
                        .insert(item_id.to_string(), locked.clone());
                }
                if let Some(group_id) = command.get("groupId") {
                    stage
                        .entry("itemGroups".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemGroups missing".to_string())?
                        .insert(item_id.to_string(), group_id.clone());
                }
            }
            "animation_layer_create" => {
                let layer = command.get("layer").cloned().unwrap_or_else(|| json!({}));
                editor_project_animation_layers_mut(project)?.push(layer);
            }
            "animation_layer_update" => {
                let layer_id = command.get("layerId").and_then(Value::as_str).unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(layer) = editor_project_animation_layers_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(layer_id))
                {
                    if let (Some(target), Some(source)) = (layer.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            "animation_layer_delete" => {
                let layer_id = command.get("layerId").and_then(Value::as_str).unwrap_or("");
                editor_project_animation_layers_mut(project)?
                    .retain(|item| item.get("id").and_then(Value::as_str) != Some(layer_id));
            }
            _ => {}
        }
    }
    normalize_editor_project_timeline(project)?;
    Ok(())
}

fn ensure_package_asset_entry(
    package_path: &std::path::Path,
    asset: &MediaAssetRecord,
    package_kind: Option<&str>,
    label: Option<&str>,
    role: Option<&str>,
) -> Result<(), String> {
    let mut assets = read_json_value_or(&package_assets_path(package_path), json!({ "items": [] }));
    let Some(items) = assets.get_mut("items").and_then(Value::as_array_mut) else {
        return Err("Package assets items missing".to_string());
    };
    let mut next_entry = json!({
        "assetId": asset.id,
        "title": asset.title.clone(),
        "mimeType": asset.mime_type.clone(),
        "relativePath": asset.relative_path.clone(),
        "absolutePath": asset.absolute_path.clone(),
        "mediaPath": asset.absolute_path.clone().or(asset.relative_path.clone()),
        "previewUrl": asset.preview_url.clone(),
        "boundManuscriptPath": asset.bound_manuscript_path.clone(),
        "exists": asset.exists,
        "updatedAt": asset.updated_at.clone(),
    });
    if let Some(value) = package_kind
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("kind".to_string(), json!(value));
    }
    if let Some(value) = label.map(str::trim).filter(|value| !value.is_empty()) {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("label".to_string(), json!(value));
    }
    if let Some(value) = role.map(str::trim).filter(|value| !value.is_empty()) {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("role".to_string(), json!(value));
    }
    if let Some(existing) = items.iter_mut().find(|item| {
        item.get("assetId")
            .and_then(|value| value.as_str())
            .map(|value| value == asset.id)
            .unwrap_or(false)
    }) {
        *existing = next_entry;
    } else {
        items.push(next_entry);
    }
    write_json_value(&package_assets_path(package_path), &assets)?;
    let editor_project_path = package_editor_project_path(package_path);
    if editor_project_path.exists() {
        let mut editor_project = read_json_value_or(&editor_project_path, json!({}));
        if let Some(editor_assets) = editor_project
            .get_mut("assets")
            .and_then(Value::as_array_mut)
        {
            let editor_asset = json!({
                "id": asset.id,
                "kind": infer_editor_asset_kind(
                    asset.mime_type.as_deref(),
                    asset.absolute_path.as_deref().or(asset.relative_path.as_deref())
                ),
                "title": asset.title.clone().unwrap_or_else(|| asset.id.clone()),
                "src": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                "mimeType": asset.mime_type.clone(),
                "durationMs": Value::Null,
                "metadata": {
                    "relativePath": asset.relative_path.clone(),
                    "absolutePath": asset.absolute_path.clone(),
                    "previewUrl": asset.preview_url.clone(),
                    "boundManuscriptPath": asset.bound_manuscript_path.clone(),
                    "exists": asset.exists
                }
            });
            if let Some(existing) = editor_assets.iter_mut().find(|item| {
                item.get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == asset.id)
                    .unwrap_or(false)
            }) {
                *existing = editor_asset;
            } else {
                editor_assets.push(editor_asset);
            }
            write_json_value(&editor_project_path, &editor_project)?;
        }
    }
    if get_package_kind_from_manifest(package_path).as_deref() == Some("video") {
        let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
        let title = manifest
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Motion");
        let mut remotion = read_json_value_or(
            &package_remotion_path(package_path),
            build_default_remotion_scene(title, &[]),
        );
        let asset_src = asset
            .absolute_path
            .clone()
            .or(asset.relative_path.clone())
            .unwrap_or_default();
        let asset_kind = infer_editor_asset_kind(asset.mime_type.as_deref(), Some(&asset_src));
        let can_seed_base_media = matches!(asset_kind, "video" | "image");
        let has_base_media = remotion
            .pointer("/baseMedia/outputPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
        if can_seed_base_media && !has_base_media {
            if let Some(object) = remotion.as_object_mut() {
                let fallback_duration_in_frames =
                    object.get("durationInFrames").cloned().unwrap_or(json!(90));
                object.insert("version".to_string(), json!(2));
                object.insert("renderMode".to_string(), json!("full"));
                object.insert(
                    "baseMedia".to_string(),
                    json!({
                        "sourceAssetIds": [asset.id.clone()],
                        "outputPath": asset_src,
                        "durationMs": object
                            .get("baseMedia")
                            .and_then(|value| value.get("durationMs"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        "status": "ready",
                        "updatedAt": now_i64()
                    }),
                );
                let scenes = object
                    .entry("scenes".to_string())
                    .or_insert_with(|| json!([]));
                if !scenes.is_array() {
                    *scenes = json!([]);
                }
                let scenes_array = scenes
                    .as_array_mut()
                    .ok_or_else(|| "Remotion scenes must be an array".to_string())?;
                if scenes_array.is_empty() {
                    scenes_array.push(json!({
                        "id": "scene-1",
                        "clipId": Value::Null,
                        "assetId": asset.id,
                        "assetKind": asset_kind,
                        "src": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                        "startFrame": 0,
                        "durationInFrames": fallback_duration_in_frames,
                        "trimInFrames": 0,
                        "motionPreset": "static",
                        "overlayTitle": Value::Null,
                        "overlayBody": Value::Null,
                        "overlays": [],
                        "entities": []
                    }));
                } else if let Some(primary_scene) =
                    scenes_array.first_mut().and_then(Value::as_object_mut)
                {
                    let current_src = primary_scene
                        .get("src")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if current_src.is_empty() {
                        primary_scene.insert(
                            "src".to_string(),
                            json!(asset
                                .absolute_path
                                .clone()
                                .or(asset.relative_path.clone())
                                .unwrap_or_default()),
                        );
                        primary_scene.insert("assetKind".to_string(), json!(asset_kind));
                        primary_scene.insert("assetId".to_string(), json!(asset.id.clone()));
                    }
                }
            }
            persist_remotion_composition_artifacts(package_path, &remotion)?;
        }
    }
    Ok(())
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
