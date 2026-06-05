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

#[cfg(test)]
mod tests {
    use super::*;

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
}
