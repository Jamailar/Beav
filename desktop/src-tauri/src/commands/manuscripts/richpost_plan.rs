use super::*;

#[path = "richpost_zones.rs"]
mod richpost_zones;
#[path = "richpost_plan/templates.rs"]
mod templates;

use richpost_zones::{
    build_default_richpost_zones, normalize_richpost_style_overrides, normalize_richpost_zones,
    richpost_page_style_overrides_for_template, richpost_zone_asset_ids,
    richpost_zone_assignment_value, richpost_zone_assignment_with_fragments,
    richpost_zone_block_ids,
};
pub(super) use templates::{
    normalize_richpost_template, richpost_master_name_from_template, richpost_master_role,
};

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

pub(super) fn richpost_asset_records(
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

pub(super) fn default_richpost_page_plan(
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

pub(super) fn normalize_richpost_page_plan(
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
