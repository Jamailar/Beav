use super::*;

pub(super) fn richpost_page_style_overrides_for_template(template: &str) -> Value {
    let _ = template;
    Value::Object(serde_json::Map::new())
}

pub(super) fn richpost_zone_assignment_value(
    block_ids: Vec<String>,
    asset_ids: Vec<String>,
) -> Value {
    richpost_zone_assignment_with_fragments(block_ids, asset_ids, Vec::new())
}

pub(super) fn richpost_zone_assignment_with_fragments(
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

pub(super) fn richpost_zone_block_ids(zones: &serde_json::Map<String, Value>) -> Vec<String> {
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

pub(super) fn richpost_zone_asset_ids(zones: &serde_json::Map<String, Value>) -> Vec<String> {
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

fn sanitize_richpost_zone_name(raw: &str) -> Option<String> {
    sanitize_richpost_master_name(raw)
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

pub(super) fn build_default_richpost_zones(
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

pub(super) fn normalize_richpost_style_overrides(raw: Option<&Value>, template: &str) -> Value {
    let mut normalized = richpost_page_style_overrides_for_template(template)
        .as_object()
        .cloned()
        .unwrap_or_default();
    merge_richpost_css_var_object(&mut normalized, raw);
    Value::Object(normalized)
}

pub(super) fn normalize_richpost_zones(
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
            if block_ids.is_empty() && asset_ids.is_empty() && fragments.is_empty() {
                continue;
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
