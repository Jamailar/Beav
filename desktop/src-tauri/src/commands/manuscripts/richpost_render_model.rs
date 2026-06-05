use super::*;

pub(super) fn richpost_css_var_map_from_tokens(
    tokens: &Value,
    role: &str,
    style_overrides: Option<&Value>,
) -> BTreeMap<String, String> {
    let mut map = BTreeMap::<String, String>::new();
    if let Some(object) = tokens.get("cssVars").and_then(Value::as_object) {
        for (key, value) in object {
            let Some(name) = sanitize_richpost_css_var_name(key) else {
                continue;
            };
            let Some(text) = richpost_css_var_string(value) else {
                continue;
            };
            map.insert(name, text);
        }
    }
    if let Some(object) = tokens
        .get("roleCssVars")
        .and_then(|value| value.get(role))
        .and_then(Value::as_object)
    {
        for (key, value) in object {
            let Some(name) = sanitize_richpost_css_var_name(key) else {
                continue;
            };
            let Some(text) = richpost_css_var_string(value) else {
                continue;
            };
            map.insert(name, text);
        }
    }
    if let Some(object) = style_overrides.and_then(Value::as_object) {
        for (key, value) in object {
            let Some(name) = sanitize_richpost_css_var_name(key) else {
                continue;
            };
            let Some(text) = richpost_css_var_string(value) else {
                continue;
            };
            map.insert(name, text);
        }
    }
    map
}

pub(super) fn richpost_css_var_style_attr(vars: &BTreeMap<String, String>) -> String {
    vars.iter()
        .map(|(key, value)| format!("{}:{};", escape_html(key), escape_html(value)))
        .collect::<Vec<_>>()
        .join("")
}

pub(super) fn richpost_token_value(tokens: &Value, key: &str) -> String {
    tokens
        .get("cssVars")
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
        .and_then(richpost_css_var_string)
        .unwrap_or_default()
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn paragraph_block(id: &str, text: &str) -> PackageContentBlock {
        PackageContentBlock {
            id: id.to_string(),
            slot: "body".to_string(),
            kind: "paragraph".to_string(),
            level: None,
            text: text.to_string(),
            order: 0,
            char_count: text.chars().count(),
        }
    }

    #[test]
    fn css_var_map_layers_global_role_and_page_overrides() {
        let map = richpost_css_var_map_from_tokens(
            &json!({
                "cssVars": {
                    "--rb-text": "#111",
                    "--bad-text": "#222"
                },
                "roleCssVars": {
                    "cover": {
                        "--rb-text": "#333",
                        "--rb-accent": "#444"
                    }
                }
            }),
            "cover",
            Some(&json!({
                "--rb-accent": "#555",
                "--invalid;": "#666"
            })),
        );

        assert_eq!(map.get("--rb-text").map(String::as_str), Some("#333"));
        assert_eq!(map.get("--rb-accent").map(String::as_str), Some("#555"));
        assert!(!map.contains_key("--bad-text"));
        assert!(!map.contains_key("--invalid;"));
    }

    #[test]
    fn css_var_style_attr_escapes_values() {
        let mut vars = BTreeMap::new();
        vars.insert("--rb-text".to_string(), "<red>".to_string());

        assert_eq!(richpost_css_var_style_attr(&vars), "--rb-text:&lt;red&gt;;");
    }

    #[test]
    fn render_master_fragment_replaces_standard_and_custom_zones() {
        let mut blocks = BTreeMap::new();
        blocks.insert("body-1".to_string(), paragraph_block("body-1", "正文"));
        let mut assets = BTreeMap::new();
        assets.insert(
            "asset-1".to_string(),
            PackageBoundAsset {
                id: "asset-1".to_string(),
                title: "封面".to_string(),
                url: "images/cover.png".to_string(),
                role: "cover".to_string(),
            },
        );
        let page = json!({
            "zones": {
                "body": { "blockIds": ["body-1"] },
                "custom": { "assetIds": ["asset-1"] }
            }
        });

        let rendered = render_richpost_master_fragment(
            "<main>{{zone:body}}</main><aside>{{zone:custom}}</aside>",
            &page,
            &blocks,
            &assets,
        );

        assert!(rendered.contains("正文"));
        assert!(rendered.contains("images/cover.png"));
        assert!(!rendered.contains("{{zone:custom}}"));
    }
}
