use super::*;

fn richpost_page_file_names_to_keep(plan: &Value) -> BTreeSet<String> {
    plan.get("pages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|page| page.get("id").and_then(Value::as_str))
        .map(|page_id| format!("{page_id}.html"))
        .collect::<BTreeSet<_>>()
}

pub(super) fn persist_richpost_pages_from_plan(
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
    let keep_file_names = richpost_page_file_names_to_keep(plan);
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
        &render_richpost_preview_shell(title, plan, &tokens, typography),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_file_names_to_keep_ignores_pages_without_ids() {
        let keep = richpost_page_file_names_to_keep(&json!({
            "pages": [
                { "id": "page-001" },
                { "title": "missing id" },
                { "id": "page-002" }
            ]
        }));

        assert!(keep.contains("page-001.html"));
        assert!(keep.contains("page-002.html"));
        assert_eq!(keep.len(), 2);
    }
}
