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
mod content_persistence;
mod download;
mod editor_ai_commands;
mod editor_commands;
mod editor_project;
mod editor_project_ffmpeg;
mod editor_project_markers;
mod editor_project_model;
mod editor_runtime_state;
mod export_helpers;
mod ffmpeg_edit;
mod layout;
mod package;
mod package_subtitles;
mod package_video;
mod post;
mod remotion;
mod remotion_context;
mod richpost;
mod richpost_artifacts;
mod richpost_model;
mod richpost_pagination;
mod richpost_plan;
mod richpost_render_model;
mod richpost_scaffold;
mod script_state;
mod subtitles;
mod timeline;
mod timeline_insertions;
mod timeline_model;
mod timeline_tracks;
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
use content_persistence::{
    generate_richpost_page_plan, package_block_is_page_break, persist_package_script_body,
    persist_richpost_page_plan,
};
pub(crate) use content_persistence::{
    save_manuscript_content, sync_manuscript_package_html_assets,
};
use editor_ai_commands::*;
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
use richpost_scaffold::{
    default_richpost_master_fragment, ensure_richpost_layout_scaffold,
    richpost_master_file_needs_upgrade, richpost_theme_root_master_path_for_theme,
    richpost_theme_spec_from_manifest, richpost_theme_spec_storage_value,
};
#[allow(unused_imports)]
pub(crate) use richpost_scaffold::{
    richpost_theme_catalog_value, richpost_theme_catalog_value_for_manifest,
    richpost_theme_state_value,
};
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
        .or_else(|| download::handle_download_channel(app, state, channel, payload))
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
