use super::*;

pub(super) fn normalize_richpost_template(value: &str) -> &'static str {
    match value.trim() {
        "cover" => "cover",
        "text-image" => "text-image",
        "image-focus" => "image-focus",
        "quote" => "quote",
        "ending" => "ending",
        _ => "text-stack",
    }
}

pub(super) fn richpost_master_name_from_template(template: &str) -> String {
    match normalize_richpost_template(template) {
        "cover" => RICHPOST_MASTER_COVER.to_string(),
        "ending" => RICHPOST_MASTER_ENDING.to_string(),
        _ => RICHPOST_MASTER_BODY.to_string(),
    }
}

pub(super) fn richpost_master_role(master_name: &str, template: &str) -> &'static str {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_normalization_falls_back_to_text_stack() {
        assert_eq!(normalize_richpost_template("cover"), "cover");
        assert_eq!(normalize_richpost_template("unknown"), "text-stack");
    }
}
