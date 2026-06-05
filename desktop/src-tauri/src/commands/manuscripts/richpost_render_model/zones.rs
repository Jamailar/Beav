use super::*;

fn richpost_zone_html(
    page: &Value,
    zone_name: &str,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    assets_by_id: &BTreeMap<String, PackageBoundAsset>,
) -> String {
    let Some(zone) = page
        .get("zones")
        .and_then(Value::as_object)
        .and_then(|zones| zones.get(zone_name))
        .and_then(Value::as_object)
    else {
        return String::new();
    };
    let asset_html = zone
        .get("assetIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|asset_id| assets_by_id.get(asset_id))
                .map(|asset| {
                    format!(
                        "<figure class=\"page-asset\" data-asset-id=\"{}\"><img src=\"{}\" alt=\"{}\" loading=\"lazy\" /></figure>",
                        escape_html(&asset.id),
                        escape_html(&asset.url),
                        escape_html(&asset.title)
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let fragment_array = zone
        .get("fragments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let fragment_html = fragment_array
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|fragment| {
            let text = fragment.get("text").and_then(Value::as_str)?;
            let kind = fragment
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("paragraph");
            let level = fragment
                .get("level")
                .and_then(Value::as_u64)
                .and_then(|value| u8::try_from(value).ok());
            Some(render_package_block_fragment_parts(kind, level, text))
        })
        .collect::<Vec<_>>()
        .join("");
    let block_html = zone
        .get("blockIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|block_id| blocks_by_id.get(block_id))
                .map(render_package_block_fragment)
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let render_fragments_first = fragment_array.iter().any(|fragment| {
        fragment
            .get("continuedFromPrevious")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let zone_content = if fragment_html.is_empty() {
        block_html
    } else if block_html.is_empty() {
        fragment_html
    } else if render_fragments_first {
        format!("{fragment_html}{block_html}")
    } else {
        format!("{block_html}{fragment_html}")
    };
    format!("{asset_html}{zone_content}")
}

pub(super) fn render_richpost_master_fragment(
    master_fragment: &str,
    page: &Value,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    assets_by_id: &BTreeMap<String, PackageBoundAsset>,
) -> String {
    let mut zone_names = vec![
        "background".to_string(),
        "overlay".to_string(),
        "decoration".to_string(),
        "title".to_string(),
        "body".to_string(),
        "media".to_string(),
        "footer".to_string(),
    ];
    if let Some(object) = page.get("zones").and_then(Value::as_object) {
        for zone_name in object.keys() {
            if !zone_names.iter().any(|item| item == zone_name) {
                zone_names.push(zone_name.clone());
            }
        }
    }
    let mut rendered = master_fragment.to_string();
    for zone_name in zone_names {
        rendered = rendered.replace(
            &format!("{{{{zone:{zone_name}}}}}"),
            &richpost_zone_html(page, &zone_name, blocks_by_id, assets_by_id),
        );
    }
    rendered
}
