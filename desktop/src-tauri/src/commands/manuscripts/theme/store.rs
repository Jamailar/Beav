use super::super::*;
use super::bundled::{bundled_richpost_theme_ids, ensure_bundled_richpost_themes};
use super::scaffold::{
    default_richpost_layout_tokens, normalize_richpost_layout_tokens_value,
    write_richpost_layout_tokens_for_theme,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;

pub(crate) fn richpost_theme_background_storage_dir(
    package_path: &std::path::Path,
    theme_id: &str,
) -> std::path::PathBuf {
    package_richpost_theme_assets_dir(package_path, &sanitize_richpost_theme_id_fragment(theme_id))
}

fn copy_dir_contents_if_exists(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    if !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    let entries = fs::read_dir(source).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_contents_if_exists(&source_path, &target_path)?;
        } else if source_path.is_file() {
            copy_if_exists(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn read_richpost_theme_specs_from_path(path: &std::path::Path) -> Vec<RichpostThemeSpec> {
    read_json_value_or(path, json!({ "items": [] }))
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value::<RichpostThemeSpec>(item.clone()).ok())
                .map(|mut theme| {
                    theme.source = "custom".to_string();
                    theme
                })
                .filter(|theme| !theme.id.trim().is_empty() && !theme.label.trim().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn read_richpost_theme_spec_from_config_path(path: &std::path::Path) -> Option<RichpostThemeSpec> {
    let raw = read_json_value_or(path, Value::Null);
    let mut theme = serde_json::from_value::<RichpostThemeSpec>(raw).ok()?;
    if theme.id.trim().is_empty() || theme.label.trim().is_empty() {
        return None;
    }
    if theme.source.trim().is_empty() {
        theme.source = "custom".to_string();
    }
    Some(theme)
}

fn resolve_richpost_theme_config_path_in_root(
    root: &std::path::Path,
    theme_id: Option<&str>,
) -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(theme_id) = theme_id.map(str::trim).filter(|value| !value.is_empty()) {
        candidates.push(root.join(package_richpost_theme_config_file_name(theme_id)));
    }
    if let Some(root_name) = root.file_name().and_then(|value| value.to_str()) {
        let normalized = sanitize_richpost_theme_id_fragment(root_name);
        if !normalized.is_empty() {
            let candidate = root.join(package_richpost_theme_config_file_name(&normalized));
            if !candidates.iter().any(|item| item == &candidate) {
                candidates.push(candidate);
            }
        }
    }
    let legacy_candidate = root.join("theme.json");
    if !candidates.iter().any(|item| item == &legacy_candidate) {
        candidates.push(legacy_candidate);
    }
    for candidate in &candidates {
        if candidate.is_file() {
            return Some(candidate.clone());
        }
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if read_richpost_theme_spec_from_config_path(&path).is_some() {
            return Some(path);
        }
    }
    None
}

fn read_richpost_theme_spec_from_root(root: &std::path::Path) -> Option<RichpostThemeSpec> {
    let config_path = resolve_richpost_theme_config_path_in_root(root, None)?;
    read_richpost_theme_spec_from_config_path(&config_path)
}

pub(crate) fn resolve_richpost_theme_background_absolute_path(
    package_path: &std::path::Path,
    relative_path: &str,
) -> Option<std::path::PathBuf> {
    let normalized = normalize_relative_path(relative_path);
    if normalized.is_empty() {
        return None;
    }
    let workspace_candidate = package_workspace_root_path(package_path).join(&normalized);
    if workspace_candidate.is_file() {
        return Some(workspace_candidate);
    }
    let package_candidate = package_path.join(&normalized);
    if package_candidate.is_file() {
        return Some(package_candidate);
    }
    None
}

pub(crate) fn global_richpost_theme_background_relative_path(
    package_path: &std::path::Path,
    theme_id: &str,
    file_name: &str,
) -> String {
    let target_path = richpost_theme_background_storage_dir(package_path, theme_id).join(file_name);
    if let Ok(relative) = target_path.strip_prefix(package_workspace_root_path(package_path)) {
        normalize_relative_path(relative.to_string_lossy().as_ref())
    } else {
        normalize_relative_path(target_path.to_string_lossy().as_ref())
    }
}

fn next_available_richpost_theme_id(
    existing: &[RichpostThemeSpec],
    requested_id: &str,
    _label: &str,
) -> String {
    let mut base_id = requested_id.trim().to_string();
    if base_id.is_empty() {
        base_id = make_id("theme");
    }
    if !existing.iter().any(|theme| theme.id == base_id) {
        return base_id;
    }
    let mut index = 2usize;
    loop {
        let candidate = format!("{base_id}-{index}");
        if !existing.iter().any(|theme| theme.id == candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn migrate_legacy_richpost_theme_spec(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    existing: &[RichpostThemeSpec],
) -> Result<RichpostThemeSpec, String> {
    let mut migrated = theme.clone();
    migrated.source = "custom".to_string();
    if existing.iter().any(|item| item.id == migrated.id) {
        migrated.id = next_available_richpost_theme_id(existing, &migrated.id, &migrated.label);
    }
    fs::create_dir_all(package_richpost_theme_store_dir(package_path))
        .map_err(|error| error.to_string())?;
    for role in [
        RICHPOST_MASTER_COVER,
        RICHPOST_MASTER_BODY,
        RICHPOST_MASTER_ENDING,
    ] {
        let current_relative = richpost_theme_background_relative_path(&migrated, role);
        if current_relative.trim().is_empty() {
            continue;
        }
        let Some(source_path) =
            resolve_richpost_theme_background_absolute_path(package_path, &current_relative)
        else {
            continue;
        };
        let extension = source_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png");
        let file_name = richpost_theme_background_relative_file_name(&migrated.id, role, extension);
        let target_dir = richpost_theme_background_storage_dir(package_path, &migrated.id);
        fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
        let target_path = target_dir.join(&file_name);
        if source_path != target_path {
            fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
        let next_relative =
            global_richpost_theme_background_relative_path(package_path, &migrated.id, &file_name);
        match role {
            RICHPOST_MASTER_COVER => migrated.cover_background_path = next_relative,
            RICHPOST_MASTER_ENDING => migrated.ending_background_path = next_relative,
            _ => migrated.body_background_path = next_relative,
        }
    }
    Ok(migrated)
}

fn migrate_legacy_richpost_theme_store(package_path: &std::path::Path) -> Result<(), String> {
    let legacy_store_dir = legacy_package_richpost_theme_store_dir(package_path);
    let theme_store_dir = package_richpost_theme_store_dir(package_path);
    if legacy_store_dir != theme_store_dir && legacy_store_dir.is_dir() {
        fs::create_dir_all(&theme_store_dir).map_err(|error| error.to_string())?;
        let mut migrated_from_legacy_dirs =
            read_custom_richpost_theme_specs_from_dirs(package_path);
        let legacy_entries = fs::read_dir(&legacy_store_dir).map_err(|error| error.to_string())?;
        let mut migrated_any_legacy_dir = false;
        for entry in legacy_entries.flatten() {
            let legacy_root = entry.path();
            if !legacy_root.is_dir() {
                continue;
            }
            let config_path = resolve_richpost_theme_config_path_in_root(&legacy_root, None)
                .unwrap_or_else(|| legacy_root.join("theme.json"));
            let Some(legacy_theme) = read_richpost_theme_spec_from_config_path(&config_path) else {
                continue;
            };
            let migrated_theme = migrate_legacy_richpost_theme_spec(
                package_path,
                &legacy_theme,
                &migrated_from_legacy_dirs,
            )?;
            let target_theme_id = sanitize_richpost_theme_id_fragment(&migrated_theme.id);
            let target_root = package_richpost_theme_root_dir(package_path, &target_theme_id);
            fs::create_dir_all(&target_root).map_err(|error| error.to_string())?;
            copy_if_exists(
                &legacy_root.join("layout.tokens.json"),
                &package_richpost_theme_tokens_path(package_path, &target_theme_id),
            )?;
            copy_dir_contents_if_exists(
                &legacy_root.join("masters"),
                &package_richpost_theme_masters_dir(package_path, &target_theme_id),
            )?;
            copy_dir_contents_if_exists(
                &legacy_root.join("assets"),
                &package_richpost_theme_assets_dir(package_path, &target_theme_id),
            )?;
            write_json_value(
                &package_richpost_theme_config_path(package_path, &target_theme_id),
                &richpost_theme_spec_storage_value(&migrated_theme),
            )?;
            migrated_from_legacy_dirs.retain(|item| item.id != migrated_theme.id);
            migrated_from_legacy_dirs.push(migrated_theme);
            migrated_any_legacy_dir = true;
        }
        let legacy_template_path = legacy_package_richpost_theme_template_path(package_path);
        let theme_template_path = package_richpost_theme_template_path(package_path);
        if legacy_template_path.is_file() && !theme_template_path.exists() {
            copy_if_exists(&legacy_template_path, &theme_template_path)?;
        }
        if migrated_any_legacy_dir {
            migrated_from_legacy_dirs
                .sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
            write_custom_richpost_theme_specs(package_path, &migrated_from_legacy_dirs)?;
        }
        let _ = fs::remove_dir_all(&legacy_store_dir);
    }

    let mut legacy_themes =
        read_richpost_theme_specs_from_path(&legacy_package_richpost_themes_path(package_path));
    legacy_themes.extend(read_richpost_theme_specs_from_path(
        &workspace_richpost_themes_path(package_path),
    ));
    if legacy_themes.is_empty() {
        let _ = fs::remove_file(legacy_package_richpost_themes_path(package_path));
        return Ok(());
    }
    let mut global_themes = read_custom_richpost_theme_specs_from_dirs(package_path);
    let mut changed = false;
    for legacy_theme in legacy_themes {
        if global_themes
            .iter()
            .any(|theme| theme.id == legacy_theme.id)
        {
            continue;
        }
        let migrated =
            migrate_legacy_richpost_theme_spec(package_path, &legacy_theme, &global_themes)?;
        global_themes.push(migrated);
        changed = true;
    }
    if changed {
        global_themes
            .sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
        write_custom_richpost_theme_specs(package_path, &global_themes)?;
    }
    let _ = fs::remove_file(legacy_package_richpost_themes_path(package_path));
    Ok(())
}

pub(crate) fn richpost_theme_background_css_vars(
    package_path: Option<&std::path::Path>,
    theme: &RichpostThemeSpec,
    role: &str,
) -> serde_json::Map<String, Value> {
    let mut vars = serde_json::Map::new();
    let relative = richpost_theme_background_relative_path(theme, role);
    if relative.trim().is_empty() {
        return vars;
    }
    let Some(package_path) = package_path else {
        return vars;
    };
    let Some(absolute) = resolve_richpost_theme_background_absolute_path(package_path, &relative)
    else {
        return vars;
    };
    if !absolute.is_file() {
        return vars;
    }
    let (mime_type, _kind, _) = guess_mime_and_kind(&absolute);
    let background_bytes = match fs::read(&absolute) {
        Ok(bytes) => bytes,
        Err(_error) => return vars,
    };
    let data_url = format!(
        "data:{};base64,{}",
        mime_type,
        base64::engine::general_purpose::STANDARD.encode(background_bytes)
    );
    vars.insert(
        "--rb-background-image".to_string(),
        json!(format!("url(\"{}\")", data_url)),
    );
    vars
}

fn richpost_theme_background_relative_file_name(
    theme_id: &str,
    role: &str,
    extension: &str,
) -> String {
    let role_fragment = sanitize_richpost_master_name(role).unwrap_or_else(|| "body".to_string());
    let theme_fragment = sanitize_richpost_theme_id_fragment(theme_id);
    let timestamp = now_i64();
    if extension.trim().is_empty() {
        format!("{timestamp}-{theme_fragment}-{role_fragment}")
    } else {
        format!(
            "{timestamp}-{theme_fragment}-{role_fragment}.{}",
            extension.trim_matches('.')
        )
    }
}

pub(crate) fn next_richpost_custom_theme_label(package_path: &std::path::Path) -> String {
    let existing = richpost_theme_catalog_for_package(Some(package_path));
    let base = "新主题";
    if !existing.iter().any(|theme| theme.label.trim() == base) {
        return base.to_string();
    }
    let mut index = 2usize;
    loop {
        let candidate = format!("{base} {index}");
        if !existing.iter().any(|theme| theme.label.trim() == candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn read_custom_richpost_theme_specs_from_dirs(
    package_path: &std::path::Path,
) -> Vec<RichpostThemeSpec> {
    let themes_dir = package_richpost_theme_store_dir(package_path);
    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(&themes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(theme) = read_richpost_theme_spec_from_root(&path) {
                items.push(theme);
            }
        }
    }
    items.sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
    items
}

fn write_custom_richpost_theme_index(
    package_path: &std::path::Path,
    themes: &[RichpostThemeSpec],
) -> Result<(), String> {
    let items = themes
        .iter()
        .map(|theme| {
            json!({
                "id": theme.id,
                "label": theme.label,
                "description": theme.description,
                "source": theme.source,
            })
        })
        .collect::<Vec<_>>();
    write_json_value(
        &package_richpost_themes_path(package_path),
        &json!({
            "version": 2,
            "items": items,
        }),
    )
}

pub(crate) fn read_custom_richpost_theme_specs(
    package_path: &std::path::Path,
) -> Vec<RichpostThemeSpec> {
    let _ = ensure_bundled_richpost_themes(package_path);
    let _ = migrate_legacy_richpost_theme_store(package_path);
    read_custom_richpost_theme_specs_from_dirs(package_path)
}

pub(crate) fn write_custom_richpost_theme_specs(
    package_path: &std::path::Path,
    themes: &[RichpostThemeSpec],
) -> Result<(), String> {
    ensure_bundled_richpost_themes(package_path)?;
    let themes_dir = package_richpost_theme_store_dir(package_path);
    fs::create_dir_all(&themes_dir).map_err(|error| error.to_string())?;
    let mut keep_ids = BTreeSet::new();
    for theme_id in bundled_richpost_theme_ids() {
        keep_ids.insert(sanitize_richpost_theme_id_fragment(theme_id));
    }
    for theme in themes {
        let theme_id = sanitize_richpost_theme_id_fragment(&theme.id);
        keep_ids.insert(theme_id.clone());
        let root = package_richpost_theme_root_dir(package_path, &theme_id);
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let legacy_config_path = root.join("theme.json");
        if legacy_config_path.is_file() {
            let _ = fs::remove_file(&legacy_config_path);
        }
        write_json_value(
            &package_richpost_theme_config_path(package_path, &theme_id),
            &richpost_theme_spec_storage_value(theme),
        )?;
    }
    if let Ok(entries) = fs::read_dir(&themes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            if keep_ids.contains(&file_name) {
                continue;
            }
            if file_name == "richpost-theme-assets" {
                continue;
            }
            let _ = fs::remove_dir_all(path);
        }
    }
    write_custom_richpost_theme_index(package_path, themes)?;
    write_json_value(
        &legacy_package_richpost_themes_path(package_path),
        &json!({
            "version": 1,
            "items": themes.iter().map(richpost_theme_spec_storage_value).collect::<Vec<_>>(),
        }),
    )
}

pub(crate) fn richpost_theme_spec_storage_value(theme: &RichpostThemeSpec) -> Value {
    json!({
        "id": theme.id,
        "label": theme.label,
        "description": theme.description,
        "shellBg": theme.shell_bg,
        "previewCardBg": theme.preview_card_bg,
        "previewCardBorder": theme.preview_card_border,
        "previewCardShadow": theme.preview_card_shadow,
        "pageBg": theme.page_bg,
        "surfaceBg": theme.surface_bg,
        "surfaceBorder": theme.surface_border,
        "surfaceShadow": theme.surface_shadow,
        "surfaceRadius": theme.surface_radius,
        "imageRadius": theme.image_radius,
        "headingColor": theme.heading_color,
        "bodyColor": theme.body_color,
        "text": theme.text,
        "muted": theme.muted,
        "accent": theme.accent,
        "headingFont": theme.heading_font,
        "bodyFont": theme.body_font,
        "coverFrame": theme.cover_frame,
        "bodyFrame": theme.body_frame,
        "endingFrame": theme.ending_frame,
        "coverBackgroundPath": theme.cover_background_path,
        "bodyBackgroundPath": theme.body_background_path,
        "endingBackgroundPath": theme.ending_background_path,
        "source": theme.source
    })
}

pub(crate) fn richpost_theme_spec_from_manifest_snapshot(
    manifest: &Value,
) -> Option<RichpostThemeSpec> {
    let raw = manifest.get("richpostThemeSnapshot")?;
    let mut theme = serde_json::from_value::<RichpostThemeSpec>(raw.clone()).ok()?;
    if theme.id.trim().is_empty() || theme.label.trim().is_empty() {
        return None;
    }
    if theme.source.trim().is_empty() {
        theme.source = "custom".to_string();
    }
    Some(theme)
}

pub(crate) fn write_applied_richpost_theme_to_manifest(
    manifest: &mut Value,
    theme: &RichpostThemeSpec,
) {
    let Some(object) = manifest.as_object_mut() else {
        return;
    };
    object.insert("richpostThemeId".to_string(), json!(theme.id.clone()));
    object.insert(
        "richpostThemeSnapshot".to_string(),
        richpost_theme_spec_storage_value(theme),
    );
    object.insert("updatedAt".to_string(), json!(now_i64()));
}

pub(crate) fn richpost_theme_spec_payload_value(theme: &RichpostThemeSpec) -> Value {
    json!({
        "id": theme.id,
        "label": theme.label,
        "description": theme.description,
        "source": theme.source,
        "shellBg": theme.shell_bg,
        "pageBg": theme.page_bg,
        "surfaceBg": theme.surface_bg,
        "surfaceBorder": theme.surface_border,
        "surfaceShadow": theme.surface_shadow,
        "surfaceRadius": theme.surface_radius,
        "imageRadius": theme.image_radius,
        "previewCardBg": theme.preview_card_bg,
        "previewCardBorder": theme.preview_card_border,
        "previewCardShadow": theme.preview_card_shadow,
        "headingColor": theme.heading_color,
        "bodyColor": theme.body_color,
        "textColor": theme.text,
        "mutedColor": theme.muted,
        "accentColor": theme.accent,
        "headingFont": theme.heading_font,
        "bodyFont": theme.body_font,
        "coverFrame": theme.cover_frame,
        "bodyFrame": theme.body_frame,
        "endingFrame": theme.ending_frame,
        "coverBackgroundPath": theme.cover_background_path,
        "bodyBackgroundPath": theme.body_background_path,
        "endingBackgroundPath": theme.ending_background_path
    })
}

pub(crate) fn copy_if_exists(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    if !source.is_file() {
        return Ok(());
    }
    let content = fs::read(source).map_err(|error| error.to_string())?;
    ensure_parent_dir(target)?;
    fs::write(target, content).map_err(|error| error.to_string())
}

pub(crate) fn sync_richpost_theme_root_from_package(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    create_from_blank: bool,
) -> Result<(), String> {
    let theme_id = sanitize_richpost_theme_id_fragment(&theme.id);
    let root = package_richpost_theme_root_dir(package_path, &theme_id);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    write_json_value(
        &package_richpost_theme_config_path(package_path, &theme_id),
        &richpost_theme_spec_storage_value(theme),
    )?;

    let package_tokens = package_layout_tokens_path(package_path);
    let theme_tokens = package_richpost_theme_tokens_path(package_path, &theme_id);
    let raw_theme_tokens = if theme_tokens.is_file() {
        read_json_value_or(
            &theme_tokens,
            default_richpost_layout_tokens(Some(package_path), theme),
        )
    } else if !create_from_blank && package_tokens.is_file() {
        read_json_value_or(
            &package_tokens,
            default_richpost_layout_tokens(Some(package_path), theme),
        )
    } else {
        default_richpost_layout_tokens(Some(package_path), theme)
    };
    write_json_value(
        &theme_tokens,
        &normalize_richpost_layout_tokens_value(&raw_theme_tokens, theme, Some(package_path)),
    )?;

    let package_masters_dir = package_richpost_masters_dir(package_path);
    let theme_masters_dir = package_richpost_theme_masters_dir(package_path, &theme_id);
    fs::create_dir_all(&theme_masters_dir).map_err(|error| error.to_string())?;
    for master_name in RICHPOST_DEFAULT_MASTER_NAMES {
        let target = package_richpost_theme_master_path(package_path, &theme_id, master_name);
        if target.exists() {
            continue;
        }
        if create_from_blank {
            write_text_file(&target, default_richpost_master_fragment(master_name))?;
        } else if package_masters_dir.is_dir() {
            copy_if_exists(
                &package_richpost_master_path(package_path, master_name),
                &target,
            )?;
            if !target.exists() {
                write_text_file(&target, default_richpost_master_fragment(master_name))?;
            }
        } else {
            write_text_file(&target, default_richpost_master_fragment(master_name))?;
        }
    }
    Ok(())
}

pub(crate) fn sync_package_from_richpost_theme_root(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
) -> Result<(), String> {
    let theme_id = sanitize_richpost_theme_id_fragment(&theme.id);
    let theme_config = package_richpost_theme_config_path(package_path, &theme_id);
    if theme_config.is_file() {
        write_json_value(&theme_config, &richpost_theme_spec_storage_value(theme))?;
    }

    let theme_tokens = package_richpost_theme_tokens_path(package_path, &theme_id);
    if theme_tokens.is_file() {
        let normalized_tokens = normalize_richpost_layout_tokens_value(
            &read_json_value_or(
                &theme_tokens,
                default_richpost_layout_tokens(Some(package_path), theme),
            ),
            theme,
            Some(package_path),
        );
        write_json_value(&theme_tokens, &normalized_tokens)?;
        write_json_value(
            &package_layout_tokens_path(package_path),
            &normalized_tokens,
        )?;
    } else {
        let _ = write_richpost_layout_tokens_for_theme(package_path, theme)?;
    }

    let theme_masters_dir = package_richpost_theme_masters_dir(package_path, &theme_id);
    if theme_masters_dir.is_dir() {
        for master_name in RICHPOST_DEFAULT_MASTER_NAMES {
            let source = package_richpost_theme_master_path(package_path, &theme_id, master_name);
            if source.is_file() {
                copy_if_exists(
                    &source,
                    &package_richpost_master_path(package_path, master_name),
                )?;
            }
        }
    }
    Ok(())
}

pub(crate) fn richpost_theme_root_tokens_path_for_theme(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
) -> Option<std::path::PathBuf> {
    let theme_id = sanitize_richpost_theme_id_fragment(&theme.id);
    if theme_id.is_empty() {
        return None;
    }
    let path = package_richpost_theme_tokens_path(package_path, &theme_id);
    path.is_file().then_some(path)
}

pub(crate) fn richpost_theme_root_master_path_for_theme(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    master_name: &str,
) -> Option<std::path::PathBuf> {
    let theme_id = sanitize_richpost_theme_id_fragment(&theme.id);
    let sanitized_master = sanitize_richpost_master_name(master_name)?;
    if theme_id.is_empty() {
        return None;
    }
    let path = package_richpost_theme_master_path(package_path, &theme_id, &sanitized_master);
    path.is_file().then_some(path)
}

pub(crate) fn richpost_theme_catalog_for_package(
    package_path: Option<&std::path::Path>,
) -> Vec<RichpostThemeSpec> {
    let mut catalog = richpost_theme_catalog_specs();
    if let Some(path) = package_path {
        catalog.extend(read_custom_richpost_theme_specs(path));
    }
    catalog
}

pub(crate) fn richpost_theme_spec_from_manifest(
    package_path: Option<&std::path::Path>,
    manifest: &Value,
) -> RichpostThemeSpec {
    let theme_id = manifest
        .get("richpostThemeId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(theme_id) = theme_id {
        if let Some(theme) = richpost_theme_catalog_for_package(package_path)
            .into_iter()
            .find(|theme| theme.id == theme_id)
        {
            return theme;
        }
    }
    if let Some(theme) = richpost_theme_spec_from_manifest_snapshot(manifest) {
        return theme;
    }
    default_richpost_theme_spec()
}

pub(crate) fn richpost_theme_spec_by_id(
    package_path: Option<&std::path::Path>,
    theme_id: &str,
) -> RichpostThemeSpec {
    let normalized = theme_id.trim();
    if let Some(theme) = richpost_theme_catalog_for_package(package_path)
        .into_iter()
        .find(|theme| theme.id == normalized)
    {
        return theme;
    }
    if let Some(package_path) = package_path {
        let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
        if let Some(theme) = richpost_theme_spec_from_manifest_snapshot(&manifest)
            .filter(|theme| theme.id == normalized)
        {
            return theme;
        }
    }
    default_richpost_theme_spec()
}

pub(crate) fn normalize_richpost_theme_draft(
    raw: &Value,
    base_theme: &RichpostThemeSpec,
    existing_theme_id: Option<&str>,
    package_path: &std::path::Path,
) -> RichpostThemeSpec {
    let label =
        sanitize_richpost_theme_label(raw.get("label").and_then(Value::as_str), &base_theme.label);
    let requested_id = raw
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let catalog = richpost_theme_catalog_for_package(Some(package_path));
    let normalized_existing_theme_id = existing_theme_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let theme_id = if let Some(existing_theme_id) = normalized_existing_theme_id {
        existing_theme_id.to_string()
    } else if !requested_id.is_empty()
        && catalog
            .iter()
            .any(|theme| theme.id == requested_id && theme.source == "custom")
    {
        requested_id.to_string()
    } else if !requested_id.is_empty() {
        next_available_richpost_theme_id(&catalog, requested_id, &label)
    } else {
        next_available_richpost_theme_id(&catalog, "", &label)
    };
    RichpostThemeSpec {
        id: theme_id,
        label,
        description: sanitize_richpost_theme_description(
            raw.get("description").and_then(Value::as_str),
        ),
        shell_bg: sanitize_richpost_theme_text(
            raw.get("shellBg").and_then(Value::as_str),
            &base_theme.shell_bg,
        ),
        preview_card_bg: sanitize_richpost_theme_text(
            raw.get("previewCardBg").and_then(Value::as_str),
            &base_theme.preview_card_bg,
        ),
        preview_card_border: sanitize_richpost_theme_text(
            raw.get("previewCardBorder").and_then(Value::as_str),
            &base_theme.preview_card_border,
        ),
        preview_card_shadow: sanitize_richpost_theme_text(
            raw.get("previewCardShadow").and_then(Value::as_str),
            &base_theme.preview_card_shadow,
        ),
        page_bg: sanitize_richpost_theme_text(
            raw.get("pageBg").and_then(Value::as_str),
            &base_theme.page_bg,
        ),
        surface_bg: sanitize_richpost_theme_text(
            raw.get("surfaceBg").and_then(Value::as_str),
            &base_theme.surface_bg,
        ),
        surface_border: sanitize_richpost_theme_text(
            raw.get("surfaceBorder").and_then(Value::as_str),
            &base_theme.surface_border,
        ),
        surface_shadow: sanitize_richpost_theme_text(
            raw.get("surfaceShadow").and_then(Value::as_str),
            &base_theme.surface_shadow,
        ),
        surface_radius: sanitize_richpost_theme_text(
            raw.get("surfaceRadius").and_then(Value::as_str),
            &base_theme.surface_radius,
        ),
        image_radius: sanitize_richpost_theme_text(
            raw.get("imageRadius").and_then(Value::as_str),
            &base_theme.image_radius,
        ),
        heading_color: sanitize_richpost_theme_text(
            raw.get("headingColor")
                .and_then(Value::as_str)
                .or_else(|| raw.get("textColor").and_then(Value::as_str))
                .or_else(|| raw.get("text").and_then(Value::as_str)),
            &base_theme.heading_color,
        ),
        body_color: sanitize_richpost_theme_text(
            raw.get("bodyColor")
                .and_then(Value::as_str)
                .or_else(|| raw.get("textColor").and_then(Value::as_str))
                .or_else(|| raw.get("text").and_then(Value::as_str)),
            &base_theme.body_color,
        ),
        text: sanitize_richpost_theme_text(
            raw.get("textColor")
                .and_then(Value::as_str)
                .or_else(|| raw.get("text").and_then(Value::as_str)),
            &base_theme.text,
        ),
        muted: sanitize_richpost_theme_text(
            raw.get("mutedColor")
                .and_then(Value::as_str)
                .or_else(|| raw.get("muted").and_then(Value::as_str)),
            &base_theme.muted,
        ),
        accent: sanitize_richpost_theme_text(
            raw.get("accentColor")
                .and_then(Value::as_str)
                .or_else(|| raw.get("accent").and_then(Value::as_str)),
            &base_theme.accent,
        ),
        heading_font: sanitize_richpost_theme_text(
            raw.get("headingFont").and_then(Value::as_str),
            &base_theme.heading_font,
        ),
        body_font: sanitize_richpost_theme_text(
            raw.get("bodyFont").and_then(Value::as_str),
            &base_theme.body_font,
        ),
        cover_frame: normalize_richpost_zone_frame(
            raw.get("coverFrame"),
            base_theme.cover_frame.clone(),
        ),
        body_frame: normalize_richpost_zone_frame(
            raw.get("bodyFrame"),
            base_theme.body_frame.clone(),
        ),
        ending_frame: normalize_richpost_zone_frame(
            raw.get("endingFrame"),
            base_theme.ending_frame.clone(),
        ),
        cover_background_path: sanitize_richpost_theme_background_path(
            raw.get("coverBackgroundPath")
                .and_then(Value::as_str)
                .or_else(|| Some(base_theme.cover_background_path.as_str())),
        ),
        body_background_path: sanitize_richpost_theme_background_path(
            raw.get("bodyBackgroundPath")
                .and_then(Value::as_str)
                .or_else(|| Some(base_theme.body_background_path.as_str())),
        ),
        ending_background_path: sanitize_richpost_theme_background_path(
            raw.get("endingBackgroundPath")
                .and_then(Value::as_str)
                .or_else(|| Some(base_theme.ending_background_path.as_str())),
        ),
        source: "custom".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_package_path(label: &str) -> std::path::PathBuf {
        let unique = format!("redbox-richpost-theme-store-{label}-{}", std::process::id());
        std::env::temp_dir()
            .join(unique)
            .join("workspace")
            .join("manuscripts")
            .join("sync-test.post")
    }

    #[test]
    fn sync_theme_tokens_refreshes_frame_mapping_for_theme_root_and_package() {
        let package_path = test_package_path("frame-sync");
        let workspace_root = package_workspace_root_path(&package_path);
        fs::create_dir_all(&package_path).expect("package dir");
        fs::create_dir_all(workspace_root.join("themes")).expect("themes dir");

        let mut theme = default_richpost_theme_spec();
        theme.id = "custom-frame-sync".to_string();
        theme.label = "Custom Frame Sync".to_string();
        theme.body_frame = RichpostZoneFrame {
            x: 0.31,
            y: 0.22,
            w: 0.52,
            h: 0.44,
        };

        let stale_tokens = json!({
            "version": 1,
            "themeId": theme.id,
            "cssVars": {
                "--rb-accent": "#123456"
            },
            "roleCssVars": {
                "body": {
                    "--rb-frame-left": "8.000%",
                    "--rb-frame-top": "10.000%",
                    "--rb-frame-width": "84.000%",
                    "--rb-frame-height": "78.000%"
                }
            }
        });
        write_json_value(&package_layout_tokens_path(&package_path), &stale_tokens)
            .expect("package tokens");
        write_json_value(
            &package_richpost_theme_tokens_path(&package_path, &theme.id),
            &stale_tokens,
        )
        .expect("theme tokens");

        sync_richpost_theme_root_from_package(&package_path, &theme, false)
            .expect("sync theme root");
        sync_package_from_richpost_theme_root(&package_path, &theme).expect("sync package");

        let expected_left = format!("{:.3}%", theme.body_frame.x * 100.0);
        let expected_top = format!("{:.3}%", theme.body_frame.y * 100.0);
        let expected_width = format!("{:.3}%", theme.body_frame.w * 100.0);
        let expected_height = format!("{:.3}%", theme.body_frame.h * 100.0);

        for path in [
            package_richpost_theme_tokens_path(&package_path, &theme.id),
            package_layout_tokens_path(&package_path),
        ] {
            let tokens = read_json_value_or(&path, Value::Null);
            assert_eq!(
                tokens
                    .pointer("/roleCssVars/body/--rb-frame-left")
                    .and_then(Value::as_str),
                Some(expected_left.as_str())
            );
            assert_eq!(
                tokens
                    .pointer("/roleCssVars/body/--rb-frame-top")
                    .and_then(Value::as_str),
                Some(expected_top.as_str())
            );
            assert_eq!(
                tokens
                    .pointer("/roleCssVars/body/--rb-frame-width")
                    .and_then(Value::as_str),
                Some(expected_width.as_str())
            );
            assert_eq!(
                tokens
                    .pointer("/roleCssVars/body/--rb-frame-height")
                    .and_then(Value::as_str),
                Some(expected_height.as_str())
            );
            assert_eq!(
                tokens
                    .pointer("/cssVars/--rb-accent")
                    .and_then(Value::as_str),
                Some("#123456")
            );
        }

        let _ = fs::remove_dir_all(
            package_path
                .ancestors()
                .nth(3)
                .map(std::path::Path::to_path_buf)
                .unwrap_or(package_path),
        );
    }
}
