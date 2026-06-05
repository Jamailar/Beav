use super::*;

pub(in crate::commands::manuscripts) fn richpost_css_var_map_from_tokens(
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

pub(in crate::commands::manuscripts) fn richpost_css_var_style_attr(
    vars: &BTreeMap<String, String>,
) -> String {
    vars.iter()
        .map(|(key, value)| format!("{}:{};", escape_html(key), escape_html(value)))
        .collect::<Vec<_>>()
        .join("")
}

pub(in crate::commands::manuscripts) fn richpost_token_value(tokens: &Value, key: &str) -> String {
    tokens
        .get("cssVars")
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
        .and_then(richpost_css_var_string)
        .unwrap_or_default()
}
