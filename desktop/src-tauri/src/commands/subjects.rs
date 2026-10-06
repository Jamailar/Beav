use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, State};

use crate::commands::generation::generate_image_assets;
use crate::commands::library::persist_media_workspace_catalog;
use crate::persistence::{ensure_store_hydrated_for_subjects, with_store};
use crate::store::{media as media_store, subjects as subject_store};
use crate::{
    file_content_hash, handle_subject_category_create, handle_subject_category_delete,
    handle_subject_category_update, handle_subject_create, handle_subject_delete,
    handle_subject_update, hydrated_subject_record, now_iso, now_ms, payload_string,
    persist_subjects_workspace, safe_subject_relative_path, subjects_root, AppState,
    SubjectAttribute, SubjectRecord,
};

pub fn handle_subjects_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "subjects:list" => {
            let _ = ensure_store_hydrated_for_subjects(state);
            with_store(state, |store| {
                let subjects = subject_store::list_subjects(&store);
                Ok(json!({ "success": true, "assets": subjects.clone(), "subjects": subjects }))
            })
        }
        "subjects:get" => {
            let _ = ensure_store_hydrated_for_subjects(state);
            let Some(id) = payload_string(payload, "id") else {
                return Some(Ok(json!({ "success": false, "error": "缺少主体 id" })));
            };
            with_store(state, |store| {
                let subject = subject_store::get_subject(&store, &id);
                Ok(json!({ "success": true, "asset": subject.clone(), "subject": subject }))
            })
        }
        "subjects:create" => handle_subject_create(payload.clone(), app, state),
        "subjects:update" => handle_subject_update(payload.clone(), app, state),
        "subjects:generate-character-card" => {
            handle_subject_generate_character_card(payload.clone(), state)
        }
        "subjects:delete" => handle_subject_delete(payload.clone(), state),
        "subjects:search" => {
            let _ = ensure_store_hydrated_for_subjects(state);
            let query = payload_string(payload, "query")
                .unwrap_or_default()
                .to_lowercase();
            let category_id = payload_string(payload, "categoryId");
            with_store(state, |store| {
                let subjects =
                    subject_store::search_subjects(&store, &query, category_id.as_deref());
                Ok(json!({ "success": true, "assets": subjects.clone(), "subjects": subjects }))
            })
        }
        "subjects:categories:list" => {
            let _ = ensure_store_hydrated_for_subjects(state);
            with_store(state, |store| {
                Ok(
                    json!({ "success": true, "categories": subject_store::list_subject_categories(&store) }),
                )
            })
        }
        "subjects:categories:create" => handle_subject_category_create(payload.clone(), state),
        "subjects:categories:update" => handle_subject_category_update(payload.clone(), state),
        "subjects:categories:delete" => handle_subject_category_delete(payload.clone(), state),
        _ => return None,
    };
    Some(result)
}

fn subject_attribute_value(attributes: &[SubjectAttribute], key: &str) -> Option<String> {
    attributes
        .iter()
        .find(|item| item.key.trim() == key)
        .map(|item| item.value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn build_character_card_prompt(subject: &SubjectRecord, category_name: &str) -> String {
    let gender = subject_attribute_value(&subject.attributes, "性别");
    let age = subject_attribute_value(&subject.attributes, "年龄");
    let other_attributes = subject
        .attributes
        .iter()
        .filter(|item| item.key.trim() != "性别" && item.key.trim() != "年龄")
        .filter_map(|item| {
            let key = item.key.trim();
            let value = item.value.trim();
            if key.is_empty() && value.is_empty() {
                None
            } else if key.is_empty() {
                Some(value.to_string())
            } else if value.is_empty() {
                Some(key.to_string())
            } else {
                Some(format!("{key}: {value}"))
            }
        })
        .collect::<Vec<_>>();
    let mut info_lines = vec![format!("名称: {}", subject.name)];
    if !category_name.trim().is_empty() {
        info_lines.push(format!("类别: {category_name}"));
    }
    if let Some(value) = gender {
        info_lines.push(format!("性别: {value}"));
    }
    if let Some(value) = age {
        info_lines.push(format!("年龄: {value}"));
    }
    if let Some(description) = subject
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        info_lines.push(format!("描述: {description}"));
    }
    if !subject.tags.is_empty() {
        info_lines.push(format!("标签: {}", subject.tags.join(", ")));
    }
    if !other_attributes.is_empty() {
        info_lines.push(format!("扩展属性: {}", other_attributes.join("; ")));
    }

    format!(
        "给这个角色制作一张影视角色信息卡，横版构图，16:9比例，白色背景，基于参考图保持角色脸型、发型、服装、年龄感和整体气质一致。需要有角色展开三视图、身体配饰细节和各类情绪的表情特写。人物属性设定放左下角，使用中文小字。\n\
         角色资料：\n{}\n\
         避免水印、logo、二维码、乱码文字、重复脸、额外角色、prompt字样。",
        info_lines.join("\n")
    )
}

fn extension_for_generated_character_card(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    }
}

fn copy_generated_card_to_subject(
    subjects_root: &Path,
    subject_id: &str,
    generated_path: &Path,
) -> Result<String, String> {
    let subject_dir = subjects_root.join(subject_id);
    fs::create_dir_all(&subject_dir).map_err(|error| error.to_string())?;
    let extension = extension_for_generated_character_card(generated_path);
    let file_name = format!("character-card-{}.{}", now_ms(), extension);
    let relative_path =
        safe_subject_relative_path(&file_name).ok_or_else(|| "角色卡文件名无效".to_string())?;
    fs::copy(generated_path, subject_dir.join(&relative_path))
        .map_err(|error| format!("角色卡写入失败: {error}"))?;
    Ok(relative_path)
}

fn handle_subject_generate_character_card(
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    ensure_store_hydrated_for_subjects(state)?;
    let Some(id) = payload_string(&payload, "id") else {
        return Ok(json!({ "success": false, "error": "缺少角色 id" }));
    };
    let subjects_root_path = subjects_root(state)?;
    let (categories, subjects) =
        with_store(state, |store| Ok(subject_store::catalog_snapshot(&store)))?;
    let Some(subject) = subjects.iter().find(|item| item.id == id).cloned() else {
        return Ok(json!({ "success": false, "error": "角色不存在" }));
    };
    let category_name = categories
        .iter()
        .find(|item| subject.category_id.as_deref() == Some(item.id.as_str()))
        .map(|item| item.name.trim().to_string())
        .unwrap_or_default();
    if category_name != "角色" {
        return Ok(json!({ "success": false, "error": "只有角色类目可以生成角色卡" }));
    }
    let Some(reference_image) = subject.absolute_image_paths.first().cloned() else {
        return Ok(json!({ "success": false, "error": "请先添加角色图片" }));
    };
    let prompt = build_character_card_prompt(&subject, &category_name);
    let generation_payload = json!({
        "prompt": prompt,
        "compiledPrompt": prompt,
        "title": format!("{} 角色卡", subject.name),
        "projectId": subject.id,
        "count": 1,
        "generationMode": "reference-guided",
        "referenceImages": [reference_image],
        "aspectRatio": "16:9",
        "size": "1536x864",
        "quality": "high",
    });
    let execution =
        generate_image_assets(state, &generation_payload, |_asset, _completed, _total| {
            Ok(())
        })?;
    let Some(generated_asset) = execution.assets.first().cloned() else {
        return Ok(json!({ "success": false, "error": "角色卡生成失败" }));
    };
    let generated_path = generated_asset
        .absolute_path
        .as_deref()
        .map(Path::new)
        .filter(|path| path.exists())
        .ok_or_else(|| "角色卡生成结果不存在".to_string())?;
    let card_relative_path =
        copy_generated_card_to_subject(subjects_root_path.as_path(), &subject.id, generated_path)?;

    let (latest_categories, mut latest_subjects) =
        with_store(state, |store| Ok(subject_store::catalog_snapshot(&store)))?;
    let Some(index) = latest_subjects
        .iter()
        .position(|item| item.id == subject.id)
    else {
        return Ok(json!({ "success": false, "error": "角色不存在" }));
    };
    let mut updated_subject = latest_subjects[index].clone();
    updated_subject
        .image_paths
        .retain(|path| path != &card_relative_path);
    updated_subject.image_paths.insert(0, card_relative_path);
    updated_subject.image_paths.truncate(5);
    updated_subject.updated_at = now_iso();
    updated_subject = hydrated_subject_record(subjects_root_path.as_path(), updated_subject);
    latest_subjects[index] = updated_subject.clone();

    crate::persistence::with_store_mut(state, |store| {
        media_store::push_asset(store, generated_asset.clone());
        subject_store::replace_catalog(store, latest_categories.clone(), latest_subjects.clone());
        Ok(())
    })?;
    persist_subjects_workspace(
        subjects_root_path.as_path(),
        &latest_categories,
        &latest_subjects,
    )?;
    persist_media_workspace_catalog(state)?;

    Ok(json!({
        "success": true,
        "subject": updated_subject,
        "asset": generated_asset,
        "contentHash": file_content_hash(generated_path).ok(),
    }))
}
