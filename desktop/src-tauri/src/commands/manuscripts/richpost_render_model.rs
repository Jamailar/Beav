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

fn read_richpost_master_fragment(
    package_path: &std::path::Path,
    theme: Option<&RichpostThemeSpec>,
    master_name: &str,
    template: &str,
) -> String {
    let sanitized = sanitize_richpost_master_name(master_name)
        .unwrap_or_else(|| richpost_master_name_from_template(template));
    let role = richpost_master_role(&sanitized, template);
    if let Some(theme_path) = theme.and_then(|value| {
        richpost_theme_root_master_path_for_theme(package_path, value, &sanitized)
    }) {
        if let Some(content) = fs::read_to_string(&theme_path)
            .ok()
            .map(|content| content.trim().to_string())
            .filter(|content| !content.is_empty())
        {
            return content;
        }
    }
    let package_master_path = package_richpost_master_path(package_path, &sanitized);
    fs::read_to_string(&package_master_path)
        .ok()
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .unwrap_or_else(|| default_richpost_master_fragment(role).to_string())
}

pub(super) fn render_richpost_page_html(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    title: &str,
    page: &Value,
    page_index: usize,
    _total_pages: usize,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    assets_by_id: &BTreeMap<String, PackageBoundAsset>,
    tokens: &Value,
    typography: RichpostTypographySettings,
) -> String {
    let template = normalize_richpost_template(
        page.get("template")
            .and_then(Value::as_str)
            .unwrap_or("text-stack"),
    );
    let master_name = page
        .get("master")
        .and_then(Value::as_str)
        .and_then(sanitize_richpost_master_name)
        .unwrap_or_else(|| richpost_master_name_from_template(template));
    let master_role = richpost_master_role(&master_name, template);
    let page_css_vars =
        richpost_css_var_map_from_tokens(tokens, master_role, page.get("styleOverrides"));
    let page_style_attr = richpost_css_var_style_attr(&page_css_vars);
    let page_id = page
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("page-{:03}", page_index + 1));
    let page_title = page
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{title} - 第 {} 页", page_index + 1));
    let master_fragment =
        read_richpost_master_fragment(package_path, Some(theme), &master_name, template);
    let page_markup =
        render_richpost_master_fragment(&master_fragment, page, blocks_by_id, assets_by_id);

    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{}</title>
  <style>
    :root {{ --rb-font-scale: 1; --rb-line-height-scale: 1; }}
    * {{ box-sizing: border-box; }}
    html, body {{ margin: 0; width: 100%; height: 100%; overflow: hidden; }}
    body {{
      height: 100vh;
      background: var(--rb-page-bg, #ffffff);
      color: var(--rb-body-text, var(--rb-text, #111111));
      font-family: var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
    }}
    .rb-page-host {{
      position: relative;
      width: 100%;
      height: 100vh;
      aspect-ratio: 3 / 4;
      background: var(--rb-page-bg, #ffffff);
      color: var(--rb-body-text, var(--rb-text, #111111));
      overflow: hidden;
      isolation: isolate;
    }}
    .rb-zone {{ min-width: 0; }}
    .rb-zone:empty {{ display: none; }}
    .rb-zone-background:empty,
    .rb-zone-overlay:empty,
    .rb-zone-decoration:empty {{ display: block; }}
    .rb-zone-overlay,
    .rb-zone-decoration {{ pointer-events: none; }}
    .page-asset {{
      width: 100%;
      margin: 0;
      max-width: 100%;
    }}
    .page-asset + .page-asset {{ margin-top: var(--rb-zone-gap, 16px); }}
    .page-asset img {{
      display: block;
      width: 100%;
      max-width: 100%;
      height: auto;
      border-radius: var(--rb-image-radius, 0px);
    }}
    .rb-block {{ min-width: 0; }}
    .rb-block + .rb-block {{ margin-top: var(--rb-zone-gap, 16px); }}
    .rb-heading {{
      width: min(100%, var(--rb-title-max-width, 100%));
    }}
    .rb-heading h1,
    .rb-heading h2,
    .rb-heading h3,
    .rb-heading h4,
    .rb-heading h5,
    .rb-heading h6 {{
      margin: 0;
      color: var(--rb-heading-text, var(--rb-text, #111111));
      font-family: var(--rb-heading-font, var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif));
      font-weight: 700;
      line-height: 1.22;
      letter-spacing: -0.02em;
    }}
    .rb-heading h1 {{ font-size: var(--rb-heading-h1-size, calc(clamp(28px, 5.4vw, 58px) * var(--rb-font-scale))); }}
    .rb-heading h2 {{ font-size: var(--rb-heading-h2-size, calc(clamp(24px, 4.5vw, 48px) * var(--rb-font-scale))); }}
    .rb-heading h3 {{ font-size: var(--rb-heading-h3-size, calc(clamp(21px, 3.8vw, 40px) * var(--rb-font-scale))); }}
    .rb-heading h4 {{ font-size: var(--rb-heading-h4-size, calc(clamp(18px, 3.2vw, 34px) * var(--rb-font-scale))); }}
    .rb-heading h5 {{ font-size: var(--rb-heading-h5-size, calc(clamp(17px, 2.7vw, 28px) * var(--rb-font-scale))); }}
    .rb-heading h6 {{ font-size: var(--rb-heading-h6-size, calc(clamp(16px, 2.4vw, 24px) * var(--rb-font-scale))); }}
    .rb-paragraph {{
      width: min(100%, var(--rb-content-max-width, 100%));
    }}
    .rb-paragraph > :first-child {{ margin-top: 0; }}
    .rb-paragraph > :last-child {{ margin-bottom: 0; }}
    .rb-paragraph p,
    .rb-paragraph li,
    .rb-paragraph blockquote,
    .rb-paragraph td,
    .rb-paragraph th {{
      color: var(--rb-body-text, var(--rb-text, #111111));
      font-family: var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
      font-size: var(--rb-body-font-size, calc(clamp(17px, 3.2vw, 34px) * var(--rb-font-scale)));
      line-height: var(--rb-runtime-body-line-height, var(--rb-body-line-height, 1.9));
    }}
    .rb-paragraph strong {{ font-weight: var(--rb-strong-weight, 700); }}
    .rb-paragraph a {{
      color: var(--rb-accent, #111111);
      text-decoration: var(--rb-link-decoration, underline);
    }}
    .rb-paragraph ul,
    .rb-paragraph ol {{
      margin: 0;
      padding-left: 1.25em;
    }}
    .rb-paragraph blockquote {{
      margin: 0;
      padding-left: 1em;
      border-left: 3px solid var(--rb-accent, #111111);
      color: var(--rb-muted, #666666);
    }}
    .rb-paragraph table {{
      margin: 0;
      border-collapse: collapse;
    }}
    .rb-paragraph hr {{
      border: 0;
      border-top: 1px solid var(--rb-surface-border, rgba(17,17,17,0.08));
      margin: calc(var(--rb-zone-gap, 16px) * 1.1) 0;
    }}
  </style>
  <script>
    (() => {{
      const applyRuntimeTypography = (fontScale, lineHeightScale) => {{
        document.documentElement.style.setProperty('--rb-font-scale', String(fontScale));
        document.documentElement.style.setProperty('--rb-line-height-scale', String(lineHeightScale));
        const host = document.querySelector('.rb-page-host');
        if (!host) return;
        const computed = window.getComputedStyle(host);
        const rawBaseLineHeight = Number.parseFloat(computed.getPropertyValue('--rb-body-line-height').trim() || '1.9');
        const baseLineHeight = Number.isFinite(rawBaseLineHeight) ? rawBaseLineHeight : 1.9;
        host.style.setProperty('--rb-runtime-body-line-height', String((baseLineHeight * lineHeightScale).toFixed(3)));
      }};
      const params = new URLSearchParams(window.location.search);
      const defaultFontScale = {};
      const defaultLineHeightScale = {};
      const rawFontScale = Number(params.get('fontScale') || String(defaultFontScale));
      const fontScale = Number.isFinite(rawFontScale) ? Math.min(1.6, Math.max(0.8, rawFontScale)) : defaultFontScale;
      const rawLineHeightScale = Number(params.get('lineHeightScale') || String(defaultLineHeightScale));
      const lineHeightScale = Number.isFinite(rawLineHeightScale) ? Math.min(1.4, Math.max(0.8, rawLineHeightScale)) : defaultLineHeightScale;
      const run = () => applyRuntimeTypography(fontScale, lineHeightScale);
      if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', run, {{ once: true }});
      }} else {{
        run();
      }}
    }})();
  </script>
</head>
<body>
  <section class="rb-page-host" data-page-id="{}" data-master="{}" data-template="{}" style="{}">
    {}
  </section>
</body>
</html>"#,
        escape_html(&page_title),
        typography.font_scale,
        typography.line_height_scale,
        escape_html(&page_id),
        escape_html(master_role),
        escape_html(template),
        page_style_attr,
        page_markup,
    )
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
