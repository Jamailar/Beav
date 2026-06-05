use super::*;

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

pub(super) fn migrate_legacy_richpost_theme_store(
    package_path: &std::path::Path,
) -> Result<(), String> {
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
