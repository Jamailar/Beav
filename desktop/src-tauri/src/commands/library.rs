use crate::commands::manuscripts::sync_manuscript_package_html_assets;
use crate::knowledge;
use crate::knowledge_index;
use crate::knowledge_index::catalog::KnowledgeCatalogSummary;
use crate::persistence::{
    ensure_store_hydrated_for_cover, ensure_store_hydrated_for_knowledge,
    ensure_store_hydrated_for_media, with_store, with_store_mut,
};
use crate::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeListPageRequest {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub kind: Option<String>,
    pub query: Option<String>,
    pub sort: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeItemDetailRequest {
    pub item_id: String,
    pub kind: String,
}

fn builtin_animation_elements() -> Vec<Value> {
    vec![json!({
        "id": "builtin:apple-drop",
        "name": "苹果落地",
        "storageKey": "builtin:apple-drop",
        "source": "builtin",
        "componentType": "apple-drop",
        "durationMs": 1000,
        "renderMode": "motion-layer",
        "props": {
            "templateId": "static",
            "overlayTitle": "苹果落地",
            "overlayBody": Value::Null,
            "overlays": []
        },
        "entities": [{
            "id": "apple",
            "type": "shape",
            "shape": "apple",
            "x": 430,
            "y": 220,
            "width": 220,
            "height": 260,
            "fill": "#d91f26",
            "animations": [{
                "id": "apple-fall",
                "kind": "fall-bounce",
                "fromFrame": 0,
                "durationInFrames": 30,
                "params": {
                    "fromY": -420,
                    "floorY": 760,
                    "bounces": 3,
                    "decay": 0.35
                }
            }]
        }]
    })]
}

fn animation_element_public_value(value: &Value) -> Value {
    json!({
        "id": value.get("id").cloned().unwrap_or(Value::Null),
        "name": value.get("name").cloned().unwrap_or_else(|| json!("未命名元素")),
        "storageKey": value.get("storageKey").cloned().unwrap_or_else(|| value.get("id").cloned().unwrap_or(Value::Null)),
        "source": value.get("source").cloned().unwrap_or_else(|| json!("workspace")),
        "componentType": value.get("componentType").cloned().unwrap_or_else(|| json!("scene-sequence")),
        "durationMs": value.get("durationMs").cloned().unwrap_or_else(|| json!(2000)),
        "renderMode": value.get("renderMode").cloned().unwrap_or_else(|| json!("motion-layer")),
        "props": value.get("props").cloned().unwrap_or_else(|| json!({})),
        "entities": value.get("entities").cloned().unwrap_or_else(|| json!([]))
    })
}

fn path_file_stem_string(path: &std::path::Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn persist_media_workspace_catalog(state: &State<'_, AppState>) -> Result<(), String> {
    let assets = with_store(state, |store| Ok(store.media_assets.clone()))?;
    write_json_value(
        &media_root(state)?.join("catalog.json"),
        &json!({
            "version": 1,
            "assets": assets,
        }),
    )
}

pub(crate) fn persist_cover_workspace_catalog(state: &State<'_, AppState>) -> Result<(), String> {
    let assets = with_store(state, |store| Ok(store.cover_assets.clone()))?;
    write_json_value(
        &cover_root(state)?.join("catalog.json"),
        &json!({
            "version": 1,
            "assets": assets,
        }),
    )
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverTemplateRecord {
    id: String,
    name: String,
    template_image_path: Option<String>,
    style_hint: String,
    title_guide: String,
    prompt_switches: Option<Value>,
    model: String,
    quality: String,
    count: i64,
    updated_at: String,
    prompt: Option<String>,
    reference_image_paths: Vec<String>,
    aspect_ratio: Option<String>,
    size: Option<String>,
    project_id: Option<String>,
    title_prefix: Option<String>,
}

fn cover_templates_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = cover_root(state)?.join("templates");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn cover_template_assets_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = cover_templates_root(state)?.join("assets");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn cover_template_catalog_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(cover_templates_root(state)?.join("catalog.json"))
}

fn read_cover_template_catalog(
    state: &State<'_, AppState>,
) -> Result<Vec<CoverTemplateRecord>, String> {
    let path = cover_template_catalog_path(state)?;
    let records = read_json_value_or(&path, json!({ "templates": [] }))
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| serde_json::from_value::<CoverTemplateRecord>(item).ok())
        .collect::<Vec<_>>();
    Ok(records)
}

fn persist_cover_template_catalog(
    state: &State<'_, AppState>,
    templates: &[CoverTemplateRecord],
) -> Result<(), String> {
    write_json_value(
        &cover_template_catalog_path(state)?,
        &json!({
            "version": 1,
            "templates": templates,
        }),
    )
}

fn relative_cover_path_from_absolute(cover_root: &Path, absolute_path: &Path) -> Option<String> {
    let normalized = normalize_legacy_workspace_path(absolute_path);
    normalized
        .strip_prefix(cover_root)
        .ok()
        .map(|value| normalize_relative_path(value.to_string_lossy().as_ref()))
}

fn cover_template_public_value(cover_root: &Path, template: &CoverTemplateRecord) -> Value {
    let reference_images = template
        .reference_image_paths
        .iter()
        .map(|rel| file_url_for_path(&cover_root.join(rel)))
        .collect::<Vec<_>>();
    let template_image = template
        .template_image_path
        .as_ref()
        .map(|rel| file_url_for_path(&cover_root.join(rel)));
    json!({
        "id": template.id,
        "name": template.name,
        "templateImage": template_image.or_else(|| reference_images.first().cloned()),
        "styleHint": template.style_hint,
        "titleGuide": template.title_guide,
        "promptSwitches": template.prompt_switches,
        "model": template.model,
        "quality": template.quality,
        "count": template.count,
        "updatedAt": template.updated_at,
        "prompt": template.prompt,
        "referenceImages": reference_images,
        "aspectRatio": template.aspect_ratio,
        "size": template.size,
        "projectId": template.project_id,
        "titlePrefix": template.title_prefix,
    })
}

fn sanitize_template_asset_label(raw: &str) -> String {
    let trimmed = raw.trim();
    let fallback = format!("template-{}", now_ms());
    if trimmed.is_empty() {
        return fallback;
    }
    let file_name = Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(trimmed);
    let normalized = normalize_relative_path(file_name);
    let stem = Path::new(&normalized)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("template");
    let cleaned = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if cleaned.is_empty() {
        fallback
    } else {
        cleaned
    }
}

fn build_cover_template_asset_path(
    asset_root: &Path,
    source_path: Option<&Path>,
    hint: &str,
) -> PathBuf {
    let extension = source_path
        .and_then(|path| path.extension().and_then(|value| value.to_str()))
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "png".to_string());
    let label = sanitize_template_asset_label(hint);
    asset_root.join(format!("{}-{}.{}", label, now_ms(), extension))
}

fn persist_cover_template_image_source(
    state: &State<'_, AppState>,
    image_source: &str,
    file_hint: &str,
) -> Result<(String, String), String> {
    let cover_root = cover_root(state)?;
    let asset_root = cover_template_assets_root(state)?;
    let trimmed = image_source.trim();
    if trimmed.is_empty() {
        return Err("缺少模板图".to_string());
    }

    if let Some(source_path) = resolve_local_path(trimmed).filter(|path| path.exists()) {
        let normalized = normalize_legacy_workspace_path(&source_path);
        if let Some(relative) = relative_cover_path_from_absolute(&cover_root, &normalized) {
            return Ok((relative, file_url_for_path(&normalized)));
        }
        let target = build_cover_template_asset_path(&asset_root, Some(&normalized), file_hint);
        fs::copy(&normalized, &target).map_err(|error| error.to_string())?;
        let relative = relative_cover_path_from_absolute(&cover_root, &target)
            .ok_or_else(|| "模板图路径无效".to_string())?;
        return Ok((relative, file_url_for_path(&target)));
    }

    let materialized = materialize_image_source(trimmed, &asset_root)?;
    let normalized = normalize_legacy_workspace_path(&materialized);
    let relative = relative_cover_path_from_absolute(&cover_root, &normalized)
        .ok_or_else(|| "模板图路径无效".to_string())?;
    Ok((relative, file_url_for_path(&normalized)))
}

fn collect_cover_template_paths(templates: &[CoverTemplateRecord]) -> HashSet<String> {
    let mut paths = HashSet::new();
    for template in templates {
        if let Some(path) = template.template_image_path.as_ref() {
            paths.insert(normalize_relative_path(path));
        }
        for path in &template.reference_image_paths {
            paths.insert(normalize_relative_path(path));
        }
    }
    paths
}

fn prune_cover_template_assets(
    state: &State<'_, AppState>,
    templates: &[CoverTemplateRecord],
) -> Result<(), String> {
    let cover_root = cover_root(state)?;
    let templates_root = cover_templates_root(state)?;
    let keep = collect_cover_template_paths(templates);

    fn walk(dir: &Path, cover_root: &Path, keep: &HashSet<String>) -> Result<(), String> {
        if !dir.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, cover_root, keep)?;
                continue;
            }
            if path.file_name().and_then(|value| value.to_str()) == Some("catalog.json") {
                continue;
            }
            let Some(relative) = relative_cover_path_from_absolute(cover_root, &path) else {
                continue;
            };
            if !keep.contains(&relative) {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    walk(&templates_root, &cover_root, &keep)
}

fn cover_template_record_from_payload(
    state: &State<'_, AppState>,
    payload: &Value,
    existing: Option<&CoverTemplateRecord>,
) -> Result<CoverTemplateRecord, String> {
    let id = payload_string(payload, "id")
        .or_else(|| existing.map(|item| item.id.clone()))
        .unwrap_or_else(|| make_id("cover-template"));
    let name = payload_string(payload, "name")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "模板名称不能为空".to_string())?;
    let template_image_path = payload_string(payload, "templateImage")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| persist_cover_template_image_source(state, &value, &name))
        .transpose()?
        .map(|(relative, _)| relative)
        .or_else(|| existing.and_then(|item| item.template_image_path.clone()));
    let reference_image_paths = payload_field(payload, "referenceImages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| persist_cover_template_image_source(state, value, &name))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .map(|items| {
            items
                .into_iter()
                .map(|(relative, _)| relative)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            existing
                .map(|item| item.reference_image_paths.clone())
                .unwrap_or_default()
        });
    let count = payload_field(payload, "count")
        .and_then(Value::as_i64)
        .or_else(|| existing.map(|item| item.count))
        .unwrap_or(1)
        .clamp(1, 4);
    Ok(CoverTemplateRecord {
        id,
        name,
        template_image_path,
        style_hint: payload_string(payload, "styleHint")
            .or_else(|| existing.map(|item| item.style_hint.clone()))
            .unwrap_or_default(),
        title_guide: payload_string(payload, "titleGuide")
            .or_else(|| existing.map(|item| item.title_guide.clone()))
            .unwrap_or_default(),
        prompt_switches: payload_field(payload, "promptSwitches")
            .cloned()
            .or_else(|| existing.and_then(|item| item.prompt_switches.clone())),
        model: payload_string(payload, "model")
            .or_else(|| existing.map(|item| item.model.clone()))
            .unwrap_or_else(|| "gpt-image-1".to_string()),
        quality: payload_string(payload, "quality")
            .or_else(|| existing.map(|item| item.quality.clone()))
            .unwrap_or_else(|| "standard".to_string()),
        count,
        updated_at: payload_string(payload, "updatedAt")
            .or_else(|| existing.map(|item| item.updated_at.clone()))
            .unwrap_or_else(now_iso),
        prompt: payload_string(payload, "prompt")
            .or_else(|| existing.and_then(|item| item.prompt.clone())),
        reference_image_paths,
        aspect_ratio: payload_string(payload, "aspectRatio")
            .or_else(|| existing.and_then(|item| item.aspect_ratio.clone())),
        size: payload_string(payload, "size")
            .or_else(|| existing.and_then(|item| item.size.clone())),
        project_id: payload_string(payload, "projectId")
            .or_else(|| existing.and_then(|item| item.project_id.clone())),
        title_prefix: payload_string(payload, "titlePrefix")
            .or_else(|| existing.and_then(|item| item.title_prefix.clone())),
    })
}

fn cover_prompt_switch_enabled(raw: Option<&Value>, key: &str, default_value: bool) -> bool {
    raw.and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default_value)
}

fn build_cover_generation_prompt(payload: &Value, titles: &[Value]) -> String {
    let title_mode = payload_string(payload, "titleMode").unwrap_or_else(|| "titles".to_string());
    let title_prompt = normalize_optional_string(payload_string(payload, "titlePrompt"));
    let style_hint = normalize_optional_string(payload_string(payload, "styleHint"));
    let title_guide = normalize_optional_string(payload_string(payload, "titleGuide"));
    let template_name = normalize_optional_string(payload_string(payload, "templateName"));
    let prompt_switches = payload_field(payload, "promptSwitches");

    let mut parts = vec![
        "你要生成一张适合中文内容平台信息流点击的封面图。".to_string(),
        "画面比例固定为 3:4，标题区域必须清晰、可读、适合直接作为封面文案。".to_string(),
        "不要出现提示词原文、排版说明、水印、AI 字样或调试文字。".to_string(),
    ];

    if let Some(name) = template_name {
        parts.push(format!("当前使用模板：{name}。"));
    }

    if title_mode == "prompt" {
        parts.push("标题生成方式：用户不直接给标题，你需要先判断最适合写在封面上的主标题、副标题、角标或标签词，再把它们自然排进画面。".to_string());
        if let Some(prompt) = title_prompt {
            parts.push(format!("用户给你的标题方向与要求：{prompt}"));
            parts.push(
                "不要整段照抄上面的说明，要提炼成短句、强记忆点、适合封面点击的中文文案。"
                    .to_string(),
            );
        }
    } else {
        let normalized_titles = titles
            .iter()
            .filter_map(|item| {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())?;
                let label = item
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("main");
                Some(format!("{label}：{text}"))
            })
            .collect::<Vec<_>>();
        if !normalized_titles.is_empty() {
            parts.push(format!(
                "标题生成方式：优先使用并忠实体现以下标题组，不要随意偏离核心信息。{}",
                normalized_titles.join(" / ")
            ));
        }
    }

    if let Some(guide) = title_guide {
        parts.push(format!("标题风格参考：{guide}"));
    }
    if let Some(style) = style_hint {
        parts.push(format!("模板风格参考：{style}"));
    }

    let mut switch_notes: Vec<&str> = Vec::new();
    if cover_prompt_switch_enabled(prompt_switches, "learnTypography", true) {
        switch_notes.push("尽量学习模板图的标题字体、字重、描边、阴影和排版节奏");
    }
    if cover_prompt_switch_enabled(prompt_switches, "learnColorMood", true) {
        switch_notes.push("尽量学习模板图的主辅色与整体色彩氛围");
    }
    if cover_prompt_switch_enabled(prompt_switches, "beautifyFace", false) {
        switch_notes.push("人物允许轻度自然美颜，但不能失真");
    }
    if cover_prompt_switch_enabled(prompt_switches, "replaceBackground", false) {
        switch_notes.push("允许在不破坏主体的前提下重绘或替换背景");
    }
    if !switch_notes.is_empty() {
        parts.push(format!("额外生成约束：{}。", switch_notes.join("；")));
    }

    parts.join("\n")
}

fn summary_to_legacy_note(summary: &KnowledgeCatalogSummary) -> Value {
    json!({
        "id": summary.item_id,
        "type": summary.note_type,
        "sourceUrl": summary.source_url,
        "title": summary.title,
        "author": summary.author,
        "content": "",
        "excerpt": summary.preview_text,
        "siteName": summary.site_name,
        "captureKind": summary.capture_kind,
        "htmlFile": Value::Null,
        "htmlFileUrl": Value::Null,
        "images": [],
        "tags": summary.tags,
        "cover": summary.cover_url,
        "video": if summary.has_video { summary.cover_url.clone() } else { None },
        "videoUrl": Value::Null,
        "transcript": Value::Null,
        "transcriptionStatus": summary.status,
        "stats": { "likes": 0, "collects": Value::Null },
        "createdAt": summary.created_at,
        "folderPath": summary.folder_path,
    })
}

fn summary_to_legacy_video(summary: &KnowledgeCatalogSummary) -> Value {
    json!({
        "id": summary.item_id,
        "videoId": summary.item_id,
        "videoUrl": summary.source_url,
        "title": summary.title,
        "originalTitle": Value::Null,
        "description": summary.preview_text,
        "summary": summary.preview_text,
        "thumbnailUrl": summary.thumbnail_url,
        "hasSubtitle": summary.has_transcript,
        "subtitleContent": Value::Null,
        "status": summary.status,
        "createdAt": summary.created_at,
        "folderPath": summary.folder_path,
    })
}

fn summary_to_legacy_doc(summary: &KnowledgeCatalogSummary) -> Value {
    json!({
        "id": summary.item_id,
        "kind": "tracked-folder",
        "name": summary.title,
        "rootPath": summary.root_path,
        "locked": false,
        "indexing": summary.status.as_deref() == Some("indexing"),
        "indexError": Value::Null,
        "fileCount": summary.file_count,
        "sampleFiles": summary.sample_files,
        "createdAt": summary.created_at,
        "updatedAt": summary.updated_at,
    })
}

fn load_note_detail(state: &State<'_, AppState>, item_id: &str) -> Result<Value, String> {
    let root = knowledge_root(state)?;
    let items = load_knowledge_notes_from_fs(&root);
    let item = items
        .into_iter()
        .find(|entry| entry.id == item_id)
        .ok_or_else(|| "未找到知识笔记".to_string())?;
    serde_json::to_value(item).map_err(|error| error.to_string())
}

fn load_youtube_detail(state: &State<'_, AppState>, item_id: &str) -> Result<Value, String> {
    let root = knowledge_root(state)?;
    let items = load_youtube_videos_from_fs(&root);
    let item = items
        .into_iter()
        .find(|entry| entry.id == item_id)
        .ok_or_else(|| "未找到 YouTube 视频".to_string())?;
    serde_json::to_value(item).map_err(|error| error.to_string())
}

fn load_document_source_detail(
    state: &State<'_, AppState>,
    item_id: &str,
) -> Result<Value, String> {
    let root = knowledge_root(state)?;
    let items = load_document_sources_from_fs(&root);
    let item = items
        .into_iter()
        .find(|entry| entry.id == item_id)
        .ok_or_else(|| "未找到文档源".to_string())?;
    serde_json::to_value(item).map_err(|error| error.to_string())
}

pub(crate) fn knowledge_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let page =
        knowledge_index::catalog::list_page(state, None, 200, Some("redbook-note"), None, None)?;
    Ok(Value::Array(
        page.items
            .iter()
            .map(summary_to_legacy_note)
            .collect::<Vec<_>>(),
    ))
}

pub(crate) fn knowledge_list_youtube_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let page =
        knowledge_index::catalog::list_page(state, None, 200, Some("youtube-video"), None, None)?;
    Ok(Value::Array(
        page.items
            .iter()
            .map(summary_to_legacy_video)
            .collect::<Vec<_>>(),
    ))
}

pub(crate) fn knowledge_docs_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let page =
        knowledge_index::catalog::list_page(state, None, 200, Some("document-source"), None, None)?;
    Ok(Value::Array(
        page.items
            .iter()
            .map(summary_to_legacy_doc)
            .collect::<Vec<_>>(),
    ))
}

pub(crate) fn knowledge_list_page_value(
    state: &State<'_, AppState>,
    payload: &KnowledgeListPageRequest,
) -> Result<Value, String> {
    let page = knowledge_index::catalog::list_page(
        state,
        payload.cursor.as_deref(),
        payload.limit.unwrap_or(60),
        payload.kind.as_deref(),
        payload.query.as_deref(),
        payload.sort.as_deref(),
    )?;
    serde_json::to_value(page).map_err(|error| error.to_string())
}

pub(crate) fn knowledge_get_item_detail_value(
    state: &State<'_, AppState>,
    payload: &KnowledgeItemDetailRequest,
) -> Result<Value, String> {
    match payload.kind.as_str() {
        "redbook-note" => load_note_detail(state, &payload.item_id),
        "youtube-video" => load_youtube_detail(state, &payload.item_id),
        "document-source" => load_document_source_detail(state, &payload.item_id),
        other => Err(format!("未知知识项类型: {other}")),
    }
}

pub(crate) fn knowledge_get_index_status_value(
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    serde_json::to_value(knowledge_index::index_status(state)?).map_err(|error| error.to_string())
}

pub(crate) fn knowledge_glob_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    crate::tools::knowledge_search::execute_glob(state, None, payload)
}

pub(crate) fn knowledge_grep_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    crate::tools::knowledge_search::execute_grep(state, None, payload)
}

pub(crate) fn knowledge_read_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    crate::tools::knowledge_search::execute_read(state, None, payload)
}

#[tauri::command]
pub async fn knowledge_list(state: State<'_, AppState>) -> Result<Value, String> {
    knowledge_list_value(&state)
}

#[tauri::command]
pub async fn knowledge_list_youtube(state: State<'_, AppState>) -> Result<Value, String> {
    knowledge_list_youtube_value(&state)
}

#[tauri::command]
pub async fn knowledge_docs_list(state: State<'_, AppState>) -> Result<Value, String> {
    knowledge_docs_list_value(&state)
}

#[tauri::command]
pub async fn knowledge_list_page(
    state: State<'_, AppState>,
    payload: KnowledgeListPageRequest,
) -> Result<Value, String> {
    knowledge_list_page_value(&state, &payload)
}

#[tauri::command]
pub async fn knowledge_get_item_detail(
    state: State<'_, AppState>,
    payload: KnowledgeItemDetailRequest,
) -> Result<Value, String> {
    knowledge_get_item_detail_value(&state, &payload)
}

#[tauri::command]
pub async fn knowledge_get_index_status(state: State<'_, AppState>) -> Result<Value, String> {
    knowledge_get_index_status_value(&state)
}

#[tauri::command]
pub async fn knowledge_rebuild_catalog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _ = knowledge_index::jobs::ensure_catalog_ready_async(&app, &state, "manual-rebuild");
    knowledge_index::jobs::schedule_rebuild(&app, "manual-rebuild");
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn knowledge_open_index_root(state: State<'_, AppState>) -> Result<Value, String> {
    let root = knowledge_index::catalog_root(&state)?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    open::that(&root).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "path": root.display().to_string() }))
}

pub fn handle_library_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "knowledge:list"
            | "knowledge:list-youtube"
            | "knowledge:docs:list"
            | "knowledge:glob"
            | "knowledge:grep"
            | "knowledge:read"
            | "knowledge:list-page"
            | "knowledge:get-item-detail"
            | "knowledge:get-index-status"
            | "knowledge:rebuild-catalog"
            | "knowledge:open-index-root"
            | "knowledge:health"
            | "knowledge:ingest-entry"
            | "knowledge:ingest-document-source"
            | "knowledge:ingest-media-assets"
            | "knowledge:batch-ingest"
            | "knowledge:delete-youtube"
            | "knowledge:retry-youtube-subtitle"
            | "knowledge:youtube-regenerate-summaries"
            | "knowledge:read-youtube-subtitle"
            | "knowledge:delete"
            | "knowledge:transcribe"
            | "knowledge:docs:add-files"
            | "knowledge:docs:add-folder"
            | "knowledge:docs:add-obsidian-vault"
            | "knowledge:docs:delete-source"
            | "media:list"
            | "media:open-root"
            | "media:open"
            | "media:update"
            | "media:bind"
            | "media:delete"
            | "media:import-files"
            | "animation-elements:list"
            | "animation-elements:open-root"
            | "animation-elements:save"
            | "animation-elements:delete"
            | "cover:list"
            | "cover:open-root"
            | "cover:open"
            | "cover:templates:list"
            | "cover:templates:save"
            | "cover:templates:delete"
            | "cover:templates:import-legacy"
            | "cover:save-template-image"
            | "cover:generate"
    ) {
        return None;
    }
    Some((|| -> Result<Value, String> {
        match channel {
            "knowledge:list" => knowledge_list_value(state),
            "knowledge:list-youtube" => knowledge_list_youtube_value(state),
            "knowledge:docs:list" => knowledge_docs_list_value(state),
            "knowledge:glob" => knowledge_glob_value(state, payload),
            "knowledge:grep" => knowledge_grep_value(state, payload),
            "knowledge:read" => knowledge_read_value(state, payload),
            "knowledge:list-page" => {
                let request: KnowledgeListPageRequest = serde_json::from_value(payload.clone())
                    .map_err(|error| format!("knowledge list page payload 无效: {error}"))?;
                knowledge_list_page_value(state, &request)
            }
            "knowledge:get-item-detail" => {
                let request: KnowledgeItemDetailRequest =
                    serde_json::from_value(payload.clone())
                        .map_err(|error| format!("knowledge detail payload 无效: {error}"))?;
                knowledge_get_item_detail_value(state, &request)
            }
            "knowledge:get-index-status" => knowledge_get_index_status_value(state),
            "knowledge:rebuild-catalog" => {
                let _ =
                    knowledge_index::jobs::ensure_catalog_ready_async(app, state, "manual-rebuild");
                knowledge_index::jobs::schedule_rebuild(app, "manual-rebuild");
                Ok(json!({ "success": true }))
            }
            "knowledge:open-index-root" => {
                let root = knowledge_index::catalog_root(state)?;
                std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
                open::that(&root).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": root.display().to_string() }))
            }
            "knowledge:health" => knowledge::knowledge_http_health(
                state,
                knowledge::knowledge_http_body_limit(),
                knowledge::knowledge_http_batch_limit(),
            ),
            "knowledge:ingest-entry" => {
                let request: knowledge::KnowledgeEntryIngestRequest =
                    serde_json::from_value(payload.clone())
                        .map_err(|error| format!("knowledge ingest entry payload 无效: {error}"))?;
                knowledge::ingest_entry(Some(app), state, &request)
            }
            "knowledge:ingest-document-source" => {
                let request: knowledge::KnowledgeDocumentSourceIngestRequest =
                    serde_json::from_value(payload.clone()).map_err(|error| {
                        format!("knowledge ingest document source payload 无效: {error}")
                    })?;
                knowledge::ingest_document_source(Some(app), state, &request)
            }
            "knowledge:ingest-media-assets" => {
                let request: knowledge::KnowledgeMediaAssetIngestRequest =
                    serde_json::from_value(payload.clone()).map_err(|error| {
                        format!("knowledge ingest media assets payload 无效: {error}")
                    })?;
                knowledge::ingest_media_assets(Some(app), state, &request)
            }
            "knowledge:batch-ingest" => {
                let request: knowledge::KnowledgeBatchIngestRequest =
                    serde_json::from_value(payload.clone())
                        .map_err(|error| format!("knowledge batch ingest payload 无效: {error}"))?;
                knowledge::batch_ingest(Some(app), state, &request)
            }
            "knowledge:delete-youtube" => {
                let video_id = payload_value_as_string(payload).unwrap_or_default();
                knowledge::delete_youtube_note(app, state, &video_id)
            }
            "knowledge:retry-youtube-subtitle" => {
                let video_id = payload_value_as_string(payload).unwrap_or_default();
                knowledge::retry_youtube_subtitle(app, state, &video_id)
            }
            "knowledge:youtube-regenerate-summaries" => {
                let _ = ensure_store_hydrated_for_knowledge(state);
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let candidates = with_store(state, |store| {
                    Ok(store
                        .youtube_videos
                        .iter()
                        .filter(|item| {
                            item.has_subtitle
                                && item.summary.as_deref().unwrap_or("").trim().is_empty()
                        })
                        .map(|item| {
                            (
                                item.id.clone(),
                                item.title.clone(),
                                item.subtitle_content.clone().unwrap_or_default(),
                            )
                        })
                        .collect::<Vec<_>>())
                })?;
                let mut updates = Vec::new();
                for (video_id, title, subtitle) in &candidates {
                    if subtitle.trim().is_empty() {
                        continue;
                    }
                    let prompt = format!(
                        "请基于下面的视频字幕，输出一段中文摘要，控制在 120 字以内。\n\n标题：{}\n\n字幕：\n{}",
                        title, subtitle
                    );
                    let summary =
                        run_model_text_task_with_settings(&settings_snapshot, None, &prompt)?;
                    updates.push((video_id.clone(), summary));
                }
                let updated_count = updates.len();
                knowledge::save_youtube_summaries(state, &updates)?;
                Ok(json!({ "success": true, "updated": updated_count }))
            }
            "knowledge:read-youtube-subtitle" => {
                let id = payload_value_as_string(payload).unwrap_or_default();
                let _ = ensure_store_hydrated_for_knowledge(state);
                with_store(state, |store| {
                    let content = store
                        .youtube_videos
                        .iter()
                        .find(|item| item.id == id || item.video_id == id)
                        .and_then(|item| item.subtitle_content.clone())
                        .unwrap_or_default();
                    Ok(json!(content))
                })
            }
            "knowledge:delete" => {
                let note_id = payload_value_as_string(payload).unwrap_or_default();
                knowledge::delete_note(app, state, &note_id)
            }
            "knowledge:transcribe" => {
                let note_id = payload_value_as_string(payload).unwrap_or_default();
                let _ = ensure_store_hydrated_for_knowledge(state);
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let note_snapshot = with_store(state, |store| {
                    Ok(store
                        .knowledge_notes
                        .iter()
                        .find(|item| item.id == note_id)
                        .cloned())
                })?;
                let Some(note_snapshot) = note_snapshot else {
                    return Ok(json!({ "success": false, "error": "笔记不存在" }));
                };
                let transcript = if let Some(video_source) = note_snapshot
                    .video
                    .clone()
                    .or(note_snapshot.video_url.clone())
                    .filter(|item| !item.trim().is_empty())
                {
                    if let Some((endpoint, api_key, model_name)) =
                        resolve_transcription_settings(&settings_snapshot)
                    {
                        let temp_dir = store_root(state)?.join("tmp");
                        fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
                        let target_path = temp_dir.join(format!("knowledge-{}-media", note_id));
                        let source_path = resolve_local_path(&video_source);
                        let mime_type = if video_source.ends_with(".mp3")
                            || video_source.ends_with(".wav")
                            || video_source.ends_with(".m4a")
                        {
                            "audio/*"
                        } else {
                            "video/*"
                        };
                        let local_media_path = if let Some(path) =
                            source_path.filter(|path| path.exists())
                        {
                            path
                        } else {
                            let bytes = run_curl_bytes("GET", &video_source, None, &[], None)?;
                            fs::write(&target_path, bytes).map_err(|error| error.to_string())?;
                            target_path.clone()
                        };
                        run_curl_transcription(
                            &endpoint,
                            api_key.as_deref(),
                            &model_name,
                            &local_media_path,
                            mime_type,
                        )
                        .unwrap_or_else(|_| {
                            format!(
                                "RedBox transcript fallback\n\n标题：{}\n\n{}",
                                note_snapshot.title,
                                note_snapshot.content.chars().take(240).collect::<String>()
                            )
                        })
                    } else {
                        format!(
                            "RedBox transcript fallback\n\n标题：{}\n\n{}",
                            note_snapshot.title,
                            note_snapshot.content.chars().take(240).collect::<String>()
                        )
                    }
                } else {
                    format!(
                        "RedBox transcript fallback\n\n标题：{}\n\n{}",
                        note_snapshot.title,
                        note_snapshot.content.chars().take(240).collect::<String>()
                    )
                };
                knowledge::persist_note_transcript(app, state, &note_id, &transcript)
            }
            "knowledge:docs:add-files"
            | "knowledge:docs:add-folder"
            | "knowledge:docs:add-obsidian-vault" => {
                let (kind, title) = match channel {
                    "knowledge:docs:add-files" => ("copied-file", "Imported Files"),
                    "knowledge:docs:add-folder" => ("tracked-folder", "Tracked Folder"),
                    _ => ("obsidian-vault", "Obsidian Vault"),
                };

                let root = if channel == "knowledge:docs:add-files" {
                    let selected = pick_files_native("选择要导入的文档文件", false, true)?;
                    if selected.is_empty() {
                        return Ok(json!({ "success": false, "error": "未选择文件" }));
                    }
                    let display_name = format!(
                        "{} · {}",
                        title,
                        with_store(state, |store| Ok(store.active_space_id.clone()))?
                    );
                    return knowledge::import_document_files(app, state, &selected, &display_name);
                } else {
                    let selected = pick_files_native(
                        if channel == "knowledge:docs:add-folder" {
                            "选择要追踪的文件夹"
                        } else {
                            "选择 Obsidian Vault 文件夹"
                        },
                        true,
                        false,
                    )?;
                    if let Some(folder) = selected.into_iter().next() {
                        folder
                    } else {
                        return Ok(json!({ "success": false, "error": "未选择文件夹" }));
                    }
                };
                if !root.exists() {
                    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
                }
                let fallback_name = root
                    .file_name()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(title)
                    .to_string();
                let display_name = format!(
                    "{} · {}",
                    fallback_name,
                    with_store(state, |store| Ok(store.active_space_id.clone()))?
                );
                knowledge::add_document_source(
                    app,
                    state,
                    kind,
                    &root,
                    &display_name,
                    kind != "tracked-folder",
                )
            }
            "knowledge:docs:delete-source" => {
                let source_id = payload_value_as_string(payload).unwrap_or_default();
                knowledge::delete_document_source(app, state, &source_id)
            }
            "media:list" => {
                let _ = ensure_store_hydrated_for_media(state);
                with_store(state, |store| {
                    let mut assets = store.media_assets.clone();
                    assets.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                    Ok(json!({ "success": true, "assets": assets }))
                })
            }
            "media:open-root" => {
                let root = media_root(state)?;
                open::that(&root).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": root.display().to_string() }))
            }
            "media:open" => {
                let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                let asset = with_store(state, |store| {
                    Ok(store
                        .media_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                };
                let relative_media_path = asset.relative_path.clone().and_then(|rel| {
                    media_root(state)
                        .ok()
                        .map(|root| root.join(rel).display().to_string())
                });
                if let Some(path) = asset.absolute_path.clone().or(relative_media_path) {
                    open::that(&path).map_err(|error| error.to_string())?;
                    return Ok(json!({ "success": true, "path": path }));
                }
                Ok(json!({ "success": false, "error": "媒体资产没有可打开的文件路径" }))
            }
            "media:update" => {
                let result = with_store_mut(state, |store| {
                    let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                    let Some(asset) = store
                        .media_assets
                        .iter_mut()
                        .find(|item| item.id == asset_id)
                    else {
                        return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                    };
                    asset.title = normalize_optional_string(payload_string(payload, "title"));
                    asset.project_id =
                        normalize_optional_string(payload_string(payload, "projectId"));
                    asset.prompt = normalize_optional_string(payload_string(payload, "prompt"));
                    asset.updated_at = now_rfc3339();
                    Ok(json!({ "success": true, "asset": asset.clone() }))
                })?;
                persist_media_workspace_catalog(state)?;
                Ok(result)
            }
            "media:bind" => {
                let manuscript_path =
                    normalize_optional_string(payload_string(payload, "manuscriptPath"));
                let role = payload_string(payload, "role")
                    .map(|value| value.trim().to_ascii_lowercase())
                    .filter(|value| !value.is_empty());
                let result = with_store_mut(state, |store| {
                    let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                    let Some(asset) = store
                        .media_assets
                        .iter_mut()
                        .find(|item| item.id == asset_id)
                    else {
                        return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                    };
                    asset.bound_manuscript_path = manuscript_path.clone();
                    asset.updated_at = now_rfc3339();
                    Ok(json!({ "success": true, "asset": asset.clone() }))
                })?;
                persist_media_workspace_catalog(state)?;
                if result.get("success").and_then(Value::as_bool) == Some(true) {
                    if let (Some(file_path), Some(role)) =
                        (manuscript_path.as_deref(), role.as_deref())
                    {
                        let full_path = resolve_manuscript_path(state, file_path)?;
                        if full_path.is_dir()
                            && is_manuscript_package_name(
                                full_path
                                    .file_name()
                                    .and_then(|value| value.to_str())
                                    .unwrap_or(""),
                            )
                            && matches!(role, "cover" | "image")
                        {
                            let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                            if role == "cover" {
                                write_json_value(
                                    &package_cover_path(&full_path),
                                    &json!({ "assetId": asset_id }),
                                )?;
                            } else {
                                let mut images = read_json_value_or(
                                    &package_images_path(&full_path),
                                    json!({ "items": [] }),
                                );
                                let items = images
                                    .as_object_mut()
                                    .and_then(|object| object.get_mut("items"))
                                    .and_then(Value::as_array_mut)
                                    .ok_or_else(|| "工程配图列表损坏".to_string())?;
                                let exists = items.iter().any(|item| {
                                    item.get("assetId").and_then(Value::as_str)
                                        == Some(asset_id.as_str())
                                });
                                if !exists {
                                    items.push(json!({ "assetId": asset_id }));
                                }
                                write_json_value(&package_images_path(&full_path), &images)?;
                            }
                            let file_name = full_path
                                .file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or("Untitled");
                            let rendered_state =
                                if get_package_kind_from_file_name(file_name) == Some("post") {
                                    sync_manuscript_package_html_assets(
                                        Some(state),
                                        &full_path,
                                        file_name,
                                        None,
                                        None,
                                    )?
                                } else {
                                    get_manuscript_package_state(&full_path)?
                                };
                            return Ok(json!({
                                "success": true,
                                "asset": result.get("asset").cloned().unwrap_or(Value::Null),
                                "state": rendered_state
                            }));
                        }
                    }
                }
                Ok(result)
            }
            "media:delete" => {
                let result = with_store_mut(state, |store| {
                    let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                    let before = store.media_assets.len();
                    store.media_assets.retain(|item| item.id != asset_id);
                    if before == store.media_assets.len() {
                        return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                    }
                    Ok(json!({ "success": true }))
                })?;
                persist_media_workspace_catalog(state)?;
                Ok(result)
            }
            "media:import-files" => {
                let selected = pick_files_native("选择要导入媒体库的文件", false, true)?;
                if selected.is_empty() {
                    return Ok(json!({ "success": false, "error": "未选择文件" }));
                }
                let imports_root = media_root(state)?.join("imports");
                fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
                let imported = with_store_mut(state, |store| {
                    let mut assets = Vec::new();
                    for file in &selected {
                        let (relative_name, target) = copy_file_into_dir(file, &imports_root)?;
                        let (mime_type, _kind, _) = guess_mime_and_kind(&target);
                        let asset = MediaAssetRecord {
                            id: make_id("media"),
                            source: "imported".to_string(),
                            source_domain: None,
                            source_link: None,
                            project_id: None,
                            title: file
                                .file_stem()
                                .and_then(|value| value.to_str())
                                .map(ToString::to_string),
                            prompt: None,
                            provider: None,
                            provider_template: None,
                            model: None,
                            aspect_ratio: None,
                            size: None,
                            quality: None,
                            mime_type: Some(mime_type),
                            relative_path: Some(format!("imports/{}", relative_name)),
                            bound_manuscript_path: None,
                            created_at: now_rfc3339(),
                            updated_at: now_rfc3339(),
                            absolute_path: Some(target.display().to_string()),
                            preview_url: Some(file_url_for_path(&target)),
                            exists: true,
                        };
                        store.media_assets.push(asset.clone());
                        assets.push(asset);
                    }
                    Ok(assets)
                })?;
                persist_media_workspace_catalog(state)?;
                Ok(json!({ "success": true, "assets": imported, "imported": imported.len() }))
            }
            "animation-elements:list" => {
                let root = remotion_elements_root(state)?;
                let mut items = builtin_animation_elements();
                if let Ok(entries) = fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if !path.is_file()
                            || path.extension().and_then(|value| value.to_str()) != Some("json")
                        {
                            continue;
                        }
                        if let Ok(raw) = fs::read_to_string(&path) {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                                items.push(animation_element_public_value(&parsed));
                            }
                        }
                    }
                }
                Ok(json!({ "success": true, "items": items }))
            }
            "animation-elements:open-root" => {
                let root = remotion_elements_root(state)?;
                open::that(&root).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": root.display().to_string() }))
            }
            "animation-elements:save" => {
                let root = remotion_elements_root(state)?;
                let name =
                    payload_string(payload, "name").unwrap_or_else(|| "未命名动画元素".to_string());
                let layer = payload.get("layer").cloned().unwrap_or_else(|| json!({}));
                let entities = layer
                    .get("entities")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let has_non_text_entity = entities.iter().any(|entity| {
                    entity
                        .get("type")
                        .and_then(Value::as_str)
                        .map(|value| value != "text")
                        .unwrap_or(false)
                });
                if !has_non_text_entity {
                    return Ok(
                        json!({ "success": false, "error": "纯文字动画不应保存到共享动画元素库" }),
                    );
                }
                let file_name = format!("{}.json", slug_from_relative_path(&name));
                let file_path = root.join(file_name);
                let saved = json!({
                    "id": payload_string(&layer, "id").unwrap_or_else(|| make_id("animation-element")),
                    "name": name,
                    "storageKey": path_file_stem_string(&file_path),
                    "source": "workspace",
                    "componentType": layer.get("componentType").cloned().unwrap_or_else(|| json!("scene-sequence")),
                    "durationMs": layer.get("durationMs").cloned().unwrap_or_else(|| json!(2000)),
                    "renderMode": layer.get("renderMode").cloned().unwrap_or_else(|| json!("motion-layer")),
                    "props": layer.get("props").cloned().unwrap_or_else(|| json!({})),
                    "entities": layer.get("entities").cloned().unwrap_or_else(|| json!([]))
                });
                write_json_value(&file_path, &saved)?;
                Ok(
                    json!({ "success": true, "item": animation_element_public_value(&saved), "path": file_path.display().to_string() }),
                )
            }
            "animation-elements:delete" => {
                let root = remotion_elements_root(state)?;
                let storage_key = payload_string(payload, "storageKey")
                    .or_else(|| payload_value_as_string(payload))
                    .unwrap_or_default();
                if storage_key.starts_with("builtin:") {
                    return Ok(json!({ "success": false, "error": "内置元素不能删除" }));
                }
                let file_name = format!("{}.json", slug_from_relative_path(&storage_key));
                let file_path = root.join(file_name);
                if !file_path.exists() {
                    return Ok(json!({ "success": false, "error": "元素不存在" }));
                }
                fs::remove_file(&file_path).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true }))
            }
            "cover:list" => {
                let _ = ensure_store_hydrated_for_cover(state);
                with_store(state, |store| {
                    let mut assets = store.cover_assets.clone();
                    assets.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!({ "success": true, "assets": assets }))
                })
            }
            "cover:open-root" => {
                let root = cover_root(state)?;
                open::that(&root).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": root.display().to_string() }))
            }
            "cover:open" => {
                let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                let asset = with_store(state, |store| {
                    Ok(store
                        .cover_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "封面资产不存在" }));
                };
                let relative_cover_path = asset.relative_path.clone().and_then(|rel| {
                    cover_root(state)
                        .ok()
                        .map(|root| root.join(rel).display().to_string())
                });
                if let Some(path) = relative_cover_path.or_else(|| asset.preview_url.clone()) {
                    open::that(&path).map_err(|error| error.to_string())?;
                    return Ok(json!({ "success": true, "path": path }));
                }
                Ok(json!({ "success": false, "error": "封面资产没有可打开的路径" }))
            }
            "cover:templates:list" => {
                let cover_root = cover_root(state)?;
                let mut templates = read_cover_template_catalog(state)?
                    .into_iter()
                    .map(|item| cover_template_public_value(&cover_root, &item))
                    .collect::<Vec<_>>();
                templates.sort_by(|a, b| {
                    let left = b
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let right = a
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    left.cmp(right)
                });
                Ok(json!({ "success": true, "templates": templates }))
            }
            "cover:templates:save" => {
                let template_payload = payload_field(payload, "template").unwrap_or(payload);
                let mut templates = read_cover_template_catalog(state)?;
                let existing_index = payload_string(template_payload, "id")
                    .and_then(|id| templates.iter().position(|item| item.id == id));
                let existing = existing_index.and_then(|index| templates.get(index));
                let saved = cover_template_record_from_payload(state, template_payload, existing)?;
                if let Some(index) = existing_index {
                    templates[index] = saved.clone();
                } else {
                    templates.push(saved.clone());
                }
                templates.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                persist_cover_template_catalog(state, &templates)?;
                prune_cover_template_assets(state, &templates)?;
                let cover_root = cover_root(state)?;
                Ok(json!({
                    "success": true,
                    "template": cover_template_public_value(&cover_root, &saved),
                    "templates": templates
                        .iter()
                        .map(|item| cover_template_public_value(&cover_root, item))
                        .collect::<Vec<_>>(),
                }))
            }
            "cover:templates:delete" => {
                let template_id = payload_string(payload, "templateId").unwrap_or_default();
                if template_id.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少模板 id" }));
                }
                let mut templates = read_cover_template_catalog(state)?;
                let before = templates.len();
                templates.retain(|item| item.id != template_id);
                if templates.len() == before {
                    return Ok(json!({ "success": false, "error": "模板不存在" }));
                }
                persist_cover_template_catalog(state, &templates)?;
                prune_cover_template_assets(state, &templates)?;
                let cover_root = cover_root(state)?;
                Ok(json!({
                    "success": true,
                    "templates": templates
                        .iter()
                        .map(|item| cover_template_public_value(&cover_root, item))
                        .collect::<Vec<_>>(),
                }))
            }
            "cover:templates:import-legacy" => {
                let incoming = payload_field(payload, "templates")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if incoming.is_empty() {
                    return Ok(json!({ "success": true, "imported": 0, "templates": [] }));
                }
                let mut templates = read_cover_template_catalog(state)?;
                let mut imported = 0usize;
                for item in incoming {
                    let template_id = payload_string(&item, "id");
                    let existing_index = template_id
                        .as_deref()
                        .and_then(|id| templates.iter().position(|record| record.id == id));
                    let existing = existing_index.and_then(|index| templates.get(index));
                    let saved = cover_template_record_from_payload(state, &item, existing)?;
                    if let Some(index) = existing_index {
                        templates[index] = saved;
                    } else {
                        templates.push(saved);
                    }
                    imported += 1;
                }
                templates.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                persist_cover_template_catalog(state, &templates)?;
                prune_cover_template_assets(state, &templates)?;
                let cover_root = cover_root(state)?;
                Ok(json!({
                    "success": true,
                    "imported": imported,
                    "templates": templates
                        .iter()
                        .map(|item| cover_template_public_value(&cover_root, item))
                        .collect::<Vec<_>>(),
                }))
            }
            "cover:save-template-image" => {
                let image_source = payload_string(payload, "imageSource").unwrap_or_default();
                if image_source.is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少模板图" }));
                }
                let file_hint =
                    payload_string(payload, "fileHint").unwrap_or_else(|| "template".to_string());
                let (relative, preview_url) =
                    persist_cover_template_image_source(state, &image_source, &file_hint)?;
                Ok(json!({
                    "success": true,
                    "previewUrl": preview_url,
                    "relativePath": relative,
                }))
            }
            "cover:generate" => {
                let count = payload_field(payload, "count")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(1)
                    .clamp(1, 4);
                let template_name =
                    normalize_optional_string(payload_string(payload, "templateName"));
                let provider = normalize_optional_string(payload_string(payload, "provider"));
                let provider_template =
                    normalize_optional_string(payload_string(payload, "providerTemplate"));
                let model = normalize_optional_string(payload_string(payload, "model"));
                let quality = normalize_optional_string(payload_string(payload, "quality"));
                let titles = payload_field(payload, "titles")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let prompt = build_cover_generation_prompt(payload, &titles);
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let settings_snapshot = {
                    let auth_runtime = state
                        .auth_runtime
                        .lock()
                        .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
                    crate::auth::project_settings_for_runtime(&settings_snapshot, &auth_runtime)
                };
                let real_image_config = resolve_image_generation_settings(&settings_snapshot);
                let placeholder_fallback_allowed =
                    payload_field(payload, "allowPlaceholderFallback")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                let mut created = Vec::new();
                for index in 0..count {
                    let file_name = format!("cover-{}-{}.png", now_ms(), index + 1);
                    let relative_path = format!("generated/{}", file_name);
                    let absolute_path = cover_root(state)?.join(&relative_path);
                    let base_title = template_name
                        .clone()
                        .unwrap_or_else(|| "RedBox Cover".to_string());
                    let asset_title = if count > 1 {
                        format!("{base_title} {}", index + 1)
                    } else {
                        base_title
                    };
                    if let Some((
                        endpoint,
                        api_key,
                        default_model,
                        default_provider,
                        default_template,
                    )) = &real_image_config
                    {
                        let effective_model =
                            model.clone().unwrap_or_else(|| default_model.clone());
                        let effective_provider = provider
                            .as_deref()
                            .unwrap_or(default_provider.as_str())
                            .to_string();
                        let effective_template = provider_template
                            .as_deref()
                            .unwrap_or(default_template.as_str())
                            .to_string();
                        append_debug_log_state(
                            state,
                            format!(
                                "[cover-gen] request:start endpoint={} provider={} template={} model={} title={}",
                                endpoint, effective_provider, effective_template, effective_model, asset_title
                            ),
                        );
                        let request_payload = json!({
                            "prompt": prompt,
                            "count": 1,
                            "quality": quality,
                        });
                        let response = match run_image_generation_request(
                            endpoint,
                            api_key.as_deref(),
                            effective_model.as_str(),
                            effective_provider.as_str(),
                            effective_template.as_str(),
                            &request_payload,
                        ) {
                            Ok(response) => Some(response),
                            Err(error) => {
                                append_debug_log_state(
                                    state,
                                    format!(
                                        "[cover-gen] request:error endpoint={} provider={} template={} model={} error={error}",
                                        endpoint, effective_provider, effective_template, effective_model
                                    ),
                                );
                                if placeholder_fallback_allowed {
                                    write_placeholder_svg(
                                        &absolute_path,
                                        &asset_title,
                                        &prompt.chars().take(48).collect::<String>(),
                                        "#F2B544",
                                    )?;
                                    None
                                } else {
                                    return Err(format!("封面生成请求失败：{error}"));
                                }
                            }
                        };
                        if let Some(response) = response {
                            if let Some(item) = extract_first_media_result(&response) {
                                if let Err(error) =
                                    write_generated_image_asset(&absolute_path, item)
                                {
                                    append_debug_log_state(
                                        state,
                                        format!(
                                            "[cover-gen] asset:write-error path={} error={error}",
                                            absolute_path.display()
                                        ),
                                    );
                                    if placeholder_fallback_allowed {
                                        write_placeholder_svg(
                                            &absolute_path,
                                            &asset_title,
                                            &prompt.chars().take(48).collect::<String>(),
                                            "#F2B544",
                                        )?;
                                    } else {
                                        return Err(format!("封面生成结果写入失败：{error}"));
                                    }
                                } else {
                                    append_debug_log_state(
                                        state,
                                        format!(
                                            "[cover-gen] request:ok path={} provider={} template={} model={}",
                                            absolute_path.display(),
                                            effective_provider,
                                            effective_template,
                                            effective_model
                                        ),
                                    );
                                }
                            } else if placeholder_fallback_allowed {
                                write_placeholder_svg(
                                    &absolute_path,
                                    &asset_title,
                                    &prompt.chars().take(48).collect::<String>(),
                                    "#F2B544",
                                )?;
                            } else {
                                append_debug_log_state(
                                    state,
                                    format!(
                                        "[cover-gen] response:empty endpoint={} provider={} template={} model={}",
                                        endpoint, effective_provider, effective_template, effective_model
                                    ),
                                );
                                return Err(
                                    "封面生成请求已发出，但 provider 返回里没有可用图片结果。"
                                        .to_string(),
                                );
                            }
                        }
                    } else if placeholder_fallback_allowed {
                        write_placeholder_svg(
                            &absolute_path,
                            &asset_title,
                            &prompt.chars().take(48).collect::<String>(),
                            "#F2B544",
                        )?;
                    } else {
                        append_debug_log_state(
                            state,
                            format!("[cover-gen] missing provider config title={asset_title}"),
                        );
                        return Err(
                            "封面生成未执行：请先在设置中配置生图 Endpoint、API Key 和模型。"
                                .to_string(),
                        );
                    }
                    created.push(CoverAssetRecord {
                        id: make_id("cover"),
                        title: Some(asset_title),
                        template_name: template_name.clone(),
                        prompt: normalize_optional_string(Some(prompt.clone())),
                        provider: provider.clone(),
                        provider_template: provider_template.clone(),
                        model: model.clone(),
                        aspect_ratio: Some("3:4".to_string()),
                        size: None,
                        quality: quality.clone(),
                        relative_path: Some(relative_path),
                        preview_url: Some(file_url_for_path(&absolute_path)),
                        exists: true,
                        updated_at: now_iso(),
                    });
                }
                with_store_mut(state, |store| {
                    for asset in &created {
                        store.cover_assets.push(asset.clone());
                    }
                    store.work_items.push(create_work_item(
                        "cover-generation",
                        template_name.clone().unwrap_or_else(|| "封面生成".to_string()),
                        normalize_optional_string(Some(if real_image_config.is_some() {
                            "RedBox 已通过已配置图片 endpoint 生成封面。".to_string()
                        } else {
                            "RedBox 已保存封面生成请求；当前缺少图片 endpoint 配置，仅生成了本地占位方案。".to_string()
                        })),
                        normalize_optional_string(Some(prompt.clone())),
                        None,
                        2,
                    ));
                    Ok(())
                })?;
                persist_cover_workspace_catalog(state)?;
                Ok(json!({ "success": true, "assets": created }))
            }
            _ => unreachable!(),
        }
    })())
}
