use super::super::*;
use serde_json::Value;
use std::fs;

struct BundledRichpostThemeAsset {
    relative_path: &'static str,
    bytes: &'static [u8],
}

struct BundledRichpostThemeResource {
    id: &'static str,
    config_json: &'static str,
    layout_tokens_json: &'static str,
    cover_master_html: &'static str,
    body_master_html: &'static str,
    ending_master_html: &'static str,
    assets: &'static [BundledRichpostThemeAsset],
}

const CROSSROADS_MINT_THEME: BundledRichpostThemeResource = BundledRichpostThemeResource {
    id: "crossroads-mint",
    config_json: include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/builtin-richpost-themes/crossroads-mint/crossroads-mint.json"
    )),
    layout_tokens_json: include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/builtin-richpost-themes/crossroads-mint/layout.tokens.json"
    )),
    cover_master_html: include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/builtin-richpost-themes/crossroads-mint/masters/cover.master.html"
    )),
    body_master_html: include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/builtin-richpost-themes/crossroads-mint/masters/body.master.html"
    )),
    ending_master_html: include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/builtin-richpost-themes/crossroads-mint/masters/ending.master.html"
    )),
    assets: &[
        BundledRichpostThemeAsset {
            relative_path: "assets/cover.svg",
            bytes: include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/builtin-richpost-themes/crossroads-mint/assets/cover.svg"
            )),
        },
        BundledRichpostThemeAsset {
            relative_path: "assets/body.svg",
            bytes: include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/builtin-richpost-themes/crossroads-mint/assets/body.svg"
            )),
        },
        BundledRichpostThemeAsset {
            relative_path: "assets/ending.svg",
            bytes: include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/builtin-richpost-themes/crossroads-mint/assets/ending.svg"
            )),
        },
    ],
};

const BUNDLED_RICHPOST_THEMES: &[BundledRichpostThemeResource] = &[CROSSROADS_MINT_THEME];

fn write_bundled_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn should_preserve_existing_theme(root: &std::path::Path, theme_id: &str) -> bool {
    let config_path = package_richpost_theme_config_path(root, theme_id);
    if !config_path.is_file() {
        return false;
    }
    read_json_value_or(&config_path, Value::Null)
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        == Some("custom")
}

fn write_bundled_theme_root(
    package_path: &std::path::Path,
    theme: &BundledRichpostThemeResource,
) -> Result<(), String> {
    let root = package_richpost_theme_root_dir(package_path, theme.id);
    fs::create_dir_all(package_richpost_theme_store_dir(package_path))
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(package_richpost_theme_masters_dir(package_path, theme.id))
        .map_err(|error| error.to_string())?;
    write_text_file(
        &package_richpost_theme_config_path(package_path, theme.id),
        theme.config_json,
    )?;
    write_text_file(
        &package_richpost_theme_tokens_path(package_path, theme.id),
        theme.layout_tokens_json,
    )?;
    write_text_file(
        &package_richpost_theme_master_path(package_path, theme.id, RICHPOST_MASTER_COVER),
        theme.cover_master_html,
    )?;
    write_text_file(
        &package_richpost_theme_master_path(package_path, theme.id, RICHPOST_MASTER_BODY),
        theme.body_master_html,
    )?;
    write_text_file(
        &package_richpost_theme_master_path(package_path, theme.id, RICHPOST_MASTER_ENDING),
        theme.ending_master_html,
    )?;
    for asset in theme.assets {
        write_bundled_bytes(&root.join(asset.relative_path), asset.bytes)?;
    }
    Ok(())
}

pub(super) fn bundled_richpost_theme_ids() -> &'static [&'static str] {
    &["crossroads-mint"]
}

pub(super) fn ensure_bundled_richpost_themes(package_path: &std::path::Path) -> Result<(), String> {
    for theme in BUNDLED_RICHPOST_THEMES {
        if should_preserve_existing_theme(package_path, theme.id) {
            continue;
        }
        write_bundled_theme_root(package_path, theme)?;
    }
    Ok(())
}
