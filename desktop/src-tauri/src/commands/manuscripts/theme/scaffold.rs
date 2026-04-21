use super::super::*;
use super::store::{
    richpost_theme_background_css_vars, richpost_theme_catalog_for_package,
    richpost_theme_root_master_path_for_theme, richpost_theme_root_tokens_path_for_theme,
    richpost_theme_spec_from_manifest,
};
use serde_json::{json, Value};
use std::fs;

fn canonical_richpost_role_css_vars(
    package_path: Option<&std::path::Path>,
    theme: &RichpostThemeSpec,
    role: &str,
) -> serde_json::Map<String, Value> {
    let mut vars = richpost_zone_frame_css_vars(&default_richpost_zone_frame(role));
    vars.extend(richpost_theme_background_css_vars(
        package_path,
        theme,
        role,
    ));
    vars
}

pub(crate) fn default_richpost_layout_tokens(
    package_path: Option<&std::path::Path>,
    theme: &RichpostThemeSpec,
) -> Value {
    let cover_role_vars =
        canonical_richpost_role_css_vars(package_path, theme, RICHPOST_MASTER_COVER);
    let body_role_vars =
        canonical_richpost_role_css_vars(package_path, theme, RICHPOST_MASTER_BODY);
    let ending_role_vars =
        canonical_richpost_role_css_vars(package_path, theme, RICHPOST_MASTER_ENDING);
    json!({
        "version": 1,
        "themeId": theme.id,
        "cssVars": {
            "--rb-shell-bg": theme.shell_bg,
            "--rb-preview-card-bg": theme.preview_card_bg,
            "--rb-preview-card-border": theme.preview_card_border,
            "--rb-preview-card-shadow": theme.preview_card_shadow,
            "--rb-page-bg": theme.page_bg,
            "--rb-surface-bg": theme.surface_bg,
            "--rb-surface-border": theme.surface_border,
            "--rb-surface-shadow": theme.surface_shadow,
            "--rb-surface-radius": theme.surface_radius,
            "--rb-image-radius": theme.image_radius,
            "--rb-heading-text": theme.heading_color,
            "--rb-body-text": theme.body_color,
            "--rb-text": theme.text,
            "--rb-muted": theme.muted,
            "--rb-accent": theme.accent,
            "--rb-heading-font": theme.heading_font,
            "--rb-body-font": theme.body_font,
            "--rb-page-padding": "clamp(18px, 3.6vw, 32px)",
            "--rb-zone-gap": "14px",
            "--rb-body-font-size": "calc(clamp(17px, 3.2vw, 34px) * var(--rb-font-scale))",
            "--rb-body-line-height": "1.92",
            "--rb-heading-h1-size": "calc(clamp(28px, 5.4vw, 58px) * var(--rb-font-scale))",
            "--rb-heading-h2-size": "calc(clamp(24px, 4.5vw, 48px) * var(--rb-font-scale))",
            "--rb-heading-h3-size": "calc(clamp(21px, 3.8vw, 40px) * var(--rb-font-scale))",
            "--rb-heading-h4-size": "calc(clamp(18px, 3.2vw, 34px) * var(--rb-font-scale))",
            "--rb-heading-h5-size": "calc(clamp(17px, 2.7vw, 28px) * var(--rb-font-scale))",
            "--rb-heading-h6-size": "calc(clamp(16px, 2.4vw, 24px) * var(--rb-font-scale))",
            "--rb-content-max-width": "100%",
            "--rb-title-max-width": "100%",
            "--rb-strong-weight": "700",
            "--rb-link-decoration": "underline"
        },
        "roleCssVars": {
            "cover": cover_role_vars,
            "body": body_role_vars,
            "ending": ending_role_vars
        }
    })
}

pub(crate) fn normalize_richpost_layout_tokens_value(
    raw: &Value,
    theme: &RichpostThemeSpec,
    package_path: Option<&std::path::Path>,
) -> Value {
    let mut normalized = default_richpost_layout_tokens(package_path, theme);
    if let Some(object) = normalized.as_object_mut() {
        if let Some(css_vars) = object.get_mut("cssVars").and_then(Value::as_object_mut) {
            merge_richpost_css_var_object(css_vars, raw.get("cssVars"));
        }
        if let Some(role_target) = object.get_mut("roleCssVars").and_then(Value::as_object_mut) {
            if let Some(raw_roles) = raw.get("roleCssVars").and_then(Value::as_object) {
                for (role_name, role_value) in raw_roles {
                    let Some(role_key) = sanitize_richpost_master_name(role_name) else {
                        continue;
                    };
                    let role_entry = role_target
                        .entry(role_key)
                        .or_insert_with(|| Value::Object(serde_json::Map::new()));
                    merge_richpost_css_var_object(
                        role_entry.as_object_mut().unwrap(),
                        Some(role_value),
                    );
                }
            }
            for role in [
                RICHPOST_MASTER_COVER,
                RICHPOST_MASTER_BODY,
                RICHPOST_MASTER_ENDING,
            ] {
                let role_entry = role_target
                    .entry(role.to_string())
                    .or_insert_with(|| Value::Object(serde_json::Map::new()));
                if let Some(role_object) = role_entry.as_object_mut() {
                    for (key, value) in canonical_richpost_role_css_vars(package_path, theme, role)
                    {
                        if key.starts_with("--rb-frame-") || key == "--rb-background-image" {
                            role_object.insert(key, value);
                        }
                    }
                }
            }
        }
        object.insert("themeId".to_string(), json!(theme.id));
        object.insert("version".to_string(), json!(1));
    }
    normalized
}

pub(crate) fn read_richpost_layout_tokens_value_for_theme(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
) -> Value {
    let default_tokens = default_richpost_layout_tokens(Some(package_path), theme);
    let raw = richpost_theme_root_tokens_path_for_theme(package_path, theme)
        .map(|path| read_json_value_or(&path, default_tokens.clone()))
        .unwrap_or_else(|| {
            read_json_value_or(
                &package_layout_tokens_path(package_path),
                default_tokens.clone(),
            )
        });
    normalize_richpost_layout_tokens_value(&raw, theme, Some(package_path))
}

pub(crate) fn write_richpost_layout_tokens_for_theme(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
) -> Result<Value, String> {
    let normalized = normalize_richpost_layout_tokens_value(
        &default_richpost_layout_tokens(Some(package_path), theme),
        theme,
        Some(package_path),
    );
    write_json_value(&package_layout_tokens_path(package_path), &normalized)?;
    Ok(normalized)
}

fn richpost_builtin_tokens_are_locked(manifest: &Value) -> bool {
    manifest
        .get("richpostTokensCustomized")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn richpost_builtin_masters_are_locked(manifest: &Value) -> bool {
    manifest
        .get("richpostMastersCustomized")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn richpost_layout_tokens_need_frame_upgrade(raw: &Value) -> bool {
    for role in [
        RICHPOST_MASTER_COVER,
        RICHPOST_MASTER_BODY,
        RICHPOST_MASTER_ENDING,
    ] {
        let Some(role_vars) = raw
            .get("roleCssVars")
            .and_then(Value::as_object)
            .and_then(|roles| roles.get(role))
            .and_then(Value::as_object)
        else {
            return true;
        };
        for key in [
            "--rb-frame-left",
            "--rb-frame-top",
            "--rb-frame-width",
            "--rb-frame-height",
        ] {
            if !role_vars.contains_key(key) {
                return true;
            }
        }
    }
    false
}

pub(crate) fn ensure_richpost_layout_scaffold(
    package_path: &std::path::Path,
    manifest: &Value,
) -> Result<Value, String> {
    ensure_richpost_theme_template_file(package_path)?;
    let theme = richpost_theme_spec_from_manifest(Some(package_path), manifest);
    let tokens_path = package_layout_tokens_path(package_path);
    let theme_tokens_path = richpost_theme_root_tokens_path_for_theme(package_path, &theme);
    if let Some(source) = theme_tokens_path.as_ref() {
        super::store::copy_if_exists(source, &tokens_path)?;
    }
    let refresh_builtin_tokens = theme_tokens_path.is_none()
        && (!richpost_builtin_tokens_are_locked(manifest)
            || !tokens_path.exists()
            || richpost_layout_tokens_need_frame_upgrade(&read_json_value_or(
                &tokens_path,
                json!({}),
            )));
    let tokens = if refresh_builtin_tokens {
        write_richpost_layout_tokens_for_theme(package_path, &theme)?
    } else {
        read_richpost_layout_tokens_value_for_theme(package_path, &theme)
    };
    let masters_dir = package_richpost_masters_dir(package_path);
    fs::create_dir_all(&masters_dir).map_err(|error| error.to_string())?;
    for master_name in RICHPOST_DEFAULT_MASTER_NAMES {
        let path = package_richpost_master_path(package_path, master_name);
        if let Some(theme_master_path) =
            richpost_theme_root_master_path_for_theme(package_path, &theme, master_name)
        {
            super::store::copy_if_exists(&theme_master_path, &path)?;
            continue;
        }
        let refresh_builtin_master = !richpost_builtin_masters_are_locked(manifest)
            || !path.exists()
            || richpost_master_file_needs_upgrade(&path);
        if refresh_builtin_master {
            write_text_file(&path, default_richpost_master_fragment(master_name))?;
        }
    }
    Ok(tokens)
}

pub(crate) fn richpost_theme_catalog_value(package_path: Option<&std::path::Path>) -> Value {
    json!(richpost_theme_catalog_for_package(package_path)
        .iter()
        .map(|theme| {
            json!({
                "id": theme.id,
                "label": theme.label,
                "description": theme.description,
                "source": theme.source,
                "shellBg": theme.shell_bg,
                "pageBg": theme.page_bg,
                "surfaceColor": theme.surface_bg,
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
        })
        .collect::<Vec<_>>())
}

pub(crate) fn richpost_theme_catalog_value_for_manifest(
    package_path: Option<&std::path::Path>,
    manifest: &Value,
) -> Value {
    let mut catalog = richpost_theme_catalog_for_package(package_path);
    if let Some(snapshot) = super::store::richpost_theme_spec_from_manifest_snapshot(manifest) {
        if !catalog.iter().any(|theme| theme.id == snapshot.id) {
            catalog.push(snapshot);
            catalog
                .sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
        }
    }
    json!(catalog
        .iter()
        .map(|theme| {
            json!({
                "id": theme.id,
                "label": theme.label,
                "description": theme.description,
                "source": theme.source,
                "shellBg": theme.shell_bg,
                "pageBg": theme.page_bg,
                "surfaceColor": theme.surface_bg,
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
        })
        .collect::<Vec<_>>())
}

pub(crate) fn richpost_theme_state_value(
    package_path: &std::path::Path,
    manifest: &Value,
) -> Value {
    let theme = richpost_theme_spec_from_manifest(Some(package_path), manifest);
    json!({
        "id": theme.id,
        "label": theme.label,
        "description": theme.description,
        "source": theme.source
    })
}
